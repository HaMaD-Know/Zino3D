/** A user-facing error with a readable message and optional technical detail. */
export class ZinoError extends Error {
  readonly detail?: string;
  readonly code: string;
  constructor(code: string, message: string, detail?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ZinoError';
    this.code = code;
    this.detail = detail;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ZinoError) return error.message;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return 'Device storage is full. Free up space or delete old projects, then try again.';
  }
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'An unknown error occurred.';
}

export function isQuotaError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.code === 22;
  }
  return error instanceof Error && /quota/i.test(error.message);
}
