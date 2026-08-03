import { AgentHeadlessError } from "./errors";
import { getAdapter } from "./adapters";
import { parseJsonEvent, parseJsonLines } from "./jsonl";
import { runInvocation } from "./process";
import type { AgentResult, Provider, ProviderCapabilities, RunAgentOptions, RunRequest } from "./types";
import { normalizeRequest } from "./validation";

export * from "./errors";
export * from "./types";
export { probeExecutable, resolveOnWindows, runInvocation } from "./process";
export { VERSION } from "./version";
export { ClaudeAdapter, CodexAdapter, CursorAdapter, getAdapter } from "./adapters";

export async function runAgent(input: RunRequest, options: RunAgentOptions = {}): Promise<AgentResult> {
  let request = normalizeRequest(input);
  const adapter = getAdapter(request.provider);
  if (adapter.prepare) request = await adapter.prepare(request);
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
    ...(structuredPartial?.error ? [structuredPartial.error] : []),
  ])];

  if (processResult.timedOut || processResult.cancelled) {
    return {
      provider: request.provider,
      status: processResult.timedOut ? "timed-out" : "cancelled",
      ...(partialFinalText !== undefined ? { finalText: partialFinalText } : {}),
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...(request.model ? { modelRequested: request.model } : {}),
      warnings: partialWarnings,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
    };
  }

  if (processResult.exitCode !== 0) {
    return {
      provider: request.provider,
      status: "failed",
      ...(partialFinalText !== undefined ? { finalText: partialFinalText } : {}),
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...(request.model ? { modelRequested: request.model } : {}),
      warnings: partialWarnings,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
    };
  }

  const parsed = adapter.parse(processResult.stdout, invocation.structured);
  if (!invocation.structured) for (const event of parsed.events) request.onEvent?.(event);
  const warnings = [...new Set([...streamWarnings, ...(parsed.protocolError ? [parsed.protocolError] : [])])];
  return {
    provider: request.provider,
    status: parsed.protocolError ? "failed" : "succeeded",
    ...(parsed.finalText !== undefined ? { finalText: parsed.finalText } : {}),
    events: parsed.events,
    exitCode: processResult.exitCode,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    ...(request.model ? { modelRequested: request.model } : {}),
    ...(parsed.modelObserved ? { modelObserved: parsed.modelObserved } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    warnings,
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

export async function listModels(provider: Provider): Promise<string[]> {
  const adapter = getAdapter(provider);
  if (!adapter.listModels) {
    throw new AgentHeadlessError("unsupported_capability", `${provider} does not expose model listing through its CLI`);
  }
  return await adapter.listModels();
}

export function assertSucceeded(result: AgentResult): asserts result is AgentResult & { status: "succeeded" } {
  if (result.status !== "succeeded") {
    throw new AgentHeadlessError(
      result.warnings.length ? "invalid_provider_output" : "provider_failed",
      `${result.provider} ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
}
