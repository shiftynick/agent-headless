import type { Provider } from "./types";
/**
 * Model IDs this runner knows about; `models <provider>` prints these lists.
 * They are a hint, not a gate: an off-list `--model` is still handed to the
 * provider CLI, which is the authority on its own catalog, and the result is
 * labelled `modelUncatalogued`. Cursor's live catalog is deliberately not
 * exposed here.
 */
export declare const SUPPORTED_MODELS: Readonly<{
    readonly claude: readonly string[];
    readonly codex: readonly string[];
    readonly cursor: readonly string[];
    readonly antigravity: readonly never[];
}>;
export declare function supportedModels(provider: Provider): string[];
export declare function normalizeClaudeModel(model: string): string;
/** Matches the Fable family, so a future Fable ID inherits its effort default. */
export declare function isClaudeFable(model: string): boolean;
/**
 * Reports whether the model is one this runner knows. Being off the catalog is
 * not an error - the provider decides what it accepts - so the only throw here
 * is Cursor's Grok-fast refusal, which is policy rather than catalog: a fast
 * variant is never an acceptable substitute for the one the caller named.
 * (Cursor's other refusal, `auto`, is applied by its adapter.) Antigravity's
 * catalog is read live, so nothing can be off it here.
 */
export declare function checkModel(provider: Provider, model: string): {
    catalogued: boolean;
};
