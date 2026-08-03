import type { Provider, ProviderAdapter } from "../types";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAdapter } from "./cursor";
export declare function getAdapter(provider: Provider): ProviderAdapter;
export { ClaudeAdapter, CodexAdapter, CursorAdapter };
