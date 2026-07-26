/**
 * Error taxonomy (spec §7). SoftError marks a narrow casualty — one URL,
 * one company, one board: the runner records it and the run continues, so
 * breadth survives. Any other thrown error fails the stage loudly.
 */
export class SoftError extends Error {
  override readonly name = 'SoftError';
  readonly scope: string;

  constructor(scope: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.scope = scope;
  }
}

export function isSoftError(err: unknown): err is SoftError {
  return err instanceof SoftError;
}
