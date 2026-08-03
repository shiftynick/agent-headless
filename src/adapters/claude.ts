import { readFileSync } from "node:fs";
import { unsupported } from "../errors";
import { asRecord, numberValue, parseJsonLines } from "../jsonl";
import { readVersion } from "../process";
import type { AgentUsage, Invocation, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
import { assertAccess, assertSession, envExecutable, textOutput } from "./shared";

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  async capabilities(executable = envExecutable(this.provider)): Promise<ProviderCapabilities> {
    const cwd = process.cwd();
    const version = await readVersion(this.provider, executable, cwd);
    return {
      provider: this.provider,
      executable,
      ...(version ? { version } : {}),
      access: ["answer-only", "inspect", "edit-workspace", "edit-isolated"],
      sessions: ["ephemeral", "persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: false,
    };
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
    if (!trimmed) return { events: [], protocolError: "Claude returned no structured output" };

    if (!trimmed.includes("\n")) {
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        return this.parseRecords([{ provider: this.provider, type: String(raw.type ?? "result"), raw }]);
      } catch {
        return { events: [], protocolError: "Claude returned invalid JSON" };
      }
    }
    const parsed = parseJsonLines(this.provider, stdout);
    if (parsed.error) return { events: parsed.events, protocolError: parsed.error };
    return this.parseRecords(parsed.events);
  }

  private parseRecords(events: ParsedOutput["events"]): ParsedOutput {
    const terminal = [...events].reverse().find((event) => asRecord(event.raw)?.type === "result");
    const result = asRecord(terminal?.raw);
    if (!result) return { events, protocolError: "Claude stream did not contain a terminal result" };
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
    const firstModel = modelUsage ? asRecord(Object.values(modelUsage)[0]) : undefined;
    return {
      events,
      ...(typeof result.result === "string" ? { finalText: result.result } : {}),
      ...(typeof result.session_id === "string" ? { sessionId: result.session_id } : {}),
      ...(typeof firstModel?.canonicalModel === "string" ? { modelObserved: firstModel.canonicalModel } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}
