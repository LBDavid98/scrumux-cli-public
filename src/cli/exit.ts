/**
 * The exit seam — one way out of the CLI, and it is not `process.exit`.
 *
 * WHY THIS EXISTS AT ALL. `Cli.die` and `Cli.emit` both need to end the
 * process on the spot, from wherever they are called, with nothing after
 * them running. A function that calls `process.exit` directly cannot be
 * unit-tested — the test process dies with it — so the surface where every
 * refusal message lives would be reachable only through a subprocess, and v8
 * coverage cannot see into one. Article 5 makes those messages product
 * surface; product surface that no unit test can reach is product surface
 * that drifts.
 *
 * So `exit` THROWS, always, in every configuration. One code path, no
 * branch on "am I under test", and the entry point turns the throw back into
 * a real exit. Nothing downstream of an `exit()` call runs.
 */

/** Thrown by `Io.exit`. Caught only at the entry point and by tests. */
export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ExitSignal';
  }
}

export interface Io {
  out(s: string): void;
  err(s: string): void;
  exit(code: number): never;
}

/** The real one. Writes to the process streams; the throw is unwound in bin. */
export const processIo: Io = {
  out: (s) => { process.stdout.write(s); },
  err: (s) => { process.stderr.write(s); },
  exit: (code) => { throw new ExitSignal(code); },
};

export interface CapturedIo extends Io {
  stdout: string;
  stderr: string;
}

/** For tests: the same interface, collecting into strings. */
export function captureIo(): CapturedIo {
  const io: CapturedIo = {
    stdout: '',
    stderr: '',
    out(s) { io.stdout += s; },
    err(s) { io.stderr += s; },
    exit(code) { throw new ExitSignal(code); },
  };
  return io;
}

/** Run something that ends in an ExitSignal and report the code it asked for. */
export function exitCodeOf(fn: () => void): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    throw e;
  }
  // A path that returns without exiting is `Cli.finish`'s safety-net case --
  // the caller decides what that means.
  return 0;
}
