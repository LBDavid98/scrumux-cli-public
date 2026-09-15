/**
 * The `rank` noun.
 *
 * A RANK MEANS SOMEONE DECIDED THIS PRIORITY. An absent rank is not a low
 * priority, it is NO DECISION, and every line below exists to keep those two
 * apart:
 *
 *   THE ORDERING LIST IS THE RANKED SET ONLY (I-0044/T-0096). Densifying
 *   across every open task stamped a rank onto work nobody had ever
 *   prioritised, so ONE move converted the whole backlog into false priority
 *   and undid the ranked/unranked split T-0092 built. The re-densify therefore
 *   walks `$order` -- the ranked ids -- and an entry absent from it keeps
 *   whatever it had, which for never-prioritised work is nothing.
 *
 *   CLEARING DELETES THE KEY. Not null, not 0: `backlog` partitions on
 *   `rank == null` and `task.schema.json` declares rank as an integer with
 *   minimum 1, so only deletion is both correct and schema-legal.
 *
 *   NO `updated_at`. Ranking is ordering metadata, not work, and must not read
 *   as a touched task.
 *
 * FEATURES RANK IN THE SAME ADDRESS SPACE AND WITH THE SAME SEMANTICS AS
 * TASKS (T-0093), in their own list inside `design.json`. The feature branch
 * ends by calling `emit`, WHICH EXITS THE PROCESS -- so a `tasks.json`
 * existence guard that ran unconditionally after it would be unreachable
 * for a feature ref. That is dispatch-by-exit, not a fallthrough bug
 * (design-nouns.md), which is why this is written as an early return rather
 * than as a `switch` that falls through: `rank set F-0001 1` in a repo with
 * no tasks.json prints `F-0001 -> rank 1` at rc 0.
 *
 * AN OUT-OF-RANGE POSITION CLAMPS, IT DOES NOT REFUSE (OQ-DN3, unruled).
 * `rank set T-0003 999` against a three-item ranked list places it last. No
 * comment states it is deliberate and no test pins it; left as it stands
 * because the sibling case (an unknown id) refuses, and only a ruling settles
 * whether the asymmetry is intended.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { refExists } from '../journal/refs.js';
import { sealBootstrap } from '../journal/seals.js';
import { sortBy } from './lib/jqlike.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';
import { guardedWrite, mapEntries } from './lib/writers.js';

export const VERBS = ['set', 'clear'] as const;

const VERBS_TSV = `set\tmove a backlog item to a position
clear\treturn an item to never-prioritised
`;

function rows(path: string): JsonValue[] {
  if (!existsSync(path)) return [];
  try {
    const doc = parsePreservingNumbers(readFileSync(path, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
    const e = (doc as { [k: string]: JsonValue })['entries'];
    return Array.isArray(e) ? e : [];
  } catch {
    return [];
  }
}

function obj(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as { [k: string]: JsonValue };
}

/** `jq -r ... | grep -c .` -- an id rendered raw, and empties dropped. */
function idList(list: readonly JsonValue[]): string[] {
  const out: string[] = [];
  for (const row of list) {
    const o = obj(row);
    const v = o === null ? undefined : o['id'];
    out.push(v === undefined || v === null ? 'null' : typeof v === 'string' ? v : String(v));
  }
  // `grep -v '^$'` in the pipelines that build the write's `$order`.
  return out.filter((s) => s !== '');
}

/**
 * `awk -v pos -v id 'NR==pos{print id} {print} END{if (NR<pos) print id}'`
 * over the list with `id` already removed: insert BEFORE the pos-th line
 * (1-based), or append when the list is shorter than pos.
 */
function insertAt(list: readonly string[], pos: number, id: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i + 1 === pos) out.push(id);
    out.push(list[i]!);
  }
  if (list.length < pos) out.push(id);
  return out;
}

/** `del(.rank)` -- the KEY goes, and the other keys keep their order. */
function delRank(row: { [k: string]: JsonValue }): { [k: string]: JsonValue } {
  const { rank: _drop, ...rest } = row;
  void _drop;
  return rest;
}

/** `.rank = (($order | index(.id)) + 1)` when the row is in `$order`. */
function reRank(row: { [k: string]: JsonValue }, order: readonly string[]): JsonValue {
  const id = row['id'];
  if (typeof id !== 'string') return row;
  const i = order.indexOf(id);
  return i < 0 ? row : { ...row, rank: i + 1 };
}

/**
 * The FEATURE filter, arm for arm:
 *
 *   if .kind != "feature" then .
 *   elif .id == $t and $clear == 1 then del(.rank)
 *   else re-rank from $order end
 *
 * The `kind` arm comes FIRST, so a non-feature entry is untouched even when it
 * shares the id -- which is why this is not the same function as the task one.
 */
function densifyFeatures(doc: JsonValue, order: readonly string[], clearRef: string | null): JsonValue {
  return mapEntries(doc, (row) => {
    if (row['kind'] !== 'feature') return row;
    if (clearRef !== null && row['id'] === clearRef) return delRank(row);
    return reRank(row, order);
  });
}

/**
 * The TASK filter, arm for arm:
 *
 *   if .id == $t then del(.rank)
 *   elif .status != "accepted" then re-rank from $order
 *   else . end
 *
 * Here the id arm comes first and applies WHATEVER the status is -- the
 * opposite nesting from the feature filter above, and the reason both exist.
 * The `set` path has no id arm at all (`$t` is never passed), so `clearId` is
 * null there.
 */
function densifyTasks(doc: JsonValue, order: readonly string[], clearId: string | null): JsonValue {
  return mapEntries(doc, (row) => {
    if (clearId !== null && row['id'] === clearId) return delRank(row);
    if (row['status'] === 'accepted') return row;
    return reRank(row, order);
  });
}

function rankImpl(
  cli: Cli,
  ctx: NounContext,
  ictx: DispatchContext,
  ref: string,
  newposRaw: string,
  clear: boolean,
): never {
  let newpos = 0;
  if (clear) {
    // Reachable despite the caller's arity check: `rank clear ""` is one
    // argument, so it passes `args.length !== 1` and arrives here empty.
    if (ref === '') {
      cli.die('usage: scrumux rank set <#|T-0001> --clear — current numbering: .claude/scripts/scrumux backlog tasks');
    }
  } else {
    if (ref === '' || newposRaw === '') {
      cli.die(
        'usage: scrumux rank set <#|T-0001> <new-#|--clear> — current numbering: .claude/scripts/scrumux backlog tasks',
      );
    }
    if (!/^[0-9]+$/.test(newposRaw)) {
      cli.die('scrumux rank: new-# must be a positive integer, or --clear to remove the rank');
    }
    newpos = Number(newposRaw);
    if (newpos < 1) cli.die('scrumux rank: new-# must be >= 1');
  }

  // ---- features, handled first because ids are disjoint by prefix --------
  if (ref.startsWith('F-')) {
    const design = join(ctx.gov, 'design.json');
    if (!existsSync(design)) cli.die('scrumux rank: no design.json yet — nothing to rank');
    const isFeature = (r: JsonValue): JsonValue | undefined => {
      const o = obj(r);
      return o !== null && o['kind'] === 'feature' ? o['id'] : undefined;
    };
    if (!refExists(design, ref, isFeature)) {
      cli.die(
        `scrumux rank: feature ${ref} not found in design.json — list them: .claude/scripts/scrumux backlog tasks --features`,
      );
    }
    const ranked = rows(design).filter((r) => {
      const o = obj(r);
      return o !== null && o['kind'] === 'feature' && o['rank'] !== undefined && o['rank'] !== null;
    });
    const forder = idList(sortBy(ranked, (r) => obj(r)?.['rank'] ?? null));
    const fcount = forder.length;

    let fnew: string[];
    if (clear) {
      if (!forder.includes(ref)) {
        cli.die(
          `scrumux rank: ${ref} has no rank to clear — it is already unprioritised: .claude/scripts/scrumux backlog tasks --features`,
        );
      }
      fnew = forder.filter((x) => x !== ref);
    } else {
      let fmax = forder.includes(ref) ? fcount : fcount + 1;
      if (fmax < 1) fmax = 1;
      if (newpos > fmax) newpos = fmax;
      fnew = insertAt(forder.filter((x) => x !== ref), newpos, ref);
    }

    guardedWrite(cli, ctx, ictx.io, design, (doc) => densifyFeatures(doc, fnew, clear ? ref : null));
    sealBootstrap(ctx.gov, ctx.today);
    return cli.emit(clear ? `${ref} -> rank cleared` : `${ref} -> rank ${newpos}`);
  }

  // ---- tasks -------------------------------------------------------------
  const tasks = join(ctx.gov, 'tasks.json');
  if (!existsSync(tasks)) cli.die('scrumux rank: no tasks.json yet — nothing to rank');
  const all = rows(tasks);
  const open = all.filter((r) => {
    const o = obj(r);
    return o !== null && o['status'] !== 'accepted';
  });
  const ranked = open.filter((r) => {
    const o = obj(r)!;
    return o['rank'] !== undefined && o['rank'] !== null;
  });
  const order = idList(sortBy(ranked, (r) => obj(r)?.['rank'] ?? null));
  const count = order.length;
  const openIds = idList(open);
  if (openIds.length === 0) cli.die('scrumux rank: no open tasks to rank');

  let tid: string;
  if (ref.startsWith('T-')) {
    tid = ref;
    // Any open task may be ranked; an unranked one is promoted into the ranked
    // list at the requested position and nothing else moves.
    if (!openIds.includes(tid)) {
      cli.die(`scrumux rank: ${tid} is not an open task — see the list: .claude/scripts/scrumux backlog tasks`);
    }
  } else if (!/^[0-9]+$/.test(ref)) {
    cli.die('scrumux rank: first arg must be a list # or a task id (T-0001)');
  } else {
    const n = Number(ref);
    if (!(n >= 1 && n <= count)) {
      cli.die(
        `scrumux rank: # ${ref} is out of range 1..${count} — see the list: .claude/scripts/scrumux backlog tasks`,
      );
    }
    // `sed -n "${REF}p"` -- the REF-th line of the ranked order.
    tid = order[n - 1]!;
  }

  if (clear) {
    if (!order.includes(tid)) {
      cli.die(
        `scrumux rank: ${tid} has no rank to clear — it is already unprioritised: .claude/scripts/scrumux backlog tasks`,
      );
    }
    const neworder = order.filter((x) => x !== tid);
    guardedWrite(cli, ctx, ictx.io, tasks, (doc) => densifyTasks(doc, neworder, tid));
    sealBootstrap(ctx.gov, ctx.today);
    return cli.emit(`${tid} -> rank cleared`);
  }

  // An unranked task joins the ranked list, so the ceiling grows by one.
  let maxpos = order.includes(tid) ? count : count + 1;
  if (maxpos < 1) maxpos = 1;
  if (newpos > maxpos) newpos = maxpos;
  const neworder = insertAt(order.filter((x) => x !== tid), newpos, tid);
  guardedWrite(cli, ctx, ictx.io, tasks, (doc) => densifyTasks(doc, neworder, null));
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${tid} -> rank ${newpos}`);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => NOUN_USAGE['rank'] ?? '',
  run(cli, ictx, verb, args): never {
    const ctx = nounContext(ictx);
    switch (verb) {
      case 'set':
        if (args.length !== 2) {
          return cli.dieUsage(
            'rank set takes <#|T-0001|F-0001> <new-#> — current numbering: scrumux backlog tasks',
          );
        }
        return rankImpl(cli, ctx, ictx, args[0]!, args[1]!, false);
      case 'clear':
        if (args.length !== 1) return cli.dieUsage('rank clear takes one <#|T-0001|F-0001>');
        return rankImpl(cli, ctx, ictx, args[0]!, '', true);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun rank — verbs: set, clear. See: scrumux help rank`,
        );
    }
  },
};
