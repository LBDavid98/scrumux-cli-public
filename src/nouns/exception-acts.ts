/**
 * `exception ratify | reject | acknowledge` — a person's acts on a recorded
 * RESOLUTION of a process finding (D-S039, the `exception resolve` half of
 * SX-020).
 *
 * `exception resolve` records a resolution with `resolution_status: proposed`
 * unless it carries a resolvable authority; a resolution written before
 * D-S039 reads as ratified with authority "unknown". The finding's own
 * `status` (open|tracked|ratified|corrected|rejected|withdrawn) is its
 * lifecycle and is not overloaded: the standing lives in `resolution_status`.
 *
 * REJECTING A RESOLUTION REOPENS THE FINDING (`status: open`): what a person
 * refused is unsettled, and `exception list` shows it again. The rejected
 * resolution's fields stay on the row as the record of what was refused.
 *
 * Dependencies: lib/standing-acts, journal/guards (authorityGuard), writers.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import type { JsonValue } from '../journal/jqformat.js';
import { authorityGuard } from '../journal/guards.js';
import { refExists } from '../journal/refs.js';
import { JournalRefusal, refusing } from '../journal/refusal.js';
import { isFile } from '../util/fs-predicates.js';
import type { NounContext } from './lib/context.js';
import { entriesOf } from './lib/jqlike.js';
import { actRefusal, applyAct, parseActFlags, rowById, standingOf, type ActVerb } from './lib/standing-acts.js';
import { guardedWrite, mapEntries } from './lib/writers.js';

/**
 * Run one act on `governance/exceptions.json`.
 *
 * Dependencies: parseActFlags, actRefusal, applyAct, authorityGuard, guardedWrite.
 */
export function exceptionAct(cli: Cli, ctx: NounContext, io: Io, verb: ActVerb, args: readonly string[]): never {
  const f = parseActFlags('exception', verb, args);
  if (typeof f === 'string') return cli.die(f);
  const path = join(ctx.gov, 'exceptions.json');
  if (!isFile(path) || !refExists(path, f.id)) return cli.die(`exception ${verb}: no ${f.id} in this repo`);
  if (verb === 'ratify') refusing(cli, () => authorityGuard(ctx.gov, f.authority, 'exception ratify'));

  let after: { [k: string]: JsonValue } | null = null;
  guardedWrite(cli, ctx, io, path, (doc) => {
    const row = rowById(entriesOf(doc), f.id)!;
    if (row['status'] === 'open' && row['resolution_status'] === undefined) {
      throw new JournalRefusal(`exception ${verb}: ${f.id} is open — there is no resolution to ${verb}. A person resolves it: scrumux exception resolve ${f.id} --status tracked|ratified|corrected|rejected|withdrawn --by WHO --authority direct|app:<session>`);
    }
    const why = actRefusal('exception', verb, f.id, standingOf(row, 'resolution_status'));
    if (why !== null) throw new JournalRefusal(why);
    after = applyAct(row, verb, f, ctx.today, 'resolution_status');
    if (verb === 'reject') after = { ...after, status: 'open' };
    return mapEntries(doc, (r) => (r['id'] === f.id ? after! : r));
  });

  const v = standingOf(after!, 'resolution_status');
  cli.data({ id: f.id, resolution_status: v.status, authority: v.authority, by: f.by });
  const said = verb === 'ratify'
    ? `${f.id}'s resolution ratified by ${f.by} (authority ${f.authority}).`
    : verb === 'reject'
      ? `${f.id}'s resolution rejected by ${f.by}; the finding is open again.`
      : `${f.id}'s resolution acknowledged by ${f.by}; its standing is unchanged (${v.status}, authority ${v.authority}).`;
  return cli.emit(said);
}
