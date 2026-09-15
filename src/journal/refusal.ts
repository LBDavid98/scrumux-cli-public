/**
 * The one exception the write engine throws.
 *
 * WHY NOT CALL THE CLI's `die` DIRECTLY: the journal engine (`src/journal/`)
 * has more than one caller. A verb wraps its write in `refusing(cli, ...)`
 * and gets an exit-2 "refused" envelope with the message printed as
 * `scrumux <command>: error: <message>` on stderr; a test, or one of the
 * walls' hook entry points, drives the engine directly with no envelope
 * machinery attached and reads the message off the thrown value. The engine
 * names the refusal and the caller disposes of it, so the MESSAGE is the
 * contract (Article 5) and it is identical either way.
 */

/** A refusal from the journal engine, carrying the operator-facing message. */
export class JournalRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalRefusal';
  }
}

/**
 * What `refusing` needs from a `Cli`. Structural on purpose: the engine does
 * not import the CLI layer, so `src/journal/` stays loadable by a test (and
 * by the walls' hook entry points) with no envelope machinery attached.
 */
export interface Refuser {
  die(message: string): never;
}

/**
 * Run a write and turn its refusal into the CLI's exit-2 refusal.
 *
 * ONLY `JournalRefusal` IS CAUGHT. A TypeError out of a caller's transform is
 * a defect in the verb, not a refusal the operator can act on, and swallowing
 * it into "scrumux task new: error: ..." would dress a crash as a governance
 * decision.
 */
export function refusing<T>(cli: Refuser, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof JournalRefusal) return cli.die(e.message);
    throw e;
  }
}
