import type { Invocation, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
export declare class CodexAdapter implements ProviderAdapter {
    readonly provider: "codex";
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    listModels(): Promise<string[]>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
}
