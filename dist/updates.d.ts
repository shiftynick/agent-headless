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
    fetch?: (url: string, options: {
        signal: AbortSignal;
    }) => Promise<{
        ok: boolean;
        json(): Promise<unknown>;
    }>;
}
/** Only stable npm releases are advertised; prerelease builds may advance to stable. */
export declare function newerStableVersion(latest: string, current: string): boolean;
/** Best effort only: registry or cache failures never turn an agent run into a failure. */
export declare function checkForUpdates(options?: UpdateCheckOptions): Promise<UpdateInfo>;
export declare function updateNotice(info: UpdateInfo): string | undefined;
