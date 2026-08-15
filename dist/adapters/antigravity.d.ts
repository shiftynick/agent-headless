import type { Invocation, ListModelsOptions, ParsedOutput, ProviderAdapter, ProviderCapabilities, RunRequest } from "../types";
/** Adapter for Antigravity CLI (`agy`) print mode. */
export declare class AntigravityAdapter implements ProviderAdapter {
    readonly provider: "antigravity";
    capabilities(executable?: string): Promise<ProviderCapabilities>;
    listModels(options?: ListModelsOptions): Promise<string[]>;
    build(request: RunRequest): Invocation;
    parse(stdout: string, structured: boolean): ParsedOutput;
}
