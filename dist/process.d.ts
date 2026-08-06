import type { Invocation, Provider, ProviderAvailability } from "./types";
export interface ProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    cancelled: boolean;
}
export interface ExecutableProbe {
    executable: string;
    availability: ProviderAvailability;
    version?: string;
    reason?: string;
}
export declare function resolveOnWindows(command: string, env: NodeJS.ProcessEnv): string;
/**
 * The environment a child launched with these overrides actually receives:
 * `process.env` with `options.env` overlaid, where an explicit `undefined`
 * *removes* the variable and, on Windows, a differently-cased override replaces
 * the inherited entry rather than sitting beside it.
 *
 * Extracted so that anything which has to see the world as the provider will -
 * `gitToplevel`'s repository probe, most of all - builds the same environment
 * `runInvocation` builds, instead of re-deriving it and drifting.
 */
export declare function effectiveEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
/**
 * How a command name plus arguments must actually be handed to `spawn` under a
 * given environment.
 *
 * Two Windows facts force this, both verified on Node 22 (win32):
 *
 * 1. `spawn`/`spawnSync` resolve a bare command against the *child* environment's
 *    `PATH` - a `.exe` reachable only through an overridden `PATH` is found, and
 *    one reachable only through the parent's is not. Lookup is therefore already
 *    at parity with the child, but `resolveOnWindows` is still applied so the
 *    resolved path is visible and `PATHEXT` is honoured consistently.
 * 2. A `.cmd`/`.bat` target cannot be executed directly at all: spawning one by
 *    full path fails `EINVAL`, and a bare name whose only match is a `.cmd` fails
 *    `ENOENT`. It has to be run through `cmd.exe`.
 *
 * Sharing this with `runInvocation` is what makes "the probe sees git exactly as
 * the provider invocation would" true rather than aspirational.
 */
export declare function resolveCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv): {
    command: string;
    args: string[];
    windowsVerbatimArguments: boolean;
};
export declare function runInvocation(invocation: Invocation, options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => void;
}): Promise<ProcessResult>;
export declare function readVersion(provider: Provider, command: string, cwd: string): Promise<string | undefined>;
export declare function probeExecutable(provider: Provider, command: string, cwd: string): Promise<ExecutableProbe>;
