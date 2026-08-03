import type { AgentEvent, Provider } from "./types";
export declare function parseJsonLines(provider: Provider, stdout: string): {
    events: AgentEvent[];
    error?: string;
};
export declare function parseJsonEvent(provider: Provider, line: string): AgentEvent;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function numberValue(value: unknown): number | undefined;
