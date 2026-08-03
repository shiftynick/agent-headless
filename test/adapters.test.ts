import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, CodexAdapter, CursorAdapter } from "../src/adapters";
import { AgentHeadlessError } from "../src/errors";
import type { Provider, RunRequest } from "../src/types";
import { normalizeRequest } from "../src/validation";

function request(provider: Provider, overrides: Partial<RunRequest> = {}): RunRequest {
  return normalizeRequest({
    provider,
    prompt: "Say OK",
    cwd: process.cwd(),
    ...overrides,
  });
}

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  test("builds a safe ephemeral inspection stream", () => {
    const invocation = adapter.build(request("claude", { model: "sonnet", effort: "high" }));
    expect(invocation.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose",
      "--model", "sonnet", "--effort", "high",
      "--permission-mode", "dontAsk", "--tools", "Read", "Glob", "Grep",
      "--no-session-persistence",
    ]);
    expect(invocation.stdin).toBe("Say OK");
  });

  test("builds answer-only without tools", () => {
    const invocation = adapter.build(request("claude", { access: "answer-only", output: "text" }));
    expect(invocation.args).toContain("--tools=");
    expect(invocation.structured).toBe(false);
  });

  test("builds an isolated named worktree", () => {
    const invocation = adapter.build(request("claude", {
      access: "edit-isolated",
      providerOptions: { claude: { worktreeName: "review-42" } },
    }));
    expect(invocation.args).toContain("--worktree");
    expect(invocation.args).toContain("review-42");
    expect(invocation.args).toContain("acceptEdits");
  });

  test("parses terminal stream result and usage", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s1", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: { x: { canonicalModel: "claude-sonnet" } } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "s1",
      modelObserved: "claude-sonnet",
      usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.01 },
    });
  });
});

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  test("maps effort through a strict TOML config value", () => {
    const invocation = adapter.build(request("codex", { effort: "medium", model: "gpt-5.6" }));
    expect(invocation.args).toContainAllValues([
      "exec", "-C", process.cwd(), "-s", "read-only", "--ephemeral", "--model", "gpt-5.6",
      "-c", 'model_reasoning_effort="medium"', "--json", "-",
    ]);
  });

  test("maps explicit workspace editing", () => {
    const invocation = adapter.build(request("codex", { access: "edit-workspace" }));
    expect(invocation.args).toContain("-s");
    expect(invocation.args).toContain("workspace-write");
  });

  test("rejects isolated editing", () => {
    expect(() => adapter.build(request("codex", { access: "edit-isolated" }))).toThrow(AgentHeadlessError);
  });

  test("requires inherited access semantics for resumed sessions", () => {
    expect(() => adapter.build(request("codex", {
      session: { mode: "resume", id: "thread-1" },
      access: "inspect",
    }))).toThrow(AgentHeadlessError);
    const invocation = adapter.build(request("codex", {
      session: { mode: "resume", id: "thread-1" },
      access: "inherit-session",
    }));
    expect(invocation.args.slice(0, 4)).toEqual(["exec", "resume", "thread-1", "--json"]);
  });

  test("does not expose writable additional dirs in read-only mode", () => {
    expect(() => adapter.build(request("codex", {
      additionalDirs: [process.cwd()],
      access: "inspect",
    }))).toThrow(AgentHeadlessError);
  });

  test("uses request-scoped executable overrides", () => {
    const invocation = adapter.build(request("codex", { env: { CODEX_BIN: "X:\\tools\\codex.exe" } }));
    expect(invocation.command).toBe("X:\\tools\\codex.exe");
  });

  test("parses Codex JSONL", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "t1",
      usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 1, reasoningOutputTokens: 0 },
    });
  });
});

describe("CursorAdapter", () => {
  const adapter = new CursorAdapter();

  test("defaults to a persistent, read-only plan session", () => {
    const invocation = adapter.build(request("cursor", { model: "gpt-5.3-codex-low" }));
    for (const value of ["--print", "--model", "gpt-5.3-codex-low", "--output-format", "stream-json", "--mode", "plan"]) {
      expect(invocation.args).toContain(value);
    }
    expect(invocation.args).not.toContain("--trust");
  });

  test("adds effort to a parameterized model without losing parameters", () => {
    const invocation = adapter.build(request("cursor", {
      model: "claude-opus[context=1m,fast=false]",
      effort: "high",
      access: "answer-only",
    }));
    expect(invocation.args).toContain("claude-opus[context=1m,fast=false,effort=high]");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).toContain("ask");
  });

  test("does not corrupt an exact model ID that already encodes effort", () => {
    const invocation = adapter.build(request("cursor", { model: "gpt-5.6-terra-low", effort: "low" }));
    expect(invocation.args).toContain("gpt-5.6-terra-low");
    expect(invocation.args).not.toContain("gpt-5.6-terra-low[effort=low]");
  });

  test("supports exact max-effort Cursor model IDs", () => {
    const invocation = adapter.build(request("cursor", { model: "claude-opus-5-max", effort: "max" }));
    expect(invocation.args).toContain("claude-opus-5-max");
  });

  test("workspace trust is explicit", () => {
    const invocation = adapter.build(request("cursor", {
      model: "gpt-5.3-codex-low",
      providerOptions: { cursor: { trustWorkspace: true } },
    }));
    expect(invocation.args).toContain("--trust");
  });

  test("rejects ephemeral sessions and schemas", () => {
    expect(() => adapter.build(request("cursor", { model: "gpt-5", session: { mode: "ephemeral" } }))).toThrow(AgentHeadlessError);
    expect(() => adapter.build(request("cursor", { model: "gpt-5", schema: {} }))).toThrow(AgentHeadlessError);
  });

  test("parses Cursor JSONL", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "c1", model: "gpt-5" }),
      JSON.stringify({ type: "assistant", subtype: "message", content: "OK" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "c1", usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 2 } }),
    ].join("\n");
    expect(adapter.parse(stdout, true)).toMatchObject({
      finalText: "OK",
      sessionId: "c1",
      modelObserved: "gpt-5",
      usage: { inputTokens: 6, cachedInputTokens: 2, outputTokens: 1 },
    });
  });
});

describe("protocol validation", () => {
  test("rejects malformed and incomplete JSONL", () => {
    expect(new CodexAdapter().parse("not-json", true).protocolError).toContain("invalid JSONL");
    expect(new CursorAdapter().parse(JSON.stringify({ type: "system" }), true).protocolError).toContain("terminal result");
  });
});
