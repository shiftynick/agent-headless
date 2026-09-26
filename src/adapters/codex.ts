import { existsSync, openSync, closeSync, fstatSync, readSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unsupported } from "../errors";
import { asRecord, numberValue, parseJsonLines } from "../jsonl";
import { supportedModels } from "../models";
import { effectiveEnv, envValue, probeExecutable } from "../process";
import type {
  AgentUsage,
  Invocation,
  ParsedOutput,
  ProviderAdapter,
  ProviderCapabilities,
  RunRequest,
} from "../types";
import {
  assertAccess,
  assertSession,
  envExecutable,
  executableFeatures,
  recoveryMetadata,
  findTerminalMarker,
  providerFailureMessage,
  textOutput,
} from "./shared";

/** Codex's own terminal markers: exactly one of these ends a well-formed turn. */
const CODEX_FAILURE_TYPES = ["turn.failed"] as const;

/**
 * Codex's JSON event stream carries no model field, so the effective model is
 * recoverable only from the session rollout file, which records it on every
 * turn_context line. Ephemeral runs persist no rollout; for them attribution
 * stays honestly absent rather than echoing the request.
 */
function observedRollout(threadId: string, request?: RunRequest): Pick<ParsedOutput, "modelObserved" | "worktree"> {
  if (request?.session?.mode === "ephemeral") return {};
  try {
    const env = effectiveEnv(request?.env);
    const root = path.join(
      envValue(env, "CODEX_HOME") ?? path.join(envValue(env, process.platform === "win32" ? "USERPROFILE" : "HOME") || os.homedir(), ".codex"),
      "sessions",
    );
    if (!existsSync(root)) return {};
    const rollout = findRolloutFile(root, threadId);
    if (!rollout) return {};
    let model: string | undefined;
    let cwd: string | undefined;
    // Only recent turn context is needed. Never load a long session transcript
    // into memory just to recover its model or worktree location.
    const fd = openSync(rollout, "r");
    let tail: string;
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const count = readSync(fd, buffer, 0, length, size - length);
      tail = buffer.subarray(0, count).toString("utf8");
    } finally { closeSync(fd); }
    for (const line of tail.split("\n")) {
      if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
      try {
        const record = asRecord(JSON.parse(line));
        if (record?.type !== "turn_context" && record?.type !== "session_meta") continue;
        const payload = asRecord(record.payload);
        if (typeof payload?.model === "string") model = payload.model;
        if (typeof payload?.cwd === "string") cwd = payload.cwd;
      } catch {
        // A malformed line invalidates itself, not the rest of the rollout.
      }
    }
    return {
      ...(model ? { modelObserved: model } : {}),
      ...(request?.access === "edit-isolated" && cwd && path.isAbsolute(cwd) && path.resolve(cwd) !== path.resolve(request.cwd) ? { worktree: cwd } : {}),
    };
  } catch {
    return {};
  }
}

/** Rollouts are date-partitioned (YYYY/MM/DD); scan newest-first, bounded. */
function findRolloutFile(root: string, threadId: string, depth = 0, budget = { remaining: 10_000 }): string | undefined {
  const entries = readdirSync(root, { withFileTypes: true })
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    if (--budget.remaining < 0) return undefined;
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) return full;
    if (entry.isDirectory() && depth < 3) {
      const found = findRolloutFile(full, threadId, depth + 1, budget);
      if (found) return found;
    }
  }
  return undefined;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;

  async capabilities(executable = envExecutable(this.provider)): Promise<ProviderCapabilities> {
    const probe = await probeExecutable(this.provider, executable, process.cwd());
    const features = probe.availability === "available" ? await executableFeatures(this.provider, executable, ["exec", "--help"]) : [];
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.reason ? { availabilityReason: probe.reason } : {}),
      access: ["answer-only", "inspect", "edit-workspace", "inherit-session", ...(features.includes("--worktree") ? ["edit-isolated" as const] : [])],
      sessions: ["ephemeral", "persistent", "resume"],
      supportsFork: features.includes("fork"),
      detectedFeatures: features,
      supportsModel: features.includes("--model"),
      supportsEffort: true,
      supportsSchema: features.includes("--output-schema"),
      supportsModelListing: true,
    };
  }

  async listModels(): Promise<string[]> {
    return supportedModels("codex");
  }

  build(request: RunRequest): Invocation {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace", "edit-isolated", "inherit-session"]);
    if (request.access === "edit-isolated" && request.session?.mode === "ephemeral") {
      unsupported("Codex isolated work requires a persistent session so its worktree can be recovered");
    }
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
    if (request.additionalDirs?.length && request.access !== "edit-workspace" && request.access !== "edit-isolated") {
      unsupported("Codex additionalDirs are writable and require access=edit-workspace");
    }
    const args = session.mode === "resume"
      ? ["exec", session.fork ? "fork" : "resume", session.id]
      : ["exec", "-C", request.cwd, "-s", (request.access === "edit-workspace" || request.access === "edit-isolated") ? "workspace-write" : "read-only"];

    if (session.mode !== "resume") {
      if (request.access === "edit-isolated") args.push("--worktree");
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

  parse(stdout: string, structured: boolean, request?: RunRequest): ParsedOutput {
    if (!structured) return textOutput(this.provider, stdout);
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error) return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };
    return { ...this.parseEvents(parsed.events, request), ...warnings };
  }

  parseEvents(events: ParsedOutput["events"], request?: RunRequest): ParsedOutput {
    const recovered = recoveryMetadata(events);
    const metadata = { ...recovered, ...(recovered.sessionId ? observedRollout(recovered.sessionId, request) : {}) };
    const started = events.find((event) => event.type === "thread.started");
    const messages = events
      .map((event) => asRecord(event.raw))
      .map((raw) => asRecord(raw?.item))
      .filter((item) => item?.type === "agent_message" && typeof item.text === "string");
    // The last terminal marker wins, so a retry that completes is not overruled
    // by an earlier failure and vice versa.
    const terminal = findTerminalMarker(
      events,
      (event) => event.type === "turn.completed",
      CODEX_FAILURE_TYPES,
    );
    if (terminal?.outcome === "failure") {
      // A failure Codex reported itself: the stream was readable, the run failed.
      return { ...metadata, events: events, protocolError: providerFailureMessage("Codex", terminal.event) };
    }
    const completed = terminal?.event;
    if (!completed) {
      // Readable, but with no terminal marker at all: genuinely ambiguous.
      return { ...metadata, events: events, protocolError: "Codex stream did not contain turn.completed", unreadable: true };
    }
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
    const threadId = typeof startRaw?.thread_id === "string" ? startRaw.thread_id : undefined;

    return {
      events: events,
      ...(typeof lastMessage?.text === "string" ? { finalText: lastMessage.text } : {}),
      ...(threadId ? { sessionId: threadId } : {}),
      ...metadata,
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}
