import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runAgent, VERSION } from "../dist/index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(args, env = {}) {
  const outsideRepository = mkdtempSync(path.join(tmpdir(), "agent-headless-cli-"));
  try {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd: outsideRepository,
      encoding: "utf8",
      env: { ...process.env, AGENT_HEADLESS_NO_UPDATE_CHECK: "1", ...env },
    });
  } finally {
    rmSync(outsideRepository, { recursive: true, force: true });
  }
}

test("the compiled CLI shows help with no provider configuration", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/u);
  assert.match(result.stdout, /agent-headless doctor/u);
});

test("the compiled CLI version matches package.json with no provider configuration", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), manifest.version);
});

test("check-updates is machine-readable, respects opt-out, and doctor preserves its JSON shape", () => {
  const disabled = runCli(["check-updates", "--force"]);
  assert.equal(disabled.status, 0);
  assert.deepEqual(JSON.parse(disabled.stdout), { currentVersion: VERSION, status: "disabled" });
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "agent-headless-update-cli-"));
  try {
    mkdirSync(path.join(cacheRoot, "agent-headless"));
    writeFileSync(path.join(cacheRoot, "agent-headless", "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0" }));
    const env = { XDG_CACHE_HOME: cacheRoot, AGENT_HEADLESS_NO_UPDATE_CHECK: "0", CLAUDE_BIN: path.join(cacheRoot, "missing-cli") };
    const check = runCli(["check-updates"], env);
    assert.equal(check.status, 0);
    assert.equal(JSON.parse(check.stdout).updateAvailable, true);
    assert.equal(check.stderr, "");
    const doctor = runCli(["doctor", "claude"], env);
    assert.equal(doctor.status, 0);
    assert.equal(JSON.parse(doctor.stdout).provider, "claude");
    assert.match(doctor.stderr, /agent-headless 99\.0\.0 is available/u);
    const version = runCli(["--version"], env);
    assert.equal(version.stdout.trim(), VERSION);
    assert.equal(version.stderr, "");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("CLI run preserves text, JSON, and provider failure exits when an update is available", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-headless-update-run-"));
  try {
    mkdirSync(path.join(root, "agent-headless"));
    writeFileSync(path.join(root, "agent-headless", "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0" }));
    const script = path.join(root, "provider.cjs");
    writeFileSync(script, `#!${process.execPath}\nconsole.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" })); process.exitCode = Number(process.env.FAKE_EXIT || 0);\n`, { mode: 0o755 });
    const executable = process.platform === "win32" ? path.join(root, "provider.cmd") : script;
    if (process.platform === "win32") writeFileSync(executable, `@"${process.execPath}" "${script}" %*\r\n`);
    const env = { XDG_CACHE_HOME: root, AGENT_HEADLESS_NO_UPDATE_CHECK: "0", CLAUDE_BIN: executable };
    const args = ["run", "--provider", "claude", "--prompt", "test"];
    const text = runCli(args, env);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout, "OK\n");
    assert.match(text.stderr, /99\.0\.0 is available/u);
    const json = runCli([...args, "--json"], env);
    assert.equal(json.status, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.finalText, "OK");
    assert.equal(result.update.updateAvailable, true);
    const failure = runCli([...args, "--json"], { ...env, FAKE_EXIT: "1" });
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stdout).status, "failed");
    assert.equal(JSON.parse(failure.stdout).update.updateAvailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
          JSON.stringify({ type: "system", subtype: "init", session_id: "c1", cwd: path.resolve("/repo/.worktrees/task-018") }),
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
  assert.equal(result.workspace.worktree, path.resolve("/repo/.worktrees/task-018"));
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
