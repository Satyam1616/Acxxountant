export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "DomainError";
    this.code = code;
  }
}

export class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "StorageError";
    this.code = code;
  }
}

export function invariant(condition: unknown, code: string, message?: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
