import type { Invocation, ParsedOutput, PrepareOptions, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
export declare class CodexAdapter implements ProviderAdapter {
    readonly provider: "codex";
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    listModels(): Promise<string[]>;
    prepare(request: RunRequest, _options?: PrepareOptions): Promise<RunRequest>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
}
