import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, VERSION } from "../dist/index.js";

test("the packaged library runs on Node and accepts a deterministic executor", async () => {
  let captured;
  const result = await runAgent(
    {
      provider: "codex",
      prompt: "Say OK",
      cwd: process.cwd(),
      model: "gpt-test",
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

  assert.equal(VERSION, "0.2.0");
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
});
