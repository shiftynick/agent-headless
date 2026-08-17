import { readFileSync } from "node:fs";
import { unsupported } from "../errors";
import { asRecord, numberValue, parseJsonLines } from "../jsonl";
import { assertSupportedModel, isClaudeFable, supportedModels } from "../models";
import { probeExecutable } from "../process";
import type {
  AgentUsage,
  Invocation,
  ParsedOutput,
  PrepareOptions,
  ProviderAdapter,
  ProviderCapabilities,
  RunRequest,
} from "../types";
import {
  assertAccess,
  assertSession,
  envExecutable,
  findTerminalMarker,
  providerFailureMessage,
  textOutput,
} from "./shared";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function compatibleModelIdentity(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

interface ModelUsageEntry {
  model: string;
  outputTokens?: number;
}

function modelUsageEntries(modelUsage: Record<string, unknown> | undefined): ModelUsageEntry[] {
  const entries: ModelUsageEntry[] = [];
  for (const value of Object.values(modelUsage ?? {})) {
    const usage = asRecord(value);
    const model = stringValue(usage?.canonicalModel);
    if (!model) continue;
    const outputTokens = numberValue(usage?.outputTokens);
    const existing = entries.find((entry) => entry.model === model);
    if (existing) {
      if (outputTokens !== undefined) existing.outputTokens = (existing.outputTokens ?? 0) + outputTokens;
      continue;
    }
    entries.push({ model, ...(outputTokens !== undefined ? { outputTokens } : {}) });
  }
  return entries;
}

function usagePrincipal(entries: ModelUsageEntry[]): ModelUsageEntry | undefined {
  if (entries.length === 1) return entries[0];
  const measured = entries.filter((entry) => entry.outputTokens !== undefined);
  if (!measured.length) return undefined;
  const maximum = Math.max(...measured.map((entry) => entry.outputTokens!));
  const leaders = measured.filter((entry) => entry.outputTokens === maximum);
  return leaders.length === 1 ? leaders[0] : undefined;
}

function lastPrincipalAssistantModel(events: ParsedOutput["events"]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const raw = asRecord(events[index]?.raw);
    if (raw?.type !== "assistant" || raw.isSidechain === true || raw.parent_tool_use_id != null) continue;
    const model = stringValue(asRecord(raw.message)?.model);
    if (model) return model;
  }
  return undefined;
}

function lastInitModel(events: ParsedOutput["events"]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const raw = asRecord(events[index]?.raw);
    if (raw?.type === "system" && raw.subtype === "init") {
      const model = stringValue(raw.model);
      if (model) return model;
    }
  }
  return undefined;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  async capabilities(executable = envExecutable(this.provider)): Promise<ProviderCapabilities> {
    const cwd = process.cwd();
    const probe = await probeExecutable(this.provider, executable, cwd);
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.reason ? { availabilityReason: probe.reason } : {}),
      access: ["answer-only", "inspect", "edit-workspace", "edit-isolated"],
      sessions: ["ephemeral", "persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: true,
    };
  }

  async listModels(): Promise<string[]> {
    return supportedModels("claude");
  }

  async prepare(request: RunRequest, _options: PrepareOptions = {}): Promise<RunRequest> {
    if (request.model) assertSupportedModel("claude", request.model);
    if (request.model && isClaudeFable(request.model) && !request.effort) {
      return { ...request, effort: "low" };
    }
    return request;
  }

  build(request: RunRequest): Invocation {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace", "edit-isolated"]);
    assertSession(request, ["ephemeral", "persistent", "resume"]);
    const args = ["-p"];
    const options = request.providerOptions?.claude;

    if (request.output === "events") args.push("--output-format", "stream-json", "--verbose");
    if (request.model) args.push("--model", request.model);
    if (request.effort) args.push("--effort", request.effort);
    if (request.maxBudgetUsd) args.push("--max-budget-usd", String(request.maxBudgetUsd));
    if (request.schema) {
      const schema = typeof request.schema === "string"
        ? readFileSync(request.schema, "utf8")
        : JSON.stringify(request.schema);
      args.push("--json-schema", schema);
      if (request.output !== "events") args.push("--output-format", "json");
    }
    for (const directory of request.additionalDirs ?? []) args.push("--add-dir", directory);
    if (options?.safeMode) args.push("--safe-mode");

    if (request.access === "answer-only") {
      args.push("--permission-mode", "dontAsk", "--tools=");
    } else if (request.access === "inspect") {
      args.push("--permission-mode", "dontAsk", "--tools", ...(options?.allowedTools ?? ["Read", "Glob", "Grep"]));
    } else {
      args.push("--permission-mode", "acceptEdits");
      if (options?.allowedTools?.length) args.push("--allowedTools", ...options.allowedTools);
      if (request.access === "edit-isolated") {
        args.push("--worktree", options?.worktreeName ?? "agent-headless");
      }
    }

    const session = request.session!;
    if (session.mode === "ephemeral") args.push("--no-session-persistence");
    if (session.mode === "persistent" && session.id) args.push("--session-id", session.id);
    if (session.mode === "resume") {
      args.push("--resume", session.id);
      if (session.fork) args.push("--fork-session");
    }

    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      structured: request.output === "events" || request.schema !== undefined,
    };
  }

  parse(stdout: string, structured: boolean): ParsedOutput {
    if (!structured) return textOutput(this.provider, stdout);
    const trimmed = stdout.trim();
    if (!trimmed) return { events: [], protocolError: "Claude returned no structured output", unreadable: true };

    if (!trimmed.includes("\n")) {
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        return this.parseRecords([{ provider: this.provider, type: String(raw.type ?? "result"), kind: raw.is_error === true ? "error" : "result", raw }]);
      } catch {
        return { events: [], protocolError: "Claude returned invalid JSON", unreadable: true };
      }
    }
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error) return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };
    return { ...this.parseRecords(parsed.events), ...warnings };
  }

  private parseRecords(events: ParsedOutput["events"]): ParsedOutput {
    // Last terminal marker wins: a result followed by an `error` is a failure,
    // an `error` followed by a later result is a success.
    const terminal = findTerminalMarker(events, (event) => asRecord(event.raw)?.type === "result");
    if (terminal?.outcome === "failure") {
      // A failure Claude reported itself: the stream was readable, the run failed.
      return { events, protocolError: providerFailureMessage("Claude", terminal.event) };
    }
    const result = asRecord(terminal?.event.raw);
    if (!result) {
      // Readable, but with no terminal marker at all: genuinely ambiguous.
      return { events, protocolError: "Claude stream did not contain a terminal result", unreadable: true };
    }
    if (result.is_error === true) return { events, protocolError: String(result.result ?? "Claude reported an error") };
    const usageRaw = asRecord(result.usage);
    const usage: AgentUsage = {};
    const inputTokens = numberValue(usageRaw?.input_tokens);
    const cachedInputTokens = numberValue(usageRaw?.cache_read_input_tokens);
    const outputTokens = numberValue(usageRaw?.output_tokens);
    const costUsd = numberValue(result.total_cost_usd);
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    if (costUsd !== undefined) usage.costUsd = costUsd;
    const modelUsage = asRecord(result.modelUsage);
    const usageEntries = modelUsageEntries(modelUsage);
    const measuredPrincipal = usagePrincipal(usageEntries);
    // Claude's result.modelUsage includes internal helper models. The top-level
    // non-sidechain assistant stream names the principal model; init is the
    // next-best source. A usage-only result is attributable only when one model
    // is present or one model has a unique highest output-token count.
    const principalModel = lastPrincipalAssistantModel(events)
      ?? lastInitModel(events)
      ?? measuredPrincipal?.model;
    const exactUsage = principalModel
      ? usageEntries.find((entry) => entry.model === principalModel)
      : undefined;
    const compatibleUsage = principalModel
      ? usageEntries.filter((entry) => compatibleModelIdentity(entry.model, principalModel))
      : [];
    const principalUsage = exactUsage
      ?? (compatibleUsage.length === 1 ? compatibleUsage[0] : undefined)
      ?? (measuredPrincipal && principalModel
        && compatibleModelIdentity(measuredPrincipal.model, principalModel)
        ? measuredPrincipal
        : undefined);
    // Without a matched principal usage entry the full split is uncertain, but
    // incompatible entries are definitively not the principal and remain useful
    // helper evidence.
    const helperModels = principalUsage
      ? usageEntries.filter((entry) => entry !== principalUsage).map((entry) => entry.model)
      : principalModel
        ? usageEntries
          .filter((entry) => !compatibleModelIdentity(entry.model, principalModel))
          .map((entry) => entry.model)
        : [];
    return {
      events,
      ...(typeof result.result === "string" ? { finalText: result.result } : {}),
      ...(typeof result.session_id === "string" ? { sessionId: result.session_id } : {}),
      ...(principalModel ? { modelObserved: principalModel } : {}),
      ...(helperModels.length ? { helperModelsObserved: helperModels } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}
