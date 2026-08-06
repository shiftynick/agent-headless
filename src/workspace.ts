import path from "node:path";
import { cursorWorktreePath } from "./adapters/cursor";
import { asRecord } from "./jsonl";
import type { AgentEvent, RunRequest, WorkspaceInfo } from "./types";

const WORKTREE_KEYS = ["worktree_path", "worktreePath", "worktree_dir", "worktreeDir", "worktree"];

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** Pulls an isolated worktree path out of parsed provider events, when one is present. */
function worktreeFromEvents(events: AgentEvent[], cwd: string): string | undefined {
  for (const event of events) {
    const raw = asRecord(event.raw);
    if (!raw) continue;
    for (const scope of [raw, asRecord(raw.item), asRecord(raw.workspace), asRecord(raw.worktree)]) {
      if (!scope) continue;
      for (const key of WORKTREE_KEYS) {
        const value = scope[key];
        if (typeof value === "string" && value.trim()) return value;
      }
    }
    // Only a session/init event's cwd identifies the worktree. A tool or status
    // event's cwd can be a subdirectory or an auxiliary path, and reporting that
    // would be confidently wrong - worse than reporting no worktree at all. The
    // explicit `worktree*` keys above stay unrestricted: they name the thing.
    if (event.kind === "session" && typeof raw.cwd === "string" && raw.cwd.trim() && !samePath(raw.cwd, cwd)) {
      return raw.cwd;
    }
  }
  return undefined;
}

/**
 * Last-resort scan of raw stdout, used when the stream could not be parsed at all.
 * This is a heuristic: it only finds a path the provider actually printed.
 */
function worktreeFromText(stdout: string, worktreeName?: string): string | undefined {
  const keyed = stdout.match(/"worktree(?:_path|Path|_dir|Dir)?"\s*:\s*"((?:[^"\\]|\\.)*)"/u);
  if (keyed?.[1]) {
    try {
      return JSON.parse(`"${keyed[1]}"`) as string;
    } catch {
      return keyed[1];
    }
  }
  if (!worktreeName) return undefined;
  const escaped = worktreeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = stdout.match(new RegExp(`(?:[A-Za-z]:[\\\\/]|/)[^\\s"']*[\\\\/]${escaped}(?![\\w.-])`, "u"));
  if (!match) return undefined;
  return match[0].includes("\\\\") ? match[0].replace(/\\\\/gu, "\\") : match[0];
}

/**
 * Describes where a run's work went. Always reports cwd and access; for isolated
 * runs it also reports the worktree name/base the runner chose (known regardless
 * of output readability) and the worktree path itself.
 *
 * The path is taken from the provider when the provider disclosed one - it is
 * authoritative about where it actually put the work - and otherwise derived
 * from the pinned name and Cursor's fixed worktree layout. Deriving is what
 * makes the path survive the case the parsed path cannot: output that could not
 * be read at all, which is exactly when a caller most needs to find the work.
 */
export function describeWorkspace(
  request: RunRequest,
  cwd: string,
  events: AgentEvent[],
  stdout: string,
): WorkspaceInfo {
  const isolated = request.access === "edit-isolated";
  const cursor = request.providerOptions?.cursor;
  const worktreeName = !isolated
    ? undefined
    : request.provider === "cursor"
      ? cursor?.worktreeName
      : request.provider === "claude"
        ? request.providerOptions?.claude?.worktreeName ?? "agent-headless"
        : undefined;
  const worktreeBase = isolated && request.provider === "cursor" ? cursor?.worktreeBase : undefined;
  const reported = isolated
    ? worktreeFromEvents(events, cwd) ?? worktreeFromText(stdout, worktreeName)
    : undefined;
  const derived = isolated && !reported ? cursorWorktreePath(request, cwd) : undefined;
  const worktree = reported ?? derived;
  return {
    cwd,
    access: request.access!,
    ...(worktree ? { worktree, worktreeSource: reported ? "reported" as const : "derived" as const } : {}),
    ...(derived ? { worktreeRoot: path.dirname(derived) } : {}),
    ...(worktreeName ? { worktreeName } : {}),
    ...(worktreeBase ? { worktreeBase } : {}),
  };
}
