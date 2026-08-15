#!/usr/bin/env node

// src/errors.ts
class AgentHeadlessError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "AgentHeadlessError";
  }
}
function invalid(message) {
  throw new AgentHeadlessError("invalid_request", message);
}
function unsupported(message) {
  throw new AgentHeadlessError("unsupported_capability", message);
}

// src/adapters/claude.ts
import { readFileSync } from "node:fs";

// src/jsonl.ts
function eventKind(provider, type, raw) {
  const lower = type.toLowerCase();
  if (provider === "antigravity") {
    if (lower === "init")
      return "session";
    if (lower === "result")
      return "result";
    if (lower === "step_update") {
      const step = asRecord(raw.step_update);
      if (step?.step_type === "agent_response")
        return "message";
      if (typeof step?.step_type === "string" && step.step_type.includes("tool"))
        return "tool";
      return "status";
    }
    if (lower === "command_result")
      return "status";
  }
  if (lower.includes("error") || raw.is_error === true)
    return "error";
  if (lower.startsWith("result") || lower === "turn.completed")
    return "result";
  if (lower === "thread.started" || lower === "system.init")
    return "session";
  const item = asRecord(raw.item);
  if (item?.type === "agent_message" || lower.startsWith("assistant"))
    return "message";
  if (item && item.type !== "agent_message" || lower.includes("tool"))
    return "tool";
  if (lower.startsWith("system") || lower.startsWith("turn."))
    return "status";
  if (provider === "claude" && lower.startsWith("user"))
    return "status";
  return "unknown";
}
var MAX_JSONL_WARNINGS = 5;
function parseJsonLines(provider, stdout) {
  const events = [];
  const warnings = [];
  let skipped = 0;
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
  for (let index = 0;index < lines.length; index += 1) {
    const line = lines[index];
    try {
      events.push(parseJsonEvent(provider, line));
    } catch {
      skipped += 1;
      if (warnings.length < MAX_JSONL_WARNINGS)
        warnings.push(`skipped unparseable JSONL at line ${index + 1}`);
    }
  }
  if (skipped > warnings.length) {
    warnings.push(`skipped ${skipped} unparseable JSONL lines in total (${warnings.length} listed)`);
  }
  if (!events.length && skipped > 0) {
    return { events, warnings, error: `invalid JSONL: no parseable lines in ${skipped} line(s) of provider output` };
  }
  return { events, warnings };
}
function parseJsonEvent(provider, line) {
  const raw = JSON.parse(line);
  const rawType = typeof raw.type === "string" ? raw.type : provider === "antigravity" && typeof raw.event === "string" ? raw.event : "unknown";
  const subtype = typeof raw.subtype === "string" ? `.${raw.subtype}` : "";
  const type = `${rawType}${subtype}`;
  return { provider, type, kind: eventKind(provider, type, raw), raw };
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// src/models.ts
var SUPPORTED_MODELS = Object.freeze({
  claude: Object.freeze(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]),
  codex: Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
  cursor: Object.freeze([
    "cursor-grok-4.5-low",
    "cursor-grok-4.5-medium",
    "cursor-grok-4.5-high",
    "composer-2.5",
    "composer-2.5-fast"
  ]),
  antigravity: Object.freeze([])
});
var CLAUDE_MODEL_ALIASES = Object.freeze({
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5"
});
function supportedModels(provider) {
  return [...SUPPORTED_MODELS[provider]];
}
function normalizeClaudeModel(model) {
  return CLAUDE_MODEL_ALIASES[model] ?? model;
}
function isClaudeFable(model) {
  return normalizeClaudeModel(model) === "claude-fable-5";
}
function assertSupportedModel(provider, model) {
  if (provider === "claude") {
    if (!SUPPORTED_MODELS.claude.includes(normalizeClaudeModel(model))) {
      unsupported(`Claude model "${model}" is not in the supported list; run \`agent-headless models claude\``);
    }
    return;
  }
  if (provider === "codex") {
    if (!SUPPORTED_MODELS.codex.includes(model)) {
      unsupported(`Codex model "${model}" is not in the supported list; run \`agent-headless models codex\``);
    }
    return;
  }
  if (provider === "antigravity")
    return;
  if (/^cursor-grok-.*-fast$/u.test(model)) {
    unsupported(`Cursor Grok fast variants are not allowed; use ${model.replace(/-fast$/u, "")}`);
  }
  if (!SUPPORTED_MODELS.cursor.includes(model)) {
    unsupported(`Cursor model "${model}" is not in the supported list; run \`agent-headless models cursor\``);
  }
}

// src/process.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
function foldEnvName(name) {
  return process.platform === "win32" ? name.toLowerCase() : name;
}
function lastEnvMatch(env, name) {
  const target = foldEnvName(name);
  let matched = false;
  let value;
  for (const key of Object.keys(env)) {
    if (foldEnvName(key) === target) {
      matched = true;
      value = env[key];
    }
  }
  return { matched, value };
}
function envValue(env, name) {
  if (process.platform !== "win32")
    return env[name];
  return lastEnvMatch(env, name).value;
}
function resolveOnWindows(command, env) {
  if (process.platform !== "win32" || path.isAbsolute(command) || /[\\/]/u.test(command))
    return command;
  const pathValue = envValue(env, "PATH") ?? "";
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate))
        return candidate;
    }
  }
  return command;
}
function effectiveEnv(overrides) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const existing = process.platform === "win32" ? Object.keys(env).find((candidate) => foldEnvName(candidate) === foldEnvName(key)) : key;
    if (existing && existing !== key)
      delete env[existing];
    if (value === undefined)
      delete env[key];
    else
      env[key] = value;
  }
  return env;
}
function resolveCommand(command, args, env) {
  const resolved = resolveOnWindows(command, env);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(resolved)) {
    const commandLine = `"${[resolved, ...args].map(quoteCmd).join(" ")}"`;
    return {
      command: envValue(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true
    };
  }
  return { command: resolved, args: [...args], windowsVerbatimArguments: false };
}
function quoteCmd(value) {
  if (/[\r\n%!]/u.test(value)) {
    throw new AgentHeadlessError("invalid_request", "A Windows .cmd argument contains newline, % or !; configure the provider executable directly.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}
async function runInvocation(invocation, options) {
  const started = Date.now();
  if (options.signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: null, durationMs: 0, timedOut: false, cancelled: true };
  }
  const env = effectiveEnv(options.env);
  const { command, args, windowsVerbatimArguments } = resolveCommand(invocation.command, invocation.args, env);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let pendingLine = "";
    const child = spawn(command, args, {
      cwd: invocation.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments,
      detached: process.platform !== "win32"
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.onStdoutLine) {
        pendingLine += chunk;
        const lines = pendingLine.split(/\r?\n/u);
        pendingLine = lines.pop() ?? "";
        for (const line of lines)
          if (line.trim())
            options.onStdoutLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let terminationRequested = false;
    let forceTimer;
    const forceKill = () => {
      if (!child.pid)
        return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        killer.on("error", () => {
          child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const terminate = () => {
      if (terminationRequested)
        return;
      terminationRequested = true;
      if (process.platform === "win32" && child.pid) {
        forceKill();
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        forceTimer = setTimeout(forceKill, 2000);
        forceTimer.unref();
      } else {
        child.kill("SIGTERM");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const abort = () => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted)
      abort();
    child.stdin.end(invocation.stdin, "utf8");
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceTimer)
        clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error.code === "ENOENT") {
        reject(new AgentHeadlessError("not_installed", `${invocation.provider} executable not found: ${invocation.command}`, { cause: error }));
      } else {
        reject(new AgentHeadlessError("provider_failed", `Unable to start ${invocation.provider}: ${error.message}`, { cause: error }));
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (forceTimer)
        clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.onStdoutLine && pendingLine.trim())
        options.onStdoutLine(pendingLine);
      resolve({ stdout, stderr, exitCode, durationMs: Date.now() - started, timedOut, cancelled });
    });
  });
}
async function probeExecutable(provider, command, cwd) {
  const env = { ...process.env };
  const executable = resolveOnWindows(command, env);
  try {
    const result = await runInvocation({ provider, command, args: ["--version"], cwd, stdin: "", structured: false }, { timeoutMs: 1e4 });
    if (result.exitCode !== 0) {
      return {
        executable,
        availability: "unusable",
        reason: result.stderr.trim() || `${provider} --version exited with ${String(result.exitCode)}`
      };
    }
    const version = result.stdout.trim();
    return { executable, availability: "available", ...version ? { version } : {} };
  } catch (error) {
    const missing = error instanceof AgentHeadlessError && error.code === "not_installed";
    return {
      executable,
      availability: missing ? "missing" : "unusable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

// src/adapters/shared.ts
import { existsSync as existsSync2 } from "node:fs";
import path2 from "node:path";
var ERROR_TYPE = /^error(?:\.|$)/u;
function isExplicitFailure(event, extraTypes = []) {
  return ERROR_TYPE.test(event.type) || extraTypes.includes(event.type);
}
function findTerminalMarker(events, isSuccess, extraFailureTypes = []) {
  for (let index = events.length - 1;index >= 0; index -= 1) {
    const event = events[index];
    if (isExplicitFailure(event, extraFailureTypes))
      return { outcome: "failure", event };
    if (isSuccess(event))
      return { outcome: "success", event };
  }
  return;
}
function providerFailureMessage(label, event) {
  const raw = asRecord(event.raw);
  const candidates = [
    asRecord(raw?.error)?.message,
    raw?.message,
    raw?.error,
    raw?.reason,
    asRecord(raw?.item)?.message
  ];
  const detail = candidates.find((value) => typeof value === "string" && value.trim());
  return `${label} reported ${event.type}${typeof detail === "string" ? `: ${detail.trim()}` : ""}`;
}
function envExecutable(provider, requestEnv) {
  const key = provider === "claude" ? "CLAUDE_BIN" : provider === "codex" ? "CODEX_BIN" : provider === "cursor" ? "CURSOR_AGENT_BIN" : "AGY_BIN";
  const fallback = provider === "cursor" ? "agent" : provider === "antigravity" ? "agy" : provider;
  const env = effectiveEnv(requestEnv);
  const override = envValue(env, key);
  if (override)
    return override;
  if (provider !== "antigravity" || process.platform !== "win32")
    return fallback;
  const pathExecutable = resolveOnWindows(fallback, env);
  if (pathExecutable !== fallback)
    return pathExecutable;
  const localAppData = envValue(env, "LOCALAPPDATA");
  const installed = localAppData && path2.join(localAppData, "agy", "bin", "agy.exe");
  return installed && existsSync2(installed) ? installed : fallback;
}
function assertAccess(request, allowed) {
  if (!allowed.includes(request.access)) {
    unsupported(`${request.provider} does not support access=${request.access}; supported: ${allowed.join(", ")}`);
  }
}
function assertSession(request, allowed) {
  if (!allowed.includes(request.session.mode)) {
    unsupported(`${request.provider} does not support session=${request.session.mode}; supported: ${allowed.join(", ")}`);
  }
}
function textOutput(provider, stdout) {
  return { finalText: stdout.replace(/\r?\n$/u, ""), events: [{ provider, type: "result", kind: "result", raw: stdout }] };
}
function providerFailure(provider, exitCode, stderr) {
  const detail = stderr.trim().split(/\r?\n/u).slice(-6).join(`
`);
  return new AgentHeadlessError("provider_failed", `${provider} failed with exit code ${String(exitCode)}${detail ? `:
${detail}` : ""}`);
}

// src/adapters/claude.ts
class ClaudeAdapter {
  provider = "claude";
  async capabilities(executable = envExecutable(this.provider)) {
    const cwd = process.cwd();
    const probe = await probeExecutable(this.provider, executable, cwd);
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...probe.version ? { version: probe.version } : {},
      ...probe.reason ? { availabilityReason: probe.reason } : {},
      access: ["answer-only", "inspect", "edit-workspace", "edit-isolated"],
      sessions: ["ephemeral", "persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: true
    };
  }
  async listModels() {
    return supportedModels("claude");
  }
  async prepare(request, _options = {}) {
    if (request.model)
      assertSupportedModel("claude", request.model);
    if (request.model && isClaudeFable(request.model) && !request.effort) {
      return { ...request, effort: "low" };
    }
    return request;
  }
  build(request) {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace", "edit-isolated"]);
    assertSession(request, ["ephemeral", "persistent", "resume"]);
    const args = ["-p"];
    const options = request.providerOptions?.claude;
    if (request.output === "events")
      args.push("--output-format", "stream-json", "--verbose");
    if (request.model)
      args.push("--model", request.model);
    if (request.effort)
      args.push("--effort", request.effort);
    if (request.maxBudgetUsd)
      args.push("--max-budget-usd", String(request.maxBudgetUsd));
    if (request.schema) {
      const schema = typeof request.schema === "string" ? readFileSync(request.schema, "utf8") : JSON.stringify(request.schema);
      args.push("--json-schema", schema);
      if (request.output !== "events")
        args.push("--output-format", "json");
    }
    for (const directory of request.additionalDirs ?? [])
      args.push("--add-dir", directory);
    if (options?.safeMode)
      args.push("--safe-mode");
    if (request.access === "answer-only") {
      args.push("--permission-mode", "dontAsk", "--tools=");
    } else if (request.access === "inspect") {
      args.push("--permission-mode", "dontAsk", "--tools", ...options?.allowedTools ?? ["Read", "Glob", "Grep"]);
    } else {
      args.push("--permission-mode", "acceptEdits");
      if (options?.allowedTools?.length)
        args.push("--allowedTools", ...options.allowedTools);
      if (request.access === "edit-isolated") {
        args.push("--worktree", options?.worktreeName ?? "agent-headless");
      }
    }
    const session = request.session;
    if (session.mode === "ephemeral")
      args.push("--no-session-persistence");
    if (session.mode === "persistent" && session.id)
      args.push("--session-id", session.id);
    if (session.mode === "resume") {
      args.push("--resume", session.id);
      if (session.fork)
        args.push("--fork-session");
    }
    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      structured: request.output === "events" || request.schema !== undefined
    };
  }
  parse(stdout, structured) {
    if (!structured)
      return textOutput(this.provider, stdout);
    const trimmed = stdout.trim();
    if (!trimmed)
      return { events: [], protocolError: "Claude returned no structured output", unreadable: true };
    if (!trimmed.includes(`
`)) {
      try {
        const raw = JSON.parse(trimmed);
        return this.parseRecords([{ provider: this.provider, type: String(raw.type ?? "result"), kind: raw.is_error === true ? "error" : "result", raw }]);
      } catch {
        return { events: [], protocolError: "Claude returned invalid JSON", unreadable: true };
      }
    }
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };
    return { ...this.parseRecords(parsed.events), ...warnings };
  }
  parseRecords(events) {
    const terminal = findTerminalMarker(events, (event) => asRecord(event.raw)?.type === "result");
    if (terminal?.outcome === "failure") {
      return { events, protocolError: providerFailureMessage("Claude", terminal.event) };
    }
    const result = asRecord(terminal?.event.raw);
    if (!result) {
      return { events, protocolError: "Claude stream did not contain a terminal result", unreadable: true };
    }
    if (result.is_error === true)
      return { events, protocolError: String(result.result ?? "Claude reported an error") };
    const usageRaw = asRecord(result.usage);
    const usage = {};
    const inputTokens = numberValue(usageRaw?.input_tokens);
    const cachedInputTokens = numberValue(usageRaw?.cache_read_input_tokens);
    const outputTokens = numberValue(usageRaw?.output_tokens);
    const costUsd = numberValue(result.total_cost_usd);
    if (inputTokens !== undefined)
      usage.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined)
      usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined)
      usage.outputTokens = outputTokens;
    if (costUsd !== undefined)
      usage.costUsd = costUsd;
    const modelUsage = asRecord(result.modelUsage);
    const firstModel = modelUsage ? asRecord(Object.values(modelUsage)[0]) : undefined;
    return {
      events,
      ...typeof result.result === "string" ? { finalText: result.result } : {},
      ...typeof result.session_id === "string" ? { sessionId: result.session_id } : {},
      ...typeof firstModel?.canonicalModel === "string" ? { modelObserved: firstModel.canonicalModel } : {},
      ...Object.keys(usage).length ? { usage } : {}
    };
  }
}

// src/adapters/codex.ts
import path3 from "node:path";
var CODEX_FAILURE_TYPES = ["turn.failed"];

class CodexAdapter {
  provider = "codex";
  async capabilities(executable = envExecutable(this.provider)) {
    const probe = await probeExecutable(this.provider, executable, process.cwd());
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...probe.version ? { version: probe.version } : {},
      ...probe.reason ? { availabilityReason: probe.reason } : {},
      access: ["answer-only", "inspect", "edit-workspace", "inherit-session"],
      sessions: ["ephemeral", "persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: true
    };
  }
  async listModels() {
    return supportedModels("codex");
  }
  async prepare(request, _options = {}) {
    if (request.model)
      assertSupportedModel("codex", request.model);
    return request;
  }
  build(request) {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace", "inherit-session"]);
    assertSession(request, ["ephemeral", "persistent", "resume"]);
    if (request.maxBudgetUsd !== undefined)
      unsupported("Codex does not expose a per-run budget flag");
    if (request.schema && typeof request.schema !== "string") {
      unsupported("Codex schema must be a JSON Schema file path");
    }
    if (request.effort === "max")
      unsupported("Codex effort=max is not supported by the current adapter");
    const session = request.session;
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
    const args = session.mode === "resume" ? ["exec", "resume", session.id] : ["exec", "-C", request.cwd, "-s", request.access === "edit-workspace" ? "workspace-write" : "read-only"];
    if (session.mode !== "resume") {
      if (session.mode === "ephemeral")
        args.push("--ephemeral");
      for (const directory of request.additionalDirs ?? [])
        args.push("--add-dir", directory);
      if (request.providerOptions?.codex?.skipGitRepoCheck)
        args.push("--skip-git-repo-check");
      if (request.providerOptions?.codex?.profile)
        args.push("--profile", request.providerOptions.codex.profile);
    } else if (request.additionalDirs?.length) {
      unsupported("Codex resume cannot change additional directories");
    }
    if (request.model)
      args.push("--model", request.model);
    if (request.effort)
      args.push("-c", `model_reasoning_effort=${JSON.stringify(request.effort)}`);
    if (request.schema)
      args.push("--output-schema", path3.resolve(request.schema));
    if (request.output === "events")
      args.push("--json");
    args.push("-");
    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      structured: request.output === "events"
    };
  }
  parse(stdout, structured) {
    if (!structured)
      return textOutput(this.provider, stdout);
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };
    const started = parsed.events.find((event) => event.type === "thread.started");
    const messages = parsed.events.map((event) => asRecord(event.raw)).map((raw) => asRecord(raw?.item)).filter((item) => item?.type === "agent_message" && typeof item.text === "string");
    const terminal = findTerminalMarker(parsed.events, (event) => event.type === "turn.completed", CODEX_FAILURE_TYPES);
    if (terminal?.outcome === "failure") {
      return { events: parsed.events, protocolError: providerFailureMessage("Codex", terminal.event), ...warnings };
    }
    const completed = terminal?.event;
    if (!completed) {
      return { events: parsed.events, protocolError: "Codex stream did not contain turn.completed", unreadable: true, ...warnings };
    }
    const startRaw = asRecord(started?.raw);
    const completeRaw = asRecord(completed.raw);
    const rawUsage = asRecord(completeRaw?.usage);
    const usage = {};
    const inputTokens = numberValue(rawUsage?.input_tokens);
    const cachedInputTokens = numberValue(rawUsage?.cached_input_tokens);
    const outputTokens = numberValue(rawUsage?.output_tokens);
    const reasoningOutputTokens = numberValue(rawUsage?.reasoning_output_tokens);
    if (inputTokens !== undefined)
      usage.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined)
      usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined)
      usage.outputTokens = outputTokens;
    if (reasoningOutputTokens !== undefined)
      usage.reasoningOutputTokens = reasoningOutputTokens;
    const lastMessage = messages.at(-1);
    return {
      events: parsed.events,
      ...typeof lastMessage?.text === "string" ? { finalText: lastMessage.text } : {},
      ...typeof startRaw?.thread_id === "string" ? { sessionId: startRaw.thread_id } : {},
      ...Object.keys(usage).length ? { usage } : {},
      ...warnings
    };
  }
}

// src/adapters/cursor.ts
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync3 } from "node:fs";
import { homedir } from "node:os";
import path4 from "node:path";
function cursorModel(model, effort) {
  if (!effort)
    return model;
  const suffix = model.match(/-(none|low|medium|high|xhigh|max|extra-high)(?:-fast)?$/u)?.[1];
  if (suffix === effort || effort === "xhigh" && suffix === "extra-high")
    return model;
  const match = model.match(/^(.*)\[([^\]]*)\]$/u);
  if (!match)
    return `${model}[effort=${effort}]`;
  const parameters = match[2];
  const existing = parameters.match(/(?:^|,)effort=([^,]+)/u)?.[1];
  if (existing === effort)
    return model;
  if (existing)
    return `${match[1]}[${parameters.replace(/(^|,)effort=[^,]+/u, `$1effort=${effort}`)}]`;
  return `${match[1]}[${parameters}${parameters ? "," : ""}effort=${effort}]`;
}
var CURSOR_DEFAULT_MODEL = "cursor-grok-4.5-medium";
var WORKTREE_NAME_PREFIX = "agent-headless";
function generateWorktreeName() {
  return `${WORKTREE_NAME_PREFIX}-${Date.now().toString(36)}-${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
}
function withDefaultWorktreeName(request, generate) {
  if (request.access !== "edit-isolated")
    return request;
  const cursor = request.providerOptions?.cursor;
  if (cursor?.worktreeName)
    return request;
  return {
    ...request,
    providerOptions: {
      ...request.providerOptions,
      cursor: { ...cursor, worktreeName: generate() }
    }
  };
}
var CURSOR_WORKTREES_ROOT_ENV = "CURSOR_WORKTREES_ROOT";
var CURSOR_WORKTREE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
function childEnvValue(name, env) {
  const { matched, value } = lastEnvMatch(env ?? {}, name);
  return matched ? value : process.env[name];
}
function cursorWorktreesRoot(env) {
  const configured = childEnvValue(CURSOR_WORKTREES_ROOT_ENV, env);
  if (configured !== undefined)
    return configured;
  try {
    const home = homedir();
    return home ? path4.join(home, ".cursor", "worktrees") : undefined;
  } catch {
    return;
  }
}
function slugifyRepoName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/-+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "worktree";
}
function hasGitAncestor(start) {
  let current = start;
  for (;; ) {
    if (existsSync3(path4.join(current, ".git")))
      return true;
    const parent = path4.dirname(current);
    if (parent === current)
      return false;
    current = parent;
  }
}
function gitToplevel(cwd, env) {
  try {
    const childEnv = effectiveEnv(env);
    const resolved = resolveCommand("git", ["rev-parse", "--show-toplevel"], childEnv);
    const result = spawnSync(resolved.command, resolved.args, {
      cwd,
      env: childEnv,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      timeout: 1e4
    });
    if (result.error || result.status !== 0)
      return;
    const toplevel = result.stdout.trim();
    return toplevel ? path4.resolve(toplevel) : undefined;
  } catch {
    return;
  }
}
function envKeyPart(env) {
  if (!env)
    return null;
  const names = [...new Set(Object.keys(env).map(foldEnvName))].sort();
  return names.map((name) => {
    const { value } = lastEnvMatch(env, name);
    return value === undefined ? [name] : [name, value];
  });
}
var repoSlugCache = new Map;
function repoSlugKey(cwd, env) {
  return JSON.stringify([cwd, envKeyPart(env)]);
}
function cursorRepoSlug(cwd, env) {
  const start = path4.resolve(cwd);
  const key = repoSlugKey(start, env);
  const cached = repoSlugCache.get(key);
  if (cached !== undefined || repoSlugCache.has(key))
    return cached;
  const toplevel = hasGitAncestor(start) ? gitToplevel(start, env) : undefined;
  const slug = toplevel === undefined ? undefined : slugifyRepoName(path4.basename(toplevel));
  repoSlugCache.set(key, slug);
  return slug;
}
function cursorWorktreePath(request, cwd = request.cwd, env = request.env) {
  if (request.provider !== "cursor" || request.access !== "edit-isolated")
    return;
  const name = request.providerOptions?.cursor?.worktreeName;
  if (!name || !CURSOR_WORKTREE_NAME_PATTERN.test(name))
    return;
  const root = cursorWorktreesRoot(env);
  const slug = cursorRepoSlug(cwd, env);
  if (root === undefined || slug === undefined)
    return;
  return path4.resolve(cwd, root, slug, name);
}
function modelWithEffort(model, effort) {
  const fast = model.endsWith("-fast") ? "-fast" : "";
  const withoutFast = fast ? model.slice(0, -fast.length) : model;
  const match = withoutFast.match(/^(.*)-(none|low|medium|high|xhigh|max|extra-high)$/u);
  const base = match?.[1] ?? withoutFast;
  return `${base}-${effort}${fast}`;
}

class CursorAdapter {
  provider = "cursor";
  async capabilities(executable = envExecutable(this.provider)) {
    const probe = await probeExecutable(this.provider, executable, process.cwd());
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...probe.version ? { version: probe.version } : {},
      ...probe.reason ? { availabilityReason: probe.reason } : {},
      access: ["answer-only", "inspect", "edit-isolated"],
      sessions: ["persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: false,
      supportsModelListing: true
    };
  }
  async listModels() {
    return supportedModels("cursor");
  }
  async prepare(request, options = {}) {
    const model = request.model ?? CURSOR_DEFAULT_MODEL;
    if (model.toLowerCase() === "auto")
      unsupported("Cursor model=auto is not allowed; name an exact model");
    let next = request.model === undefined ? { ...request, model } : { ...request };
    const models = supportedModels("cursor");
    if (request.effort && !model.includes("[")) {
      const candidate = modelWithEffort(model, request.effort);
      if (models.includes(candidate))
        next = { ...next, model: candidate };
      else if (models.includes(model)) {
        unsupported(`Cursor model ${model} has no supported ${request.effort} effort variant; choose an exact model ID`);
      }
    }
    assertSupportedModel("cursor", next.model);
    return withDefaultWorktreeName(next, options.generateWorktreeName ?? generateWorktreeName);
  }
  build(request) {
    assertAccess(request, ["answer-only", "inspect", "edit-isolated"]);
    assertSession(request, ["persistent", "resume"]);
    const model = request.model ?? CURSOR_DEFAULT_MODEL;
    if (model.toLowerCase() === "auto")
      unsupported("Cursor model=auto is not allowed; name an exact model");
    if (request.schema)
      unsupported("Cursor does not support JSON Schema-constrained output");
    if (request.maxBudgetUsd !== undefined)
      unsupported("Cursor does not expose a per-run budget flag");
    const args = ["--print", "--workspace", request.cwd, "--model", cursorModel(model, request.effort)];
    const options = withDefaultWorktreeName(request, generateWorktreeName).providerOptions?.cursor;
    if (options?.trustWorkspace)
      args.push("--trust");
    if (request.output === "events") {
      args.push("--output-format", "stream-json");
      if (options?.streamPartialOutput)
        args.push("--stream-partial-output");
    }
    if (request.access === "answer-only")
      args.push("--mode", "ask");
    if (request.access === "inspect")
      args.push("--mode", "plan");
    if (request.access === "edit-isolated") {
      args.push("--worktree", options.worktreeName);
      if (options?.worktreeBase)
        args.push("--worktree-base", options.worktreeBase);
      if (process.platform !== "win32")
        args.push("--sandbox", "enabled");
    }
    if (request.session.mode === "persistent" && request.session.id) {
      unsupported("Cursor cannot select a session ID when starting a persistent session");
    }
    if (request.session.mode === "resume")
      args.push("--resume", request.session.id);
    for (const directory of request.additionalDirs ?? [])
      args.push("--add-dir", directory);
    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      structured: request.output === "events"
    };
  }
  parse(stdout, structured) {
    if (!structured)
      return textOutput(this.provider, stdout);
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };
    const terminal = findTerminalMarker(parsed.events, (event) => event.type.startsWith("result"));
    if (terminal?.outcome === "failure") {
      return { events: parsed.events, protocolError: providerFailureMessage("Cursor", terminal.event), ...warnings };
    }
    const result = asRecord(terminal?.event.raw);
    if (!result) {
      return { events: parsed.events, protocolError: "Cursor stream did not contain a terminal result", unreadable: true, ...warnings };
    }
    if (result.is_error === true || result.subtype !== "success") {
      return { events: parsed.events, protocolError: String(result.result ?? "Cursor reported an error"), ...warnings };
    }
    const init = asRecord(parsed.events.find((event) => event.type.startsWith("system"))?.raw);
    const rawUsage = asRecord(result.usage);
    const usage = {};
    const inputTokens = numberValue(rawUsage?.inputTokens);
    const cachedInputTokens = numberValue(rawUsage?.cacheReadTokens);
    const outputTokens = numberValue(rawUsage?.outputTokens);
    if (inputTokens !== undefined)
      usage.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined)
      usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined)
      usage.outputTokens = outputTokens;
    return {
      events: parsed.events,
      ...typeof result.result === "string" ? { finalText: result.result } : {},
      ...typeof result.session_id === "string" ? { sessionId: result.session_id } : typeof init?.session_id === "string" ? { sessionId: init.session_id } : {},
      ...typeof init?.model === "string" ? { modelObserved: init.model } : {},
      ...Object.keys(usage).length ? { usage } : {},
      ...warnings
    };
  }
}

// src/adapters/antigravity.ts
var AGY_MODEL_LINE = /^([^\t\s]+)\t/u;
function usageFrom(raw) {
  const usage = {};
  const inputTokens = numberValue(raw?.input_tokens);
  const cachedInputTokens = numberValue(raw?.cache_read_tokens);
  const outputTokens = numberValue(raw?.output_tokens);
  const reasoningOutputTokens = numberValue(raw?.thinking_tokens);
  if (inputTokens !== undefined)
    usage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined)
    usage.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined)
    usage.outputTokens = outputTokens;
  if (reasoningOutputTokens !== undefined)
    usage.reasoningOutputTokens = reasoningOutputTokens;
  return Object.keys(usage).length ? usage : undefined;
}
function resultRecord(event) {
  return asRecord(asRecord(event?.raw)?.result);
}
function reportedFailure(result) {
  const status = typeof result.status === "string" ? result.status : "failure";
  const response = typeof result.response === "string" && result.response.trim() ? `: ${result.response.trim()}` : "";
  return `Antigravity reported ${status}${response}`;
}

class AntigravityAdapter {
  provider = "antigravity";
  async capabilities(executable = envExecutable(this.provider)) {
    const probe = await probeExecutable(this.provider, executable, process.cwd());
    return {
      provider: this.provider,
      executable: probe.executable,
      availability: probe.availability,
      ...probe.version ? { version: probe.version } : {},
      ...probe.reason ? { availabilityReason: probe.reason } : {},
      access: ["answer-only", "inspect", "edit-workspace"],
      sessions: ["persistent", "resume"],
      supportsModel: true,
      supportsEffort: true,
      supportsSchema: true,
      supportsModelListing: true
    };
  }
  async listModels(options = {}) {
    const command = options.executable ?? envExecutable(this.provider, options.env);
    const result = await runInvocation({ provider: this.provider, command, args: ["models"], cwd: process.cwd(), stdin: "", structured: false }, { timeoutMs: 20000, ...options.env ? { env: options.env } : {} });
    if (result.exitCode !== 0)
      throw providerFailure(this.provider, result.exitCode, result.stderr);
    return [...new Set(result.stdout.split(/\r?\n/u).map((line) => line.match(AGY_MODEL_LINE)?.[1]).filter((model) => model !== undefined))];
  }
  build(request) {
    assertAccess(request, ["answer-only", "inspect", "edit-workspace"]);
    assertSession(request, ["persistent", "resume"]);
    if (request.maxBudgetUsd !== undefined)
      unsupported("Antigravity does not expose a per-run budget flag");
    if (request.effort === "xhigh" || request.effort === "max") {
      unsupported("Antigravity effort supports low, medium, or high");
    }
    const session = request.session;
    if (session.mode === "persistent" && session.id) {
      unsupported("Antigravity cannot select a conversation ID when starting a persistent session");
    }
    const options = request.providerOptions?.antigravity;
    const args = ["--print", request.prompt, "--output-format", request.output === "events" ? "stream-json" : "text"];
    args.push("--print-timeout", `${request.timeoutMs}ms`);
    if (request.access === "edit-workspace")
      args.push("--mode", "accept-edits");
    else
      args.push("--mode", "plan");
    if (session.mode === "resume")
      args.push("--conversation", session.id);
    if (request.model)
      args.push("--model", request.model);
    if (request.effort)
      args.push("--effort", request.effort);
    if (request.schema !== undefined) {
      args.push("--json-schema", typeof request.schema === "string" ? request.schema : JSON.stringify(request.schema));
    }
    for (const directory of request.additionalDirs ?? [])
      args.push("--add-dir", directory);
    if (options?.sandbox)
      args.push("--sandbox");
    if (options?.agent)
      args.push("--agent", options.agent);
    if (options?.project)
      args.push("--project", options.project);
    return {
      provider: this.provider,
      command: envExecutable(this.provider, request.env),
      args,
      cwd: request.cwd,
      stdin: "",
      structured: request.output === "events"
    };
  }
  parse(stdout, structured) {
    if (!structured)
      return textOutput(this.provider, stdout);
    const parsed = parseJsonLines(this.provider, stdout);
    const warnings = parsed.warnings.length ? { warnings: parsed.warnings } : {};
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error, unreadable: true, ...warnings };
    let terminal;
    let terminalFailure;
    for (let index = parsed.events.length - 1;index >= 0; index -= 1) {
      const event = parsed.events[index];
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
        ...warnings
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
      ...typeof result.response === "string" ? { finalText: result.response } : {},
      ...typeof conversationId === "string" && conversationId ? { sessionId: conversationId } : {},
      ...typeof initDetails?.model === "string" ? { modelObserved: initDetails.model } : {},
      ...usage ? { usage } : {},
      ...warnings
    };
  }
}

// src/adapters/index.ts
var adapters = {
  claude: new ClaudeAdapter,
  codex: new CodexAdapter,
  cursor: new CursorAdapter,
  antigravity: new AntigravityAdapter
};
function getAdapter(provider) {
  const adapter = adapters[provider];
  if (!adapter)
    throw new AgentHeadlessError("invalid_request", `unknown provider: ${String(provider)}`);
  return adapter;
}

// src/validation.ts
import { existsSync as existsSync4, realpathSync, statSync } from "node:fs";
function normalizeRequest(request) {
  if (!request.prompt?.trim())
    invalid("prompt must be non-empty");
  if (!request.cwd)
    invalid("cwd is required");
  if (!existsSync4(request.cwd) || !statSync(request.cwd).isDirectory()) {
    invalid(`cwd is not an existing directory: ${request.cwd}`);
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    invalid("timeoutMs must be a positive number");
  }
  if (request.maxBudgetUsd !== undefined && (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0)) {
    invalid("maxBudgetUsd must be a positive number");
  }
  if (request.model !== undefined && !request.model.trim())
    invalid("model must be non-empty");
  const additionalDirs = request.additionalDirs?.map((directory) => {
    if (!existsSync4(directory) || !statSync(directory).isDirectory()) {
      invalid(`additional directory does not exist: ${directory}`);
    }
    return realpathSync(directory);
  });
  return {
    ...request,
    cwd: realpathSync(request.cwd),
    access: request.access ?? (request.provider === "codex" && request.session?.mode === "resume" ? "inherit-session" : "answer-only"),
    output: request.output ?? "events",
    session: request.session ?? (request.provider === "cursor" || request.provider === "antigravity" ? { mode: "persistent" } : { mode: "ephemeral" }),
    timeoutMs: request.timeoutMs ?? 20 * 60000,
    ...additionalDirs ? { additionalDirs } : {}
  };
}

// src/workspace.ts
import path5 from "node:path";
var WORKTREE_KEYS = ["worktree_path", "worktreePath", "worktree_dir", "worktreeDir", "worktree"];
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path5.normalize(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
function worktreeFromEvents(events, cwd) {
  for (const event of events) {
    const raw = asRecord(event.raw);
    if (!raw)
      continue;
    for (const scope of [raw, asRecord(raw.item), asRecord(raw.workspace), asRecord(raw.worktree)]) {
      if (!scope)
        continue;
      for (const key of WORKTREE_KEYS) {
        const value = scope[key];
        if (typeof value === "string" && value.trim())
          return value;
      }
    }
    if (event.kind === "session" && typeof raw.cwd === "string" && raw.cwd.trim() && !samePath(raw.cwd, cwd)) {
      return raw.cwd;
    }
  }
  return;
}
function worktreeFromText(stdout, worktreeName) {
  const keyed = stdout.match(/"worktree(?:_path|Path|_dir|Dir)?"\s*:\s*"((?:[^"\\]|\\.)*)"/u);
  if (keyed?.[1]) {
    try {
      return JSON.parse(`"${keyed[1]}"`);
    } catch {
      return keyed[1];
    }
  }
  if (!worktreeName)
    return;
  const escaped = worktreeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = stdout.match(new RegExp(`(?:[A-Za-z]:[\\\\/]|/)[^\\s"']*[\\\\/]${escaped}(?![\\w.-])`, "u"));
  if (!match)
    return;
  return match[0].includes("\\\\") ? match[0].replace(/\\\\/gu, "\\") : match[0];
}
function absoluteReported(disclosed, cwd) {
  if (disclosed === undefined)
    return;
  const trimmed = disclosed.trim();
  if (!trimmed)
    return;
  if (path5.isAbsolute(trimmed))
    return trimmed;
  const resolved = path5.resolve(cwd, trimmed);
  return path5.isAbsolute(resolved) ? resolved : undefined;
}
function describeWorkspace(request, cwd, events, stdout) {
  const isolated = request.access === "edit-isolated";
  const cursor = request.providerOptions?.cursor;
  const worktreeName = !isolated ? undefined : request.provider === "cursor" ? cursor?.worktreeName : request.provider === "claude" ? request.providerOptions?.claude?.worktreeName ?? "agent-headless" : undefined;
  const worktreeBase = isolated && request.provider === "cursor" ? cursor?.worktreeBase : undefined;
  const disclosed = isolated ? worktreeFromEvents(events, cwd) ?? worktreeFromText(stdout, worktreeName) : undefined;
  const reported = absoluteReported(disclosed, cwd);
  const derived = isolated && !reported ? cursorWorktreePath(request, cwd, request.env) : undefined;
  const worktree = reported ?? derived;
  return {
    cwd,
    access: request.access,
    ...worktree ? { worktree, worktreeSource: reported ? "reported" : "derived" } : {},
    ...derived ? { worktreeRoot: path5.dirname(derived) } : {},
    ...worktreeName ? { worktreeName } : {},
    ...worktreeBase ? { worktreeBase } : {}
  };
}
// src/version.ts
var VERSION = "0.5.2";

// src/index.ts
var MODEL_REJECTION = /(?:unknown|unrecognized|unsupported|invalid|unavailable)\s+model|no\s+such\s+model|model\b[^\n]{0,80}?(?:not\s+(?:found|available|supported|recognized)|does\s+not\s+exist|is\s+invalid|is\s+no\s+longer)/iu;
async function modelRejectionWarnings(request, modelDefaulted, text, options) {
  if (request.provider !== "cursor" || !text || !MODEL_REJECTION.test(text))
    return [];
  const origin = modelDefaulted ? `${CURSOR_DEFAULT_MODEL} is this runner's built-in default and may be stale` : "this model was requested explicitly";
  const warnings = [
    `cursor rejected model "${request.model ?? "(none)"}" - ${origin}; run \`agent-headless models cursor\` for the supported list`
  ];
  if (!modelDefaulted)
    return warnings;
  try {
    const models = await (options.listModels ?? listModels)("cursor", {
      executable: envExecutable("cursor", request.env),
      ...request.env ? { env: request.env } : {}
    });
    if (models.length) {
      const shown = models.slice(0, 40);
      warnings.push(`available cursor models: ${shown.join(", ")}${models.length > shown.length ? `, ... (${models.length} total)` : ""}`);
    }
  } catch {}
  return warnings;
}
async function runAgent(input, options = {}) {
  let request = normalizeRequest(input);
  const adapter = getAdapter(request.provider);
  const modelChosenByCaller = request.model !== undefined;
  if (adapter.prepare) {
    request = await adapter.prepare(request, {
      ...options.generateWorktreeName ? { generateWorktreeName: options.generateWorktreeName } : {}
    });
  }
  const modelDefaulted = !modelChosenByCaller && request.model !== undefined;
  const invocation = adapter.build(request);
  const streamWarnings = [];
  const processResult = await (options.execute ?? runInvocation)(invocation, {
    timeoutMs: request.timeoutMs,
    ...request.signal ? { signal: request.signal } : {},
    ...request.env ? { env: request.env } : {},
    ...invocation.structured && request.onEvent ? {
      onStdoutLine: (line) => {
        try {
          request.onEvent?.(parseJsonEvent(request.provider, line));
        } catch {
          streamWarnings.push("invalid JSONL received during streaming");
        }
      }
    } : {}
  });
  const structuredPartial = invocation.structured ? parseJsonLines(request.provider, processResult.stdout) : undefined;
  const textPartial = invocation.structured ? undefined : adapter.parse(processResult.stdout, false);
  const partialEvents = structuredPartial?.events ?? textPartial?.events ?? [];
  const partialFinalText = textPartial?.finalText;
  const partialWarnings = [...new Set([
    ...streamWarnings,
    ...structuredPartial?.warnings ?? [],
    ...structuredPartial?.error ? [structuredPartial.error] : []
  ])];
  const partialWorkspace = describeWorkspace(request, invocation.cwd, partialEvents, processResult.stdout);
  if (processResult.timedOut || processResult.cancelled) {
    return {
      provider: request.provider,
      status: processResult.timedOut ? "timed-out" : "cancelled",
      ...partialFinalText !== undefined ? { finalText: partialFinalText } : {},
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...request.model ? { modelRequested: request.model } : {},
      ...modelDefaulted ? { modelDefaulted: true } : {},
      warnings: partialWarnings,
      workspace: partialWorkspace,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs
    };
  }
  if (processResult.exitCode !== 0) {
    const rejection2 = await modelRejectionWarnings(request, modelDefaulted, `${processResult.stderr}
${processResult.stdout}`, options);
    return {
      provider: request.provider,
      status: "failed",
      ...partialFinalText !== undefined ? { finalText: partialFinalText } : {},
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...request.model ? { modelRequested: request.model } : {},
      ...modelDefaulted ? { modelDefaulted: true } : {},
      warnings: [...new Set([...partialWarnings, ...rejection2])],
      workspace: partialWorkspace,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs
    };
  }
  const parsed = adapter.parse(processResult.stdout, invocation.structured);
  if (!invocation.structured)
    for (const event of parsed.events)
      request.onEvent?.(event);
  const rejection = parsed.protocolError ? await modelRejectionWarnings(request, modelDefaulted, `${parsed.protocolError}
${processResult.stderr}`, options) : [];
  const warnings = [...new Set([
    ...streamWarnings,
    ...parsed.warnings ?? [],
    ...parsed.protocolError ? [parsed.protocolError] : [],
    ...rejection
  ])];
  return {
    provider: request.provider,
    status: parsed.protocolError ? parsed.unreadable ? "unparsed" : "failed" : "succeeded",
    ...parsed.finalText !== undefined ? { finalText: parsed.finalText } : {},
    events: parsed.events,
    exitCode: processResult.exitCode,
    ...parsed.sessionId ? { sessionId: parsed.sessionId } : {},
    ...request.model ? { modelRequested: request.model } : {},
    ...modelDefaulted ? { modelDefaulted: true } : {},
    ...parsed.modelObserved ? { modelObserved: parsed.modelObserved } : {},
    ...parsed.usage ? { usage: parsed.usage } : {},
    warnings,
    workspace: describeWorkspace(request, invocation.cwd, parsed.events, processResult.stdout),
    stderr: processResult.stderr,
    durationMs: processResult.durationMs
  };
}
async function getCapabilities(provider) {
  return await getAdapter(provider).capabilities();
}
async function getAllCapabilities() {
  return await Promise.all(["claude", "codex", "cursor", "antigravity"].map(getCapabilities));
}
async function listModels(provider, options = {}) {
  const adapter = getAdapter(provider);
  if (!adapter.listModels) {
    throw new AgentHeadlessError("unsupported_capability", `${provider} does not expose model listing through its CLI`);
  }
  return await adapter.listModels(options);
}
function assertSucceeded(result) {
  if (result.status !== "succeeded") {
    throw new AgentHeadlessError(result.status === "unparsed" ? "invalid_provider_output" : "provider_failed", `${result.provider} ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
}

// src/cli.ts
import { readFileSync as readFileSync2 } from "node:fs";
import process2 from "node:process";
var help = `agent-headless - one headless interface for Claude, Codex, Cursor, and Antigravity

Usage:
  agent-headless run --provider <claude|codex|cursor|antigravity> --prompt <text> [options]
  agent-headless capabilities [provider]
  agent-headless models <claude|codex|cursor|antigravity>
  agent-headless --version

Run options:
  --prompt <text>                 Prompt text; omit to read stdin
  --prompt-file <path>            Read prompt from a UTF-8 file
  --cwd <path>                    Working directory (default: current directory)
  --model <id>                    Provider model or alias; when omitted, Cursor
                                  falls back to cursor-grok-4.5-medium and the
                                  result reports modelDefaulted: true
  --effort <level>                low, medium, high, xhigh, or max
  --access <mode>                 answer-only (default), inspect, edit-workspace, edit-isolated, inherit-session
  --session <mode>                ephemeral or persistent; use --resume for continuation
  --resume <id>                   Resume a provider session
  --output <mode>                 text or events (default: events)
  --schema <path>                 JSON Schema path (Claude, Codex, or Antigravity)
  --max-budget-usd <number>       Claude-only spending ceiling
  --timeout-ms <number>           Timeout in milliseconds
  --add-dir <path>                Additional directory; repeatable
  --trust-workspace               Explicitly trust Cursor's workspace
  --json                          Print the normalized result as JSON
  --help                          Show help

Exit codes:
  0  succeeded
  1  failed, timed out, cancelled, or a usage error
  2  unparsed - the provider exited 0 but its output could not be read; the
     work may have completed, so check the reported workspace before retrying
`;
function take(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new AgentHeadlessError("invalid_request", `${flag} requires a value`);
  return value;
}
function parseRun(args) {
  let provider;
  let prompt;
  let promptFile;
  let cwd = process2.cwd();
  let model;
  let effort;
  let access;
  let output;
  let session;
  let timeoutMs;
  let maxBudgetUsd;
  let schema;
  let json = false;
  const additionalDirs = [];
  let trustWorkspace = false;
  for (let index = 0;index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--trust-workspace") {
      trustWorkspace = true;
      continue;
    }
    if (flag === "--provider") {
      provider = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--prompt") {
      prompt = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--prompt-file") {
      promptFile = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--cwd") {
      cwd = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--model") {
      model = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--effort") {
      effort = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--access") {
      access = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--output") {
      output = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--session") {
      session = { mode: take(args, index, flag) };
      index++;
      continue;
    }
    if (flag === "--resume") {
      session = { mode: "resume", id: take(args, index, flag) };
      index++;
      continue;
    }
    if (flag === "--timeout-ms") {
      timeoutMs = Number(take(args, index, flag));
      index++;
      continue;
    }
    if (flag === "--max-budget-usd") {
      maxBudgetUsd = Number(take(args, index, flag));
      index++;
      continue;
    }
    if (flag === "--schema") {
      schema = take(args, index, flag);
      index++;
      continue;
    }
    if (flag === "--add-dir") {
      additionalDirs.push(take(args, index, flag));
      index++;
      continue;
    }
    throw new AgentHeadlessError("invalid_request", `unknown option: ${flag}`);
  }
  if (!provider || !["claude", "codex", "cursor", "antigravity"].includes(provider)) {
    throw new AgentHeadlessError("invalid_request", "--provider must be claude, codex, cursor, or antigravity");
  }
  if (prompt && promptFile)
    throw new AgentHeadlessError("invalid_request", "--prompt and --prompt-file are mutually exclusive");
  if (promptFile)
    prompt = readFileSync2(promptFile, "utf8");
  if (!prompt && !process2.stdin.isTTY)
    prompt = readFileSync2(0, "utf8");
  if (!prompt)
    throw new AgentHeadlessError("invalid_request", "provide --prompt, --prompt-file, or stdin");
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new AgentHeadlessError("invalid_request", "invalid --effort value");
  }
  if (access && !["answer-only", "inspect", "edit-workspace", "edit-isolated", "inherit-session"].includes(access)) {
    throw new AgentHeadlessError("invalid_request", "invalid --access value");
  }
  if (output && !["text", "events"].includes(output))
    throw new AgentHeadlessError("invalid_request", "invalid --output value");
  return {
    request: {
      provider,
      prompt,
      cwd,
      ...model ? { model } : {},
      ...effort ? { effort } : {},
      ...access ? { access } : {},
      ...output ? { output } : {},
      ...session ? { session } : {},
      ...timeoutMs !== undefined ? { timeoutMs } : {},
      ...maxBudgetUsd !== undefined ? { maxBudgetUsd } : {},
      ...schema ? { schema } : {},
      ...additionalDirs.length ? { additionalDirs } : {},
      ...trustWorkspace ? { providerOptions: { cursor: { trustWorkspace: true } } } : {}
    },
    json
  };
}
async function main() {
  const [command, ...args] = process2.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "capabilities") {
    const provider = args[0];
    if (provider && !["claude", "codex", "cursor", "antigravity"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "capabilities provider must be claude, codex, cursor, or antigravity");
    }
    console.log(JSON.stringify(provider ? await getCapabilities(provider) : await getAllCapabilities(), null, 2));
    return;
  }
  if (command === "models") {
    const provider = args[0];
    if (!provider || !["claude", "codex", "cursor", "antigravity"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "models provider must be claude, codex, cursor, or antigravity");
    }
    console.log((await listModels(provider)).join(`
`));
    return;
  }
  if (command !== "run")
    throw new AgentHeadlessError("invalid_request", `unknown command: ${command}`);
  const { request, json } = parseRun(args);
  const result = await runAgent(request);
  if (json)
    console.log(JSON.stringify(result, null, 2));
  else if (result.finalText !== undefined)
    process2.stdout.write(`${result.finalText}
`);
  if (result.stderr && result.status !== "succeeded")
    process2.stderr.write(result.stderr);
  if (result.status === "unparsed") {
    for (const warning of result.warnings)
      process2.stderr.write(`warning: ${warning}
`);
    const workspace = result.workspace;
    if (workspace) {
      const worktree = workspace.worktree ?? workspace.worktreeName;
      process2.stderr.write(`workspace: ${workspace.cwd}${worktree ? ` (worktree: ${worktree})` : ""}
`);
    }
    process2.exitCode = 2;
  } else if (result.status !== "succeeded")
    process2.exitCode = 1;
}
main().catch((error) => {
  if (error instanceof AgentHeadlessError)
    console.error(`${error.code}: ${error.message}`);
  else
    console.error(error instanceof Error ? error.message : String(error));
  process2.exitCode = 1;
});
