import type { Invocation, ParsedOutput, PrepareOptions, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
export declare class ClaudeAdapter implements ProviderAdapter {
    readonly provider: "claude";
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    listModels(): Promise<string[]>;
    prepare(request: RunRequest, _options?: PrepareOptions): Promise<RunRequest>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
    private parseRecords;
}
