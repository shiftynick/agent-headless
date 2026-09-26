import { existsSync } from "node:fs";
import path from "node:path";
import { AgentHeadlessError, unsupported } from "../errors";
import { effectiveEnv, envValue, resolveOnWindows, runInvocation } from "../process";
import { asRecord } from "../jsonl";
import type { AgentEvent, ParsedOutput, Provider, RunRequest, SessionMode } from "../types";

/** A top-level `error` event, with or without a `.subtype` suffix. */
const ERROR_TYPE = /^error(?:\.|$)/u;

/**
 * Recognises an *explicit*, provider-reported failure. Only a top-level `error`
 * event - or a provider's own terminal failure type, passed in `extraTypes` -
 * counts. A stream that merely lacks its terminal success marker is ambiguous
 * (the work may well have completed), so it must stay `unparsed` instead of
 * being relabelled a failure.
 */
export function isExplicitFailure(event: AgentEvent, extraTypes: readonly string[] = []): boolean {
  return ERROR_TYPE.test(event.type) || extraTypes.includes(event.type);
}

/** The last terminal marker in a stream, and which way it decided the run. */
export type TerminalMarker = { outcome: "success" | "failure"; event: AgentEvent };

/**
 * Applies the one rule every adapter shares: **the last terminal marker in the
 * stream decides**. A success result followed by an `error` is a failure; a
 * failure followed by a later success result is a success. Scanning in reverse
 * and stopping at the first marker of either kind is what makes both directions
 * fall out of a single pass - neither "any success wins" nor "any failure wins".
 *
 * Returns `undefined` only when the stream contains no terminal marker at all,
 * which is the genuinely ambiguous case callers must report as `unreadable`.
 */
export function findTerminalMarker(
  events: AgentEvent[],
  isSuccess: (event: AgentEvent) => boolean,
  extraFailureTypes: readonly string[] = [],
): TerminalMarker | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (isExplicitFailure(event, extraFailureTypes)) return { outcome: "failure", event };
    if (isSuccess(event)) return { outcome: "success", event };
  }
  return undefined;
}

/** Carries the provider's own wording out of a failure event, when it has any. */
export function providerFailureMessage(label: string, event: AgentEvent): string {
  const raw = asRecord(event.raw);
  const candidates = [
    asRecord(raw?.error)?.message,
    raw?.message,
    raw?.error,
    raw?.reason,
    raw?.result,
    Array.isArray(raw?.errors) ? raw.errors.join("; ") : undefined,
    asRecord(raw?.item)?.message,
  ];
  const detail = candidates.find((value) => typeof value === "string" && value.trim());
  return `${label} reported ${event.type}${typeof detail === "string" ? `: ${detail.trim()}` : ""}`;
}

/** Session identity remains useful even when no terminal result was produced. */
export function recoveryMetadata(events: AgentEvent[]): Pick<ParsedOutput, "sessionId" | "modelObserved"> {
  let sessionId: string | undefined;
  let modelObserved: string | undefined;
  for (const event of events) {
    const raw = asRecord(event.raw);
    if (!raw || raw.isSidechain === true || raw.parent_tool_use_id != null) continue;
    const session = event.kind === "session";
    const result = event.kind === "result" || raw.type === "result";
    if (session || result) {
      const nested = asRecord(raw.result);
      const id = raw.session_id ?? raw.thread_id ?? raw.conversation_id ?? nested?.conversation_id;
      if (typeof id === "string" && id) sessionId = id;
    }
    const model = session ? raw.model ?? asRecord(raw.init)?.model
      : raw.type === "assistant" ? asRecord(raw.message)?.model : undefined;
    if (typeof model === "string" && model) modelObserved = model;
  }
  return { ...(sessionId ? { sessionId } : {}), ...(modelObserved ? { modelObserved } : {}) };
}

export function rejectUnsupportedFork(request: RunRequest): void {
  if (request.session?.mode === "resume" && request.session.fork) {
    unsupported(`${request.provider} does not support forking a session`);
  }
}

/** Read-only feature evidence from the selected executable, never an authenticated run. */
export async function executableFeatures(provider: Provider, command: string, args = ["--help"]): Promise<string[]> {
  try {
    const result = await runInvocation({ provider, command, args, cwd: process.cwd(), stdin: "", structured: false }, { timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) return [];
    const help = `${result.stdout}\n${result.stderr}`;
    const features = [...new Set(help.match(/--[a-z][a-z-]+\b/gu) ?? [])];
    if (/^\s+fork\s/mu.test(help)) features.push("fork");
    return features;
  } catch { return []; }
}

export function envExecutable(provider: Provider, requestEnv?: Record<string, string | undefined>): string {
  const key = provider === "claude"
    ? "CLAUDE_BIN"
    : provider === "codex"
      ? "CODEX_BIN"
      : provider === "cursor"
        ? "CURSOR_AGENT_BIN"
        : "AGY_BIN";
  const fallback = provider === "cursor" ? "agent" : provider === "antigravity" ? "agy" : provider;
  // Read the effective child environment. A case-sensitive or partial read
  // could disagree with the process we launch, especially on Windows.
  const env = effectiveEnv(requestEnv);
  const override = envValue(env, key);
  if (override) return override;

  if (provider !== "antigravity" || process.platform !== "win32") return fallback;

  // AGY's Windows installer puts its executable here but does not always add
  // the directory to PATH. Prefer a PATH-resolved executable when available,
  // then use the documented per-user install path. Do not edit PATH or search
  // the host filesystem for a provider executable.
  const pathExecutable = resolveOnWindows(fallback, env);
  if (pathExecutable !== fallback) return pathExecutable;
  const localAppData = envValue(env, "LOCALAPPDATA");
  const installed = localAppData && path.join(localAppData, "agy", "bin", "agy.exe");
  return installed && existsSync(installed) ? installed : fallback;
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
