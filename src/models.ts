import { unsupported } from "./errors";
import type { Provider } from "./types";

/**
 * Model IDs this runner knows about; `models <provider>` prints these lists.
 * They are a hint, not a gate: an off-list `--model` is still handed to the
 * provider CLI, which is the authority on its own catalog, and the result is
 * labelled `modelUncatalogued`. Cursor's live catalog is deliberately not
 * exposed here.
 */
export const SUPPORTED_MODELS = Object.freeze({
  claude: Object.freeze(["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"]),
  codex: Object.freeze(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
  cursor: Object.freeze([
    "cursor-grok-4.5-low",
    "cursor-grok-4.5-medium",
    "cursor-grok-4.5-high",
    "cursor-grok-4.6-low",
    "cursor-grok-4.6-medium",
    "cursor-grok-4.6-high",
    "composer-2.5",
    "composer-2.5-fast",
  ]),
  // Antigravity's authenticated catalog is intentionally read live through
  // `agy models`; pinning it here would make this runner misreport valid models
  // whenever the CLI's catalog changes.
  antigravity: Object.freeze([]),
} as const);

const CLAUDE_MODEL_ALIASES = Object.freeze({
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
} as const);

export function supportedModels(provider: Provider): string[] {
  return [...SUPPORTED_MODELS[provider]];
}

export function normalizeClaudeModel(model: string): string {
  return CLAUDE_MODEL_ALIASES[model as keyof typeof CLAUDE_MODEL_ALIASES] ?? model;
}

/** Matches the Fable family, so a future Fable ID inherits its effort default. */
export function isClaudeFable(model: string): boolean {
  return normalizeClaudeModel(model).startsWith("claude-fable-");
}

/**
 * Reports whether the model is one this runner knows. Being off the catalog is
 * not an error - the provider decides what it accepts - so the only throw here
 * is Cursor's Grok-fast refusal, which is policy rather than catalog: a fast
 * variant is never an acceptable substitute for the one the caller named.
 * (Cursor's other refusal, `auto`, is applied by its adapter.) Antigravity's
 * catalog is read live, so nothing can be off it here.
 */
export function checkModel(provider: Provider, model: string): { catalogued: boolean } {
  if (provider === "claude") {
    return { catalogued: (SUPPORTED_MODELS.claude as readonly string[]).includes(normalizeClaudeModel(model)) };
  }
  if (provider === "codex") {
    return { catalogued: (SUPPORTED_MODELS.codex as readonly string[]).includes(model) };
  }
  if (provider === "antigravity") return { catalogued: true };
  if (/^cursor-grok-.*-fast$/u.test(model)) {
    unsupported(`Cursor Grok fast variants are not allowed; use ${model.replace(/-fast$/u, "")}`);
  }
  return { catalogued: (SUPPORTED_MODELS.cursor as readonly string[]).includes(model) };
}
