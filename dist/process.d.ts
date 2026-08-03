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
export declare function runInvocation(invocation: Invocation, options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => void;
}): Promise<ProcessResult>;
export declare function readVersion(provider: Provider, command: string, cwd: string): Promise<string | undefined>;
export declare function probeExecutable(provider: Provider, command: string, cwd: string): Promise<ExecutableProbe>;
