import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { invalid } from "./errors";
import type { RunRequest } from "./types";

export function normalizeRequest(request: RunRequest): RunRequest {
  if (!request.prompt?.trim()) invalid("prompt must be non-empty");
  if (!request.cwd) invalid("cwd is required");
  if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
    invalid(`cwd is not an existing directory: ${request.cwd}`);
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    invalid("timeoutMs must be a positive number");
  }
  if (request.maxBudgetUsd !== undefined && (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0)) {
    invalid("maxBudgetUsd must be a positive number");
  }
  if (request.model !== undefined && !request.model.trim()) invalid("model must be non-empty");
  const additionalDirs = request.additionalDirs?.map((directory) => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      invalid(`additional directory does not exist: ${directory}`);
    }
    return realpathSync(directory);
  });
  return {
    ...request,
    cwd: realpathSync(request.cwd),
    access: request.access ?? (
      request.provider === "codex" && request.session?.mode === "resume"
        ? "inherit-session"
        : "answer-only"
    ),
    output: request.output ?? "events",
    session: request.session ?? (request.provider === "cursor" ? { mode: "persistent" } : { mode: "ephemeral" }),
    timeoutMs: request.timeoutMs ?? 20 * 60_000,
    ...(additionalDirs ? { additionalDirs } : {}),
  };
}

export function schemaPath(schema: object | string | undefined): string | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema !== "string") return undefined;
  return path.resolve(schema);
}
