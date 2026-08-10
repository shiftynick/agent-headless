import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAgent, VERSION } from "../dist/index.js";

test("the packaged library runs on Node and accepts a deterministic executor", async () => {
  let captured;
  const result = await runAgent(
    {
      provider: "codex",
      prompt: "Say OK",
      cwd: process.cwd(),
      model: "gpt-5.6-sol",
    },
    {
      execute: async (invocation) => {
        captured = invocation;
        return {
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }),
          ].join("\n"),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          cancelled: false,
        };
      },
    },
  );

  // Compared against the manifest rather than a literal: a hardcoded version
  // goes stale at the next release and then fails for the wrong reason, which is
  // exactly what it did between 0.2.0 and 0.3.0.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, manifest.version);
  assert.equal(captured.stdin, "Say OK");
  assert.equal(result.status, "succeeded");
  assert.equal(result.finalText, "OK");
  assert.deepEqual(result.events.map((event) => event.kind), ["session", "message", "result"]);
});

test("timed-out structured runs retain partial events for diagnosis", async () => {
  const result = await runAgent(
    { provider: "codex", prompt: "wait", cwd: process.cwd() },
    {
      execute: async () => ({
        stdout: JSON.stringify({ type: "thread.started", thread_id: "partial" }),
        stderr: "deadline reached",
        exitCode: null,
        durationMs: 5,
        timedOut: true,
        cancelled: false,
      }),
    },
  );

  assert.equal(result.status, "timed-out");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "session");
  assert.equal(result.workspace.cwd, process.cwd());
});

test("the packaged library tolerates a banner line and always reports its workspace", async () => {
  const result = await runAgent(
    {
      provider: "cursor",
      prompt: "do the work",
      cwd: process.cwd(),
      model: "cursor-grok-4.5-high",
      access: "edit-isolated",
      providerOptions: { cursor: { worktreeName: "task-018" } },
    },
    {
      execute: async () => ({
        stdout: [
          "Cursor Agent 2026.08 starting",
          JSON.stringify({ type: "system", subtype: "init", session_id: "c1", cwd: "/repo/.worktrees/task-018" }),
          JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        durationMs: 3,
        timedOut: false,
        cancelled: false,
      }),
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.finalText, "done");
  assert.deepEqual(result.warnings, ["skipped unparseable JSONL at line 1"]);
  assert.equal(result.workspace.worktree, "/repo/.worktrees/task-018");
  assert.equal(result.workspace.worktreeName, "task-018");
});

// Guards the packaged distribution against the shape of failure a consumer
// actually meets: the reviewer's live probe of dist/ got `finalText: "ok"` and
// no error from a stream whose success result was followed by an `error` event.
test("the packaged library reports a post-result error as a failed run", async () => {
  const streams = {
    claude: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" }),
      JSON.stringify({ type: "error", message: "stream aborted after the result" }),
    ],
    cursor: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "c1" }),
      JSON.stringify({ type: "error", error: "stream aborted after the result" }),
    ],
  };
  for (const [provider, lines] of Object.entries(streams)) {
    const model = provider === "claude" ? "claude-opus-5" : "cursor-grok-4.5-medium";
    const result = await runAgent(
      { provider, prompt: "Say OK", cwd: process.cwd(), model },
      {
        execute: async () => ({
          stdout: lines.join("\n"),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          cancelled: false,
        }),
      },
    );
    assert.equal(result.status, "failed", `${provider} must not report succeeded`);
    assert.equal(result.finalText, undefined);
    assert.ok(
      result.warnings.some((warning) => warning.includes("stream aborted after the result")),
      `${provider} must carry the provider's own wording, got ${JSON.stringify(result.warnings)}`,
    );
  }
});
