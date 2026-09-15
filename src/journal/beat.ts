/**
 * How a writer verb ENDS.
 *
 * CLAUDE.MD, "How the machine talks to the agent": every exit is a chance to
 * put a stochastic reader back on the beat, and a command that finishes with
 * a bare id has spent a turn and taught nothing. These three are how the
 * write path spends that turn.
 *
 * WHAT `beat` MUST NEVER SAY. It states what the work is NOW and what the
 * next legitimate move is. It does NOT hand out a governance chore -- "now go
 * log this" is the boundary this sits beside, and the line it must not cross.
 *
 * ROUTED THROUGH `say`, NOT A DIRECT WRITE, so `--json` keeps stdout to one
 * object (P-13/OQ-20: a diagnostic computed and suppressed under `--json`
 * goes into the envelope, never nowhere).
 */
import type { JsonValue } from './jqformat.js';

/** The slice of `Cli` these need. Structural, so nothing here imports it. */
export interface Emitter {
  say(line: string): void;
  data(obj: Record<string, JsonValue>): void;
  emit(summary?: string): never;
}

/**
 * `emitted <id>` -- THE writer's one exit.
 *
 * Prints the bare id in human mode, so `ID=$(scrumux task new ...)` captures
 * just the id, and carries the same id as `.data.id` under `--json`. Every
 * record-writing verb ends here rather than with its own ad hoc print.
 */
export function emitted(cli: Emitter, id: string): never {
  cli.data({ id });
  cli.say(id);
  return cli.emit('');
}

/** `beat <state line> [next move]` -- where the work is, and the next move. */
export function beat(cli: Emitter, state: string, next?: string): void {
  cli.say(`  ${state}`);
  if (next !== undefined && next !== '') cli.say(`  next: ${next}`);
}

/**
 * `attested <what> <how verification starts>`.
 *
 * Anything an agent records about its own work is a CLAIM until something
 * that is not the agent confirms it. Said at the point of recording, so the
 * rule is met rather than remembered.
 */
export function attested(cli: Emitter, what: string, next?: string): void {
  cli.say(`  ${what} recorded as ATTESTED — your claim about your own work, pending verification.`);
  cli.say('  You may initiate verification; you may not be the thing that verifies it.');
  if (next !== undefined && next !== '') cli.say(`  next: ${next}`);
}
