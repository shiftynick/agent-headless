import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgentHeadlessError } from "./errors";
import type { Invocation, Provider, ProviderAvailability } from "./types";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ExecutableProbe {
  executable: string;
  availability: ProviderAvailability;
  version?: string;
  reason?: string;
}

/**
 * Reads one variable from an environment the way Windows itself would: by
 * name, ignoring case. Every JS-side read of an environment the child will
 * receive must go through this on win32 - a case-sensitive property access
 * diverges from what the spawned process experiences, and that divergence is
 * exactly how an equivalent overlay ends up resolving differently here than
 * it does for the provider.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  // Last match wins, mirroring effectiveEnv, where a later case-variant entry
  // overwrites an earlier one. A first-match read here would resolve
  // {CLAUDE_BIN: "A", claude_bin: "B"} to A while the child sees B.
  const lower = name.toLowerCase();
  let value: string | undefined;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) value = env[key];
  }
  return value;
}

export function resolveOnWindows(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32" || path.isAbsolute(command) || /[\\/]/u.test(command)) return command;
  const pathValue = envValue(env, "PATH") ?? "";
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * The environment a child launched with these overrides actually receives:
 * `process.env` with `options.env` overlaid, where an explicit `undefined`
 * *removes* the variable and, on Windows, a differently-cased override replaces
 * the inherited entry rather than sitting beside it.
 *
 * Extracted so that anything which has to see the world as the provider will -
 * `gitToplevel`'s repository probe, most of all - builds the same environment
 * `runInvocation` builds, instead of re-deriving it and drifting.
 */
export function effectiveEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const existing = process.platform === "win32"
      ? Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
      : key;
    if (existing && existing !== key) delete env[existing];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * How a command name plus arguments must actually be handed to `spawn` under a
 * given environment.
 *
 * Two Windows facts force this, both verified on Node 22 (win32):
 *
 * 1. `spawn`/`spawnSync` resolve a bare command against the *child* environment's
 *    `PATH` - a `.exe` reachable only through an overridden `PATH` is found, and
 *    one reachable only through the parent's is not. Lookup is therefore already
 *    at parity with the child, but `resolveOnWindows` is still applied so the
 *    resolved path is visible and `PATHEXT` is honoured consistently.
 * 2. A `.cmd`/`.bat` target cannot be executed directly at all: spawning one by
 *    full path fails `EINVAL`, and a bare name whose only match is a `.cmd` fails
 *    `ENOENT`. It has to be run through `cmd.exe`.
 *
 * Sharing this with `runInvocation` is what makes "the probe sees git exactly as
 * the provider invocation would" true rather than aspirational.
 */
export function resolveCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  const resolved = resolveOnWindows(command, env);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(resolved)) {
    const commandLine = `"${[resolved, ...args].map(quoteCmd).join(" ")}"`;
    return {
      command: envValue(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args: [...args], windowsVerbatimArguments: false };
}

function quoteCmd(value: string): string {
  if (/[\r\n%!]/u.test(value)) {
    throw new AgentHeadlessError(
      "invalid_request",
      "A Windows .cmd argument contains newline, % or !; configure the provider executable directly.",
    );
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export async function runInvocation(
  invocation: Invocation,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => void;
  },
): Promise<ProcessResult> {
  const started = Date.now();
  if (options.signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: null, durationMs: 0, timedOut: false, cancelled: true };
  }
  const env = effectiveEnv(options.env);
  const { command, args, windowsVerbatimArguments } = resolveCommand(invocation.command, invocation.args, env);

  return await new Promise<ProcessResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let pendingLine = "";
    const child = spawn(command, args, {
      cwd: invocation.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.onStdoutLine) {
        pendingLine += chunk;
        const lines = pendingLine.split(/\r?\n/u);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onStdoutLine(line);
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    let terminationRequested = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const forceKill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        killer.on("error", () => { child.kill(); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      if (process.platform === "win32" && child.pid) {
        forceKill();
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        forceTimer = setTimeout(forceKill, 2_000);
        forceTimer.unref();
      } else {
        child.kill("SIGTERM");
      }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    const abort = () => { cancelled = true; terminate(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(invocation.stdin, "utf8");
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error.code === "ENOENT") {
        reject(new AgentHeadlessError("not_installed", `${invocation.provider} executable not found: ${invocation.command}`, { cause: error }));
      } else {
        reject(new AgentHeadlessError("provider_failed", `Unable to start ${invocation.provider}: ${error.message}`, { cause: error }));
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.onStdoutLine && pendingLine.trim()) options.onStdoutLine(pendingLine);
      resolve({ stdout, stderr, exitCode, durationMs: Date.now() - started, timedOut, cancelled });
    });
  });
}

export async function readVersion(provider: Provider, command: string, cwd: string): Promise<string | undefined> {
  return (await probeExecutable(provider, command, cwd)).version;
}

export async function probeExecutable(provider: Provider, command: string, cwd: string): Promise<ExecutableProbe> {
  const env = { ...process.env };
  const executable = resolveOnWindows(command, env);
  try {
    const result = await runInvocation(
      { provider, command, args: ["--version"], cwd, stdin: "", structured: false },
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) {
      return {
        executable,
        availability: "unusable",
        reason: result.stderr.trim() || `${provider} --version exited with ${String(result.exitCode)}`,
      };
    }
    const version = result.stdout.trim();
    return { executable, availability: "available", ...(version ? { version } : {}) };
  } catch (error) {
    const missing = error instanceof AgentHeadlessError && error.code === "not_installed";
    return {
      executable,
      availability: missing ? "missing" : "unusable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
