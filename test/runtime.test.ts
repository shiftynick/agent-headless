import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CURSOR_DEFAULT_MODEL, getCapabilities, runAgent } from "../src";
import { runInvocation } from "../src/process";
import type { RunAgentOptions, RunRequest, RunStatus } from "../src/types";

const fakeClaude = path.join(import.meta.dir, "fixtures", "fake-claude.cmd");

test("onEvent receives JSONL before the provider exits", async () => {
  if (process.platform !== "win32") return;
  let settled = false;
  let firstEvent!: () => void;
  const observed = new Promise<void>((resolve) => { firstEvent = resolve; });
  const execution = runAgent({
    provider: "claude",
    prompt: "hello",
    cwd: process.cwd(),
    env: { CLAUDE_BIN: fakeClaude, FAKE_DELAY_MS: "350" },
    onEvent: () => firstEvent(),
  }).then((result) => { settled = true; return result; });

  await observed;
  expect(settled).toBe(false);
  const result = await execution;
  expect(result.status).toBe("succeeded");
  expect(result.finalText).toBe("FAKE_OK");
});

test("an already-aborted signal never launches the provider", async () => {
  if (process.platform !== "win32") return;
  const directory = mkdtempSync(path.join(tmpdir(), "agent-headless-abort-"));
  const marker = path.join(directory, "started.txt");
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent({
      provider: "claude",
      prompt: "do not run",
      cwd: process.cwd(),
      signal: controller.signal,
      env: { CLAUDE_BIN: fakeClaude, FAKE_MARKER: marker },
    });
    expect(result.status).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capability probing launches a Windows cmd shim and reports resolved availability", async () => {
  if (process.platform !== "win32") return;
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = fakeClaude;
  try {
    const capabilities = await getCapabilities("claude");
    expect(capabilities.availability).toBe("available");
    expect(capabilities.executable).toEndWith("fake-claude.cmd");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

function stubbed(
  stdout: string,
  overrides: Partial<{ exitCode: number | null; timedOut: boolean; cancelled: boolean; stderr: string }> = {},
): RunAgentOptions {
  return {
    execute: async () => ({
      stdout,
      stderr: overrides.stderr ?? "",
      exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
      durationMs: 1,
      timedOut: overrides.timedOut ?? false,
      cancelled: overrides.cancelled ?? false,
    }),
  };
}

const isolatedCursor: RunRequest = {
  provider: "cursor",
  prompt: "do the work",
  cwd: process.cwd(),
  model: "gpt-5.3-codex-low",
  access: "edit-isolated",
  providerOptions: { cursor: { worktreeName: "task-018", worktreeBase: "main" } },
};

const cursorSuccess = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "gpt-5", cwd: "/repo/.worktrees/task-018" }),
  JSON.stringify({ type: "assistant", subtype: "message", content: "working" }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "c1" }),
].join("\n");

test("a banner line before the stream does not fail an otherwise successful run", async () => {
  const result = await runAgent(isolatedCursor, stubbed(`Cursor Agent 2026.08 starting\n${cursorSuccess}`));

  expect(result.status).toBe("succeeded");
  expect(result.finalText).toBe("done");
  expect(result.events.map((event) => event.kind)).toEqual(["session", "message", "result"]);
  expect(result.warnings).toEqual(["skipped unparseable JSONL at line 1"]);
});

test("a wholly unreadable stream from a clean exit reports unparsed, not failed", async () => {
  const result = await runAgent(isolatedCursor, stubbed("banner one\nbanner two"));

  expect(result.status).toBe("unparsed");
  expect(result.exitCode).toBe(0);
  expect(result.warnings.some((warning) => warning.includes("no parseable lines"))).toBe(true);
});

test("warnings stay bounded for a pathologically noisy stream", async () => {
  const noise = Array.from({ length: 300 }, (_, index) => `noise ${index}`).join("\n");
  const result = await runAgent(isolatedCursor, stubbed(`${noise}\n${cursorSuccess}`));

  expect(result.status).toBe("succeeded");
  expect(result.warnings.length).toBeLessThanOrEqual(7);
  expect(result.warnings.at(-1)).toContain("skipped 300 unparseable JSONL lines in total");
});

test("a truncated trailing line does not discard the events before it", async () => {
  const result = await runAgent(isolatedCursor, stubbed(`${cursorSuccess}\n{"type":"assist`));

  expect(result.status).toBe("succeeded");
  expect(result.finalText).toBe("done");
  expect(result.warnings).toEqual(["skipped unparseable JSONL at line 4"]);
});

test("every outcome reports where the work went", async () => {
  const succeeded = await runAgent(isolatedCursor, stubbed(cursorSuccess));
  expect(succeeded.workspace).toMatchObject({
    cwd: process.cwd(),
    access: "edit-isolated",
    worktree: "/repo/.worktrees/task-018",
    worktreeName: "task-018",
    worktreeBase: "main",
  });

  const failed = await runAgent(isolatedCursor, stubbed("", { exitCode: 3, stderr: "boom" }));
  expect(failed.status).toBe("failed");
  expect(failed.workspace).toMatchObject({ cwd: process.cwd(), access: "edit-isolated", worktreeName: "task-018" });

  const timedOut = await runAgent(isolatedCursor, stubbed("", { exitCode: null, timedOut: true }));
  expect(timedOut.status).toBe("timed-out");
  expect(timedOut.workspace).toMatchObject({ worktreeName: "task-018", worktreeBase: "main" });

  const cancelled = await runAgent(isolatedCursor, stubbed("", { exitCode: null, cancelled: true }));
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.workspace?.cwd).toBe(process.cwd());
});

test("an unreadable isolated stream still surfaces a worktree path printed in raw text", async () => {
  const result = await runAgent(
    isolatedCursor,
    stubbed('preparing worktree {"worktree_path":"/repo/.worktrees/task-018"} ...\nstill not jsonl'),
  );

  expect(result.status).toBe("unparsed");
  expect(result.workspace?.worktree).toBe("/repo/.worktrees/task-018");
});

test("an explicit provider failure on a clean exit is failed, not unparsed", async () => {
  const result = await runAgent(
    { provider: "codex", prompt: "x", cwd: process.cwd() },
    stubbed([
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }),
    ].join("\n")),
  );

  expect(result.status).toBe("failed");
  expect(result.exitCode).toBe(0);
  expect(result.warnings).toContain("Codex reported turn.failed: usage limit reached");
});

test("a clean exit with no terminal marker at all is still unparsed, not failed", async () => {
  const result = await runAgent(
    { provider: "codex", prompt: "x", cwd: process.cwd() },
    stubbed([
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
    ].join("\n")),
  );

  expect(result.status).toBe("unparsed");
  expect(result.exitCode).toBe(0);
});

test("a non-session event's differing cwd is not taken as the worktree", async () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "gpt-5", cwd: process.cwd() }),
    JSON.stringify({ type: "tool_call", subtype: "started", cwd: "/repo/packages/api" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "c1" }),
  ].join("\n");
  const result = await runAgent(isolatedCursor, stubbed(stream));

  expect(result.status).toBe("succeeded");
  // A tool event's cwd is never promoted to "the worktree"; with nothing
  // authoritative disclosed, the reported path is the derived one instead.
  expect(result.workspace.worktree).not.toBe("/repo/packages/api");
  expect(result.workspace.worktreeSource).toBe("derived");
  expect(result.workspace.worktreeName).toBe("task-018");
});

test("a genuinely failing provider is still reported as failed", async () => {
  const result = await runAgent(
    { provider: "codex", prompt: "x", cwd: process.cwd() },
    stubbed("", { exitCode: 1, stderr: "codex exploded" }),
  );

  expect(result.status).toBe("failed");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("codex exploded");
});

/** Asserts a flag is present and immediately followed by its value. */
function expectFlag(args: string[], flag: string, value: string): void {
  expect(args[args.indexOf(flag) + 1]).toBe(value);
}

/** Captures the invocation runAgent actually spawned, alongside a canned result. */
function capturing(
  stdout: string,
  overrides: Partial<{ exitCode: number | null; timedOut: boolean; stderr: string }> = {},
): RunAgentOptions & { args: () => string[] } {
  let args: string[] = [];
  return {
    args: () => args,
    execute: async (invocation) => {
      args = invocation.args;
      return {
        stdout,
        stderr: overrides.stderr ?? "",
        exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
        durationMs: 1,
        timedOut: overrides.timedOut ?? false,
        cancelled: false,
      };
    },
  };
}

const bareCursor: RunRequest = { provider: "cursor", prompt: "do the work", cwd: process.cwd() };

test("a Cursor run with no model uses the documented default and says that it did", async () => {
  const options = capturing(cursorSuccess);
  const result = await runAgent(bareCursor, options);

  expectFlag(options.args(), "--model", CURSOR_DEFAULT_MODEL);
  expect(result.status).toBe("succeeded");
  expect(result.modelDefaulted).toBe(true);
  expect(result.modelRequested).toBe(CURSOR_DEFAULT_MODEL);
});

test("an explicit Cursor model overrides the default and is reported as chosen", async () => {
  const options = capturing(cursorSuccess);
  const result = await runAgent({ ...bareCursor, model: "gpt-5.3-codex-low" }, options);

  expectFlag(options.args(), "--model", "gpt-5.3-codex-low");
  expect(options.args()).not.toContain(CURSOR_DEFAULT_MODEL);
  expect(result.modelRequested).toBe("gpt-5.3-codex-low");
  expect(result.modelDefaulted).toBeFalsy();
});

test("Claude and Codex get no injected model default", async () => {
  for (const provider of ["claude", "codex"] as const) {
    const options = capturing(
      provider === "claude"
        ? JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1" })
        : [
            JSON.stringify({ type: "thread.started", thread_id: "t1" }),
            JSON.stringify({ type: "turn.completed", usage: {} }),
          ].join("\n"),
    );
    const result = await runAgent({ provider, prompt: "x", cwd: process.cwd() }, options);

    expect(options.args()).not.toContain("--model");
    expect(result.modelRequested).toBeUndefined();
    expect(result.modelDefaulted).toBeFalsy();
  }
});

test("a rejected default model is answered with the live model list", async () => {
  const result = await runAgent(bareCursor, {
    ...stubbed("", { exitCode: 1, stderr: "error: unknown model 'cursor-grok-4.5-medium'" }),
    listModels: async () => ["gpt-5.3-codex-low", "cursor-grok-4.5-high-fast"],
  });

  expect(result.status).toBe("failed");
  expect(result.modelDefaulted).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("run `agent-headless models cursor`"))).toBe(true);
  expect(result.warnings.some((warning) => warning.includes("cursor-grok-4.5-high-fast"))).toBe(true);
});

test("the rejected-default model listing is resolved against the run's own environment", async () => {
  let seen: { provider: string; executable?: string; env?: Record<string, string | undefined> } | undefined;
  const env = { CURSOR_AGENT_BIN: "X:\\alt\\cursor-agent.exe", CURSOR_API_KEY: "other-account" };
  const result = await runAgent(
    { ...bareCursor, env },
    {
      ...stubbed("", { exitCode: 1, stderr: "error: unknown model 'cursor-grok-4.5-medium'" }),
      listModels: async (provider, options) => {
        seen = { provider, ...options };
        return ["alt-install-model"];
      },
    },
  );

  expect(seen).toEqual({ provider: "cursor", executable: "X:\\alt\\cursor-agent.exe", env });
  expect(result.warnings.some((warning) => warning.includes("alt-install-model"))).toBe(true);
});

test("a caller who explicitly names the default model is not reported as defaulted", async () => {
  const options = capturing(cursorSuccess);
  const result = await runAgent({ ...bareCursor, model: CURSOR_DEFAULT_MODEL }, options);

  expectFlag(options.args(), "--model", CURSOR_DEFAULT_MODEL);
  expect(result.status).toBe("succeeded");
  expect(result.modelRequested).toBe(CURSOR_DEFAULT_MODEL);
  // The flag reports who chose the model, not which string was chosen: an
  // implementation comparing against CURSOR_DEFAULT_MODEL would fail here.
  expect(result.modelDefaulted).toBeFalsy();
});

test("an explicitly chosen model that is rejected is not paid for with a model listing", async () => {
  let listed = 0;
  const result = await runAgent(
    { ...bareCursor, model: "gpt-9-imaginary" },
    {
      ...stubbed("", { exitCode: 1, stderr: "error: model not found: gpt-9-imaginary" }),
      listModels: async () => {
        listed += 1;
        return [];
      },
    },
  );

  expect(listed).toBe(0);
  expect(result.warnings.some((warning) => warning.includes("agent-headless models cursor"))).toBe(true);
});

test("an ordinary failure triggers no model listing at all", async () => {
  let listed = 0;
  await runAgent(bareCursor, {
    ...stubbed("", { exitCode: 1, stderr: "boom" }),
    listModels: async () => {
      listed += 1;
      return [];
    },
  });

  expect(listed).toBe(0);
});

test("an isolated Cursor run always names its worktree explicitly", async () => {
  const options = capturing(cursorSuccess);
  const result = await runAgent(
    { ...bareCursor, model: "gpt-5", access: "edit-isolated" },
    { ...options, generateWorktreeName: () => "agent-headless-fixed-1" },
  );

  const args = options.args();
  expect(args.slice(args.indexOf("--worktree"), args.indexOf("--worktree") + 2))
    .toEqual(["--worktree", "agent-headless-fixed-1"]);
  expect(result.workspace?.worktreeName).toBe("agent-headless-fixed-1");
});

test("an explicit worktree name is used and reported unchanged", async () => {
  const options = capturing(cursorSuccess);
  const result = await runAgent(
    { ...bareCursor, model: "gpt-5", access: "edit-isolated", providerOptions: { cursor: { worktreeName: "task-018" } } },
    { ...options, generateWorktreeName: () => "agent-headless-fixed-1" },
  );

  expectFlag(options.args(), "--worktree", "task-018");
  expect(options.args()).not.toContain("agent-headless-fixed-1");
  expect(result.workspace?.worktreeName).toBe("task-018");
});

test("the generated worktree name survives a timeout and a non-zero exit", async () => {
  const isolated: RunRequest = { ...bareCursor, model: "gpt-5", access: "edit-isolated" };
  const generateWorktreeName = (): string => "agent-headless-fixed-2";

  const timedOut = await runAgent(isolated, {
    ...stubbed("", { exitCode: null, timedOut: true }),
    generateWorktreeName,
  });
  expect(timedOut.status).toBe("timed-out");
  expect(timedOut.workspace?.worktreeName).toBe("agent-headless-fixed-2");

  const failed = await runAgent(isolated, { ...stubbed("", { exitCode: 4 }), generateWorktreeName });
  expect(failed.status).toBe("failed");
  expect(failed.workspace?.worktreeName).toBe("agent-headless-fixed-2");
});

test("concurrent isolated runs do not share a generated worktree name", async () => {
  const isolated: RunRequest = { ...bareCursor, model: "gpt-5", access: "edit-isolated" };
  const [first, second] = await Promise.all([
    runAgent(isolated, stubbed(cursorSuccess)),
    runAgent(isolated, stubbed(cursorSuccess)),
  ]);

  expect(first!.workspace?.worktreeName).toMatch(/^agent-headless-/u);
  expect(first!.workspace?.worktreeName).not.toBe(second!.workspace?.worktreeName);
});

/**
 * Where Cursor documents it puts a named worktree
 * (`cursor-agent --help`: "an isolated git worktree at
 * ~/.cursor/worktrees/<reponame>/<name>"), recomputed here from node builtins
 * only. Deliberately not imported from the runner: an expectation that calls
 * the code under test would agree with any implementation, including a wrong one.
 */
function cursorWorktreeLocation(cwd: string, name: string, root?: string): string {
  let repoRoot = path.resolve(cwd);
  while (!existsSync(path.join(repoRoot, ".git"))) {
    const parent = path.dirname(repoRoot);
    if (parent === repoRoot) throw new Error(`no git repository at or above ${cwd}`);
    repoRoot = parent;
  }
  const slug = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
  return path.join(root ?? path.join(homedir(), ".cursor", "worktrees"), slug, name);
}

/** A readable, successful Cursor stream that discloses no worktree path at all. */
const cursorSilentSuccess = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "c2", model: "gpt-5", cwd: process.cwd() }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "c2" }),
].join("\n");

test("every isolated outcome reports the worktree path, readable stream or not", async () => {
  const name = "agent-headless-fixed-3";
  const expected = cursorWorktreeLocation(process.cwd(), name);
  const isolated: RunRequest = { ...bareCursor, model: "gpt-5", access: "edit-isolated" };
  const outcomes: Array<[RunStatus, RunAgentOptions]> = [
    ["succeeded", stubbed(cursorSilentSuccess)],
    ["unparsed", stubbed("banner one\nbanner two")],
    ["failed", stubbed("banner one\nbanner two", { exitCode: 3, stderr: "boom" })],
    ["timed-out", stubbed("", { exitCode: null, timedOut: true })],
    ["cancelled", stubbed("", { exitCode: null, cancelled: true })],
  ];

  for (const [status, options] of outcomes) {
    const result = await runAgent(isolated, { ...options, generateWorktreeName: () => name });
    expect(result.status).toBe(status);
    expect(result.workspace.worktree).toBe(expected);
    expect(path.isAbsolute(result.workspace.worktree!)).toBe(true);
    expect(result.workspace.worktreeSource).toBe("derived");
  }
});

test("the reported root and name compose to exactly the reported path", async () => {
  const result = await runAgent(
    { ...bareCursor, model: "gpt-5", access: "edit-isolated" },
    { ...stubbed("banner one\nbanner two"), generateWorktreeName: () => "agent-headless-fixed-5" },
  );
  const { worktree, worktreeRoot, worktreeName } = result.workspace;

  expect(path.join(worktreeRoot!, worktreeName!)).toBe(worktree!);
  // Joined, not concatenated: no doubled or foreign separator survives that.
  expect(worktree).toBe(path.normalize(worktree!));
  expect(worktree).toContain(path.sep);
  expect(worktree).not.toContain(path.sep === "\\" ? "/" : "\\");
});

test("a worktree path the provider discloses beats the derived one", async () => {
  const result = await runAgent(isolatedCursor, stubbed(cursorSuccess));

  // The provider is authoritative about where it actually put the work.
  expect(result.workspace.worktree).toBe("/repo/.worktrees/task-018");
  expect(result.workspace.worktreeSource).toBe("reported");
  expect(result.workspace.worktree).not.toBe(cursorWorktreeLocation(process.cwd(), "task-018"));
  // No root is claimed for a path whose layout the runner did not choose.
  expect(result.workspace.worktreeRoot).toBeUndefined();
});

test("a disclosed path is reported only once it is absolute", async () => {
  const relative = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "c3", model: "gpt-5", cwd: process.cwd() }),
    JSON.stringify({ type: "assistant", subtype: "message", worktree_path: "relative-worktree" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "c3" }),
  ].join("\n");
  const resolved = await runAgent(isolatedCursor, stubbed(relative));

  // `WorkspaceInfo.worktree` promises an absolute path. A provider prints a
  // relative one against its own working directory, which is this run's cwd,
  // so that is what it resolves against - reporting "relative-worktree"
  // verbatim hands the caller a string that means nothing outside that cwd.
  expect(resolved.workspace.worktree).toBe(path.resolve(process.cwd(), "relative-worktree"));
  expect(path.isAbsolute(resolved.workspace.worktree!)).toBe(true);
  expect(resolved.workspace.worktreeSource).toBe("reported");

  // An already-absolute disclosure is still authoritative and untouched.
  const absolute = await runAgent(isolatedCursor, stubbed(cursorSuccess));
  expect(absolute.workspace.worktree).toBe("/repo/.worktrees/task-018");
  expect(path.isAbsolute(absolute.workspace.worktree!)).toBe(true);
});

test("an unusable disclosure falls back to the derived path rather than being reported", async () => {
  const result = await runAgent(
    { ...bareCursor, model: "gpt-5", access: "edit-isolated" },
    {
      ...stubbed('preparing worktree {"worktree_path":"   "} ...\nstill not jsonl'),
      generateWorktreeName: () => "agent-headless-fixed-10",
    },
  );

  // A blank disclosure names nothing; it must not win over - or suppress - the
  // path the runner can still compute from the pinned name and Cursor's layout.
  expect(result.workspace.worktree).toBe(cursorWorktreeLocation(process.cwd(), "agent-headless-fixed-10"));
  expect(result.workspace.worktreeSource).toBe("derived");
});

test("a caller-supplied worktree name and base are honored, and the base stays a Git ref", async () => {
  const options = capturing("banner one\nbanner two");
  const result = await runAgent(
    {
      ...bareCursor,
      model: "gpt-5",
      access: "edit-isolated",
      providerOptions: { cursor: { worktreeName: "task-018", worktreeBase: "release-2.1" } },
    },
    { ...options, generateWorktreeName: () => "agent-headless-fixed-6" },
  );

  expectFlag(options.args(), "--worktree", "task-018");
  expectFlag(options.args(), "--worktree-base", "release-2.1");
  expect(result.workspace.worktreeName).toBe("task-018");
  expect(result.workspace.worktreeBase).toBe("release-2.1");
  expect(result.workspace.worktree).toBe(cursorWorktreeLocation(process.cwd(), "task-018"));
  // `--worktree-base` names the branch to fork from; treating it as a directory
  // would both mislocate the work and hand Cursor a ref it cannot resolve.
  expect(result.workspace.worktree).not.toContain("release-2.1");
});

test("a relocated CURSOR_WORKTREES_ROOT moves the reported path with it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-headless-wt-root-"));
  try {
    const result = await runAgent(
      { ...bareCursor, model: "gpt-5", access: "edit-isolated", env: { CURSOR_WORKTREES_ROOT: root } },
      { ...stubbed("banner one\nbanner two"), generateWorktreeName: () => "agent-headless-fixed-7" },
    );

    expect(result.workspace.worktree).toBe(cursorWorktreeLocation(process.cwd(), "agent-headless-fixed-7", root));
    expect(result.workspace.worktree?.startsWith(root + path.sep)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no path is invented for a worktree name Cursor would refuse", async () => {
  const result = await runAgent(
    {
      ...bareCursor,
      model: "gpt-5",
      access: "edit-isolated",
      providerOptions: { cursor: { worktreeName: "feature/thing" } },
    },
    stubbed("banner one\nbanner two"),
  );

  // Cursor validates `--worktree` against [A-Za-z0-9._-]+ and aborts otherwise,
  // so no worktree exists to point at - reporting a joined path would be fiction.
  expect(result.workspace.worktreeName).toBe("feature/thing");
  expect(result.workspace.worktree).toBeUndefined();
  expect(result.workspace.worktreeRoot).toBeUndefined();
  expect(result.workspace.worktreeSource).toBeUndefined();
});

test("a non-isolated run reports no worktree of any kind", async () => {
  const result = await runAgent({ ...bareCursor, model: "gpt-5", access: "inspect" }, stubbed(cursorSilentSuccess));

  expect(result.workspace.access).toBe("inspect");
  expect(result.workspace.worktree).toBeUndefined();
  expect(result.workspace.worktreeRoot).toBeUndefined();
});

test("mid-run cancellation terminates a live provider process", async () => {
  const controller = new AbortController();
  const execution = runInvocation(
    {
      provider: "claude",
      command: process.execPath,
      args: ["-e", "process.stdout.write('started\\n'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      stdin: "",
      structured: false,
    },
    {
      timeoutMs: 10_000,
      signal: controller.signal,
      onStdoutLine: () => controller.abort(),
    },
  );
  const result = await execution;
  expect(result.cancelled).toBe(true);
  expect(result.timedOut).toBe(false);
  expect(result.durationMs).toBeLessThan(5_000);
});
