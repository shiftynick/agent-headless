import { unsupported } from "./errors";
import type { Provider } from "./types";

/**
 * Exact model IDs this runner will pass to each provider. `models <provider>`
 * prints these lists. Off-list `--model` values fail before the provider is
 * launched. Cursor's live catalog is deliberately not exposed here.
 */
export const SUPPORTED_MODELS = Object.freeze({
  claude: Object.freeze(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]),
  codex: Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
  cursor: Object.freeze([
    "cursor-grok-4.5-low",
    "cursor-grok-4.5-medium",
    "cursor-grok-4.5-high",
    "composer-2.5",
    "composer-2.5-fast",
  ]),
  // Antigravity's authenticated catalog is intentionally read live through
  // `agy models`; pinning it here would make this runner reject valid models
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

export function isClaudeFable(model: string): boolean {
  return normalizeClaudeModel(model) === "claude-fable-5";
}

export function assertSupportedModel(provider: Provider, model: string): void {
  if (provider === "claude") {
    if (!(SUPPORTED_MODELS.claude as readonly string[]).includes(normalizeClaudeModel(model))) {
      unsupported(
        `Claude model "${model}" is not in the supported list; run \`agent-headless models claude\``,
      );
    }
    return;
  }
  if (provider === "codex") {
    if (!(SUPPORTED_MODELS.codex as readonly string[]).includes(model)) {
      unsupported(
        `Codex model "${model}" is not in the supported list; run \`agent-headless models codex\``,
      );
    }
    return;
  }
  if (provider === "antigravity") {
    unsupported("Antigravity models are resolved from the authenticated AGY CLI; run `agent-headless models antigravity`");
  }
  if (/^cursor-grok-.*-fast$/u.test(model)) {
    unsupported(`Cursor Grok fast variants are not allowed; use ${model.replace(/-fast$/u, "")}`);
  }
  if (!(SUPPORTED_MODELS.cursor as readonly string[]).includes(model)) {
    unsupported(
      `Cursor model "${model}" is not in the supported list; run \`agent-headless models cursor\``,
    );
  }
}
