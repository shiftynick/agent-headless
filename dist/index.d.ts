import type { AgentResult, ListModelsOptions, Provider, ProviderCapabilities, RunAgentOptions, RunRequest } from "./types";
export * from "./errors";
export * from "./types";
export { describeWorkspace } from "./workspace";
export { MAX_JSONL_WARNINGS, parseJsonEvent, parseJsonLines } from "./jsonl";
export { probeExecutable, resolveOnWindows, runInvocation } from "./process";
export { VERSION } from "./version";
export { ClaudeAdapter, CodexAdapter, CursorAdapter, CURSOR_DEFAULT_MODEL, CURSOR_WORKTREE_NAME_PATTERN, CURSOR_WORKTREES_ROOT_ENV, cursorRepoSlug, cursorWorktreePath, cursorWorktreesRoot, generateWorktreeName, getAdapter, WORKTREE_NAME_PREFIX, } from "./adapters";
export declare function runAgent(input: RunRequest, options?: RunAgentOptions): Promise<AgentResult>;
export declare function getCapabilities(provider: Provider): Promise<ProviderCapabilities>;
export declare function getAllCapabilities(): Promise<ProviderCapabilities[]>;
export declare function listModels(provider: Provider, options?: ListModelsOptions): Promise<string[]>;
export declare function assertSucceeded(result: AgentResult): asserts result is AgentResult & {
    status: "succeeded";
};
