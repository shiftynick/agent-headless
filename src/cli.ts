#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { AgentHeadlessError, getAllCapabilities, getCapabilities, listModels, runAgent, VERSION } from "./index";
import type { AccessMode, Effort, OutputMode, Provider, RunRequest, SessionMode } from "./types";
import { checkForUpdates, updateNotice } from "./updates";

const help = `agent-headless - one headless interface for Claude, Codex, Cursor, and Antigravity

Usage:
  agent-headless run --provider <claude|codex|cursor|antigravity> --prompt <text> [options]
  agent-headless doctor [provider]
  agent-headless capabilities [provider]
  agent-headless models <claude|codex|cursor|antigravity>
  agent-headless check-updates [--force]
  agent-headless --version

Run options:
  --prompt <text>                 Prompt text; omit to read stdin
  --prompt-file <path>            Read prompt from a UTF-8 file
  --cwd <path>                    Working directory (default: current directory)
  --model <id>                    Provider model or alias; when omitted, Cursor
                                  falls back to cursor-grok-4.6-medium and the
                                  result reports modelDefaulted: true
  --effort <level>                low, medium, high, xhigh, or max
  --access <mode>                 answer-only (default), inspect, edit-workspace, edit-isolated, inherit-session
  --session <mode>                ephemeral or persistent; use --resume for continuation
  --resume <id>                   Resume a provider session
  --fork                          Fork --resume into a new session (Claude/Codex)
  --output <mode>                 text or events (default: events)
  --schema <path>                 JSON Schema path (Claude, Codex, or Antigravity)
  --max-budget-usd <number>       Claude-only spending ceiling
  --timeout-ms <number>           Timeout in milliseconds
  --max-stdout-bytes <number>     Stop after this much stdout (default: 16777216)
  --max-stderr-bytes <number>     Stop after this much stderr (default: 1048576)
  --add-dir <path>                Additional directory; repeatable
  --trust-workspace               Explicitly trust Cursor's workspace
  --json                          Print the normalized result as JSON
  --help                          Show help

Update checks:
  run and doctor cache npm checks and report newer versions on stderr.
  run --json includes an update object; check-updates prints only JSON.
  Set AGENT_HEADLESS_NO_UPDATE_CHECK=1 to disable checks.

Exit codes:
  0  succeeded
  1  failed, timed out, cancelled, or a usage error
  2  unparsed - the provider exited 0 but its output could not be read; the
     work may have completed, so check the reported workspace before retrying
`;

function take(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new AgentHeadlessError("invalid_request", `${flag} requires a value`);
  return value;
}

function parseRun(args: string[]): { request: RunRequest; json: boolean } {
  let provider: Provider | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let cwd = process.cwd();
  let model: string | undefined;
  let effort: Effort | undefined;
  let access: AccessMode | undefined;
  let output: OutputMode | undefined;
  let session: SessionMode | undefined;
  let timeoutMs: number | undefined;
  let maxBudgetUsd: number | undefined;
  let schema: string | undefined;
  let json = false;
  const additionalDirs: string[] = [];
  let trustWorkspace = false;
  let fork = false;
  const outputLimits: NonNullable<RunRequest["outputLimits"]> = {};

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--json") { json = true; continue; }
    if (flag === "--fork") { fork = true; continue; }
    if (flag === "--trust-workspace") { trustWorkspace = true; continue; }
    if (flag === "--provider") { provider = take(args, index, flag) as Provider; index++; continue; }
    if (flag === "--prompt") { prompt = take(args, index, flag); index++; continue; }
    if (flag === "--prompt-file") { promptFile = take(args, index, flag); index++; continue; }
    if (flag === "--cwd") { cwd = take(args, index, flag); index++; continue; }
    if (flag === "--model") { model = take(args, index, flag); index++; continue; }
    if (flag === "--effort") { effort = take(args, index, flag) as Effort; index++; continue; }
    if (flag === "--access") { access = take(args, index, flag) as AccessMode; index++; continue; }
    if (flag === "--output") { output = take(args, index, flag) as OutputMode; index++; continue; }
    if (flag === "--session") { session = { mode: take(args, index, flag) as "ephemeral" | "persistent" }; index++; continue; }
    if (flag === "--resume") { session = { mode: "resume", id: take(args, index, flag) }; index++; continue; }
    if (flag === "--timeout-ms") { timeoutMs = Number(take(args, index, flag)); index++; continue; }
    if (flag === "--max-stdout-bytes") { outputLimits.stdoutBytes = Number(take(args, index, flag)); index++; continue; }
    if (flag === "--max-stderr-bytes") { outputLimits.stderrBytes = Number(take(args, index, flag)); index++; continue; }
    if (flag === "--max-budget-usd") { maxBudgetUsd = Number(take(args, index, flag)); index++; continue; }
    if (flag === "--schema") { schema = take(args, index, flag); index++; continue; }
    if (flag === "--add-dir") { additionalDirs.push(take(args, index, flag)); index++; continue; }
    throw new AgentHeadlessError("invalid_request", `unknown option: ${flag}`);
  }
  if (!provider || !["claude", "codex", "cursor", "antigravity"].includes(provider)) {
    throw new AgentHeadlessError("invalid_request", "--provider must be claude, codex, cursor, or antigravity");
  }
  if (prompt && promptFile) throw new AgentHeadlessError("invalid_request", "--prompt and --prompt-file are mutually exclusive");
  if (promptFile) prompt = readFileSync(promptFile, "utf8");
  if (!prompt && !process.stdin.isTTY) prompt = readFileSync(0, "utf8");
  if (!prompt) throw new AgentHeadlessError("invalid_request", "provide --prompt, --prompt-file, or stdin");
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new AgentHeadlessError("invalid_request", "invalid --effort value");
  }
  if (access && !["answer-only", "inspect", "edit-workspace", "edit-isolated", "inherit-session"].includes(access)) {
    throw new AgentHeadlessError("invalid_request", "invalid --access value");
  }
  if (output && !["text", "events"].includes(output)) throw new AgentHeadlessError("invalid_request", "invalid --output value");
  if (fork) {
    if (session?.mode !== "resume") throw new AgentHeadlessError("invalid_request", "--fork requires --resume");
    session = { ...session, fork: true };
  }
  return {
    request: {
      provider,
      prompt,
      cwd,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(access ? { access } : {}),
      ...(output ? { output } : {}),
      ...(session ? { session } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(Object.keys(outputLimits).length ? { outputLimits } : {}),
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      ...(schema ? { schema } : {}),
      ...(additionalDirs.length ? { additionalDirs } : {}),
      ...(trustWorkspace ? { providerOptions: { cursor: { trustWorkspace: true } } } : {}),
    },
    json,
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "check-updates") {
    if (args.some((arg) => arg !== "--force")) {
      throw new AgentHeadlessError("invalid_request", "check-updates accepts only --force");
    }
    console.log(JSON.stringify(await checkForUpdates({ force: args.includes("--force") }), null, 2));
    return;
  }
  if (command === "capabilities" || command === "doctor") {
    const provider = args[0] as Provider | undefined;
    if (provider && !["claude", "codex", "cursor", "antigravity"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", `${command} provider must be claude, codex, cursor, or antigravity`);
    }
    const [capabilities, update] = await Promise.all([
      provider ? getCapabilities(provider) : getAllCapabilities(),
      command === "doctor" ? checkForUpdates() : Promise.resolve(undefined),
    ]);
    console.log(JSON.stringify(capabilities, null, 2));
    const notice = update && updateNotice(update);
    if (notice) console.error(notice);
    return;
  }
  if (command === "models") {
    const provider = args[0] as Provider | undefined;
    if (!provider || !["claude", "codex", "cursor", "antigravity"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "models provider must be claude, codex, cursor, or antigravity");
    }
    console.log((await listModels(provider)).join("\n"));
    return;
  }
  if (command !== "run") throw new AgentHeadlessError("invalid_request", `unknown command: ${command}`);
  const { request, json } = parseRun(args);
  const controller = new AbortController();
  let interrupted: number | undefined;
  const sigint = () => { interrupted ??= 130; controller.abort(); };
  const sigterm = () => { interrupted ??= 143; controller.abort(); };
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  let result;
  try {
    result = await runAgent({ ...request, signal: controller.signal }, { checkForUpdates: true });
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
  const notice = result.update && updateNotice(result.update);
  if (notice) console.error(notice);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.structuredOutput !== undefined) console.log(JSON.stringify(result.structuredOutput, null, 2));
  else if (result.finalText !== undefined) process.stdout.write(`${result.finalText}\n`);
  if (result.stderr && result.status !== "succeeded") process.stderr.write(result.stderr);
  if (result.status !== "succeeded") {
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    if (!result.stderr && !result.warnings.length) process.stderr.write(`${result.provider} ${result.status}\n`);
  }
  if (result.status === "unparsed") {
    // The provider exited 0 but its output was unreadable: the work may exist.
    const workspace = result.workspace;
    if (workspace) {
      const worktree = workspace.worktree ?? workspace.worktreeName;
      process.stderr.write(`workspace: ${workspace.cwd}${worktree ? ` (worktree: ${worktree})` : ""}\n`);
    }
    process.exitCode = 2;
  } else if (result.status !== "succeeded") process.exitCode = 1;
  if (interrupted) process.exitCode = interrupted;
}

main().catch((error) => {
  if (error instanceof AgentHeadlessError) console.error(`${error.code}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
