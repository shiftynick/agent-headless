import { describe, expect, test } from "bun:test";
import { normalizeRequest } from "../src/validation";
import { resolveOnWindows } from "../src/process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("normalizeRequest", () => {
  test("uses ephemeral sessions for Claude and Codex", () => {
    for (const provider of ["claude", "codex"] as const) {
      expect(normalizeRequest({ provider, prompt: "x", cwd: process.cwd() }).session).toEqual({ mode: "ephemeral" });
    }
  });

  test("uses persistent sessions for providers without an ephemeral mode", () => {
    for (const provider of ["cursor", "antigravity"] as const) {
      expect(normalizeRequest({ provider, prompt: "x", cwd: process.cwd() }).session).toEqual({ mode: "persistent" });
    }
  });

  test("defaults every new session to least-privilege answer-only access", () => {
    for (const provider of ["claude", "codex", "cursor", "antigravity"] as const) {
      expect(normalizeRequest({ provider, prompt: "x", cwd: process.cwd() }).access).toBe("answer-only");
    }
  });

  test("rejects missing prompt and nonexistent cwd", () => {
    expect(() => normalizeRequest({ provider: "claude", prompt: "", cwd: process.cwd() })).toThrow();
    expect(() => normalizeRequest({ provider: "claude", prompt: "x", cwd: "Z:\\definitely-missing" })).toThrow();
  });
});

test("Windows command resolution uses the real case-preserved Path key", () => {
  if (process.platform !== "win32") return;
  const dir = mkdtempSync(path.join(tmpdir(), "ah-path-case-"));
  try {
    writeFileSync(path.join(dir, "codex.cmd"), "@echo fake\r\n");
    expect(resolveOnWindows("codex", { Path: dir, PATHEXT: ".CMD" })).toBe(path.join(dir, "codex.cmd"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
