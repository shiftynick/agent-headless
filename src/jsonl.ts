import type { AgentEvent, AgentEventKind, Provider } from "./types";

function eventKind(provider: Provider, type: string, raw: Record<string, unknown>): AgentEventKind {
  const lower = type.toLowerCase();
  if (provider === "antigravity") {
    if (lower === "init") return "session";
    if (lower === "result") return "result";
    if (lower === "step_update") {
      const step = asRecord(raw.step_update);
      if (step?.step_type === "agent_response") return "message";
      if (typeof step?.step_type === "string" && step.step_type.includes("tool")) return "tool";
      return "status";
    }
    if (lower === "command_result") return "status";
  }
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
  const parser = new JsonLineParser(provider);
  for (const line of stdout.split(/\r?\n/u)) parser.push(line);
  return parser.result();
}

/** Incremental JSONL decoder; input retention is bounded by the process runner. */
export class JsonLineParser {
  private events: AgentEvent[] = [];
  private warnings: string[] = [];
  private skipped = 0;
  private lineNumber = 0;
  constructor(private provider: Provider) {}

  push(line: string): AgentEvent | undefined {
    this.lineNumber++;
    if (!line.trim()) return undefined;
    try {
      const event = parseJsonEvent(this.provider, line);
      this.events.push(event);
      return event;
    } catch {
      this.skipped++;
      if (this.warnings.length < MAX_JSONL_WARNINGS) this.warnings.push(`skipped unparseable JSONL at line ${this.lineNumber}`);
      return undefined;
    }
  }

  result(): JsonLinesResult {
    const warnings = [...this.warnings];
    if (this.skipped > warnings.length) warnings.push(`skipped ${this.skipped} unparseable JSONL lines in total (${warnings.length} listed)`);
    return { events: this.events, warnings,
      ...(!this.events.length && this.skipped > 0
        ? { error: `invalid JSONL: no parseable lines in ${this.skipped} line(s) of provider output` } : {}),
    };
  }
}

export function parseJsonEvent(provider: Provider, line: string): AgentEvent {
  const raw = asRecord(JSON.parse(line));
  if (!raw) throw new Error("event must be an object");
  const rawType = typeof raw.type === "string"
    ? raw.type
    : provider === "antigravity" && typeof raw.event === "string"
      ? raw.event
      : "unknown";
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
