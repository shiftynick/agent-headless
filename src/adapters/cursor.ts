import { unsupported } from "../errors";
import { asRecord, numberValue, parseJsonLines } from "../jsonl";
import { readVersion, runInvocation } from "../process";
import type { AgentUsage, Invocation, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
import { assertAccess, assertSession, envExecutable, textOutput } from "./shared";

function cursorModel(model: string, effort: RunRequest["effort"]): string {
  if (!effort) return model;
  const suffix = model.match(/-(none|low|medium|high|xhigh|max|extra-high)(?:-fast)?$/u)?.[1];
  if (suffix === effort || (effort === "xhigh" && suffix === "extra-high")) return model;
  const match = model.match(/^(.*)\[([^\]]*)\]$/u);
  if (!match) return `${model}[effort=${effort}]`;
  const parameters = match[2]!;
  const existing = parameters.match(/(?:^|,)effort=([^,]+)/u)?.[1];
  if (existing === effort) return model;
  if (existing) return `${match[1]}[${parameters.replace(/(^|,)effort=[^,]+/u, `$1effort=${effort}`)}]`;
  return `${match[1]}[${parameters}${parameters ? "," : ""}effort=${effort}]`;
}

const modelPromises = new Map<string, Promise<string[]>>();

function parseModels(stdout: string): string[] {
  return stdout.split(/\r?\n/u)
    .map((line) => line.match(/^([^\s]+)\s+-\s+/u)?.[1])
    .filter((model): model is string => Boolean(model));
}

function modelWithEffort(model: string, effort: Exclude<RunRequest["effort"], undefined>): string {
  const fast = model.endsWith("-fast") ? "-fast" : "";
  const withoutFast = fast ? model.slice(0, -fast.length) : model;
  const match = withoutFast.match(/^(.*)-(none|low|medium|high|xhigh|max|extra-high)$/u);
  const base = match?.[1] ?? withoutFast;
  return `${base}-${effort}${fast}`;
}

export class CursorAdapter implements ProviderAdapter {
  readonly provider = "cursor" as const;

  async capabilities(executable = envExecutable(this.provider)): Promise<ProviderCapabilities> {
    const version = await readVersion(this.provider, executable, process.cwd());
    return {
      provider: this.provider,
      executable,
      ...(version ? { version } : {}),
      access: ["answer-only", "inspect", "edit-isolated"],
      sessions: ["persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: false,
      supportsModelListing: true,
    };
  }

  async listModels(executable = envExecutable(this.provider)): Promise<string[]> {
    let modelsPromise = modelPromises.get(executable);
    if (!modelsPromise) {
      modelsPromise = (async () => {
        const result = await runInvocation(
          { provider: this.provider, command: executable, args: ["models"], cwd: process.cwd(), stdin: "", structured: false },
          { timeoutMs: 30_000 },
        );
        if (result.exitCode !== 0) unsupported(`Cursor model listing failed: ${result.stderr.trim()}`);
        return parseModels(result.stdout);
      })();
      modelPromises.set(executable, modelsPromise);
    }
    return await modelsPromise;
  }

  async prepare(request: RunRequest): Promise<RunRequest> {
    if (!request.effort || !request.model || request.model.includes("[")) return request;
    const models = await this.listModels(envExecutable(this.provider, request.env));
    const candidate = modelWithEffort(request.model, request.effort);
    const xhighCandidate = request.effort === "xhigh"
      ? modelWithEffort(request.model, "high").replace(/-high(-fast)?$/u, "-extra-high$1")
      : undefined;
    const resolved = [candidate, xhighCandidate].find((value) => value && models.includes(value));
    if (resolved) return { ...request, model: resolved };
    if (models.includes(request.model)) {
      unsupported(`Cursor model ${request.model} has no available ${request.effort} effort variant; choose an exact model ID`);
    }
    return request;
  }

  build(request: RunRequest): Invocation {
    assertAccess(request, ["answer-only", "inspect", "edit-isolated"]);
    assertSession(request, ["persistent", "resume"]);
    if (!request.model) unsupported("Cursor requires an explicit model; use `agent models` to list choices");
    if (request.model.toLowerCase() === "auto") unsupported("Cursor model=auto is not allowed; name an exact model");
    if (request.schema) unsupported("Cursor does not support JSON Schema-constrained output");
    if (request.maxBudgetUsd !== undefined) unsupported("Cursor does not expose a per-run budget flag");

    const args = ["--print", "--workspace", request.cwd, "--model", cursorModel(request.model, request.effort)];
    const options = request.providerOptions?.cursor;
    if (options?.trustWorkspace) args.push("--trust");
    if (request.output === "events") {
      args.push("--output-format", "stream-json");
      if (options?.streamPartialOutput) args.push("--stream-partial-output");
    }
    if (request.access === "answer-only") args.push("--mode", "ask");
    if (request.access === "inspect") args.push("--mode", "plan");
    if (request.access === "edit-isolated") {
      args.push("--worktree");
      if (options?.worktreeName) args.push(options.worktreeName);
      if (options?.worktreeBase) args.push("--worktree-base", options.worktreeBase);
      args.push("--sandbox", "enabled");
    }
    if (request.session!.mode === "persistent" && request.session!.id) {
      unsupported("Cursor cannot select a session ID when starting a persistent session");
    }
    if (request.session!.mode === "resume") args.push("--resume", request.session!.id);
    for (const directory of request.additionalDirs ?? []) args.push("--add-dir", directory);

    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      structured: request.output === "events",
    };
  }

  parse(stdout: string, structured: boolean): ParsedOutput {
    if (!structured) return textOutput(this.provider, stdout);
    const parsed = parseJsonLines(this.provider, stdout);
    if (parsed.error) return { events: parsed.events, protocolError: parsed.error };
    const terminal = [...parsed.events].reverse().find((event) => event.type.startsWith("result"));
    const result = asRecord(terminal?.raw);
    if (!result) return { events: parsed.events, protocolError: "Cursor stream did not contain a terminal result" };
    if (result.is_error === true || result.subtype !== "success") {
      return { events: parsed.events, protocolError: String(result.result ?? "Cursor reported an error") };
    }
    const init = asRecord(parsed.events.find((event) => event.type.startsWith("system"))?.raw);
    const rawUsage = asRecord(result.usage);
    const usage: AgentUsage = {};
    const inputTokens = numberValue(rawUsage?.inputTokens);
    const cachedInputTokens = numberValue(rawUsage?.cacheReadTokens);
    const outputTokens = numberValue(rawUsage?.outputTokens);
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    return {
      events: parsed.events,
      ...(typeof result.result === "string" ? { finalText: result.result } : {}),
      ...(typeof result.session_id === "string" ? { sessionId: result.session_id } : typeof init?.session_id === "string" ? { sessionId: init.session_id } : {}),
      ...(typeof init?.model === "string" ? { modelObserved: init.model } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}
