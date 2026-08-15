import type { Provider, ProviderAdapter } from "../types";
import { AgentHeadlessError } from "../errors";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAdapter } from "./cursor";
import { AntigravityAdapter } from "./antigravity";

const adapters: Record<Provider, ProviderAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  cursor: new CursorAdapter(),
  antigravity: new AntigravityAdapter(),
};

export function getAdapter(provider: Provider): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new AgentHeadlessError("invalid_request", `unknown provider: ${String(provider)}`);
  return adapter;
}

export { AntigravityAdapter, ClaudeAdapter, CodexAdapter, CursorAdapter };
export {
  CURSOR_DEFAULT_MODEL,
  CURSOR_WORKTREE_NAME_PATTERN,
  CURSOR_WORKTREES_ROOT_ENV,
  cursorRepoSlug,
  cursorWorktreePath,
  cursorWorktreesRoot,
  generateWorktreeName,
  modelListingKey,
  WORKTREE_NAME_PREFIX,
} from "./cursor";
