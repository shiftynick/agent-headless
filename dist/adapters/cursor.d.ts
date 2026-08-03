import type { Invocation, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
export declare class CursorAdapter implements ProviderAdapter {
    readonly provider: "cursor";
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    listModels(executable?: string): Promise<string[]>;
    prepare(request: RunRequest): Promise<RunRequest>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
}
