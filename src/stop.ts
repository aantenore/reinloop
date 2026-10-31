/**
 * Thrown by middleware (or a tool) to end the run on purpose: the loop finishes it with status `stopped` and this
 * `reason`, without treating it as a failure. `output` becomes the run output (default: the last assistant text).
 */
export class RunStop extends Error {
  readonly reason: string;
  readonly output?: string;
  constructor(reason: string, output?: string) {
    super(reason);
    this.name = 'RunStop';
    this.reason = reason;
    this.output = output;
  }
}
