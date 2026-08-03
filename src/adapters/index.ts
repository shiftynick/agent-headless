import type { Provider, ProviderAdapter } from "../types";
import { AgentHeadlessError } from "../errors";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAdapter } from "./cursor";

const adapters: Record<Provider, ProviderAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  cursor: new CursorAdapter(),
};

export function getAdapter(provider: Provider): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new AgentHeadlessError("invalid_request", `unknown provider: ${String(provider)}`);
  return adapter;
}

export { ClaudeAdapter, CodexAdapter, CursorAdapter };
