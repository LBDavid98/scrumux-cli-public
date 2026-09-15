/**
 * The `epic` noun.
 *
 * ONE FUNCTION, TWO VERBS, AND THE DISPATCH IS ON `$1`. `epic_run` calls
 * `epic_impl "$@"` for `new` and `epic_impl update "$@"` for `update`, and
 * `epic_impl` branches on whether its FIRST ARGUMENT is the literal word
 * `update`. So `scrumux epic new update E-0005 --add-feature F-0001` performs
 * an UPDATE. That is not a shape worth inventing, and it is not a shape worth
 * quietly closing either -- it is what this CLI does today. Kept, not closed.
 *
 * `design.json` IS POLYMORPHIC: epics, features, stories, surfaces and
 * controls share one file keyed by `.kind`, which is why every id check and
 * the allocator's own stream both select on kind as well as id
 * (src/journal/refs.ts, src/journal/ids.ts).
 *
 * FIVE SEPARATE READS OF ONE FILE BECOME ONE. `epic update` makes five
 * `jq`/`ref_exists` subprocess calls against the same `design.json` for one
 * invocation; this reads it once per check and holds nothing else. Explicitly
 * sanctioned behaviour-preserving work -- the ANSWERS are identical, including
 * the "current: …" list a remove-refusal prints.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { refExists } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { appendWithId, ensureFile, writeJson, type WriteOptions } from '../journal/write.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { asArray, asString, entriesOf, field } from './lib/jqlike.js';
import { appendEntry, mapEntries, shellWords, warnReseal } from './lib/writers.js';

export const VERBS = ['new', 'update'] as const;

const VERBS_TSV = 'new\tcreate an epic, optionally with features\nupdate\tadd or remove features\n';
const USAGE = NOUN_USAGE['epic'] ?? '';

/** `design_ensure` (journal.sh:193) -- the literal 16 bytes, never jq's (P-49). */
const DESIGN_SEED = '{"entries": []}';

/** `.entries[] | select(.kind==K) | .id`, as a set of the ids present. */
function idsOfKind(doc: JsonValue, kind: string): JsonValue[] {
  return entriesOf(doc).filter((r) => field(r, 'kind') === kind).map((r) => field(r, 'id'));
}

/**
 * `design.json`, parsed, or null.
 *
 * The same disposition every `ref_exists`/`jq -e` in this file has: a file
 * that is ABSENT or does not PARSE answers "no such id" rather than reporting
 * a corrupt journal, because a reference check is not that surface.
 */
function designDoc(gov: string): JsonValue | null {
  const path = join(gov, 'design.json');
  if (!existsSync(path)) return null;
  try {
    return parsePreservingNumbers(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The epic row itself, or null. */
function epicRow(doc: JsonValue | null, id: string): JsonValue | null {
  if (doc === null) return null;
  for (const r of entriesOf(doc)) {
    if (field(r, 'kind') === 'epic' && field(r, 'id') === id) return r;
  }
  return null;
}

/** `(.features // [])` as a list of jq-rendered strings, for membership. */
function featuresOf(row: JsonValue | null): JsonValue[] {
  if (row === null) return [];
  const f = field(row, 'features');
  return asArray(f) ?? [];
}

// ------------------------------------------------------------------ new ---

export interface EpicNewFlags {
  name: string;
  desc: string;
  features: string[];
}

export function parseEpicNewFlags(args: readonly string[], die: (m: string) => never): EpicNewFlags {
  const f: EpicNewFlags = { name: '', desc: '', features: [] };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`epic: ${flag} needs a value — see: scrumux help epic`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--name': f.name = value(a); break;
      case '--desc': f.desc = value(a); break;
      // REPEATED FLAGS ACCUMULATE WITH NO DE-DUPLICATION, at every call site
      // in this module group. `--feature F-0001 --feature F-0001` writes
      // `["F-0001","F-0001"]`; nothing dedupes it going in or reading it back
      // (design-nouns.md, "Deliberate looseness"). Reproduced.
      case '--feature': f.features.push(value(a)); break;
      default: die(`epic: unknown flag ${a} — see: scrumux help epic`);
    }
  }
  return f;
}

function epicNew(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const f = parseEpicNewFlags(args, (m) => cli.die(m));

  if (f.name === '') {
    cli.die('epic: --name is required — the state of the world the epic reaches, said as a claim rather than a heading. GOOD "Self-knowledge: the harness sees its own code and its own governance" (E-0005). GOOD "CLI MVP" (E-0006). BAD "Improvements" — it names no destination, so nothing can be said to be inside or outside it.');
  }
  if (f.desc === '') {
    cli.die('epic: --desc is required — what changes when the epic lands, and where the scope came from. GOOD "The harness stops reasoning about itself by reading and starts reasoning about itself by query. A code graph and a governance graph on one shared library, so context packs are derived rather than hand-assembled and impact questions are answered mechanically. Fulfils D-0009, ratified but never built, and closes I-0018" (E-0005). GOOD "The harness stands alone: it installs into any repo, proves it is live there, refuses only what is dangerous, runs its gates in seconds, and records enough about its own behaviour that the next round of priorities comes from data. Everything in this epic comes from the deep-dive review of 2026-08-20 and D-0058..D-0061" (E-0006). BAD "various fixes" — a later reader cannot tell what belongs in it.');
  }

  const design = join(ctx.gov, 'design.json');
  refusing(cli, () => ensureFile(design, DESIGN_SEED));

  // `for f in $(printf '%s' "$FEATS" | jq -r '.[]')` -- UNQUOTED, so the ids
  // are field-split on IFS before they are checked. See `shellWords`.
  for (const dep of shellWords(f.features)) {
    if (!refExists(design, dep, (r) => (field(r, 'kind') === 'feature' ? field(r, 'id') : undefined))) {
      cli.die(`epic: feature ${dep} not found — add it first: scrumux feature new --name ... --desc ...`);
    }
  }

  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  const id = refusing(cli, () => {
    const res = appendWithId(
      design,
      (doc) => idsOfKind(doc, 'epic'),
      'E',
      (doc, newId) => {
        const entry: { [k: string]: JsonValue } = {
          kind: 'epic', id: newId, name: f.name, description: f.desc,
        };
        if (f.features.length > 0) entry['features'] = [...f.features];
        return appendEntry(doc, entry);
      },
      opts,
    );
    warnReseal(cli, res.resealWarning);
    return res.id;
  });

  sealBootstrap(ctx.gov, ctx.today);
  return emitted(cli, id);
}

// --------------------------------------------------------------- update ---

export interface EpicUpdateFlags {
  adds: string[];
  dels: string[];
}

export function parseEpicUpdateFlags(args: readonly string[], die: (m: string) => never): EpicUpdateFlags {
  const f: EpicUpdateFlags = { adds: [], dels: [] };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`epic update: ${flag} needs a value — see: scrumux help epic`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--add-feature': f.adds.push(value(a)); break;
      case '--remove-feature': f.dels.push(value(a)); break;
      default: die(`epic update: unknown flag ${a} — see: scrumux help epic`);
    }
  }
  return f;
}

/**
 * `(((.features // []) + $adds) - $dels)`.
 *
 * jq's array `-` removes EVERY occurrence of each element on the right, which
 * is why a duplicate that got in through the no-dedup accumulation above comes
 * out in one removal. `//` on `.features` is jq's, so `false` would also fall
 * back -- not reachable here, but the shape is reproduced rather than
 * "corrected" into a null check.
 */
export function nextFeatures(current: readonly JsonValue[], adds: readonly string[], dels: readonly string[]): JsonValue[] {
  const drop = new Set(dels);
  return [...current, ...adds].filter((v) => !(typeof v === 'string' && drop.has(v)));
}

function epicUpdate(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  // `EID=${1:-}; shift 2>/dev/null || true` -- the id is positional and the
  // shift is allowed to fail on an empty line.
  const eid = args.length > 0 ? args[0]! : '';
  const rest = args.slice(1);
  if (eid === '') {
    cli.die('usage: scrumux epic update E-0001 [--add-feature F-0001]... [--remove-feature F-0001]...');
  }

  const design = join(ctx.gov, 'design.json');
  if (!refExists(design, eid, (r) => (field(r, 'kind') === 'epic' ? field(r, 'id') : undefined))) {
    cli.die(`epic update: ${eid} not found in design.json — list ids: jq -r '.entries[] | select(.kind=="epic") | .id' governance/design.json`);
  }

  const f = parseEpicUpdateFlags(rest, (m) => cli.die(m));

  // `[ "$(… jq -s 'map(length) | add')" -gt 0 ]` -- the two accumulators are
  // slurped and summed, so ONE of either flag is enough.
  if (f.adds.length + f.dels.length === 0) {
    cli.die('epic update: nothing to update — pass --add-feature and/or --remove-feature');
  }

  const doc = designDoc(ctx.gov);
  const row = epicRow(doc, eid);
  const current = featuresOf(row);

  for (const add of shellWords(f.adds)) {
    if (!refExists(design, add, (r) => (field(r, 'kind') === 'feature' ? field(r, 'id') : undefined))) {
      cli.die(`epic update: feature ${add} not found — add it first: scrumux feature new --name ... --desc ...`);
    }
    // `(.features // []) | index($f) == null` -- an epic's features are a set.
    if (current.some((v) => v === add)) {
      cli.die(`epic update: ${add} is already on ${eid} — an epic's features are a set`);
    }
  }
  for (const del of shellWords(f.dels)) {
    if (!current.some((v) => v === del)) {
      // The "current:" tail renders `(.features // []) | join(", ")` -- so
      // an epic with no features at all reports an empty list rather than
      // "(none)".
      const shown = current.map((v) => asString(v) ?? '').join(', ');
      cli.die(`epic update: ${del} is not on ${eid} — nothing to remove; current: ${shown}`);
    }
  }

  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  refusing(cli, () => {
    const res = writeJson(
      design,
      (d) => mapEntries(d, (r) => {
        if (field(r, 'kind') !== 'epic' || field(r, 'id') !== eid) return r;
        const o = r as { [k: string]: JsonValue };
        return { ...o, features: nextFeatures(asArray(field(r, 'features')) ?? [], f.adds, f.dels) };
      }),
      opts,
    );
    warnReseal(cli, res.resealWarning);
  });

  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${eid} updated`);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    const nc = nounContext(ctx);
    switch (verb) {
      case 'new':
        // The branch is on the first ARGUMENT, so `epic new update …`
        // reaches the update path. Kept, not closed.
        return args.length > 0 && args[0] === 'update'
          ? epicUpdate(cli, nc, ctx.io, args.slice(1))
          : epicNew(cli, nc, ctx.io, args);
      case 'update':
        return epicUpdate(cli, nc, ctx.io, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun epic — verbs: new, update. See: scrumux help epic`,
        );
    }
  },
};
