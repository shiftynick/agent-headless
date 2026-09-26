import { AgentHeadlessError } from "./errors";
import { CURSOR_DEFAULT_MODEL, getAdapter } from "./adapters";
import { JsonLineParser, parseJsonLines } from "./jsonl";
import { checkModel } from "./models";
import { DEFAULT_OUTPUT_LIMITS, runInvocation, utf8Prefix } from "./process";
import { envExecutable, recoveryMetadata } from "./adapters/shared";
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
import { checkForUpdates } from "./updates";

export * from "./errors";
export * from "./types";
export { describeWorkspace } from "./workspace";
export { MAX_JSONL_WARNINGS, parseJsonEvent, parseJsonLines } from "./jsonl";
export { DEFAULT_OUTPUT_LIMITS, probeExecutable, resolveOnWindows, runInvocation } from "./process";
export { VERSION } from "./version";
export { checkForUpdates } from "./updates";
export type { UpdateInfo, UpdateCheckOptions } from "./updates";
export {
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  AntigravityAdapter,
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
  if (!options.checkForUpdates) return executeAgent(input, options);
  const [result, update] = await Promise.all([
    executeAgent(input, options),
    checkForUpdates({ ...(input.env ? { env: input.env } : {}) }),
  ]);
  return { ...result, update };
}

async function executeAgent(input: RunRequest, options: RunAgentOptions): Promise<AgentResult> {
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
  // The catalog is a hint, so an unknown model reaches the provider; labelling
  // it here is the only place the caller learns the name went out unverified.
  const modelUncatalogued = request.model !== undefined
    && !checkModel(request.provider, request.model).catalogued;
  const modelWarnings = modelUncatalogued
    ? [`model "${request.model}" is not in agent-headless's known ${request.provider} catalog; passed through unverified - check modelObserved`]
    : [];
  const invocation = adapter.build(request);
  const parser = new JsonLineParser(request.provider);
  const streamWarnings = new Set<string>();
  const emit = (event: import("./types").AgentEvent) => {
    try { request.onEvent?.(event); }
    catch { streamWarnings.add("onEvent callback threw; provider execution continued"); }
  };
  const processResult = await (options.execute ?? runInvocation)(invocation, {
    timeoutMs: request.timeoutMs!,
    ...(request.outputLimits ? { outputLimits: request.outputLimits } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.env ? { env: request.env } : {}),
    ...(invocation.structured ? {
      onStdoutLine: (line: string) => {
        const event = parser.push(line);
        if (event) emit(event);
      },
    } : {}),
  });
  // Injected executors return complete stdout; enforce the same retention
  // contract before parsing it. The native executor already stops at limits.
  const limits = { ...DEFAULT_OUTPUT_LIMITS, ...request.outputLimits };
  for (const stream of ["stdout", "stderr"] as const) {
    const limit = limits[stream === "stdout" ? "stdoutBytes" : "stderrBytes"];
    if (Buffer.byteLength(processResult[stream]) > limit) {
      processResult[stream] = utf8Prefix(processResult[stream], limit);
      processResult.outputLimitExceeded ??= stream;
    }
  }
  const decoded = invocation.structured
    ? options.execute ? parseJsonLines(request.provider, processResult.stdout) : parser.result()
    : undefined;
  const parsed = decoded && adapter.parseEvents
    ? { ...adapter.parseEvents(decoded.events, request), warnings: decoded.warnings,
        ...(decoded.error ? { protocolError: decoded.error, unreadable: true } : {}) }
    : adapter.parse(processResult.stdout, invocation.structured, request);
  if (!invocation.structured) for (const event of parsed.events) emit(event);
  const recovered = recoveryMetadata(parsed.events);
  const sessionId = parsed.sessionId ?? recovered.sessionId
    ?? (request.session?.mode === "resume" && !request.session.fork ? request.session.id
      : request.session?.mode === "persistent" ? request.session.id : undefined);
  const observed = parsed.modelObserved ?? recovered.modelObserved;
  const status = processResult.timedOut ? "timed-out"
    : processResult.cancelled ? "cancelled"
    : processResult.outputLimitExceeded || processResult.inputError || processResult.exitCode !== 0 ? "failed"
    : parsed.protocolError ? (parsed.unreadable ? "unparsed" : "failed") : "succeeded";
  const rejection = status === "failed"
    ? await modelRejectionWarnings(request, modelDefaulted,
      `${parsed.protocolError ?? ""}\n${processResult.stderr}\n${processResult.stdout}`, options)
    : [];
  const warnings = [...new Set([
    ...modelWarnings, ...streamWarnings, ...(parsed.warnings ?? []),
    ...(parsed.protocolError ? [parsed.protocolError] : []),
    ...(processResult.outputLimitExceeded ? [`provider ${processResult.outputLimitExceeded} exceeded the configured output limit; run stopped and output is incomplete`] : []),
    ...(processResult.inputError ? [processResult.inputError] : []),
    ...(processResult.exitCode !== 0 && !processResult.timedOut && !processResult.cancelled && !parsed.protocolError
      ? [`${request.provider} exited with ${String(processResult.exitCode)}`] : []),
    ...rejection,
  ])];
  return {
    provider: request.provider,
    status,
    ...(parsed.finalText !== undefined ? { finalText: parsed.finalText } : {}),
    ...(parsed.structuredOutput !== undefined ? { structuredOutput: parsed.structuredOutput } : {}),
    events: parsed.events,
    exitCode: processResult.exitCode,
    ...(sessionId ? { sessionId } : {}),
    ...(request.model ? { modelRequested: request.model } : {}),
    ...(modelDefaulted ? { modelDefaulted: true } : {}),
    ...(modelUncatalogued ? { modelUncatalogued: true } : {}),
    ...(observed ? { modelObserved: observed } : {}),
    ...(parsed.helperModelsObserved?.length ? { helperModelsObserved: parsed.helperModelsObserved } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    warnings,
    workspace: describeWorkspace(request, invocation.cwd, parsed.events, processResult.stdout, parsed.worktree),
    stderr: processResult.stderr,
    durationMs: processResult.durationMs,
  };
}

export async function getCapabilities(provider: Provider): Promise<ProviderCapabilities> {
  return await getAdapter(provider).capabilities();
}

export async function getAllCapabilities(): Promise<ProviderCapabilities[]> {
  return await Promise.all((["claude", "codex", "cursor", "antigravity"] as const).map(getCapabilities));
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
      `${result.provider} ${result.status}: ${result.stderr.trim() || result.warnings.join("; ") || "no provider diagnostic"}`,
    );
  }
}
