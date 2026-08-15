import { providerFailure, assertAccess, assertSession, envExecutable, textOutput } from "./shared";
import { asRecord, numberValue, parseJsonLines } from "../jsonl";
import { probeExecutable, runInvocation } from "../process";
import { unsupported } from "../errors";
import type {
  AgentEvent,
  AgentUsage,
  Invocation,
  ListModelsOptions,
  ParsedOutput,
  ProviderAdapter,
  ProviderCapabilities,
  RunRequest,
} from "../types";

const AGY_MODEL_LINE = /^([^\t\s]+)\t/u;

function usageFrom(raw: Record<string, unknown> | undefined): AgentUsage | undefined {
  const usage: AgentUsage = {};
  const inputTokens = numberValue(raw?.input_tokens);
  const cachedInputTokens = numberValue(raw?.cache_read_tokens);
  const outputTokens = numberValue(raw?.output_tokens);
  const reasoningOutputTokens = numberValue(raw?.thinking_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
  return Object.keys(usage).length ? usage : undefined;
}

function resultRecord(event: AgentEvent | undefined): Record<string, unknown> | undefined {
  return asRecord(asRecord(event?.raw)?.result);
}

function reportedFailure(result: Record<string, unknown>): string {
  const status = typeof result.status === "string" ? result.status : "failure";
  const response = typeof result.response === "string" && result.response.trim()
    ? `: ${result.response.trim()}`
    : "";
  return `Antigravity reported ${status}${response}`;
}

/** Adapter for Antigravity CLI (`agy`) print mode. */
export class AntigravityAdapter implements ProviderAdapter {
  readonly provider = "antigravity" as const;

  async capabilities(executable = envExecutable(this.provider)): Promise<ProviderCapabilities> {
    const probe = await probeExecutable(this.provider, executable, process.cwd());
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.reason ? { availabilityReason: probe.reason } : {}),
      // AGY's plan mode presents a read-first plan before writing. It is not a
      // filesystem sandbox, so callers still need its separately configured
      // command permissions for any shell tool the model proposes.
      access: ["answer-only", "inspect", "edit-workspace"],
      sessions: ["persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: true,
    };
  }

  async listModels(options: ListModelsOptions = {}): Promise<string[]> {
    const command = options.executable ?? envExecutable(this.provider, options.env);
    const result = await runInvocation(
      { provider: this.provider, command, args: ["models"], cwd: process.cwd(), stdin: "", structured: false },
      { timeoutMs: 20_000, ...(options.env ? { env: options.env } : {}) },
    );
    if (result.exitCode !== 0) throw providerFailure(this.provider, result.exitCode, result.stderr);
    return [...new Set(result.stdout
      .split(/\r?\n/u)
      .map((line) => line.match(AGY_MODEL_LINE)?.[1])
      .filter((model): model is string => model !== undefined))];
  }

  build(request: RunRequest): Invocation {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace"]);
    assertSession(request, ["persistent", "resume"]);
    if (request.maxBudgetUsd !== undefined) unsupported("Antigravity does not expose a per-run budget flag");
    if (request.effort === "xhigh" || request.effort === "max") {
      unsupported("Antigravity effort supports low, medium, or high");
    }
    const session = request.session!;
    if (session.mode === "persistent" && session.id) {
      unsupported("Antigravity cannot select a conversation ID when starting a persistent session");
    }

    const options = request.providerOptions?.antigravity;
    const args = ["--print", request.prompt, "--output-format", request.output === "events" ? "stream-json" : "text"];
    // Keep AGY's own print deadline aligned with the runner's requested limit,
    // rather than silently falling back to AGY's shorter five-minute default.
    args.push("--print-timeout", `${request.timeoutMs!}ms`);
    if (request.access === "edit-workspace") args.push("--mode", "accept-edits");
    else args.push("--mode", "plan");
    if (session.mode === "resume") args.push("--conversation", session.id);
    if (request.model) args.push("--model", request.model);
    if (request.effort) args.push("--effort", request.effort);
    if (request.schema !== undefined) {
      args.push("--json-schema", typeof request.schema === "string" ? request.schema : JSON.stringify(request.schema));
    }
    for (const directory of request.additionalDirs ?? []) args.push("--add-dir", directory);
    if (options?.sandbox) args.push("--sandbox");
    if (options?.agent) args.push("--agent", options.agent);
    if (options?.project) args.push("--project", options.project);

    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: "",
      structured: request.output === "events",
    };
  }

  parse(stdout: string, structured: boolean): ParsedOutput {
    if (!structured) return textOutput(this.provider, stdout);
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error) return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };

    // AGY emits exactly one terminal `result` per print run. Scan from the end
    // so an explicit stream error after a nominal result still wins.
    let terminal: AgentEvent | undefined;
    let terminalFailure: AgentEvent | undefined;
    for (let index = parsed.events.length - 1; index >= 0; index -= 1) {
      const event = parsed.events[index]!;
      if (event.kind === "error") {
        terminalFailure = event;
        break;
      }
      if (event.type === "result") {
        terminal = event;
        break;
      }
    }
    if (terminalFailure) {
      const raw = asRecord(terminalFailure.raw);
      const message = typeof raw?.message === "string" ? `: ${raw.message}` : "";
      return { events: parsed.events, protocolError: `Antigravity reported ${terminalFailure.type}${message}`, ...warnings };
    }
    const result = resultRecord(terminal);
    if (!result) {
      return {
        events: parsed.events,
        protocolError: "Antigravity stream did not contain a terminal result",
        unreadable: true,
        ...warnings,
      };
    }
    if (result.status !== "SUCCESS") {
      return { events: parsed.events, protocolError: reportedFailure(result), ...warnings };
    }
    const init = asRecord(parsed.events.find((event) => event.type === "init")?.raw);
    const initDetails = asRecord(init?.init);
    const conversationId = result.conversation_id ?? init?.conversation_id;
    const usage = usageFrom(asRecord(result.usage));
    return {
      events: parsed.events,
      ...(typeof result.response === "string" ? { finalText: result.response } : {}),
      ...(typeof conversationId === "string" && conversationId ? { sessionId: conversationId } : {}),
      ...(typeof initDetails?.model === "string" ? { modelObserved: initDetails.model } : {}),
      ...(usage ? { usage } : {}),
      ...warnings,
    };
  }
}
