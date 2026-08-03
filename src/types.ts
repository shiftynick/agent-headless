export type Provider = "claude" | "codex" | "cursor";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AccessMode = "answer-only" | "inspect" | "edit-workspace" | "edit-isolated" | "inherit-session";
export type OutputMode = "text" | "events";
export type AgentEventKind = "session" | "message" | "tool" | "status" | "result" | "error" | "unknown";
export type ProviderAvailability = "available" | "missing" | "unusable";

export type SessionMode =
  | { mode: "ephemeral" }
  | { mode: "persistent"; id?: string }
  | { mode: "resume"; id: string; fork?: boolean };

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
    codex?: { skipGitRepoCheck?: boolean; profile?: string };
    claude?: { allowedTools?: string[]; safeMode?: boolean; worktreeName?: string };
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

export interface AgentResult {
  provider: Provider;
  status: "succeeded" | "failed" | "timed-out" | "cancelled";
  finalText?: string;
  events: AgentEvent[];
  exitCode: number | null;
  sessionId?: string;
  modelRequested?: string;
  modelObserved?: string;
  usage?: AgentUsage;
  warnings: string[];
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

export interface RunAgentOptions {
  execute?: InvocationExecutor;
}

export type InvocationExecutor = (
  invocation: Invocation,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => void;
  },
) => Promise<{
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
}

export interface ProviderAdapter {
  provider: Provider;
  capabilities(executable?: string): Promise<ProviderCapabilities>;
  prepare?(request: RunRequest): Promise<RunRequest>;
  listModels?(): Promise<string[]>;
  build(request: RunRequest): Invocation;
  parse(stdout: string, structured: boolean): ParsedOutput;
}
