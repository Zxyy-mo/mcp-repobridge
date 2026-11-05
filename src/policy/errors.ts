export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export type StructuredErrorCategory = "validation" | "permission" | "not_found" | "execution" | "runtime" | "internal";

export class StructuredToolError extends Error {
  readonly toolCode: string;
  readonly category: StructuredErrorCategory;
  readonly retryable: boolean;
  readonly recovery?: { tool: string; arguments: Record<string, unknown>; reason: string };
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    category: StructuredErrorCategory;
    message: string;
    retryable?: boolean;
    recovery?: StructuredToolError["recovery"];
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "StructuredToolError";
    this.toolCode = input.code;
    this.category = input.category;
    this.retryable = input.retryable ?? false;
    this.recovery = input.recovery;
    this.details = input.details;
  }
}
