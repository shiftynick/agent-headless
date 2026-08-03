#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { AgentHeadlessError, getAllCapabilities, getCapabilities, listModels, runAgent, VERSION } from "./index";
import type { AccessMode, Effort, OutputMode, Provider, RunRequest, SessionMode } from "./types";

const help = `agent-headless - one headless interface for Claude, Codex, and Cursor

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

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--json") { json = true; continue; }
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
    if (flag === "--max-budget-usd") { maxBudgetUsd = Number(take(args, index, flag)); index++; continue; }
    if (flag === "--schema") { schema = take(args, index, flag); index++; continue; }
    if (flag === "--add-dir") { additionalDirs.push(take(args, index, flag)); index++; continue; }
    throw new AgentHeadlessError("invalid_request", `unknown option: ${flag}`);
  }
  if (!provider || !["claude", "codex", "cursor"].includes(provider)) {
    throw new AgentHeadlessError("invalid_request", "--provider must be claude, codex, or cursor");
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
  if (command === "capabilities") {
    const provider = args[0] as Provider | undefined;
    if (provider && !["claude", "codex", "cursor"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "capabilities provider must be claude, codex, or cursor");
    }
    console.log(JSON.stringify(provider ? await getCapabilities(provider) : await getAllCapabilities(), null, 2));
    return;
  }
  if (command === "models") {
    const provider = args[0] as Provider | undefined;
    if (!provider || !["claude", "codex", "cursor"].includes(provider)) {
      throw new AgentHeadlessError("invalid_request", "models provider must be claude, codex, or cursor");
    }
    console.log((await listModels(provider)).join("\n"));
    return;
  }
  if (command !== "run") throw new AgentHeadlessError("invalid_request", `unknown command: ${command}`);
  const { request, json } = parseRun(args);
  const result = await runAgent(request);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.finalText !== undefined) process.stdout.write(`${result.finalText}\n`);
  if (result.stderr && result.status !== "succeeded") process.stderr.write(result.stderr);
  if (result.status !== "succeeded") process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof AgentHeadlessError) console.error(`${error.code}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
