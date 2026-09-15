/**
 * `decide ratify | reject | acknowledge` — a person's acts on a recorded
 * decision (D-S039, SX-020).
 *
 * `decide new` records a decision PROPOSED unless it carries a resolvable
 * authority, and every record written before D-S039 reads as ratified with
 * authority "unknown". scrumux-app lists both as variance and runs these verbs
 * under the acting person's identity; a person at a terminal runs them too.
 *
 * SUPERSESSION FOLLOWS STANDING. A proposed decision that names `supersedes`
 * does not stamp `superseded_by` on its predecessor; ratifying it stamps it in
 * the same write. Rejecting a legacy decision that had stamped one removes
 * that stamp, so the predecessor reads as live again.
 *
 * Dependencies: lib/standing-acts (parse, refusal, apply), journal/guards
 * (authorityGuard), journal/write (writeJson via guardedWrite), refs.
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
import { actRefusal, applyAct, parseActFlags, rowById, standingOf, withoutKeys, type ActVerb } from './lib/standing-acts.js';
import { guardedWrite, mapEntries } from './lib/writers.js';

/**
 * Run one act on `governance/decisions.json`.
 *
 * Dependencies: parseActFlags, actRefusal, applyAct, authorityGuard, guardedWrite.
 */
export function decideAct(cli: Cli, ctx: NounContext, io: Io, verb: ActVerb, args: readonly string[]): never {
  const f = parseActFlags('decide', verb, args);
  if (typeof f === 'string') return cli.die(f);
  const path = join(ctx.gov, 'decisions.json');
  if (!isFile(path) || !refExists(path, f.id)) return cli.die(`decide ${verb}: ${f.id} not found in governance/decisions.json`);
  if (verb === 'ratify') {
    if (f.authority === `standing:${f.id}`) {
      return cli.die(`decide ratify: ${f.id} cannot be its own authority — a record does not delegate its own ratification. Use --authority direct|app:<session>, or a different ratified delegation`);
    }
    refusing(cli, () => authorityGuard(ctx.gov, f.authority, 'decide ratify'));
  }

  let after: { [k: string]: JsonValue } | null = null;
  guardedWrite(cli, ctx, io, path, (doc) => {
    const row = rowById(entriesOf(doc), f.id)!;
    const why = actRefusal('decide', verb, f.id, standingOf(row));
    if (why !== null) throw new JournalRefusal(why);
    after = applyAct(row, verb, f, ctx.today, 'status');
    const sup = typeof row['supersedes'] === 'string' ? row['supersedes'] : '';
    return mapEntries(doc, (r) => {
      if (r['id'] === f.id) return after!;
      if (sup === '' || r['id'] !== sup) return r;
      // The deferred back-stamp (ratify) or its removal (reject).
      if (verb === 'ratify') return { ...r, superseded_by: f.id };
      if (verb === 'reject' && r['superseded_by'] === f.id) return withoutKeys(r, ['superseded_by']);
      return r;
    });
  });

  const v = standingOf(after!);
  cli.data({ id: f.id, status: v.status, authority: v.authority, by: f.by });
  const said = verb === 'ratify'
    ? `${f.id} ratified by ${f.by} (authority ${f.authority}).`
    : verb === 'reject'
      ? `${f.id} rejected by ${f.by}: it binds nothing.`
      : `${f.id} acknowledged by ${f.by}; its standing is unchanged (${v.status}, authority ${v.authority}).`;
  return cli.emit(said);
}
