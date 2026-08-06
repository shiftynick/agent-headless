import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
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
    const invocation = adapter.build(request("codex", { effort: "medium", model: "gpt-5.6" }));
    expect(invocation.args).toContainAllValues([
      "exec", "-C", process.cwd(), "-s", "read-only", "--ephemeral", "--model", "gpt-5.6",
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

describe("CursorAdapter", () => {
  const adapter = new CursorAdapter();

  test("defaults to a persistent, read-only plan session", () => {
    const invocation = adapter.build(request("cursor", { model: "gpt-5.3-codex-low", access: "inspect" }));
    for (const value of ["--print", "--model", "gpt-5.3-codex-low", "--output-format", "stream-json", "--mode", "plan"]) {
      expect(invocation.args).toContain(value);
    }
    expect(invocation.args).not.toContain("--trust");
  });

  test("adds effort to a parameterized model without losing parameters", () => {
    const invocation = adapter.build(request("cursor", {
      model: "claude-opus[context=1m,fast=false]",
      effort: "high",
      access: "answer-only",
    }));
    expect(invocation.args).toContain("claude-opus[context=1m,fast=false,effort=high]");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).toContain("ask");
  });

  test("does not corrupt an exact model ID that already encodes effort", () => {
    const invocation = adapter.build(request("cursor", { model: "gpt-5.6-terra-low", effort: "low" }));
    expect(invocation.args).toContain("gpt-5.6-terra-low");
    expect(invocation.args).not.toContain("gpt-5.6-terra-low[effort=low]");
  });

  test("supports exact max-effort Cursor model IDs", () => {
    const invocation = adapter.build(request("cursor", { model: "claude-opus-5-max", effort: "max" }));
    expect(invocation.args).toContain("claude-opus-5-max");
  });

  test("workspace trust is explicit", () => {
    const invocation = adapter.build(request("cursor", {
      model: "gpt-5.3-codex-low",
      providerOptions: { cursor: { trustWorkspace: true } },
    }));
    expect(invocation.args).toContain("--trust");
  });

  test("requests Cursor sandbox only where the CLI supports it", () => {
    const invocation = adapter.build(request("cursor", {
      model: "gpt-5.3-codex-low",
      access: "edit-isolated",
    }));
    expect(invocation.args).toContain("--worktree");
    if (process.platform === "win32") expect(invocation.args).not.toContain("--sandbox");
    else expect(invocation.args).toContainAllValues(["--sandbox", "enabled"]);
  });

  test("falls back to the documented default model when none was named", async () => {
    const prepared = await adapter.prepare(request("cursor", { access: "answer-only" }));
    expect(prepared.model).toBe(CURSOR_DEFAULT_MODEL);
    expect(adapter.build(prepared).args).toContain(CURSOR_DEFAULT_MODEL);
    // Also holds for a direct build that never went through prepare.
    expectFlag(adapter.build(request("cursor", { access: "answer-only" })).args, "--model", CURSOR_DEFAULT_MODEL);
  });

  test("an explicitly named model always beats the default", async () => {
    const prepared = await adapter.prepare(request("cursor", { model: "gpt-5.3-codex-low" }));
    expect(prepared.model).toBe("gpt-5.3-codex-low");
    expect(adapter.build(prepared).args).not.toContain(CURSOR_DEFAULT_MODEL);
  });

  test("still refuses model=auto, which names no accountable model", () => {
    expect(() => adapter.build(request("cursor", { model: "auto" }))).toThrow(AgentHeadlessError);
  });

  test("never emits a bare --worktree, because Cursor would then name it itself", async () => {
    const prepared = await adapter.prepare(
      request("cursor", { model: "gpt-5", access: "edit-isolated" }),
      { generateWorktreeName: () => "agent-headless-fixed-1" },
    );
    expect(prepared.providerOptions?.cursor?.worktreeName).toBe("agent-headless-fixed-1");
    const args = adapter.build(prepared).args;
    expect(args.slice(args.indexOf("--worktree"), args.indexOf("--worktree") + 2))
      .toEqual(["--worktree", "agent-headless-fixed-1"]);

    const direct = adapter.build(request("cursor", { model: "gpt-5", access: "edit-isolated" })).args;
    const name = direct[direct.indexOf("--worktree") + 1];
    expect(name).toMatch(/^agent-headless-[a-z0-9]+-[a-f0-9]{12}$/u);
  });

  test("an explicit worktree name is passed through untouched", async () => {
    const prepared = await adapter.prepare(request("cursor", {
      model: "gpt-5",
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

  test("the repository slug comes from the repository root, slugified as Cursor does", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-headless-repo-"));
    try {
      const repository = path.join(parent, "My Repo!");
      const nested = path.join(repository, "packages", "api");
      mkdirSync(path.join(repository, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });

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
      const linked = path.join(parent, "checkout");
      mkdirSync(linked, { recursive: true });
      // Git writes a `.git` *file* in a linked worktree or submodule; a check
      // that only accepts a directory would walk past the root and misreport.
      writeFileSync(path.join(linked, ".git"), "gitdir: ../repo/.git/worktrees/checkout\n");
      expect(cursorRepoSlug(linked)).toBe("checkout");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a worktree path is derived only where one actually exists", async () => {
    const isolated = await adapter.prepare(
      request("cursor", { model: "gpt-5", access: "edit-isolated" }),
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
    expect(() => adapter.build(request("cursor", { model: "gpt-5", session: { mode: "ephemeral" } }))).toThrow(AgentHeadlessError);
    expect(() => adapter.build(request("cursor", { model: "gpt-5", schema: {} }))).toThrow(AgentHeadlessError);
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
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "gpt-5" }),
      JSON.stringify({ type: "assistant", subtype: "message", content: "OK" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "c1", usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 2 } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "c1",
      modelObserved: "gpt-5",
      usage: { inputTokens: 6, cachedInputTokens: 2, outputTokens: 1 },
    });
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
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "gpt-5" }),
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

describe("Cursor model listing memoization (real cache path)", () => {
  // Exercises the module-level memo through a real child process, so a wrong
  // cache key shows up as a missing or extra spawn rather than being hidden
  // behind an injected `listModels` seam.
  const directory = mkdtempSync(path.join(tmpdir(), "agent-headless-models-"));
  const counter = path.join(directory, "calls.log");
  const isWindows = process.platform === "win32";
  const executable = path.join(directory, isWindows ? "fake-cursor.cmd" : "fake-cursor.sh");
  writeFileSync(
    executable,
    isWindows
      ? `@echo off\r\necho call>>"${counter}"\r\necho model-a - a model\r\n`
      : `#!/bin/sh\necho call >> "${counter}"\necho "model-a - a model"\n`,
  );
  if (!isWindows) chmodSync(executable, 0o755);

  function calls(): number {
    if (!existsSync(counter)) return 0;
    return readFileSync(counter, "utf8").split(/\r?\n/u).filter((line) => line.trim()).length;
  }

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("a deleted variable and an untouched one do not share a cached listing", async () => {
    const adapter = new CursorAdapter();
    expect(await adapter.listModels({ executable, env: { CURSOR_API_KEY: undefined } })).toEqual(["model-a"]);
    expect(calls()).toBe(1);
    // Repeating the identical request must be served from the memo.
    await adapter.listModels({ executable, env: { CURSOR_API_KEY: undefined } });
    expect(calls()).toBe(1);
    // A different account context must not be: under the `JSON.stringify` key
    // both of these collapse to `{}` and this stays at 1.
    expect(await adapter.listModels({ executable, env: {} })).toEqual(["model-a"]);
    expect(calls()).toBe(2);
  }, 30_000);

  test("two identical environments written in different orders share one cached listing", async () => {
    const adapter = new CursorAdapter();
    const before = calls();
    await adapter.listModels({ executable, env: { CURSOR_API_KEY: "k", CURSOR_TEAM: "t" } });
    expect(calls()).toBe(before + 1);
    await adapter.listModels({ executable, env: { CURSOR_TEAM: "t", CURSOR_API_KEY: "k" } });
    expect(calls()).toBe(before + 1);
  }, 30_000);
});
