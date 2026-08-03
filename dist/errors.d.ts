export type AgentErrorCode = "invalid_request" | "unsupported_capability" | "not_installed" | "provider_failed" | "invalid_provider_output";
export declare class AgentHeadlessError extends Error {
    readonly code: AgentErrorCode;
    constructor(code: AgentErrorCode, message: string, options?: ErrorOptions);
}
export declare function invalid(message: string): never;
export declare function unsupported(message: string): never;
