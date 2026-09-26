import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VERSION } from "./version";
import { effectiveEnv, envValue } from "./process";

const REGISTRY_URL = "https://registry.npmjs.org/agent-headless/latest";
const DAY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 1_500;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface UpdateInfo {
  currentVersion: string;
  status: "checked" | "unavailable" | "disabled";
  latestVersion?: string;
  updateAvailable?: boolean;
}

export interface UpdateCheckOptions {
  /** Ignore the cached registry response. Still respects the opt-out. */
  force?: boolean;
  /** Environment overlay, including AGENT_HEADLESS_NO_UPDATE_CHECK=1. */
  env?: Record<string, string | undefined>;
  /** Override the per-user cache directory. */
  cacheDir?: string;
  /** Optional transport for deterministic tests; no credentials are sent. */
  fetch?: (url: string, options: { signal: AbortSignal }) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
}

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && STABLE_VERSION.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

/** Only stable npm releases are advertised; prerelease builds may advance to stable. */
export function newerStableVersion(latest: string, current: string): boolean {
  if (!stableVersion(latest)) return false;
  const core = current.split(/[+-]/u)[0]!;
  if (!stableVersion(core)) return false;
  const next = latest.split(".").map(Number);
  const installed = core.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index]! > installed[index]!;
  }
  return current.split("+")[0]!.includes("-");
}

/** Best effort only: registry or cache failures never turn an agent run into a failure. */
export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<UpdateInfo> {
  const unavailable: UpdateInfo = { currentVersion: VERSION, status: "unavailable" };
  const env = effectiveEnv(options.env);
  if (envValue(env, "AGENT_HEADLESS_NO_UPDATE_CHECK") === "1") {
    return { currentVersion: VERSION, status: "disabled" };
  }
  const checked = (latestVersion: string): UpdateInfo => ({
    currentVersion: VERSION,
    status: "checked",
    latestVersion,
    updateAvailable: newerStableVersion(latestVersion, VERSION),
  });
  try {
    const root = options.cacheDir ?? path.join(
      envValue(env, "XDG_CACHE_HOME") || (process.platform === "win32" ? envValue(env, "LOCALAPPDATA") : undefined)
        || path.join(homedir(), ".cache"),
      "agent-headless",
    );
    const cachePath = path.join(root, "update-check.json");
    if (!options.force) {
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8"));
        const age = Date.now() - cached.checkedAt;
        const ttl = cached.latestVersion === null ? 60 * 60_000 : DAY_MS;
        if (typeof cached.checkedAt === "number" && age >= 0 && age < ttl) {
          if (stableVersion(cached.latestVersion)) return checked(cached.latestVersion);
          if (cached.latestVersion === null) return unavailable;
        }
      } catch { /* Missing or damaged cache: try the registry. */ }
    }

    let latestVersion: string | null = null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound both response headers and body, including an injected transport
      // that ignores abort. Clearing the timer keeps short-lived CLIs fast.
      latestVersion = await Promise.race([
        (async () => {
          const response = await (options.fetch ?? globalThis.fetch)(REGISTRY_URL, { signal: controller.signal });
          if (!response.ok) return null;
          const data = await response.json() as { version?: unknown } | null;
          return stableVersion(data?.version) ? data.version : null;
        })(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, TIMEOUT_MS);
        }),
      ]);
    } catch { /* Offline, rejected, or malformed: preserve the caller's result. */ }
    finally { clearTimeout(timer); }

    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(root, { recursive: true });
      await writeFile(temporary, JSON.stringify({ checkedAt: Date.now(), latestVersion }), { mode: 0o600 });
      await rename(temporary, cachePath);
    } catch { /* Read-only homes and concurrent callers must remain usable. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return latestVersion ? checked(latestVersion) : unavailable;
  } catch { return unavailable; }
}

export function updateNotice(info: UpdateInfo): string | undefined {
  if (!info.updateAvailable || !info.latestVersion) return undefined;
  return `agent-headless ${info.latestVersion} is available (installed: ${info.currentVersion}). Update the consuming repo's dependency and lockfile, or use npx -y agent-headless@latest.`;
}
