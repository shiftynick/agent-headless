import { AgentHeadlessError } from "../errors";
import type { ParsedOutput, Provider, RunRequest, SessionMode } from "../types";
export declare function envExecutable(provider: Provider, requestEnv?: Record<string, string | undefined>): string;
export declare function assertAccess(request: RunRequest, allowed: string[]): void;
export declare function assertSession(request: RunRequest, allowed: Array<SessionMode["mode"]>): void;
export declare function textOutput(provider: Provider, stdout: string): ParsedOutput;
export declare function providerFailure(provider: Provider, exitCode: number | null, stderr: string): AgentHeadlessError;
