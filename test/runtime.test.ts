import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCapabilities, runAgent } from "../src";
import { runInvocation } from "../src/process";

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
