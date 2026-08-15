import { AgentHeadlessError, unsupported } from "../errors";
import { envValue } from "../process";
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
    asRecord(raw?.item)?.message,
  ];
  const detail = candidates.find((value) => typeof value === "string" && value.trim());
  return `${label} reported ${event.type}${typeof detail === "string" ? `: ${detail.trim()}` : ""}`;
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
  // requestEnv is a plain object, so a case-sensitive read would ignore a
  // differently cased override that the child environment will honour.
  return (requestEnv ? envValue(requestEnv, key) : undefined) || process.env[key] || fallback;
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
