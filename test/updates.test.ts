import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, VERSION } from "../src";
import { checkForUpdates, newerStableVersion, updateNotice } from "../src/updates";

const directories: string[] = [];
function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-headless-updates-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const enabled = { AGENT_HEADLESS_NO_UPDATE_CHECK: undefined };

test("compares numeric versions and advertises only newer stable releases", () => {
  for (const [latest, current, expected] of [
    ["0.10.0", "0.9.0", true], ["1.0.0", "0.99.0", true],
    ["0.7.1", "0.7.0", true], ["0.7.0", "0.7.0", false],
    ["0.7.0", "0.8.0", false], ["0.8.0-beta.1", "0.7.0", false],
    ["0.8.0", "0.8.0-beta.1", true], ["0.8.0", "0.8.0+build", false],
    ["garbage", "0.7.0", false], ["01.0.0", "0.7.0", false],
  ] as const) expect(newerStableVersion(latest, current)).toBe(expected);
});

test("checks once, caches across calls, and force refreshes", async () => {
  let calls = 0;
  const options = { cacheDir: directory(), env: enabled, fetch: async (url: string) => {
    expect(url).toBe("https://registry.npmjs.org/agent-headless/latest");
    calls++;
    return { ok: true, json: async () => ({ version: "99.0.0" }) };
  } };
  const info = await checkForUpdates(options);
  expect(info).toEqual({ currentVersion: VERSION, status: "checked", latestVersion: "99.0.0", updateAvailable: true });
  expect(updateNotice(info)).toContain("dependency and lockfile");
  expect(await checkForUpdates(options)).toEqual(info);
  expect(calls).toBe(1);
  await checkForUpdates({ ...options, force: true });
  expect(calls).toBe(2);
});

test("old, malformed, and future-dated caches are refreshed", async () => {
  const cacheDir = directory();
  for (const contents of ["broken", JSON.stringify({ checkedAt: 0, latestVersion: "99.0.0" }),
    JSON.stringify({ checkedAt: Date.now() + 100_000, latestVersion: "99.0.0" })]) {
    writeFileSync(path.join(cacheDir, "update-check.json"), contents);
    const info = await checkForUpdates({ cacheDir, env: enabled, fetch: async () => ({ ok: true, json: async () => ({ version: VERSION }) }) });
    expect(info.updateAvailable).toBe(false);
    expect(updateNotice(info)).toBeUndefined();
  }
});

test("opt-out wins over force and makes no request", async () => {
  const info = await checkForUpdates({ force: true, env: { AGENT_HEADLESS_NO_UPDATE_CHECK: "1" },
    fetch: async () => { throw new Error("must not fetch"); } });
  expect(info).toEqual({ currentVersion: VERSION, status: "disabled" });
});

test("network failures are unavailable, cached briefly, and not called up-to-date", async () => {
  let calls = 0;
  const options = { cacheDir: directory(), env: enabled, fetch: async () => { calls++; throw new Error("offline"); } };
  expect(await checkForUpdates(options)).toEqual({ currentVersion: VERSION, status: "unavailable" });
  await checkForUpdates(options);
  expect(calls).toBe(1);
  writeFileSync(path.join(options.cacheDir, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 61 * 60_000, latestVersion: null }));
  await checkForUpdates(options);
  expect(calls).toBe(2);
});

test("bad HTTP responses and registry bodies are harmless", async () => {
  for (const response of [
    { ok: false, json: async () => ({ version: "99.0.0" }) },
    { ok: true, json: async () => { throw new Error("invalid JSON"); } },
    { ok: true, json: async () => null },
    { ok: true, json: async () => ({ version: "99.0.0; bad command" }) },
  ]) {
    expect((await checkForUpdates({ cacheDir: directory(), env: enabled, fetch: async () => response })).status).toBe("unavailable");
  }
});

test("a stalled response body is aborted within the check deadline", async () => {
  let signal: AbortSignal | undefined;
  const info = await checkForUpdates({ cacheDir: directory(), env: enabled, fetch: async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  expect(info.status).toBe("unavailable");
  expect(signal?.aborted).toBe(true);
});

test("an unwritable cache does not discard a successful registry check", async () => {
  const cacheDir = path.join(directory(), "file");
  writeFileSync(cacheDir, "not a directory");
  const info = await checkForUpdates({ cacheDir, env: enabled, fetch: async () => ({ ok: true, json: async () => ({ version: "99.0.0" }) }) });
  expect(info.updateAvailable).toBe(true);
});

test("library checks are opt-in and attach metadata across provider outcomes", async () => {
  const cacheRoot = directory();
  mkdirSync(path.join(cacheRoot, "agent-headless"));
  writeFileSync(path.join(cacheRoot, "agent-headless", "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0" }));
  const request = { provider: "codex" as const, prompt: "test", cwd: process.cwd(), env: { ...enabled, XDG_CACHE_HOME: cacheRoot } };
  for (const status of ["succeeded", "failed", "timed-out", "cancelled", "unparsed"] as const) {
    const options = { execute: async () => ({
      stdout: status === "unparsed" ? "" : JSON.stringify({ type: "turn.completed" }),
      stderr: "", exitCode: status === "failed" ? 1 : 0, durationMs: 1,
      timedOut: status === "timed-out", cancelled: status === "cancelled",
    }) };
    const plain = await runAgent(request, options);
    const withUpdate = await runAgent(request, { ...options, checkForUpdates: true });
    expect(plain.update).toBeUndefined();
    expect(withUpdate.update?.updateAvailable).toBe(true);
    expect(withUpdate.status).toBe(status);
    const { update, ...rest } = withUpdate;
    expect(rest).toEqual(plain);
  }
});
