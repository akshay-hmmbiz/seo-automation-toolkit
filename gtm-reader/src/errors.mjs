/**
 * An error with a message that is safe to show to the user as it is,
 * and the exit code the command line should end with.
 *
 * Exit codes: 1 = bad input or usage, 2 = container not found or not reachable.
 */
export class GtmReaderError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'GtmReaderError';
    this.exitCode = exitCode;
  }
}
