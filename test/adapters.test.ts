import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { effectiveEnv, envValue, resolveCommand } from "../src/process";
import { envExecutable } from "../src/adapters/shared";
import path from "node:path";
import {
  AntigravityAdapter,
  ClaudeAdapter,
  CodexAdapter,
  CURSOR_DEFAULT_MODEL,
  CURSOR_WORKTREES_ROOT_ENV,
  CursorAdapter,
  cursorRepoSlug,
  cursorWorktreePath,
  cursorWorktreesRoot,
  generateWorktreeName,
  modelListingKey,
} from "../src/adapters";
import { AgentHeadlessError } from "../src/errors";
import { MAX_JSONL_WARNINGS, parseJsonLines } from "../src/jsonl";
import { SUPPORTED_MODELS } from "../src/models";
import type { Provider, RunRequest } from "../src/types";
import { normalizeRequest } from "../src/validation";

/** Asserts a flag is present and immediately followed by its value. */
function expectFlag(args: string[], flag: string, value: string): void {
  expect(args[args.indexOf(flag) + 1]).toBe(value);
}

function request(provider: Provider, overrides: Partial<RunRequest> = {}): RunRequest {
  return normalizeRequest({
    provider,
    prompt: "Say OK",
    cwd: process.cwd(),
    ...overrides,
  });
}

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  test("builds a safe ephemeral inspection stream", () => {
    const invocation = adapter.build(request("claude", { model: "sonnet", effort: "high", access: "inspect" }));
    expect(invocation.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose",
      "--model", "sonnet", "--effort", "high",
      "--permission-mode", "dontAsk", "--tools", "Read", "Glob", "Grep",
      "--no-session-persistence",
    ]);
    expect(invocation.stdin).toBe("Say OK");
  });

  test("builds answer-only without tools", () => {
    const invocation = adapter.build(request("claude", { access: "answer-only", output: "text" }));
    expect(invocation.args).toContain("--tools=");
    expect(invocation.structured).toBe(false);
  });

  test("builds an isolated named worktree", () => {
    const invocation = adapter.build(request("claude", {
      access: "edit-isolated",
      providerOptions: { claude: { worktreeName: "review-42" } },
    }));
    expect(invocation.args).toContain("--worktree");
    expect(invocation.args).toContain("review-42");
    expect(invocation.args).toContain("acceptEdits");
  });

  test("parses terminal stream result and usage", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s1", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: { x: { canonicalModel: "claude-sonnet" } } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "s1",
      modelObserved: "claude-sonnet",
      usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.01 },
      events: [
        { kind: "session" },
        { kind: "result" },
      ],
    });
  });
});

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  test("maps effort through a strict TOML config value", () => {
    const invocation = adapter.build(request("codex", { effort: "medium", model: "gpt-5.6-sol" }));
    expect(invocation.args).toContainAllValues([
      "exec", "-C", process.cwd(), "-s", "read-only", "--ephemeral", "--model", "gpt-5.6-sol",
      "-c", 'model_reasoning_effort="medium"', "--json", "-",
    ]);
  });

  test("maps explicit workspace editing", () => {
    const invocation = adapter.build(request("codex", { access: "edit-workspace" }));
    expect(invocation.args).toContain("-s");
    expect(invocation.args).toContain("workspace-write");
  });

  test("rejects isolated editing", () => {
    expect(() => adapter.build(request("codex", { access: "edit-isolated" }))).toThrow(AgentHeadlessError);
  });

  test("requires inherited access semantics for resumed sessions", () => {
    expect(() => adapter.build(request("codex", {
      session: { mode: "resume", id: "thread-1" },
      access: "inspect",
    }))).toThrow(AgentHeadlessError);
    const invocation = adapter.build(request("codex", {
      session: { mode: "resume", id: "thread-1" },
      access: "inherit-session",
    }));
    expect(invocation.args.slice(0, 4)).toEqual(["exec", "resume", "thread-1", "--json"]);
  });

  test("does not expose writable additional dirs in read-only mode", () => {
    expect(() => adapter.build(request("codex", {
      additionalDirs: [process.cwd()],
      access: "inspect",
    }))).toThrow(AgentHeadlessError);
  });

  test("uses request-scoped executable overrides", () => {
    const invocation = adapter.build(request("codex", { env: { CODEX_BIN: "X:\\tools\\codex.exe" } }));
    expect(invocation.command).toBe("X:\\tools\\codex.exe");
  });

  test("parses Codex JSONL", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "t1",
      usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 1, reasoningOutputTokens: 0 },
      events: [
        { kind: "session" },
        { kind: "status" },
        { kind: "message" },
        { kind: "result" },
      ],
    });
  });
});

describe("AntigravityAdapter", () => {
  const adapter = new AntigravityAdapter();

  test("builds a structured, read-first print run", () => {
    const invocation = adapter.build(request("antigravity", {
      model: "gemini-3.7-flash-high",
      effort: "high",
      access: "inspect",
      schema: { type: "object" },
      additionalDirs: [process.cwd()],
      providerOptions: { antigravity: { sandbox: true, agent: "reviewer", project: "p1" } },
      timeoutMs: 12_345,
    }));
    expect(invocation.command).toBe(envExecutable("antigravity"));
    expect(invocation.args).toEqual([
      "--print", "Say OK", "--output-format", "stream-json", "--print-timeout", "12345ms",
      "--mode", "plan", "--model", "gemini-3.7-flash-high", "--effort", "high",
      "--json-schema", '{"type":"object"}', "--add-dir", process.cwd(), "--sandbox",
      "--agent", "reviewer", "--project", "p1",
    ]);
    expect(invocation.stdin).toBe("");
  });

  test("passes an operator-selected live-catalog model through to AGY", () => {
    const invocation = adapter.build(request("antigravity", { model: "gemini-3.7-flash-high" }));
    expectFlag(invocation.args, "--model", "gemini-3.7-flash-high");
  });

  test("maps explicit workspace edits and conversation resume", () => {
    const edit = adapter.build(request("antigravity", { access: "edit-workspace" }));
    expectFlag(edit.args, "--mode", "accept-edits");
    const resumed = adapter.build(request("antigravity", {
      session: { mode: "resume", id: "conversation-1" },
    }));
    expectFlag(resumed.args, "--conversation", "conversation-1");
  });

  test("rejects impossible isolation, ephemeral sessions, budgets, and unsupported effort", () => {
    expect(() => adapter.build(request("antigravity", { access: "edit-isolated" }))).toThrow(AgentHeadlessError);
    expect(() => adapter.build(request("antigravity", { session: { mode: "ephemeral" } }))).toThrow(AgentHeadlessError);
    expect(() => adapter.build(request("antigravity", { maxBudgetUsd: 1 }))).toThrow(AgentHeadlessError);
    expect(() => adapter.build(request("antigravity", { effort: "max" }))).toThrow(AgentHeadlessError);
  });

  test("parses AGY stream events, terminal response, session, model, and usage", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "a1", init: { model: "gemini-3.7-flash-high" } }),
      JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "OK" } }),
      JSON.stringify({ event: "result", result: {
        conversation_id: "a1", status: "SUCCESS", response: "OK",
        usage: { input_tokens: 5, cache_read_tokens: 2, output_tokens: 1, thinking_tokens: 3 },
      } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "a1",
      modelObserved: "gemini-3.7-flash-high",
      usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 1, reasoningOutputTokens: 3 },
      events: [{ kind: "session" }, { kind: "message" }, { kind: "result" }],
    });
  });

  test("treats an AGY non-success terminal result as a provider failure", () => {
    const parsed = adapter.parse(JSON.stringify({ event: "result", result: { status: "FAILED", response: "quota exhausted" } }), true);
    expect(parsed.unreadable).toBeUndefined();
    expect(parsed.protocolError).toBe("Antigravity reported FAILED: quota exhausted");
  });
});

describe("CursorAdapter", () => {
  const adapter = new CursorAdapter();

  test("defaults to a persistent, read-only plan session", () => {
    const invocation = adapter.build(request("cursor", { model: "cursor-grok-4.5-high", access: "inspect" }));
    for (const value of ["--print", "--model", "cursor-grok-4.5-high", "--output-format", "stream-json", "--mode", "plan"]) {
      expect(invocation.args).toContain(value);
    }
    expect(invocation.args).not.toContain("--trust");
  });

  test("adds effort to a parameterized model without losing parameters", () => {
    const invocation = adapter.build(request("cursor", {
      model: "composer-2.5[context=1m]",
      effort: "high",
      access: "answer-only",
    }));
    expect(invocation.args).toContain("composer-2.5[context=1m,effort=high]");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).toContain("ask");
  });

  test("does not corrupt an exact model ID that already encodes effort", () => {
    const invocation = adapter.build(request("cursor", { model: "cursor-grok-4.5-low", effort: "low" }));
    expect(invocation.args).toContain("cursor-grok-4.5-low");
    expect(invocation.args).not.toContain("cursor-grok-4.5-low[effort=low]");
  });

  test("supports exact Composer fast model IDs", () => {
    const invocation = adapter.build(request("cursor", { model: "composer-2.5-fast" }));
    expect(invocation.args).toContain("composer-2.5-fast");
  });

  test("workspace trust is explicit", () => {
    const invocation = adapter.build(request("cursor", {
      model: "cursor-grok-4.5-high",
      providerOptions: { cursor: { trustWorkspace: true } },
    }));
    expect(invocation.args).toContain("--trust");
  });

  test("requests Cursor sandbox only where the CLI supports it", () => {
    const invocation = adapter.build(request("cursor", {
      model: "cursor-grok-4.5-high",
      access: "edit-isolated",
    }));
    expect(invocation.args).toContain("--worktree");
    if (process.platform === "win32") expect(invocation.args).not.toContain("--sandbox");
    else {
      const sandbox = invocation.args.indexOf("--sandbox");
      expect(sandbox).not.toBe(-1);
      expect(invocation.args.slice(sandbox, sandbox + 2)).toEqual(["--sandbox", "enabled"]);
    }
  });

  test("falls back to the documented default model when none was named", async () => {
    const prepared = await adapter.prepare(request("cursor", { access: "answer-only" }));
    expect(CURSOR_DEFAULT_MODEL).toBe("cursor-grok-4.6-medium");
    expect(prepared.model).toBe(CURSOR_DEFAULT_MODEL);
    expect(adapter.build(prepared).args).toContain(CURSOR_DEFAULT_MODEL);
    // Also holds for a direct build that never went through prepare.
    expectFlag(adapter.build(request("cursor", { access: "answer-only" })).args, "--model", CURSOR_DEFAULT_MODEL);
  });

  test("an explicitly named model always beats the default", async () => {
    const prepared = await adapter.prepare(request("cursor", { model: "cursor-grok-4.5-high" }));
    expect(prepared.model).toBe("cursor-grok-4.5-high");
    expect(adapter.build(prepared).args).not.toContain(CURSOR_DEFAULT_MODEL);
  });

  test("keeps Grok 4.5 compatibility while accepting curated Grok 4.6 IDs", async () => {
    for (const model of ["cursor-grok-4.5-medium", "cursor-grok-4.6-medium"]) {
      const prepared = await adapter.prepare(request("cursor", { model }));
      expect(prepared.model).toBe(model);
    }
  });

  test("still refuses model=auto, which names no accountable model", () => {
    expect(() => adapter.build(request("cursor", { model: "auto" }))).toThrow(AgentHeadlessError);
  });

  test("never emits a bare --worktree, because Cursor would then name it itself", async () => {
    const prepared = await adapter.prepare(
      request("cursor", { model: "cursor-grok-4.5-medium", access: "edit-isolated" }),
      { generateWorktreeName: () => "agent-headless-fixed-1" },
    );
    expect(prepared.providerOptions?.cursor?.worktreeName).toBe("agent-headless-fixed-1");
    const args = adapter.build(prepared).args;
    expect(args.slice(args.indexOf("--worktree"), args.indexOf("--worktree") + 2))
      .toEqual(["--worktree", "agent-headless-fixed-1"]);

    const direct = adapter.build(request("cursor", { model: "cursor-grok-4.5-medium", access: "edit-isolated" })).args;
    const name = direct[direct.indexOf("--worktree") + 1];
    expect(name).toMatch(/^agent-headless-[a-z0-9]+-[a-f0-9]{12}$/u);
  });

  test("an explicit worktree name is passed through untouched", async () => {
    const prepared = await adapter.prepare(request("cursor", {
      model: "cursor-grok-4.5-medium",
      access: "edit-isolated",
      providerOptions: { cursor: { worktreeName: "task-018", worktreeBase: "main" } },
    }));
    expect(prepared.providerOptions?.cursor?.worktreeName).toBe("task-018");
    expectFlag(adapter.build(prepared).args, "--worktree", "task-018");
    expectFlag(adapter.build(prepared).args, "--worktree-base", "main");
  });

  test("generated worktree names are CLI-safe and collision-resistant", () => {
    const names = new Set(Array.from({ length: 500 }, () => generateWorktreeName()));
    expect(names.size).toBe(500);
    for (const name of names) {
      expect(name).toMatch(/^agent-headless-[a-z0-9-]+$/u);
      expect(name.length).toBeLessThanOrEqual(48);
    }
  });

  test("the worktree root follows the child's environment, not this process's", () => {
    const fallback = path.join(homedir(), ".cursor", "worktrees");
    expect(cursorWorktreesRoot()).toBe(process.env[CURSOR_WORKTREES_ROOT_ENV] ?? fallback);
    expect(cursorWorktreesRoot({ [CURSOR_WORKTREES_ROOT_ENV]: "/srv/worktrees" })).toBe("/srv/worktrees");
    // An overlay entry set to undefined *removes* the variable from the child,
    // so the child sees Cursor's default - not this process's inherited value.
    const previous = process.env[CURSOR_WORKTREES_ROOT_ENV];
    process.env[CURSOR_WORKTREES_ROOT_ENV] = "/inherited";
    try {
      expect(cursorWorktreesRoot({ [CURSOR_WORKTREES_ROOT_ENV]: undefined })).toBe(fallback);
      expect(cursorWorktreesRoot()).toBe("/inherited");
    } finally {
      if (previous === undefined) delete process.env[CURSOR_WORKTREES_ROOT_ENV];
      else process.env[CURSOR_WORKTREES_ROOT_ENV] = previous;
    }
  });

  // These fixtures use real `git` rather than a hand-made `.git` entry on
  // purpose. Cursor resolves the repository with `git rev-parse --show-toplevel`,
  // so a fabricated `.git` proves nothing about what Cursor would accept - it
  // only asserts the equivalence that turned out to be wrong.
  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error}`);
  }

  test("the repository slug comes from the repository root, slugified as Cursor does", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-headless-repo-"));
    try {
      const repository = path.join(parent, "My Repo!");
      const nested = path.join(repository, "packages", "api");
      mkdirSync(nested, { recursive: true });
      git(repository, "init", "-q");

      // Not `basename(cwd)`: Cursor slugs the repository root it resolves with
      // `git rev-parse --show-toplevel`, whatever subdirectory the run starts in.
      expect(cursorRepoSlug(nested)).toBe("my-repo");
      expect(cursorRepoSlug(repository)).toBe("my-repo");
      // The filesystem root, rather than the temp directory, stands in for "no
      // repository": on a machine whose home directory is itself a Git repo
      // (dotfiles), everything under it - including temp - has an ancestor `.git`.
      expect(cursorRepoSlug(path.parse(parent).root)).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a linked worktree's .git file still identifies the repository root", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-headless-linked-"));
    try {
      const repository = path.join(parent, "repo");
      mkdirSync(repository, { recursive: true });
      git(repository, "init", "-q");
      git(repository, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
      // Git writes a `.git` *file* in a linked worktree; a check that only
      // accepts a directory would walk past the root and misreport.
      git(repository, "worktree", "add", "-q", path.join(parent, "checkout"), "-b", "side");
      expect(cursorRepoSlug(path.join(parent, "checkout"))).toBe("checkout");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a malformed .git entry is not mistaken for a repository", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-headless-malformed-"));
    try {
      const notARepository = path.join(parent, "not-a-repo");
      const nested = path.join(notARepository, "src");
      mkdirSync(nested, { recursive: true });
      // `git rev-parse` calls this "invalid gitfile format" and refuses; an
      // ancestor walk that accepts any entry named `.git` would derive
      // `<worktrees-root>/not-a-repo/<name>`, where no worktree can ever exist.
      writeFileSync(path.join(notARepository, ".git"), "");

      expect(cursorRepoSlug(notARepository)).toBeUndefined();
      expect(cursorRepoSlug(nested)).toBeUndefined();

      const isolated = await adapter.prepare(
        request("cursor", { model: "cursor-grok-4.5-medium", access: "edit-isolated", cwd: nested }),
        { generateWorktreeName: () => "agent-headless-fixed-9" },
      );
      expect(cursorWorktreePath(isolated)).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a worktree path is derived only where one actually exists", async () => {
    const isolated = await adapter.prepare(
      request("cursor", { model: "cursor-grok-4.5-medium", access: "edit-isolated" }),
      { generateWorktreeName: () => "agent-headless-fixed-8" },
    );
    expect(cursorWorktreePath(isolated)).toBe(
      path.join(cursorWorktreesRoot()!, cursorRepoSlug(process.cwd())!, "agent-headless-fixed-8"),
    );

    // Every one of these would otherwise name a directory that never exists.
    expect(cursorWorktreePath({ ...isolated, access: "inspect" })).toBeUndefined();
    expect(cursorWorktreePath({ ...isolated, provider: "claude" })).toBeUndefined();
    expect(cursorWorktreePath({ ...isolated, cwd: path.parse(tmpdir()).root })).toBeUndefined();
    expect(cursorWorktreePath({
      ...isolated,
      providerOptions: { cursor: { worktreeName: "feature/thing" } },
    })).toBeUndefined();
  });

  test("rejects ephemeral sessions and schemas", () => {
    expect(() => adapter.build(request("cursor", { model: "cursor-grok-4.5-medium", session: { mode: "ephemeral" } }))).toThrow(AgentHeadlessError);
    expect(() => adapter.build(request("cursor", { model: "cursor-grok-4.5-medium", schema: {} }))).toThrow(AgentHeadlessError);
  });

  test("the memo key separates a deleted variable from an untouched one", () => {
    // `JSON.stringify` drops undefined-valued properties, so these two would
    // collapse to one key - even though runInvocation deletes an inherited
    // credential for the first and preserves it for the second.
    expect(modelListingKey("agent", { CURSOR_API_KEY: undefined }))
      .not.toBe(modelListingKey("agent", {}));
    // A literal "undefined" string must not impersonate a deleted variable.
    expect(modelListingKey("agent", { CURSOR_API_KEY: undefined }))
      .not.toBe(modelListingKey("agent", { CURSOR_API_KEY: "undefined" }));
    // No overrides at all is its own case, distinct from an empty override map.
    expect(modelListingKey("agent", undefined)).not.toBe(modelListingKey("agent", {}));
    // Equivalent environments written in different orders share one key.
    expect(modelListingKey("agent", { A: "1", B: "2" }))
      .toBe(modelListingKey("agent", { B: "2", A: "1" }));
    // The executable still participates.
    expect(modelListingKey("agent", {})).not.toBe(modelListingKey("/opt/agent", {}));
  });

  test("parses Cursor JSONL", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "cursor-grok-4.5-medium" }),
      JSON.stringify({ type: "assistant", subtype: "message", content: "OK" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "c1", usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 2 } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "c1",
      modelObserved: "cursor-grok-4.5-medium",
      usage: { inputTokens: 6, cachedInputTokens: 2, outputTokens: 1 },
    });
  });
});

describe("Cursor worktree derivation probes git under the request's environment", () => {
  // The guarantee that an absent `workspace.worktree` proves no worktree exists
  // rests on the probe seeing git exactly as the Cursor invocation would. These
  // fixtures put a fake `git` on a PATH that only `request.env` supplies, so a
  // probe run under the parent environment cannot possibly produce their answer.
  const isWindows = process.platform === "win32";
  const root = mkdtempSync(path.join(tmpdir(), "agent-headless-gitenv-"));
  const counter = path.join(root, "calls.log");

  /** A `git` on PATH that always reports `toplevel`, and records each call. */
  function shimDir(name: string, toplevel: string): string {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, isWindows ? "git.cmd" : "git");
    writeFileSync(
      executable,
      isWindows
        ? `@echo off\r\necho call>>"${counter}"\r\necho ${toplevel}\r\n`
        : `#!/bin/sh\necho call >> "${counter}"\necho '${toplevel}'\n`,
    );
    if (!isWindows) chmodSync(executable, 0o755);
    return directory;
  }

  function calls(): number {
    if (!existsSync(counter)) return 0;
    return readFileSync(counter, "utf8").split(/\r?\n/u).filter((line) => line.trim()).length;
  }

  // A cwd with a `.git` entry real git rejects: it clears the cheap ancestor
  // pre-check so the probe actually runs, while guaranteeing the *parent*
  // environment's git answers "not a repository". Any repository slug that comes
  // back therefore came from the shim.
  const workdir = path.join(root, "workdir");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(path.join(workdir, ".git"), "");

  const shimA = shimDir("bin-a", path.join(root, "Shim Repo"));
  const shimB = shimDir("bin-b", path.join(root, "Other Repo"));

  function isolated(env?: Record<string, string | undefined>): RunRequest {
    return request("cursor", {
      model: "cursor-grok-4.5-medium",
      access: "edit-isolated",
      cwd: workdir,
      providerOptions: { cursor: { worktreeName: "agent-headless-fixed-env" } },
      ...(env ? { env } : {}),
    });
  }

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the probe honours request.env, not the parent environment", () => {
    // Catches the original implementation, which spawned `git` with the parent
    // process environment: there the fabricated `.git` makes real git refuse and
    // derivation returns undefined, whatever request.env says.
    expect(cursorWorktreePath(isolated({ PATH: shimA }))).toBe(
      path.join(cursorWorktreesRoot()!, "shim-repo", "agent-headless-fixed-env"),
    );
    expect(calls()).toBeGreaterThan(0);
  });

  test("the same request without that env derives via the parent's git", () => {
    // The overlay is applied to the inherited environment, never substituted for
    // it: with no overrides the probe is the parent's git, which refuses this
    // malformed `.git`. An implementation that passed only the overrides as the
    // child environment would lose PATH entirely - failing here for the wrong
    // reason, and failing the shim cases on Windows, where the `.cmd` wrapper
    // needs ComSpec and PATHEXT from the inherited environment.
    expect(cursorWorktreePath(isolated())).toBeUndefined();
    // ...while the inherited environment is genuinely still in play: this repo
    // resolves only because the parent's PATH reaches git.
    // ...while the inherited environment is genuinely still in play: this repo
    // resolves only because the parent's PATH reaches git. A subdirectory no
    // other test has probed, so the memo cannot answer for it.
    expect(cursorRepoSlug(path.join(process.cwd(), "src"))).toBeDefined();
  });

  test("two environments against one cwd do not share a repository-slug entry", () => {
    // Catches a memo keyed on cwd alone: this lookup would be served the first
    // test's answer, reinstating exactly the parity break env threading fixes.
    expect(cursorWorktreePath(isolated({ PATH: shimB }))).toBe(
      path.join(cursorWorktreesRoot()!, "other-repo", "agent-headless-fixed-env"),
    );
    // And both stay distinct from the no-overlay answer.
    expect(cursorWorktreePath(isolated())).toBeUndefined();
    expect(cursorRepoSlug(workdir, { PATH: shimA })).toBe("shim-repo");
  });

  test("identical environments in different key orders share one cached entry", () => {
    // The key comes from the same encoder as `modelListingKey`, so order
    // independence and present-but-undefined-vs-absent hold here too; this
    // asserts the memo actually consults it.
    const first = calls();
    expect(cursorRepoSlug(workdir, { CURSOR_TEAM: "t", PATH: shimA })).toBe("shim-repo");
    expect(calls()).toBe(first + 1);
    expect(cursorRepoSlug(workdir, { PATH: shimA, CURSOR_TEAM: "t" })).toBe("shim-repo");
    expect(calls()).toBe(first + 1);
    // A deleted variable is its own environment, not the untouched one.
    expect(cursorRepoSlug(workdir, { CURSOR_TEAM: undefined, PATH: shimA })).toBe("shim-repo");
    expect(calls()).toBe(first + 2);
  });
});

describe("tolerant JSONL parsing", () => {
  test("skips a non-JSON banner line and keeps every real event", () => {
    const parsed = parseJsonLines("cursor", [
      "Cursor Agent v1.2.3 - starting worktree run",
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1" }),
      JSON.stringify({ type: "result", subtype: "success", result: "OK" }),
    ].join("\n"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.events.map((event) => event.kind)).toEqual(["session", "result"]);
    expect(parsed.warnings).toEqual(["skipped unparseable JSONL at line 1"]);
  });

  test("keeps events preceding a truncated trailing line", () => {
    const parsed = parseJsonLines("codex", [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
      '{"type":"item.completed","item":{"type":"agent_mes',
    ].join("\n"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.events).toHaveLength(2);
    expect(parsed.warnings).toEqual(["skipped unparseable JSONL at line 3"]);
  });

  test("reports a stream-level error only when nothing at all parsed", () => {
    const parsed = parseJsonLines("codex", "banner\nalso not json");
    expect(parsed.events).toHaveLength(0);
    expect(parsed.error).toContain("invalid JSONL");
    expect(parsed.error).toContain("no parseable lines");
  });

  test("bounds warnings for a pathological stream and summarizes the rest", () => {
    const parsed = parseJsonLines("cursor", [
      ...Array.from({ length: 400 }, (_, index) => `garbage line ${index}`),
      JSON.stringify({ type: "result", subtype: "success", result: "OK" }),
    ].join("\n"));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.warnings).toHaveLength(MAX_JSONL_WARNINGS + 1);
    expect(parsed.warnings.at(-1)).toContain("skipped 400 unparseable JSONL lines in total");
  });

  test("adapters surface skipped-line warnings without a protocol error", () => {
    const stdout = [
      "not-json banner",
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "cursor-grok-4.5-medium" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "c1" }),
    ].join("\n");
    const parsed = new CursorAdapter().parse(stdout, true);
    expect(parsed.protocolError).toBeUndefined();
    expect(parsed.finalText).toBe("OK");
    expect(parsed.warnings).toEqual(["skipped unparseable JSONL at line 1"]);
  });

  test("marks unreadable output distinctly from provider-reported failure", () => {
    expect(new CodexAdapter().parse("not-json", true).unreadable).toBe(true);
    const reported = new CursorAdapter().parse(
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "boom" }),
      true,
    );
    expect(reported.protocolError).toBe("boom");
    expect(reported.unreadable).toBeUndefined();
  });
});

describe("explicit provider failure versus ambiguous output", () => {
  test("a Codex turn.failed is a reported failure, not unreadable output", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.failed", error: { message: "model refused the request" } }),
    ].join("\n");
    const parsed = new CodexAdapter().parse(stdout, true);
    expect(parsed.unreadable).toBeUndefined();
    expect(parsed.protocolError).toBe("Codex reported turn.failed: model refused the request");
  });

  test("a top-level error event is a reported failure for every provider", () => {
    const codex = new CodexAdapter().parse(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "error", message: "sandbox denied" }),
      ].join("\n"),
      true,
    );
    expect(codex.unreadable).toBeUndefined();
    expect(codex.protocolError).toBe("Codex reported error: sandbox denied");

    const claude = new ClaudeAdapter().parse(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
        JSON.stringify({ type: "error", message: "credit balance too low" }),
      ].join("\n"),
      true,
    );
    expect(claude.unreadable).toBeUndefined();
    expect(claude.protocolError).toBe("Claude reported error: credit balance too low");

    const cursor = new CursorAdapter().parse(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "c1" }),
        JSON.stringify({ type: "error", error: "worktree base is missing" }),
      ].join("\n"),
      true,
    );
    expect(cursor.unreadable).toBeUndefined();
    expect(cursor.protocolError).toBe("Cursor reported error: worktree base is missing");
  });

  test("a readable stream with no terminal marker at all stays ambiguous", () => {
    for (const parsed of [
      new CodexAdapter().parse([
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
      ].join("\n"), true),
      new ClaudeAdapter().parse([
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: "hi" } }),
      ].join("\n"), true),
      new CursorAdapter().parse([
        JSON.stringify({ type: "system", subtype: "init", session_id: "c1" }),
        JSON.stringify({ type: "assistant", subtype: "message", content: "hi" }),
      ].join("\n"), true),
    ]) {
      expect(parsed.unreadable).toBe(true);
    }
  });

  // Both directions, for every adapter. Only one direction would be satisfied by
  // a wrong rule: "any success anywhere wins" (the shipped result-first ordering)
  // passes failure-then-success, and "any failure anywhere wins" passes
  // success-then-failure. Pinning both is what forces last-marker-wins.
  test("an error after a successful result makes the run a failure, for every provider", () => {
    const codex = new CodexAdapter().parse([
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 1 } }),
      JSON.stringify({ type: "error", message: "stream aborted after the turn" }),
    ].join("\n"), true);
    expect(codex.protocolError).toBe("Codex reported error: stream aborted after the turn");
    expect(codex.unreadable).toBeUndefined();
    expect(codex.finalText).toBeUndefined();

    const claude = new ClaudeAdapter().parse([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" }),
      JSON.stringify({ type: "error", message: "stream aborted after the result" }),
    ].join("\n"), true);
    expect(claude.protocolError).toBe("Claude reported error: stream aborted after the result");
    expect(claude.unreadable).toBeUndefined();
    expect(claude.finalText).toBeUndefined();

    const cursor = new CursorAdapter().parse([
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "c1" }),
      JSON.stringify({ type: "error", error: "stream aborted after the result" }),
    ].join("\n"), true);
    expect(cursor.protocolError).toBe("Cursor reported error: stream aborted after the result");
    expect(cursor.unreadable).toBeUndefined();
    expect(cursor.finalText).toBeUndefined();
  });

  test("a successful result after an earlier error still wins, for every provider", () => {
    const codex = new CodexAdapter().parse([
      JSON.stringify({ type: "error", message: "first attempt died" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "retried ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 1 } }),
    ].join("\n"), true);
    expect(codex.protocolError).toBeUndefined();
    expect(codex.finalText).toBe("retried ok");

    const claude = new ClaudeAdapter().parse([
      JSON.stringify({ type: "error", message: "first attempt died" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "retried ok", session_id: "s1" }),
    ].join("\n"), true);
    expect(claude.protocolError).toBeUndefined();
    expect(claude.finalText).toBe("retried ok");

    const cursor = new CursorAdapter().parse([
      JSON.stringify({ type: "error", error: "first attempt died" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "retried ok", session_id: "c1" }),
    ].join("\n"), true);
    expect(cursor.protocolError).toBeUndefined();
    expect(cursor.finalText).toBe("retried ok");
  });

  test("a turn.completed after an earlier failure still wins", () => {
    const stdout = [
      JSON.stringify({ type: "turn.failed", error: { message: "first attempt died" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 1 } }),
    ].join("\n");
    const parsed = new CodexAdapter().parse(stdout, true);
    expect(parsed.protocolError).toBeUndefined();
    expect(parsed.finalText).toBe("OK");
  });

  test("Cursor's non-success terminal result is already a failure, not unreadable", () => {
    const parsed = new CursorAdapter().parse(
      JSON.stringify({ type: "result", subtype: "error_max_turns", result: "hit the turn limit" }),
      true,
    );
    expect(parsed.unreadable).toBeUndefined();
    expect(parsed.protocolError).toBe("hit the turn limit");
  });
});

describe("protocol validation", () => {
  test("rejects malformed and incomplete JSONL", () => {
    expect(new CodexAdapter().parse("not-json", true).protocolError).toContain("invalid JSONL");
    expect(new CursorAdapter().parse(JSON.stringify({ type: "system" }), true).protocolError).toContain("terminal result");
  });
});

describe("supported model lists", () => {
  test("each provider exposes its curated allowlist", async () => {
    expect(await new ClaudeAdapter().listModels()).toEqual([...SUPPORTED_MODELS.claude]);
    expect(await new CodexAdapter().listModels()).toEqual([...SUPPORTED_MODELS.codex]);
    expect(await new CursorAdapter().listModels()).toEqual([...SUPPORTED_MODELS.cursor]);
    expect(SUPPORTED_MODELS.cursor).toContain("cursor-grok-4.5-medium");
    expect(SUPPORTED_MODELS.cursor).toContain("cursor-grok-4.6-medium");
    expect(SUPPORTED_MODELS.cursor.includes("cursor-grok-4.5-medium-fast" as never)).toBe(false);
  });

  test("Claude Fable defaults to low effort unless the caller sets one", async () => {
    const adapter = new ClaudeAdapter();
    const prepared = await adapter.prepare(request("claude", { model: "claude-fable-5" }));
    expect(prepared.effort).toBe("low");
    expectFlag(adapter.build(prepared).args, "--effort", "low");

    const explicit = await adapter.prepare(request("claude", { model: "claude-fable-5", effort: "high" }));
    expect(explicit.effort).toBe("high");
  });

  test("off-list and Grok-fast Cursor models fail closed", async () => {
    await expect(new CursorAdapter().prepare(request("cursor", { model: "claude-opus-5-thinking-high" })))
      .rejects.toThrow(/supported list/u);
    await expect(new CursorAdapter().prepare(request("cursor", { model: "cursor-grok-4.5-high-fast" })))
      .rejects.toThrow(/fast variants are not allowed/u);
    await expect(new CodexAdapter().prepare(request("codex", { model: "gpt-5.5" })))
      .rejects.toThrow(/supported list/u);
  });
});

describe("memo keys under Windows case-insensitive resolution", () => {
  // effectiveEnv resolves case-insensitive duplicates by insertion order, so
  // two overlays that resolve differently must never share a cache key, and
  // two that resolve identically should. A key built by sorting the RAW
  // entries collides on exactly the first case.
  const winOnly = process.platform === "win32" ? test : test.skip;

  winOnly("case-variant overlays that resolve differently get different keys", () => {
    const a = modelListingKey("git", { PATH: "A", Path: "B" }); // resolves Path=B
    const b = modelListingKey("git", { Path: "B", PATH: "A" }); // resolves PATH=A
    expect(a).not.toBe(b);
  });

  winOnly("overlays with identical resolution share one key", () => {
    const a = modelListingKey("git", { PATH: "A", Path: "B" }); // resolves Path=B
    const b = modelListingKey("git", { Path: "B" });            // resolves Path=B
    expect(a).toBe(b);
  });

  winOnly("a case-variant deletion that resolves differently is distinct", () => {
    const a = modelListingKey("git", { PATH: "A", Path: undefined }); // deletes
    const b = modelListingKey("git", { Path: undefined, PATH: "A" }); // sets A
    expect(a).not.toBe(b);
  });

  test("case-sensitive platforms keep distinct names distinct", () => {
    if (process.platform === "win32") return;
    const a = modelListingKey("git", { PATH: "A", Path: "B" });
    const b = modelListingKey("git", { Path: "B", PATH: "A" });
    expect(a).toBe(b); // same set of (name,value) pairs; order alone must not split the cache
  });
});

describe("environment reads mirror Windows case-insensitivity", () => {
  const winOnly = process.platform === "win32" ? test : test.skip;

  winOnly("an arbitrarily cased ComSpec override is honoured for .cmd wrapping", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ah-comspec-"));
    try {
      writeFileSync(path.join(dir, "tool.cmd"), "@echo ok\r\n");
      const wrapped = resolveCommand("tool", [], effectiveEnv({ pAtH: dir, CoMsPeC: "custom-shell.exe" }));
      expect(wrapped.command).toBe("custom-shell.exe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  winOnly("an arbitrarily cased PATH override still resolves a .cmd on disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ah-path-"));
    try {
      writeFileSync(path.join(dir, "zzfind.cmd"), "@echo ok\r\n");
      const wrapped = resolveCommand("zzfind", [], effectiveEnv({ pAtH: dir }));
      expect(wrapped.args.join(" ").toLowerCase()).toContain("zzfind.cmd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  winOnly("an arbitrarily cased provider-bin override selects the executable", () => {
    expect(envExecutable("claude", { claude_bin: "X:/somewhere/claude-custom.exe" }))
      .toBe("X:/somewhere/claude-custom.exe");
  });

  winOnly("Antigravity finds the standard per-user installation when PATH does not", () => {
    const localAppData = mkdtempSync(path.join(tmpdir(), "ah-agy-local-"));
    const installed = path.join(localAppData, "agy", "bin", "agy.exe");
    try {
      mkdirSync(path.dirname(installed), { recursive: true });
      writeFileSync(installed, "stub");
      expect(envExecutable("antigravity", { LOCALAPPDATA: localAppData, PATH: "" })).toBe(installed);
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  winOnly("Antigravity prefers AGY_BIN and PATH over the standard installation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ah-agy-priority-"));
    const localAppData = path.join(root, "local");
    const pathDir = path.join(root, "path");
    const installed = path.join(localAppData, "agy", "bin", "agy.exe");
    const onPath = path.join(pathDir, "agy.exe");
    try {
      mkdirSync(path.dirname(installed), { recursive: true });
      mkdirSync(pathDir, { recursive: true });
      writeFileSync(installed, "installed");
      writeFileSync(onPath, "path");
      const env = { LOCALAPPDATA: localAppData, PATH: pathDir, PATHEXT: ".EXE" };
      expect(envExecutable("antigravity", env).toLowerCase()).toBe(onPath.toLowerCase());
      expect(envExecutable("antigravity", { ...env, AGY_BIN: "X:/custom/agy.exe" }))
        .toBe("X:/custom/agy.exe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("case-sensitive platforms keep case-sensitive reads", () => {
    if (process.platform === "win32") return;
    expect(envValue({ path: "/x" }, "PATH")).toBeUndefined();
  });
});

describe("case-variant duplicates resolve last-wins, matching effectiveEnv", () => {
  const winOnly = process.platform === "win32" ? test : test.skip;

  winOnly("a later case-variant provider-bin entry wins", () => {
    expect(envExecutable("claude", { CLAUDE_BIN: "A", claude_bin: "B" })).toBe("B");
    expect(envExecutable("claude", { claude_bin: "B", CLAUDE_BIN: "A" })).toBe("A");
  });

  winOnly("envValue itself is last-wins for duplicates", () => {
    expect(envValue({ PATH: "A", pAtH: "B" }, "PATH")).toBe("B");
  });

  winOnly("a later case-variant worktrees-root entry wins", () => {
    expect(cursorWorktreesRoot({ CURSOR_WORKTREES_ROOT: "X:\one", cursor_worktrees_root: "X:\two" }))
      .toBe("X:\two");
  });

  winOnly("a deleted-last duplicate reads as deleted, falling to the default", () => {
    const root = cursorWorktreesRoot({ CURSOR_WORKTREES_ROOT: "X:\gone", cursor_worktrees_root: undefined });
    expect(root).not.toBe("X:\gone");
  });
});
