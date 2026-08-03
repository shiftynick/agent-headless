import { AgentHeadlessError } from "./errors";
import { getAdapter } from "./adapters";
import { parseJsonEvent } from "./jsonl";
import { runInvocation } from "./process";
import type { AgentResult, Provider, ProviderCapabilities, RunRequest } from "./types";
import { normalizeRequest } from "./validation";

export * from "./errors";
export * from "./types";
export { ClaudeAdapter, CodexAdapter, CursorAdapter, getAdapter } from "./adapters";

export async function runAgent(input: RunRequest): Promise<AgentResult> {
  let request = normalizeRequest(input);
  const adapter = getAdapter(request.provider);
  if (adapter.prepare) request = await adapter.prepare(request);
  const invocation = adapter.build(request);
  const processResult = await runInvocation(invocation, {
    timeoutMs: request.timeoutMs!,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.env ? { env: request.env } : {}),
    ...(invocation.structured && request.onEvent ? {
      onStdoutLine: (line: string) => {
        try { request.onEvent?.(parseJsonEvent(request.provider, line)); } catch { /* final parsing reports protocol errors */ }
      },
    } : {}),
  });

  if (processResult.timedOut || processResult.cancelled) {
    return {
      provider: request.provider,
      status: processResult.timedOut ? "timed-out" : "cancelled",
      events: [],
      exitCode: processResult.exitCode,
      ...(request.model ? { modelRequested: request.model } : {}),
      warnings: [],
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
    };
  }

  if (processResult.exitCode !== 0) {
    return {
      provider: request.provider,
      status: "failed",
      events: [],
      exitCode: processResult.exitCode,
      ...(request.model ? { modelRequested: request.model } : {}),
      warnings: [],
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
    };
  }

  const parsed = adapter.parse(processResult.stdout, invocation.structured);
  if (!invocation.structured) for (const event of parsed.events) request.onEvent?.(event);
  const warnings = parsed.protocolError ? [parsed.protocolError] : [];
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
