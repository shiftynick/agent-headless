import type { Provider } from "./types";
/**
 * Exact model IDs this runner will pass to each provider. `models <provider>`
 * prints these lists. Off-list `--model` values fail before the provider is
 * launched. Cursor's live catalog is deliberately not exposed here.
 */
export declare const SUPPORTED_MODELS: Readonly<{
    readonly claude: readonly string[];
    readonly codex: readonly string[];
    readonly cursor: readonly string[];
    readonly antigravity: readonly never[];
}>;
export declare function supportedModels(provider: Provider): string[];
export declare function normalizeClaudeModel(model: string): string;
export declare function isClaudeFable(model: string): boolean;
export declare function assertSupportedModel(provider: Provider, model: string): void;
