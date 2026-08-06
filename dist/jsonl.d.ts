import type { AgentEvent, Provider } from "./types";
/** Upper bound on per-line warnings retained; the remainder is summarized as a count. */
export declare const MAX_JSONL_WARNINGS = 5;
export interface JsonLinesResult {
    events: AgentEvent[];
    /** Bounded, human-readable notes about lines that were skipped. */
    warnings: string[];
    /** Set only when the stream was wholly unreadable: at least one line, none parseable. */
    error?: string;
}
/**
 * Parses a JSONL stream leniently: unparseable lines are skipped and reported as
 * bounded warnings instead of aborting the stream. A stream-level `error` is
 * returned only when nothing at all parsed, so a leading banner line or a
 * truncated trailing line can never discard a provider's real events.
 */
export declare function parseJsonLines(provider: Provider, stdout: string): JsonLinesResult;
export declare function parseJsonEvent(provider: Provider, line: string): AgentEvent;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function numberValue(value: unknown): number | undefined;
