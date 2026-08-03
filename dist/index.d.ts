import type { AgentResult, Provider, ProviderCapabilities, RunAgentOptions, RunRequest } from "./types";
export * from "./errors";
export * from "./types";
export { probeExecutable, resolveOnWindows, runInvocation } from "./process";
export { VERSION } from "./version";
export { ClaudeAdapter, CodexAdapter, CursorAdapter, getAdapter } from "./adapters";
export declare function runAgent(input: RunRequest, options?: RunAgentOptions): Promise<AgentResult>;
export declare function getCapabilities(provider: Provider): Promise<ProviderCapabilities>;
export declare function getAllCapabilities(): Promise<ProviderCapabilities[]>;
export declare function listModels(provider: Provider): Promise<string[]>;
export declare function assertSucceeded(result: AgentResult): asserts result is AgentResult & {
    status: "succeeded";
};
