import type { Invocation, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
export declare class ClaudeAdapter implements ProviderAdapter {
    readonly provider: "claude";
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
    private parseRecords;
}
