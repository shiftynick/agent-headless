import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInvocation, runAgent, CodexAdapter, ClaudeAdapter } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const library = new URL("../dist/index.js", import.meta.url).href;
const invoke = (code, stdin = "") => ({ provider: "codex", command: process.execPath, args: ["-e", code], cwd: process.cwd(), stdin, structured: false });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function running(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return false;
    return true;
  } catch { return false; }
}
function provider(root, source) {
  const script = path.join(root, "provider.cjs");
  writeFileSync(script, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  if (process.platform !== "win32") return script;
  const cmd = path.join(root, "provider.cmd");
  writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
  return cmd;
}

test("an early provider exit with a large stdin does not crash the supervisor", () => {
  const source = `import {runInvocation} from ${JSON.stringify(library)};
    const r = await runInvocation(${JSON.stringify(invoke("process.exit(7)"))}, {timeoutMs:3000});
    console.log(JSON.stringify(r));`;
  // Construct the large prompt inside the subprocess, avoiding argv limits.
  const withPrompt = source.replace('"stdin":""', '"stdin":"x".repeat(20*1024*1024)');
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", withPrompt], { encoding: "utf8", timeout: 7000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).exitCode, 7);
  assert.doesNotMatch(result.stderr, /Unhandled 'error'/u);
});

for (const mode of ["cancel", "timeout"]) test(`${mode} cleans up a descendant after the leader exits and pipes close`, { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  let descendant;
  const leaf = `process.on('SIGTERM',()=>{});process.send('ready');process.disconnect();setInterval(()=>{},1000);`;
  const code = `const {spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','ignore','ignore','ipc']});leaf.on('message',()=>console.log(leaf.pid));setInterval(()=>{},1000);`;
  try {
    const result = await runInvocation(invoke(code), { timeoutMs: mode === "timeout" ? 2000 : 6000, signal: controller.signal, onStdoutLine: line => {
      descendant = Number(line); if (mode === "cancel") controller.abort();
    } });
    assert.equal(mode === "cancel" ? result.cancelled : result.timedOut, true);
    assert.ok(descendant, "descendant did not start before the deadline");
    for (let i = 0; i < 20 && running(descendant); i++) await delay(25);
    assert.equal(running(descendant), false, "descendant survived completed cancellation");
  } finally { if (descendant && running(descendant)) process.kill(descendant, "SIGKILL"); }
});

test("stdout and stderr floods are bounded and stop the process", { timeout: 10_000 }, async () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = await runInvocation(invoke(`setInterval(()=>process.${stream}.write('x'.repeat(65536)),1)`), {
      timeoutMs: 4000, outputLimits: { stdoutBytes: 4096, stderrBytes: 2048 },
    });
    assert.equal(result.outputLimitExceeded, stream);
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
    assert.ok(Buffer.byteLength(result.stderr) <= 2048);
    assert.equal(result.timedOut, false);
  }
});

test("output limits do not split multibyte characters or exceed the byte budget", async () => {
  const result = await runInvocation(invoke("process.stdout.write('😀'.repeat(20))"), { timeoutMs: 2000, outputLimits: { stdoutBytes: 5 } });
  assert.equal(result.outputLimitExceeded, "stdout");
  assert.equal(result.stdout, "😀");
  assert.ok(Buffer.byteLength(result.stdout) <= 5);
});

for (const signal of ["SIGINT", "SIGTERM"]) test(`CLI forwards ${signal} and waits for provider cleanup`, { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ah-cli-signal-"));
  let pid; let child;
  try {
    const marker = path.join(root, "pid");
    const executable = provider(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
    child = spawn(process.execPath, [cli, "run", "--provider", "claude", "--prompt", "test", "--json"], {
      env: { ...process.env, AGENT_HEADLESS_NO_UPDATE_CHECK: "1", CLAUDE_BIN: executable }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.resume();
    const closed = new Promise(resolve => child.once("close", resolve));
    for (let i = 0; i < 100; i++) { try { pid = Number(readFileSync(marker, "utf8")); break; } catch { await delay(20); } }
    assert.ok(pid, "provider did not start");
    child.kill(signal);
    assert.equal(await closed, signal === "SIGINT" ? 130 : 143);
    assert.equal(JSON.parse(stdout).status, "cancelled");
    assert.equal(running(pid), false);
  } finally {
    child?.kill("SIGKILL");
    if (pid && running(pid)) try { process.kill(-pid, "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI renders provider errors and schema payloads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ah-cli-results-"));
  try {
    const executable = provider(root, `const fail=process.env.FAIL==='1';console.log(JSON.stringify(fail?{type:'result',is_error:true,result:'Authentication expired'}:{type:'result',is_error:false,result:'',structured_output:{answer:42}}));process.exitCode=fail?1:0;`);
    const invokeCli = env => spawnSync(process.execPath, [cli, "run", "--provider", "claude", "--prompt", "test"], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, AGENT_HEADLESS_NO_UPDATE_CHECK: "1", CLAUDE_BIN: executable, ...env },
    });
    const failed = invokeCli({ FAIL: "1" }); assert.equal(failed.status, 1); assert.match(failed.stderr, /Authentication expired/u);
    const schema = invokeCli({}); assert.equal(schema.status, 0, schema.stderr); assert.deepEqual(JSON.parse(schema.stdout), { answer: 42 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native streaming delivers events once and preserves normalized metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ah-stream-"));
  try {
    const executable = provider(root, `process.stdin.resume();console.log(JSON.stringify({type:'system',subtype:'init',session_id:'s1',model:'actual'}));setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done',session_id:'s1'})),20);`);
    const observed = [];
    const result = await runAgent({ provider: "claude", cwd: root, prompt: "test", env: { CLAUDE_BIN: executable }, onEvent: event => observed.push(event) });
    assert.equal(result.status, "succeeded"); assert.equal(result.sessionId, "s1");
    assert.equal(result.modelObserved, "actual"); assert.equal(observed.length, 2);
    assert.deepEqual(result.events, observed);
    assert.equal(result.events[0], observed[0], "native events should not be reparsed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capabilities distinguish old and new installed CLI features", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ah-features-"));
  try {
    const executable = provider(root, `if(process.argv.includes('--version'))console.log('codex-cli fixture');else console.log(require('node:fs').readFileSync(${JSON.stringify(path.join(root, "help"))},'utf8'));`);
    writeFileSync(path.join(root, "help"), "--model --config --json --ephemeral --output-schema\n  resume Resume a session");
    const old = await new CodexAdapter().capabilities(executable);
    assert.equal(old.availability, "available"); assert.equal(old.supportsFork, false); assert.ok(!old.access.includes("edit-isolated"));
    writeFileSync(path.join(root, "help"), readFileSync(new URL("./fixtures/protocols/help/codex-0.157.1-exec.txt", import.meta.url), "utf8"));
    const current = await new CodexAdapter().capabilities(executable);
    assert.equal(current.supportsFork, true); assert.ok(current.access.includes("edit-isolated"));
    writeFileSync(path.join(root, "help"), readFileSync(new URL("./fixtures/protocols/help/claude-2.1.283.txt", import.meta.url), "utf8"));
    const claude = await new ClaudeAdapter().capabilities(executable);
    assert.equal(claude.supportsFork, true); assert.equal(claude.supportsSchema, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
