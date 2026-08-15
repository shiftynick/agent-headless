import { expect, setDefaultTimeout, test } from "bun:test";
import { runAgent } from "../src";

const live = process.env.AGENT_HEADLESS_LIVE === "1" ? test : test.skip;
const cwd = process.env.AGENT_HEADLESS_LIVE_CWD ?? process.cwd();
setDefaultTimeout(190_000);

live("Claude headless adapter completes a structured answer-only run", async () => {
  const result = await runAgent({
    provider: "claude",
    prompt: "Return exactly CLAUDE_HEADLESS_OK and nothing else. Do not use tools.",
    cwd,
    model: process.env.AGENT_HEADLESS_CLAUDE_MODEL ?? "fable",
    effort: "low",
    access: "answer-only",
    timeoutMs: 180_000,
  });
  expect(result.status).toBe("succeeded");
  expect(result.finalText).toContain("CLAUDE_HEADLESS_OK");
  expect(result.sessionId).toBeTruthy();
});

live("Codex headless adapter completes a structured answer-only run", async () => {
  const result = await runAgent({
    provider: "codex",
    prompt: "Return exactly CODEX_HEADLESS_OK and nothing else. Do not use tools.",
    cwd,
    ...(process.env.AGENT_HEADLESS_CODEX_MODEL ? { model: process.env.AGENT_HEADLESS_CODEX_MODEL } : {}),
    effort: "low",
    access: "answer-only",
    timeoutMs: 180_000,
  });
  expect(result.status).toBe("succeeded");
  expect(result.finalText).toContain("CODEX_HEADLESS_OK");
  expect(result.sessionId).toBeTruthy();
});

live("Cursor headless adapter completes a structured answer-only run", async () => {
  const result = await runAgent({
    provider: "cursor",
    prompt: "Return exactly CURSOR_HEADLESS_OK and nothing else. Do not use tools.",
    cwd,
    model: process.env.AGENT_HEADLESS_CURSOR_MODEL ?? "gpt-5.6-terra-low",
    effort: "low",
    access: "answer-only",
    providerOptions: { cursor: { trustWorkspace: true } },
    timeoutMs: 180_000,
  });
  expect(result.status).toBe("succeeded");
  expect(result.finalText).toContain("CURSOR_HEADLESS_OK");
  expect(result.sessionId).toBeTruthy();
});

live("Antigravity headless adapter completes a structured answer-only run", async () => {
  const result = await runAgent({
    provider: "antigravity",
    prompt: "Return exactly ANTIGRAVITY_HEADLESS_OK and nothing else. Do not use tools.",
    cwd,
    ...(process.env.AGENT_HEADLESS_ANTIGRAVITY_MODEL ? { model: process.env.AGENT_HEADLESS_ANTIGRAVITY_MODEL } : {}),
    effort: "low",
    access: "answer-only",
    timeoutMs: 180_000,
  });
  expect(result.status).toBe("succeeded");
  expect(result.finalText).toContain("ANTIGRAVITY_HEADLESS_OK");
  expect(result.sessionId).toBeTruthy();
});
