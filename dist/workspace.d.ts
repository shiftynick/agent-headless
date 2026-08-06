import type { AgentEvent, RunRequest, WorkspaceInfo } from "./types";
/**
 * Describes where a run's work went. Always reports cwd and access; for isolated
 * runs it also reports the worktree name/base the runner chose (known regardless
 * of output readability) plus the observed worktree path when it is discoverable.
 */
export declare function describeWorkspace(request: RunRequest, cwd: string, events: AgentEvent[], stdout: string): WorkspaceInfo;
