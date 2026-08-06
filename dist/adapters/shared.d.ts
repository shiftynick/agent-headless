import { AgentHeadlessError } from "../errors";
import type { AgentEvent, ParsedOutput, Provider, RunRequest, SessionMode } from "../types";
/**
 * Recognises an *explicit*, provider-reported failure. Only a top-level `error`
 * event - or a provider's own terminal failure type, passed in `extraTypes` -
 * counts. A stream that merely lacks its terminal success marker is ambiguous
 * (the work may well have completed), so it must stay `unparsed` instead of
 * being relabelled a failure.
 */
export declare function isExplicitFailure(event: AgentEvent, extraTypes?: readonly string[]): boolean;
/** The last terminal marker in a stream, and which way it decided the run. */
export type TerminalMarker = {
    outcome: "success" | "failure";
    event: AgentEvent;
};
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
export declare function findTerminalMarker(events: AgentEvent[], isSuccess: (event: AgentEvent) => boolean, extraFailureTypes?: readonly string[]): TerminalMarker | undefined;
/** Carries the provider's own wording out of a failure event, when it has any. */
export declare function providerFailureMessage(label: string, event: AgentEvent): string;
export declare function envExecutable(provider: Provider, requestEnv?: Record<string, string | undefined>): string;
export declare function assertAccess(request: RunRequest, allowed: string[]): void;
export declare function assertSession(request: RunRequest, allowed: Array<SessionMode["mode"]>): void;
export declare function textOutput(provider: Provider, stdout: string): ParsedOutput;
export declare function providerFailure(provider: Provider, exitCode: number | null, stderr: string): AgentHeadlessError;
