export type Provider = "claude" | "codex" | "cursor";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AccessMode = "answer-only" | "inspect" | "edit-workspace" | "edit-isolated" | "inherit-session";
export type OutputMode = "text" | "events";
export type AgentEventKind = "session" | "message" | "tool" | "status" | "result" | "error" | "unknown";
export type ProviderAvailability = "available" | "missing" | "unusable";
/**
 * `failed` means the provider itself reported failure. `unparsed` means the
 * provider exited cleanly but its output could not be interpreted - the work may
 * well have completed, so callers must not treat it as a provider failure.
 */
export type RunStatus = "succeeded" | "failed" | "unparsed" | "timed-out" | "cancelled";
export type SessionMode = {
    mode: "ephemeral";
} | {
    mode: "persistent";
    id?: string;
} | {
    mode: "resume";
    id: string;
    fork?: boolean;
};
export interface RunRequest {
    provider: Provider;
    prompt: string;
    cwd: string;
    model?: string;
    effort?: Effort;
    access?: AccessMode;
    output?: OutputMode;
    session?: SessionMode;
    timeoutMs?: number;
    maxBudgetUsd?: number;
    schema?: object | string;
    additionalDirs?: string[];
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
    env?: Record<string, string | undefined>;
    providerOptions?: {
        codex?: {
            skipGitRepoCheck?: boolean;
            profile?: string;
        };
        claude?: {
            allowedTools?: string[];
            safeMode?: boolean;
            worktreeName?: string;
        };
        cursor?: {
            worktreeName?: string;
            worktreeBase?: string;
            streamPartialOutput?: boolean;
            trustWorkspace?: boolean;
        };
    };
}
export interface AgentUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    costUsd?: number;
}
export interface AgentEvent {
    provider: Provider;
    type: string;
    kind: AgentEventKind;
    raw: unknown;
}
/** Where a run's work landed, reported on every run outcome. */
export interface WorkspaceInfo {
    /** The resolved working directory the provider was launched in. */
    cwd: string;
    access: AccessMode;
    /** Actual isolated worktree path, when it could be observed in provider output. */
    worktree?: string;
    /** Worktree name the runner asked for; known even when the stream is unreadable. */
    worktreeName?: string;
    /** Worktree base the runner asked for; known even when the stream is unreadable. */
    worktreeBase?: string;
}
export interface AgentResult {
    provider: Provider;
    status: RunStatus;
    finalText?: string;
    events: AgentEvent[];
    exitCode: number | null;
    sessionId?: string;
    modelRequested?: string;
    modelObserved?: string;
    /**
     * True when the caller named no model and the runner supplied its documented
     * default (Cursor only today). Callers whose correctness depends on an
     * explicitly chosen model - cold review needs an operator-chosen reviewer of a
     * known family - must check this flag; `modelRequested` reports the effective
     * model and so cannot by itself distinguish chosen from defaulted.
     */
    modelDefaulted?: boolean;
    usage?: AgentUsage;
    warnings: string[];
    /**
     * Always present: every `runAgent` return path describes where the work went,
     * so tsc - not review - enforces that invariant.
     */
    workspace: WorkspaceInfo;
    stderr: string;
    durationMs: number;
}
export interface ProviderCapabilities {
    provider: Provider;
    version?: string;
    executable: string;
    availability: ProviderAvailability;
    availabilityReason?: string;
    access: AccessMode[];
    sessions: Array<SessionMode["mode"]>;
    supportsModel: boolean;
    supportsEffort: boolean;
    supportsSchema: boolean;
    supportsModelListing: boolean;
}
/**
 * Which installation a model listing should be resolved against. A run may have
 * selected a different executable or account through `RunRequest.env`, so a
 * listing made with the process-global config can name models from an entirely
 * different installation.
 */
export interface ListModelsOptions {
    /** Executable to list from; defaults to the process-global resolution. */
    executable?: string;
    /** Environment overlay the run used, so credentials/account match. */
    env?: Record<string, string | undefined>;
}
export interface RunAgentOptions {
    execute?: InvocationExecutor;
    /**
     * Used only on the model-rejection failure path, to name the models the
     * provider actually offers. Defaults to the provider adapter's own listing;
     * injectable so tests never shell out. Receives the executable and env of the
     * run that failed, so the listing describes the same installation.
     */
    listModels?: (provider: Provider, options: ListModelsOptions) => Promise<string[]>;
    /**
     * Overrides the isolated-worktree name generator. Exists so tests can assert
     * exact argv; production runs use the CSPRNG-backed default.
     */
    generateWorktreeName?: () => string;
}
/** Run-scoped hooks an adapter's `prepare` step may use. */
export interface PrepareOptions {
    generateWorktreeName?: () => string;
}
export type InvocationExecutor = (invocation: Invocation, options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => void;
}) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    cancelled: boolean;
}>;
export interface Invocation {
    provider: Provider;
    command: string;
    args: string[];
    cwd: string;
    stdin: string;
    structured: boolean;
}
export interface ParsedOutput {
    finalText?: string;
    events: AgentEvent[];
    sessionId?: string;
    modelObserved?: string;
    usage?: AgentUsage;
    protocolError?: string;
    /**
     * True when `protocolError` describes output we could not read, rather than a
     * failure the provider itself reported. Drives the `unparsed` status.
     */
    unreadable?: boolean;
    /** Non-fatal notes, e.g. individual JSONL lines that were skipped. */
    warnings?: string[];
}
export interface ProviderAdapter {
    provider: Provider;
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    prepare?(request: RunRequest, options?: PrepareOptions): Promise<RunRequest>;
    listModels?(options?: ListModelsOptions): Promise<string[]>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
}
