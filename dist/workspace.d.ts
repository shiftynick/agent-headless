import type { AgentEvent, RunRequest, WorkspaceInfo } from "./types";
/**
 * Describes where a run's work went. Always reports cwd and access; for isolated
 * runs it also reports the worktree name/base the runner chose (known regardless
 * of output readability) and the worktree path itself.
 *
 * The path is taken from the provider when the provider disclosed one - it is
 * authoritative about where it actually put the work - and otherwise derived
 * from the pinned name and Cursor's fixed worktree layout. Deriving is what
 * makes the path survive the case the parsed path cannot: output that could not
 * be read at all, which is exactly when a caller most needs to find the work.
 */
export declare function describeWorkspace(request: RunRequest, cwd: string, events: AgentEvent[], stdout: string): WorkspaceInfo;
