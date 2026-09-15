/**
 * The sink for a prose REPORT verb, and the refusal that can escape one.
 *
 * `Cli.say()` suppresses under `--json`, which is right for a command that
 * has a structured answer. A REPORT does not: `status session`, `status
 * sprint` and `backlog tasks` ARE their prose. Under `--json` those lines
 * have to go somewhere, and "nowhere" would hand a caller an empty object for
 * a command whose whole output is the report. `Report` is that somewhere:
 *
 *   - lines are collected VERBATIM, in order, in both modes;
 *   - human mode prints every line as it is produced, blank ones included;
 *   - `--json` drops BLANK LINES from `.data.lines` -- a `line('')` separator
 *     is a rendering device and never reaches the object.
 *
 * HUMAN MODE WRITES THROUGH, and that is not an optimisation. A report
 * function can refuse half way (`backlog` dies on an unreadable journal after
 * its header line is already out), and the terminal has those bytes by then.
 * Buffering them until `emit` would lose them, because the refusal exits
 * before `emit` is reached.
 *
 * THE SWALLOW IS DELIBERATE. Under `--json`, a refusal mid-report throws
 * `ReportRefusal` past whatever this class has buffered -- the buffered lines
 * never reach any envelope, because there is no envelope to put them in yet.
 * `backlog tasks --json` over an unreadable `tasks.json` produces exit 2 and
 * no `.data.lines`. `--json` is the lossier mode here (docs/port/PHILOSOPHY.md
 * P-53), and that is an accepted property of the contract, not a bug to close
 * by inventing a partial-report envelope shape. `ReportRefusal` exists so the
 * call site has to dispose of it deliberately rather than let it propagate as
 * an unhandled exception.
 *
 * WHY IT LIVES IN `src/cli/` rather than beside the jq helpers in
 * `src/nouns/lib/jqlike.ts`: it is a property of the OUTPUT SEAM, not of any
 * noun -- it decides where a line goes under `--json`, which is the same
 * question `Cli.say` and `Io` answer, and those live here too. Two importers
 * today is a fact about which verbs are reports, not about where the
 * mechanism belongs.
 */
import type { Io } from './exit.js';

/** Thrown by a report function that cannot continue partway through.
 *  Carries only the message; the disposition is the caller's. */
export class ReportRefusal extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ReportRefusal';
  }
}

export class Report {
  private buf = '';

  /**
   * @param json  the `--json` flag: buffer for `.data.lines`, or write through.
   * @param io    where a human-mode line goes the moment it exists.
   */
  constructor(private readonly json: boolean, private readonly io: Io) {}

  /** One report line, written through in human mode or buffered under `--json`.
   *  The argument may itself be multi-line. */
  line(s: string): void {
    if (this.json) this.buf += s + '\n';
    else this.io.out(s + '\n');
  }

  /** Several lines, each disposed of the same way as `line`. */
  lines(ss: readonly string[]): void {
    for (const s of ss) this.line(s);
  }

  /**
   * The buffered lines, split and with blank ones dropped. Empty in human
   * mode by construction: nothing was buffered, it was all written through.
   */
  dataLines(): string[] {
    return this.buf.split('\n').filter((l) => l.length > 0);
  }
}
