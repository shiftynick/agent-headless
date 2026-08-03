import type { AgentEvent, Provider } from "./types";

export function parseJsonLines(provider: Provider, stdout: string): { events: AgentEvent[]; error?: string } {
  const events: AgentEvent[] = [];
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    try {
      events.push(parseJsonEvent(provider, line));
    } catch {
      return { events, error: `invalid JSONL at line ${index + 1}` };
    }
  }
  return { events };
}

export function parseJsonEvent(provider: Provider, line: string): AgentEvent {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const rawType = typeof raw.type === "string" ? raw.type : "unknown";
  const subtype = typeof raw.subtype === "string" ? `.${raw.subtype}` : "";
  return { provider, type: `${rawType}${subtype}`, raw };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
