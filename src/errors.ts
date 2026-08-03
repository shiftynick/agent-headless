export type AgentErrorCode =
  | "invalid_request"
  | "unsupported_capability"
  | "not_installed"
  | "provider_failed"
  | "invalid_provider_output";

export class AgentHeadlessError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentHeadlessError";
  }
}

export function invalid(message: string): never {
  throw new AgentHeadlessError("invalid_request", message);
}

export function unsupported(message: string): never {
  throw new AgentHeadlessError("unsupported_capability", message);
}
