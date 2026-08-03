import { AgentHeadlessError, unsupported } from "../errors";
import type { ParsedOutput, Provider, RunRequest, SessionMode } from "../types";

export function envExecutable(provider: Provider, requestEnv?: Record<string, string | undefined>): string {
  const key = provider === "claude" ? "CLAUDE_BIN" : provider === "codex" ? "CODEX_BIN" : "CURSOR_AGENT_BIN";
  const fallback = provider === "cursor" ? "agent" : provider;
  return requestEnv?.[key] || process.env[key] || fallback;
}

export function assertAccess(request: RunRequest, allowed: string[]): void {
  if (!allowed.includes(request.access!)) {
    unsupported(`${request.provider} does not support access=${request.access}; supported: ${allowed.join(", ")}`);
  }
}

export function assertSession(request: RunRequest, allowed: Array<SessionMode["mode"]>): void {
  if (!allowed.includes(request.session!.mode)) {
    unsupported(`${request.provider} does not support session=${request.session!.mode}; supported: ${allowed.join(", ")}`);
  }
}

export function textOutput(provider: Provider, stdout: string): ParsedOutput {
  return { finalText: stdout.replace(/\r?\n$/u, ""), events: [{ provider, type: "result", kind: "result", raw: stdout }] };
}

export function providerFailure(provider: Provider, exitCode: number | null, stderr: string): AgentHeadlessError {
  const detail = stderr.trim().split(/\r?\n/u).slice(-6).join("\n");
  return new AgentHeadlessError(
    "provider_failed",
    `${provider} failed with exit code ${String(exitCode)}${detail ? `:\n${detail}` : ""}`,
  );
}
