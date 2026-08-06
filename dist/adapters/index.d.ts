import type { Provider, ProviderAdapter } from "../types";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAdapter } from "./cursor";
export declare function getAdapter(provider: Provider): ProviderAdapter;
export { ClaudeAdapter, CodexAdapter, CursorAdapter };
export { CURSOR_DEFAULT_MODEL, CURSOR_WORKTREE_NAME_PATTERN, CURSOR_WORKTREES_ROOT_ENV, cursorRepoSlug, cursorWorktreePath, cursorWorktreesRoot, generateWorktreeName, modelListingKey, WORKTREE_NAME_PREFIX, } from "./cursor";
