import path from "node:path";
import { unsupported } from "../errors";
import { asRecord, numberValue, parseJsonLines } from "../jsonl";
import { probeExecutable } from "../process";
import type { AgentUsage, Invocation, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
import { assertAccess, assertSession, envExecutable, textOutput } from "./shared";

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;

  async capabilities(executable = envExecutable(this.provider)): Promise<ProviderCapabilities> {
    const probe = await probeExecutable(this.provider, executable, process.cwd());
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.reason ? { availabilityReason: probe.reason } : {}),
      access: ["answer-only", "inspect", "edit-workspace", "inherit-session"],
      sessions: ["ephemeral", "persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: false,
    };
  }

  build(request: RunRequest): Invocation {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace", "inherit-session"]);
    assertSession(request, ["ephemeral", "persistent", "resume"]);
    if (request.maxBudgetUsd !== undefined) unsupported("Codex does not expose a per-run budget flag");
    if (request.schema && typeof request.schema !== "string") {
      unsupported("Codex schema must be a JSON Schema file path");
    }
    if (request.effort === "max") unsupported("Codex effort=max is not supported by the current adapter");

    const session = request.session!;
    if (session.mode === "resume" && request.access !== "inherit-session") {
      unsupported("Codex resume inherits its original access boundary; use access=inherit-session");
    }
    if (session.mode !== "resume" && request.access === "inherit-session") {
      unsupported("Codex access=inherit-session is only valid when resuming");
    }
    if (session.mode === "persistent" && session.id) {
      unsupported("Codex cannot select a session ID when starting a persistent session");
    }
    if (request.additionalDirs?.length && request.access !== "edit-workspace") {
      unsupported("Codex additionalDirs are writable and require access=edit-workspace");
    }
    const args = session.mode === "resume"
      ? ["exec", "resume", session.id]
      : ["exec", "-C", request.cwd, "-s", request.access === "edit-workspace" ? "workspace-write" : "read-only"];

    if (session.mode !== "resume") {
      if (session.mode === "ephemeral") args.push("--ephemeral");
      for (const directory of request.additionalDirs ?? []) args.push("--add-dir", directory);
      if (request.providerOptions?.codex?.skipGitRepoCheck) args.push("--skip-git-repo-check");
      if (request.providerOptions?.codex?.profile) args.push("--profile", request.providerOptions.codex.profile);
    } else if (request.additionalDirs?.length) {
      unsupported("Codex resume cannot change additional directories");
    }
    if (request.model) args.push("--model", request.model);
    if (request.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(request.effort)}`);
    if (request.schema) args.push("--output-schema", path.resolve(request.schema));
    if (request.output === "events") args.push("--json");
    args.push("-");
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
    const started = parsed.events.find((event) => event.type === "thread.started");
    const completed = [...parsed.events].reverse().find((event) => event.type === "turn.completed");
    const messages = parsed.events
      .map((event) => asRecord(event.raw))
      .map((raw) => asRecord(raw?.item))
      .filter((item) => item?.type === "agent_message" && typeof item.text === "string");
    if (!completed) return { events: parsed.events, protocolError: "Codex stream did not contain turn.completed" };
    const startRaw = asRecord(started?.raw);
    const completeRaw = asRecord(completed.raw);
    const rawUsage = asRecord(completeRaw?.usage);
    const usage: AgentUsage = {};
    const inputTokens = numberValue(rawUsage?.input_tokens);
    const cachedInputTokens = numberValue(rawUsage?.cached_input_tokens);
    const outputTokens = numberValue(rawUsage?.output_tokens);
    const reasoningOutputTokens = numberValue(rawUsage?.reasoning_output_tokens);
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
    const lastMessage = messages.at(-1);
    return {
      events: parsed.events,
      ...(typeof lastMessage?.text === "string" ? { finalText: lastMessage.text } : {}),
      ...(typeof startRaw?.thread_id === "string" ? { sessionId: startRaw.thread_id } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}
