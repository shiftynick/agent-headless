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
function parseJsonLines(provider, stdout) {
  const events = [];
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
  for (let index = 0;index < lines.length; index += 1) {
    const line = lines[index];
    try {
      events.push(parseJsonEvent(provider, line));
    } catch {
      return { events, error: `invalid JSONL at line ${index + 1}` };
    }
  }
  return { events };
}
function parseJsonEvent(provider, line) {
  const raw = JSON.parse(line);
  const rawType = typeof raw.type === "string" ? raw.type : "unknown";
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

// src/process.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
function resolveOnWindows(command, env) {
  if (process.platform !== "win32" || path.isAbsolute(command) || /[\\/]/u.test(command))
    return command;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate))
        return candidate;
    }
  }
  return command;
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
  const env = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    const existing = process.platform === "win32" ? Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase()) : key;
    if (existing && existing !== key)
      delete env[existing];
    if (value === undefined)
      delete env[key];
    else
      env[key] = value;
  }
  let command = resolveOnWindows(invocation.command, env);
  let args = invocation.args;
  let windowsVerbatimArguments = false;
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const commandLine = `"${[command, ...args].map(quoteCmd).join(" ")}"`;
    command = env.ComSpec || env.COMSPEC || "cmd.exe";
    args = ["/d", "/s", "/c", commandLine];
    windowsVerbatimArguments = true;
  }
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
function envExecutable(provider, requestEnv) {
  const key = provider === "claude" ? "CLAUDE_BIN" : provider === "codex" ? "CODEX_BIN" : "CURSOR_AGENT_BIN";
  const fallback = provider === "cursor" ? "agent" : provider;
  return requestEnv?.[key] || process.env[key] || fallback;
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
      supportsModelListing: false
    };
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
      return { events: [], protocolError: "Claude returned no structured output" };
    if (!trimmed.includes(`
`)) {
      try {
        const raw = JSON.parse(trimmed);
        return this.parseRecords([{ provider: this.provider, type: String(raw.type ?? "result"), kind: raw.is_error === true ? "error" : "result", raw }]);
      } catch {
        return { events: [], protocolError: "Claude returned invalid JSON" };
      }
    }
    const parsed = parseJsonLines(this.provider, stdout);
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error };
    return this.parseRecords(parsed.events);
  }
  parseRecords(events) {
    const terminal = [...events].reverse().find((event) => asRecord(event.raw)?.type === "result");
    const result = asRecord(terminal?.raw);
    if (!result)
      return { events, protocolError: "Claude stream did not contain a terminal result" };
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
import path2 from "node:path";
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
      supportsModelListing: false
    };
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
      args.push("--output-schema", path2.resolve(request.schema));
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
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error };
    const started = parsed.events.find((event) => event.type === "thread.started");
    const completed = [...parsed.events].reverse().find((event) => event.type === "turn.completed");
    const messages = parsed.events.map((event) => asRecord(event.raw)).map((raw) => asRecord(raw?.item)).filter((item) => item?.type === "agent_message" && typeof item.text === "string");
    if (!completed)
      return { events: parsed.events, protocolError: "Codex stream did not contain turn.completed" };
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
      ...Object.keys(usage).length ? { usage } : {}
    };
  }
}

// src/adapters/cursor.ts
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
var modelPromises = new Map;
function parseModels(stdout) {
  return stdout.split(/\r?\n/u).map((line) => line.match(/^([^\s]+)\s+-\s+/u)?.[1]).filter((model) => Boolean(model));
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
  async listModels(executable = envExecutable(this.provider)) {
    let modelsPromise = modelPromises.get(executable);
    if (!modelsPromise) {
      modelsPromise = (async () => {
        const result = await runInvocation({ provider: this.provider, command: executable, args: ["models"], cwd: process.cwd(), stdin: "", structured: false }, { timeoutMs: 30000 });
        if (result.exitCode !== 0)
          unsupported(`Cursor model listing failed: ${result.stderr.trim()}`);
        return parseModels(result.stdout);
      })();
      modelPromises.set(executable, modelsPromise);
    }
    return await modelsPromise;
  }
  async prepare(request) {
    if (!request.effort || !request.model || request.model.includes("["))
      return request;
    const models = await this.listModels(envExecutable(this.provider, request.env));
    const candidate = modelWithEffort(request.model, request.effort);
    const xhighCandidate = request.effort === "xhigh" ? modelWithEffort(request.model, "high").replace(/-high(-fast)?$/u, "-extra-high$1") : undefined;
    const resolved = [candidate, xhighCandidate].find((value) => value && models.includes(value));
    if (resolved)
      return { ...request, model: resolved };
    if (models.includes(request.model)) {
      unsupported(`Cursor model ${request.model} has no available ${request.effort} effort variant; choose an exact model ID`);
    }
    return request;
  }
  build(request) {
    assertAccess(request, ["answer-only", "inspect", "edit-isolated"]);
    assertSession(request, ["persistent", "resume"]);
    if (!request.model)
      unsupported("Cursor requires an explicit model; use `agent models` to list choices");
    if (request.model.toLowerCase() === "auto")
      unsupported("Cursor model=auto is not allowed; name an exact model");
    if (request.schema)
      unsupported("Cursor does not support JSON Schema-constrained output");
    if (request.maxBudgetUsd !== undefined)
      unsupported("Cursor does not expose a per-run budget flag");
    const args = ["--print", "--workspace", request.cwd, "--model", cursorModel(request.model, request.effort)];
    const options = request.providerOptions?.cursor;
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
      args.push("--worktree");
      if (options?.worktreeName)
        args.push(options.worktreeName);
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
    if (parsed.error)
      return { events: parsed.events, protocolError: parsed.error };
    const terminal = [...parsed.events].reverse().find((event) => event.type.startsWith("result"));
    const result = asRecord(terminal?.raw);
    if (!result)
      return { events: parsed.events, protocolError: "Cursor stream did not contain a terminal result" };
    if (result.is_error === true || result.subtype !== "success") {
      return { events: parsed.events, protocolError: String(result.result ?? "Cursor reported an error") };
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
      ...Object.keys(usage).length ? { usage } : {}
    };
  }
}

// src/adapters/index.ts
var adapters = {
  claude: new ClaudeAdapter,
  codex: new CodexAdapter,
  cursor: new CursorAdapter
};
function getAdapter(provider) {
  const adapter = adapters[provider];
  if (!adapter)
    throw new AgentHeadlessError("invalid_request", `unknown provider: ${String(provider)}`);
  return adapter;
}

// src/validation.ts
import { existsSync as existsSync2, realpathSync, statSync } from "node:fs";
function normalizeRequest(request) {
  if (!request.prompt?.trim())
    invalid("prompt must be non-empty");
  if (!request.cwd)
    invalid("cwd is required");
  if (!existsSync2(request.cwd) || !statSync(request.cwd).isDirectory()) {
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
    if (!existsSync2(directory) || !statSync(directory).isDirectory()) {
      invalid(`additional directory does not exist: ${directory}`);
    }
    return realpathSync(directory);
  });
  return {
    ...request,
    cwd: realpathSync(request.cwd),
    access: request.access ?? (request.provider === "codex" && request.session?.mode === "resume" ? "inherit-session" : "answer-only"),
    output: request.output ?? "events",
    session: request.session ?? (request.provider === "cursor" ? { mode: "persistent" } : { mode: "ephemeral" }),
    timeoutMs: request.timeoutMs ?? 20 * 60000,
    ...additionalDirs ? { additionalDirs } : {}
  };
}
// src/version.ts
var VERSION = "0.2.0";

// src/index.ts
async function runAgent(input, options = {}) {
  let request = normalizeRequest(input);
  const adapter = getAdapter(request.provider);
  if (adapter.prepare)
    request = await adapter.prepare(request);
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
    ...structuredPartial?.error ? [structuredPartial.error] : []
  ])];
  if (processResult.timedOut || processResult.cancelled) {
    return {
      provider: request.provider,
      status: processResult.timedOut ? "timed-out" : "cancelled",
      ...partialFinalText !== undefined ? { finalText: partialFinalText } : {},
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...request.model ? { modelRequested: request.model } : {},
      warnings: partialWarnings,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs
    };
  }
  if (processResult.exitCode !== 0) {
    return {
      provider: request.provider,
      status: "failed",
      ...partialFinalText !== undefined ? { finalText: partialFinalText } : {},
      events: partialEvents,
      exitCode: processResult.exitCode,
      ...request.model ? { modelRequested: request.model } : {},
      warnings: partialWarnings,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs
    };
  }
  const parsed = adapter.parse(processResult.stdout, invocation.structured);
  if (!invocation.structured)
    for (const event of parsed.events)
      request.onEvent?.(event);
  const warnings = [...new Set([...streamWarnings, ...parsed.protocolError ? [parsed.protocolError] : []])];
  return {
    provider: request.provider,
    status: parsed.protocolError ? "failed" : "succeeded",
    ...parsed.finalText !== undefined ? { finalText: parsed.finalText } : {},
    events: parsed.events,
    exitCode: processResult.exitCode,
    ...parsed.sessionId ? { sessionId: parsed.sessionId } : {},
    ...request.model ? { modelRequested: request.model } : {},
    ...parsed.modelObserved ? { modelObserved: parsed.modelObserved } : {},
    ...parsed.usage ? { usage: parsed.usage } : {},
    warnings,
    stderr: processResult.stderr,
    durationMs: processResult.durationMs
  };
}
async function getCapabilities(provider) {
  return await getAdapter(provider).capabilities();
}
async function getAllCapabilities() {
  return await Promise.all(["claude", "codex", "cursor"].map(getCapabilities));
}
async function listModels(provider) {
  const adapter = getAdapter(provider);
  if (!adapter.listModels) {
    throw new AgentHeadlessError("unsupported_capability", `${provider} does not expose model listing through its CLI`);
  }
  return await adapter.listModels();
}
function assertSucceeded(result) {
  if (result.status !== "succeeded") {
    throw new AgentHeadlessError(result.warnings.length ? "invalid_provider_output" : "provider_failed", `${result.provider} ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
}

// src/cli.ts
import { readFileSync as readFileSync2 } from "node:fs";
import process2 from "node:process";
var help = `agent-headless - one headless interface for Claude, Codex, and Cursor

Usage:
  agent-headless run --provider <claude|codex|cursor> --prompt <text> [options]
  agent-headless capabilities [provider]
  agent-headless models cursor
  agent-headless --version

Run options:
  --prompt <text>                 Prompt text; omit to read stdin
  --prompt-file <path>            Read prompt from a UTF-8 file
  --cwd <path>                    Working directory (default: current directory)
  --model <id>                    Provider model or alias (required for Cursor)
  --effort <level>                low, medium, high, xhigh, or max
  --access <mode>                 answer-only (default), inspect, edit-workspace, edit-isolated, inherit-session
  --session <mode>                ephemeral or persistent; use --resume for continuation
  --resume <id>                   Resume a provider session
  --output <mode>                 text or events (default: events)
  --schema <path>                 JSON Schema path (Claude or Codex)
  --max-budget-usd <number>       Claude-only spending ceiling
  --timeout-ms <number>           Timeout in milliseconds
  --add-dir <path>                Additional directory; repeatable
  --trust-workspace               Explicitly trust Cursor's workspace
  --json                          Print the normalized result as JSON
  --help                          Show help
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
  if (!provider || !["claude", "codex", "cursor"].includes(provider)) {
    throw new AgentHeadlessError("invalid_request", "--provider must be claude, codex, or cursor");
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
    if (provider && !["claude", "codex", "cursor"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "capabilities provider must be claude, codex, or cursor");
    }
    console.log(JSON.stringify(provider ? await getCapabilities(provider) : await getAllCapabilities(), null, 2));
    return;
  }
  if (command === "models") {
    const provider = args[0];
    if (!provider || !["claude", "codex", "cursor"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "models provider must be claude, codex, or cursor");
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
  if (result.status !== "succeeded")
    process2.exitCode = 1;
}
main().catch((error) => {
  if (error instanceof AgentHeadlessError)
    console.error(`${error.code}: ${error.message}`);
  else
    console.error(error instanceof Error ? error.message : String(error));
  process2.exitCode = 1;
});
