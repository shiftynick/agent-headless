import { AgentHeadlessError } from "./errors";
import { CURSOR_DEFAULT_MODEL, getAdapter } from "./adapters";
import { parseJsonEvent, parseJsonLines } from "./jsonl";
import { runInvocation } from "./process";
import { envExecutable } from "./adapters/shared";
import type {
  AgentResult,
  ListModelsOptions,
  Provider,
  ProviderCapabilities,
  RunAgentOptions,
  RunRequest,
} from "./types";
import { normalizeRequest } from "./validation";
import { describeWorkspace } from "./workspace";

export * from "./errors";
export * from "./types";
export { describeWorkspace } from "./workspace";
export { MAX_JSONL_WARNINGS, parseJsonEvent, parseJsonLines } from "./jsonl";
export { probeExecutable, resolveOnWindows, runInvocation } from "./process";
export { VERSION } from "./version";
export {
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  CURSOR_DEFAULT_MODEL,
  CURSOR_WORKTREE_NAME_PATTERN,
  CURSOR_WORKTREES_ROOT_ENV,
  cursorRepoSlug,
  cursorWorktreePath,
  cursorWorktreesRoot,
  generateWorktreeName,
  getAdapter,
  WORKTREE_NAME_PREFIX,
} from "./adapters";
export { SUPPORTED_MODELS, supportedModels } from "./models";

/** Shapes in which the Cursor CLI reports that it will not accept a model ID. */
const MODEL_REJECTION =
  /(?:unknown|unrecognized|unsupported|invalid|unavailable)\s+model|no\s+such\s+model|model\b[^\n]{0,80}?(?:not\s+(?:found|available|supported|recognized)|does\s+not\s+exist|is\s+invalid|is\s+no\s+longer)/iu;

/**
 * Turns a bare model rejection into something actionable. The live model list is
 * only fetched when the model was defaulted - that is the case where the caller
 * never chose the model and so cannot know what replaced it, and it keeps the
 * extra subprocess off every other run, including every successful one.
 */
async function modelRejectionWarnings(
  request: RunRequest,
  modelDefaulted: boolean,
  text: string,
  options: RunAgentOptions,
): Promise<string[]> {
  if (request.provider !== "cursor" || !text || !MODEL_REJECTION.test(text)) return [];
  const origin = modelDefaulted
    ? `${CURSOR_DEFAULT_MODEL} is this runner's built-in default and may be stale`
    : "this model was requested explicitly";
  const warnings = [
    `cursor rejected model "${request.model ?? "(none)"}" - ${origin}; run \`agent-headless models cursor\` for the supported list`,
  ];
  if (!modelDefaulted) return warnings;
  try {
    // Resolved against the failed run's own executable and env: a listing from a
    // different installation would name models this run could never have used.
    const models = await (options.listModels ?? listModels)("cursor", {
      executable: envExecutable("cursor", request.env),
      ...(request.env ? { env: request.env } : {}),
    });
    if (models.length) {
      const shown = models.slice(0, 40);
      warnings.push(`available cursor models: ${shown.join(", ")}${models.length > shown.length ? `, ... (${models.length} total)` : ""}`);
    }
  } catch {
    // Best effort only: a failing listing must never replace the original failure.
  }
  return warnings;
}

export async function runAgent(input: RunRequest, options: RunAgentOptions = {}): Promise<AgentResult> {
  let request = normalizeRequest(input);
  const adapter = getAdapter(request.provider);
  // Recorded before `prepare` may supply a default, so the result can say which happened.
  const modelChosenByCaller = request.model !== undefined;
  if (adapter.prepare) {
    request = await adapter.prepare(request, {
      ...(options.generateWorktreeName ? { generateWorktreeName: options.generateWorktreeName } : {}),
    });
  }
  const modelDefaulted = !modelChosenByCaller && request.model !== undefined;
  const invocation = adapter.build(request);
  const streamWarnings: string[] = [];
  const processResult = await (options.execute ?? runInvocation)(invocation, {
    timeoutMs: request.timeoutMs!,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.env ? { env: request.env } : {}),
    ...(invocation.structured && request.onEvent ? {
      onStdoutLine: (line: string) => {
        try {
          request.onEvent?.(parseJsonEvent(request.provider, line));
        } catch {
          streamWarnings.push("invalid JSONL received during streaming");
        }
      },
    } : {}),
  });

  const structuredPartial = invocation.structured
    ? parseJsonLines(request.provider, processResult.stdout)
    : undefined;
  const textPartial = invocation.structured
    ? undefined
    : adapter.parse(processResult.stdout, false);
  const partialEvents = structuredPartial?.events ?? textPartial?.events ?? [];
  const partialFinalText = textPartial?.finalText;
  const partialWarnings = [...new Set([
    ...streamWarnings,
    ...(structuredPartial?.warnings ?? []),
    ...(structuredPartial?.error ? [structuredPartial.error] : []),
  ])];
  // Reported on every return path so a caller can always find where work landed.
  const partialWorkspace = describeWorkspace(request, invocation.cwd, partialEvents, processResult.stdout);

  if (processResult.timedOut || processResult.cancelled) {
    return {
      provider: request.provider,
      status: processResult.timedOut ? "timed-out" : "cancelled",
      ...(partialFinalText !== undefined ? { finalText: partialFinalText } : {}),
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...(request.model ? { modelRequested: request.model } : {}),
      ...(modelDefaulted ? { modelDefaulted: true } : {}),
      warnings: partialWarnings,
      workspace: partialWorkspace,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
    };
  }

  if (processResult.exitCode !== 0) {
    const rejection = await modelRejectionWarnings(
      request,
      modelDefaulted,
      `${processResult.stderr}\n${processResult.stdout}`,
      options,
    );
    return {
      provider: request.provider,
      status: "failed",
      ...(partialFinalText !== undefined ? { finalText: partialFinalText } : {}),
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...(request.model ? { modelRequested: request.model } : {}),
      ...(modelDefaulted ? { modelDefaulted: true } : {}),
      warnings: [...new Set([...partialWarnings, ...rejection])],
      workspace: partialWorkspace,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
    };
  }

  const parsed = adapter.parse(processResult.stdout, invocation.structured);
  if (!invocation.structured) for (const event of parsed.events) request.onEvent?.(event);
  const rejection = parsed.protocolError
    ? await modelRejectionWarnings(request, modelDefaulted, `${parsed.protocolError}\n${processResult.stderr}`, options)
    : [];
  const warnings = [...new Set([
    ...streamWarnings,
    ...(parsed.warnings ?? []),
    ...(parsed.protocolError ? [parsed.protocolError] : []),
    ...rejection,
  ])];
  return {
    provider: request.provider,
    // The provider exited 0 here: unreadable output is not the same as failure.
    status: parsed.protocolError ? (parsed.unreadable ? "unparsed" : "failed") : "succeeded",
    ...(parsed.finalText !== undefined ? { finalText: parsed.finalText } : {}),
    events: parsed.events,
    exitCode: processResult.exitCode,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    ...(request.model ? { modelRequested: request.model } : {}),
    ...(modelDefaulted ? { modelDefaulted: true } : {}),
    ...(parsed.modelObserved ? { modelObserved: parsed.modelObserved } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    warnings,
    workspace: describeWorkspace(request, invocation.cwd, parsed.events, processResult.stdout),
    stderr: processResult.stderr,
    durationMs: processResult.durationMs,
  };
}

export async function getCapabilities(provider: Provider): Promise<ProviderCapabilities> {
  return await getAdapter(provider).capabilities();
}

export async function getAllCapabilities(): Promise<ProviderCapabilities[]> {
  return await Promise.all((["claude", "codex", "cursor"] as const).map(getCapabilities));
}

export async function listModels(provider: Provider, options: ListModelsOptions = {}): Promise<string[]> {
  const adapter = getAdapter(provider);
  if (!adapter.listModels) {
    throw new AgentHeadlessError("unsupported_capability", `${provider} does not expose model listing through its CLI`);
  }
  return await adapter.listModels(options);
}

export function assertSucceeded(result: AgentResult): asserts result is AgentResult & { status: "succeeded" } {
  if (result.status !== "succeeded") {
    throw new AgentHeadlessError(
      result.status === "unparsed" ? "invalid_provider_output" : "provider_failed",
      `${result.provider} ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
}
