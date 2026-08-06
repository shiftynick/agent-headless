import type { AgentEvent, AgentEventKind, Provider } from "./types";

function eventKind(provider: Provider, type: string, raw: Record<string, unknown>): AgentEventKind {
  const lower = type.toLowerCase();
  if (lower.includes("error") || raw.is_error === true) return "error";
  if (lower.startsWith("result") || lower === "turn.completed") return "result";
  if (lower === "thread.started" || lower === "system.init") return "session";
  const item = asRecord(raw.item);
  if (item?.type === "agent_message" || lower.startsWith("assistant")) return "message";
  if (item && item.type !== "agent_message" || lower.includes("tool")) return "tool";
  if (lower.startsWith("system") || lower.startsWith("turn.")) return "status";
  if (provider === "claude" && lower.startsWith("user")) return "status";
  return "unknown";
}

/** Upper bound on per-line warnings retained; the remainder is summarized as a count. */
export const MAX_JSONL_WARNINGS = 5;

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
export function parseJsonLines(provider: Provider, stdout: string): JsonLinesResult {
  const events: AgentEvent[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    try {
      events.push(parseJsonEvent(provider, line));
    } catch {
      skipped += 1;
      if (warnings.length < MAX_JSONL_WARNINGS) warnings.push(`skipped unparseable JSONL at line ${index + 1}`);
    }
  }
  if (skipped > warnings.length) {
    warnings.push(`skipped ${skipped} unparseable JSONL lines in total (${warnings.length} listed)`);
  }
  if (!events.length && skipped > 0) {
    return { events, warnings, error: `invalid JSONL: no parseable lines in ${skipped} line(s) of provider output` };
  }
  return { events, warnings };
}

export function parseJsonEvent(provider: Provider, line: string): AgentEvent {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const rawType = typeof raw.type === "string" ? raw.type : "unknown";
  const subtype = typeof raw.subtype === "string" ? `.${raw.subtype}` : "";
  const type = `${rawType}${subtype}`;
  return { provider, type, kind: eventKind(provider, type, raw), raw };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
