import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgentHeadlessError } from "./errors";
import type { Invocation, Provider } from "./types";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export function resolveOnWindows(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32" || path.isAbsolute(command) || /[\\/]/u.test(command)) return command;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
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
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    const existing = process.platform === "win32"
      ? Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
      : key;
    if (existing && existing !== key) delete env[existing];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  let command = resolveOnWindows(invocation.command, env);
  let args = invocation.args;
  let windowsVerbatimArguments = false;
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const commandLine = `"${[command, ...args].map(quoteCmd).join(" ")}"`;
    command = env.ComSpec || env.COMSPEC || "cmd.exe";
    args = ["/d", "/s", "/c", commandLine];
    windowsVerbatimArguments = true;
  }

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

    const terminate = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
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
      options.signal?.removeEventListener("abort", abort);
      if (error.code === "ENOENT") {
        reject(new AgentHeadlessError("not_installed", `${invocation.provider} executable not found: ${invocation.command}`, { cause: error }));
      } else {
        reject(new AgentHeadlessError("provider_failed", `Unable to start ${invocation.provider}: ${error.message}`, { cause: error }));
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.onStdoutLine && pendingLine.trim()) options.onStdoutLine(pendingLine);
      resolve({ stdout, stderr, exitCode, durationMs: Date.now() - started, timedOut, cancelled });
    });
  });
}

export async function readVersion(provider: Provider, command: string, cwd: string): Promise<string | undefined> {
  try {
    const result = await runInvocation(
      { provider, command, args: ["--version"], cwd, stdin: "", structured: false },
      { timeoutMs: 10_000 },
    );
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}
