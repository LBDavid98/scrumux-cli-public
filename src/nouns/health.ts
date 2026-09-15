/**
 * The `health` noun.
 *
 * REGISTRATION ONLY. This whole noun is one verb that appends a row to
 * `governance/repo-health.json`. The thing that RUNS those commands is
 * `run_health_checks`, called from `task verify` in a different module -- so
 * nothing here executes the string it stores, and a check registered here is
 * inert until something else decides to run it.
 *
 * THE DEFAULTS ARE APPLIED AT THE OTHER END, NOT HERE. An omitted `--type` or
 * `--timeout` writes NO key, and the runner supplies `test` / 120 seconds when
 * it reads the row back. So `repo-health.json` records what the
 * operator said and not what the system will do, and the two split sites are
 * visible in the file. Deliberate: writing the resolved default here
 * would change every existing row's meaning from "unspecified" to "explicitly
 * test/120", which is a different fact (read-verbs-small.md L4).
 *
 * `--timeout 0` IS ACCEPTED. The guard excludes only non-digit
 * characters, so `0` and an absurdly large value both pass (L5). Not
 * tightened -- inventing a refusal here would refuse input this CLI has
 * always accepted.
 *
 * NO ID IS ALLOCATED: rows are keyed by `name`. That is `writeJson` rather
 * than `appendWithId`, and it is why this verb ends in `emit` with a
 * sentence rather than in `emitted` with an id. Registering the same name
 * twice used to append a SECOND row, which made a typo in `--command`
 * unreachable from the CLI; it now REPLACES -- see `registerEntry` below.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { RawNumber, type JsonValue } from '../journal/jqformat.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { ensureFile, writeJson, type WriteOptions } from '../journal/write.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { appendEntry, warnReseal } from './lib/writers.js';

export const VERBS = ['add'] as const;

const VERBS_TSV = 'add\tthe only verb\n';
const USAGE = NOUN_USAGE['health'] ?? '';

/** `{"entries": []}` -- the literal 16 bytes `ensure_file` seeds (P-49). */
const SEED = '{"entries": []}';

export interface HealthFlags {
  name: string;
  command: string;
  type: string;
  timeout: string;
}

export function parseHealthFlags(args: readonly string[], die: (m: string) => never): HealthFlags {
  const f: HealthFlags = { name: '', command: '', type: '', timeout: '' };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`health: ${flag} needs a value — see: scrumux help`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--name': f.name = value(a); break;
      case '--command': f.command = value(a); break;
      case '--type': f.type = value(a); break;
      case '--timeout': f.timeout = value(a); break;
      // NOTE the message: "see: scrumux help", not "scrumux help health".
      // Every other noun in this group names itself; this one does not, and
      // the wording is contract (Article 5) rather than a typo to correct.
      default: die(`health: unknown flag ${a} — see: scrumux help`);
    }
  }
  return f;
}

/** The row `write_json`'s filter appends, key order included. */
export function healthEntry(f: HealthFlags): JsonValue {
  const entry: { [k: string]: JsonValue } = { name: f.name, command: f.command };
  if (f.type !== '') entry['type'] = f.type;
  // `($to|tonumber)`: jq 1.7 keeps the decNumber literal through `tonumber`,
  // so "0120" is written 120 and "007" is written 7 -- leading zeros are
  // canonicalised away and nothing else is. RawNumber + canonNumber is that,
  // exactly, and it also keeps a value too large for a double intact, which a
  // parse-to-number-and-print would not.
  if (f.timeout !== '') entry['timeout_seconds'] = new RawNumber(f.timeout);
  return entry;
}

/** `jq -r`'s rendering of one field: a string bare, absent as '', anything else as its JSON text. */
function jqField(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** An object row, or null -- `($x | type) == "object"` in the jq filter. */
function objRow(v: JsonValue): { [k: string]: JsonValue } | null {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as { [k: string]: JsonValue } : null;
}

/**
 * `add` on a name ALREADY REGISTERED replaces it in place; a new name appends.
 *
 * WHY THIS IS NOT AN APPEND. `add` was the only verb on this noun and it
 * appended unconditionally, so a typo in `--command` was UNREACHABLE:
 * correcting it left the wrong row in place under the same name, permanently
 * red, and every `task verify` and `session check` on the repo failed
 * thereafter over a command no verb in the CLI could reach. Measured end to
 * end (E2E 2026-09-02, I-0004) on a repo whose own code was green throughout.
 *
 * REPLACE RATHER THAN A `remove` VERB, deliberately: `remove` is a second
 * verb, a second refusal surface and a way to lose a check silently, where
 * replace-on-add is the operator's actual move -- they are re-registering the
 * check they meant -- announced old -> new, with the log keeping the previous
 * value either way (Article 8).
 *
 * THE ENTRY COUNT NEVER MOVES, and that is not fussiness. `writeJson` refuses
 * any filter leaving fewer entries than it found -- the same guard that catches
 * a destructive `repair` jq -- so a version of this that COLLAPSED pre-existing
 * duplicates was refused outright, on both implementations, in the exact words
 * `repair` uses. That guard is right and stays: a write verb quietly setting
 * ALLOW_ENTRY_REMOVAL would make "nothing in the CLI removes an entry by
 * design" false. So the FIRST row under the name is replaced in place, any
 * further rows are left exactly as they are, and the caller names them and the
 * sanctioned way to drop them.
 *
 * The no-match arm delegates to `appendEntry` so a non-object document and a
 * non-array `entries` fail in the same words they always did.
 */
function registerEntry(doc: JsonValue, f: HealthFlags): { doc: JsonValue; displaced: string[] } {
  const entry = healthEntry(f);
  const o = objRow(doc);
  const rows = o === null ? null : o['entries'];
  if (o === null || !Array.isArray(rows)) return { doc: appendEntry(doc, entry), displaced: [] };

  const displaced: string[] = [];
  const out: JsonValue[] = [];
  for (const row of rows) {
    const r = objRow(row);
    if (r === null || r['name'] !== f.name) { out.push(row); continue; }
    displaced.push(jqField(r['command']));
    // The FIRST match takes the new row in its own slot; every later one is
    // kept verbatim. Order is contract -- `run_health_checks` reports in file
    // order -- and so is the count (see the header).
    out.push(displaced.length === 1 ? entry : row);
  }
  if (displaced.length === 0) return { doc: appendEntry(doc, entry), displaced };
  return { doc: { ...o, entries: out }, displaced };
}

function healthAdd(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const f = parseHealthFlags(args, (m) => cli.die(m));

  if (f.name === '') cli.die('health: --name is required');
  if (f.command === '') cli.die('health: --command is required (POSIX shell command; exit 0 = healthy)');
  if (!(f.type === '' || f.type === 'build' || f.type === 'test' || f.type === 'run'
    || f.type === 'lint' || f.type === 'other')) {
    cli.die('health: --type must be build|test|run|lint|other');
  }
  // `case "$TIMEOUT" in ''|*[!0-9]*) [ -z "$TIMEOUT" ] || die …;; esac`
  // -- empty passes through the first arm, a run of digits matches no arm at
  // all, and anything else dies.
  if (f.timeout !== '' && /[^0-9]/.test(f.timeout)) {
    cli.die('health: --timeout must be an integer (seconds)');
  }

  const path = join(ctx.gov, 'repo-health.json');
  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  let displaced: string[] = [];
  refusing(cli, () => {
    ensureFile(path, SEED);
    const res = writeJson(path, (doc) => {
      const r = registerEntry(doc, f);
      displaced = r.displaced;
      return r.doc;
    }, opts);
    warnReseal(cli, res.resealWarning);
  });

  // T-0100: repo-health.json IS sealed, and the per-file reseal is
  // `write_json`'s (`reseal_one`) -- this blanket call is only the
  // never-sealed-repo bootstrap.
  sealBootstrap(ctx.gov, ctx.today);
  if (displaced.length === 0) return cli.emit(`health check '${f.name}' registered`);
  if (displaced.length > 1) {
    cli.say(`  (this name is on ${displaced.length} entries; the first was replaced and the rest are untouched — nothing on this noun deletes a row. Drop them all and re-add: ALLOW_ENTRY_REMOVAL=1 scrumux repair journal repo-health.json --apply '.entries |= map(select(.name != "${f.name}"))' --why '<why>' --by <you>)`);
  }
  return cli.emit(`health check '${f.name}' re-registered: ${displaced[0] ?? ''} -> ${f.command}`);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'add':
        return healthAdd(cli, nounContext(ctx), ctx.io, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun health — the only verb is 'add'. See: scrumux help health`,
        );
    }
  },
};
