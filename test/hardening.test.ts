import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, assertSucceeded, ClaudeAdapter, CodexAdapter, CursorAdapter, AntigravityAdapter } from "../src";
import { normalizeRequest } from "../src/validation";
import { checkForUpdates } from "../src/updates";
import { JsonLineParser } from "../src/jsonl";
import type { InvocationExecutor, Provider, RunRequest, RunStatus } from "../src/types";

const roots: string[] = [];
function temporary() { const dir = mkdtempSync(path.join(tmpdir(), "ah-hardening-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const req = (provider: Provider, rest: Partial<RunRequest> = {}) => normalizeRequest({ provider, prompt: "test", cwd: process.cwd(), ...rest });
const executed = (stdout: string, rest = {}): InvocationExecutor => async () => ({ stdout, stderr: "", exitCode: 0, durationMs: 1, timedOut: false, cancelled: false, ...rest });
const streams = {
  claude: { type: "system", subtype: "init", session_id: "recoverable", model: "observed-model" },
  codex: { type: "thread.started", thread_id: "recoverable" },
  cursor: { type: "system", subtype: "init", session_id: "recoverable", model: "observed-model" },
  antigravity: { event: "init", conversation_id: "recoverable", init: { model: "observed-model" } },
};

test("all incomplete outcomes retain provider session identity", async () => {
  for (const provider of Object.keys(streams) as Provider[]) {
    for (const outcome of [{ exitCode: 1 }, { timedOut: true }, { cancelled: true }, {}]) {
      const result = await runAgent(req(provider), { execute: executed(JSON.stringify(streams[provider]), outcome) });
      expect(result.sessionId).toBe("recoverable");
      if (provider !== "codex") expect(result.modelObserved).toBe("observed-model");
    }
  }
});

test("failed streams expose provider diagnostics to assertSucceeded", async () => {
  const result = await runAgent(req("claude"), { execute: executed(JSON.stringify({ type: "result", is_error: true, result: "Authentication expired" }), { exitCode: 1 }) });
  expect(result.warnings.join(" ")).toContain("Authentication expired");
  expect(() => assertSucceeded(result)).toThrow(/Authentication expired/u);
});

test("schema output is normalized even when the text result is empty", async () => {
  const value = { answer: 42, items: ["one"] };
  const result = await runAgent(req("claude", { schema: { type: "object" } }), {
    execute: executed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: value })),
  });
  expect(result.status).toBe("succeeded");
  expect(result.structuredOutput).toEqual(value);
});

test("fork semantics are explicit for every adapter", () => {
  const session = { mode: "resume" as const, id: "original", fork: true };
  expect(new ClaudeAdapter().build(req("claude", { session })).args).toContain("--fork-session");
  expect(new CodexAdapter().build(req("codex", { session })).args.slice(0, 3)).toEqual(["exec", "fork", "original"]);
  expect(() => new CursorAdapter().build(req("cursor", { session }))).toThrow(/fork/u);
  expect(() => new AntigravityAdapter().build(req("antigravity", { session }))).toThrow(/fork/u);
});

test("a failed fork never claims the source session is the new session", async () => {
  const result = await runAgent(req("codex", { session: { mode: "resume", id: "original", fork: true } }), { execute: executed("", { exitCode: 1 }) });
  expect(result.sessionId).toBeUndefined();
});

test("concurrent Claude worktrees are unique and recoverable on failure", async () => {
  const results = await Promise.all([0, 1].map(() => runAgent(req("claude", { access: "edit-isolated" }), { execute: executed("", { exitCode: 1 }) })));
  const names = results.map(result => result.workspace.worktreeName);
  expect(names.every(Boolean)).toBe(true);
  expect(new Set(names).size).toBe(2);
  const pinned = await runAgent(req("claude", { access: "edit-isolated" }), { execute: executed("", { exitCode: 1 }), generateWorktreeName: () => "pinned" });
  expect(pinned.workspace.worktreeName).toBe("pinned");
  const supplied = await runAgent(req("claude", { access: "edit-isolated", providerOptions: { claude: { worktreeName: "chosen" } } }), { execute: executed("", { exitCode: 1 }) });
  expect(supplied.workspace.worktreeName).toBe("chosen");
});

test("Codex attribution and isolated location come from the request environment, even on failure", async () => {
  const root = temporary();
  const session = path.join(root, "sessions", "2026", "09", "26");
  const worktree = path.join(root, "managed-worktree");
  mkdirSync(session, { recursive: true });
  writeFileSync(path.join(session, "rollout-date-recoverable.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { cwd: worktree } }),
    JSON.stringify({ type: "turn_context", payload: { model: "actual-model", cwd: worktree } }),
  ].join("\n"));
  for (const outcome of [{}, { exitCode: 1 }, { timedOut: true }]) {
    const result = await runAgent(req("codex", { access: "edit-isolated", env: { CODEX_HOME: root } }), {
      execute: executed(`${JSON.stringify(streams.codex)}\n${JSON.stringify({ type: "turn.completed" })}`, outcome),
    });
    expect(result.modelObserved).toBe("actual-model");
    expect(result.workspace.worktree).toBe(worktree);
    expect(result.workspace.worktreeSource).toBe("reported");
  }
  const ephemeral = await runAgent(req("codex", { env: { CODEX_HOME: root } }), {
    execute: executed(`${JSON.stringify(streams.codex)}\n${JSON.stringify({ type: "turn.completed" })}`),
  });
  expect(ephemeral.modelObserved).toBeUndefined();
});

test("limits are validated and truncation cannot be mistaken for success", async () => {
  for (const value of [0, -1, Infinity, 1.5]) expect(() => req("claude", { outputLimits: { stdoutBytes: value } })).toThrow(/limits/u);
  const result = await runAgent(req("claude", { outputLimits: { stdoutBytes: 80, stderrBytes: 20 } }), {
    execute: executed(JSON.stringify({ type: "result", result: "ok", is_error: false }) + "\n" + "x".repeat(1000), { stderr: "x".repeat(1000) }),
  });
  expect(result.status).toBe("failed");
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(20);
  expect(result.warnings.join(" ")).toContain("output limit");
});

test("incremental JSONL parsing bounds warnings and ignores non-object values", () => {
  const parser = new JsonLineParser("claude");
  for (let i = 0; i < 100; i++) parser.push("bad json");
  parser.push("null"); parser.push("[]"); parser.push("42");
  const event = parser.push(JSON.stringify(streams.claude));
  expect(parser.result().events).toEqual([event!]);
  expect(parser.result().warnings).toHaveLength(6);
  expect(parser.result().warnings.at(-1)).toContain("103 unparseable");
});

(process.platform === "win32" ? test : test.skip)("update opt-out observes Windows overlay casing and deletion", async () => {
  const root = temporary(); let calls = 0;
  const fetch = async () => { calls++; return { ok: true, json: async () => ({ version: "99.0.0" }) }; };
  const disabled = await checkForUpdates({ cacheDir: root, force: true, env: { AGENT_HEADLESS_NO_UPDATE_CHECK: "0", agent_headless_no_update_check: "1" }, fetch });
  expect(disabled.status).toBe("disabled"); expect(calls).toBe(0);
  const enabled = await checkForUpdates({ cacheDir: root, force: true, env: { AGENT_HEADLESS_NO_UPDATE_CHECK: "1", agent_headless_no_update_check: undefined }, fetch });
  expect(enabled.status).toBe("checked"); expect(calls).toBe(1);
});

test("versioned provider protocol fixtures preserve normalized contracts", async () => {
  const base = path.join(import.meta.dir, "fixtures", "protocols", "v1");
  const manifest = JSON.parse(readFileSync(path.join(base, "manifest.json"), "utf8")) as {
    cases: Array<{ provider: Provider; file: string; status: RunStatus; structuredOutput?: unknown }>;
  };
  for (const fixture of manifest.cases) {
    const result = await runAgent(req(fixture.provider), { execute: executed(readFileSync(path.join(base, fixture.file), "utf8")) });
    expect(result.status).toBe(fixture.status);
    expect(result.sessionId).toBe("fixture-session");
    if (fixture.structuredOutput) expect(result.structuredOutput).toEqual(fixture.structuredOutput);
    else if (fixture.status === "succeeded") expect(result.finalText).toBe("OK");
    if (fixture.status === "failed") expect(result.warnings.join(" ")).toContain("fixture provider failure");
  }
});
