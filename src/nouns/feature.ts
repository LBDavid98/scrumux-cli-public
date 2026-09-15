/**
 * The `feature` noun.
 *
 * ONE VERB, `new`. It appends a `kind:"feature"` row to the shared, polymorphic
 * `design.json` and prints the id.
 *
 * RANK IS NEVER MANUFACTURED (PHILOSOPHY P-44). `feature new` leaves `.rank`
 * unset exactly as `task new` does; `backlog features` renders an unranked
 * feature as unranked, and `rank` is the only thing that ever writes the
 * field. A port that helpfully seeded `rank: 9999` would put every new feature
 * into an order nobody chose.
 *
 * `--dep` IS CHECKED AGAINST design.json AND NOTHING ELSE. There is no cycle
 * check, no self-reference check and no de-duplication -- `--dep F-0001 --dep
 * F-0001` writes the id twice. That is the same accumulation shape every
 * repeated flag in this module group has (design-nouns.md, "Deliberate
 * looseness"), and it is reproduced rather than tightened.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import type { JsonValue } from '../journal/jqformat.js';
import { refExists } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { appendWithId, ensureFile, type WriteOptions } from '../journal/write.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { entriesOf, field } from './lib/jqlike.js';
import { appendEntry, shellWords, warnReseal } from './lib/writers.js';

export const VERBS = ['new'] as const;

const VERBS_TSV = 'new\tthe only verb\n';
const USAGE = NOUN_USAGE['feature'] ?? '';

/** `design_ensure` -- the literal 16 bytes, never jq's rendering (P-49). */
const DESIGN_SEED = '{"entries": []}';

export interface FeatureFlags {
  name: string;
  desc: string;
  deps: string[];
}

export function parseFeatureFlags(args: readonly string[], die: (m: string) => never): FeatureFlags {
  const f: FeatureFlags = { name: '', desc: '', deps: [] };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`feature: ${flag} needs a value — see: scrumux help feature`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--name': f.name = value(a); break;
      case '--desc': f.desc = value(a); break;
      case '--dep': f.deps.push(value(a)); break;
      default: die(`feature: unknown flag ${a} — see: scrumux help feature`);
    }
  }
  return f;
}

function featureNew(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const f = parseFeatureFlags(args, (m) => cli.die(m));

  if (f.name === '') {
    cli.die('feature: --name is required — two or three words naming the capability, not the work. GOOD "Governance graph" (F-0008). GOOD "Gate integrity" (F-0009). GOOD "Deployability" (F-0013). BAD "Phase 2 improvements" — a schedule, not a capability.');
  }
  if (f.desc === '') {
    cli.die('feature: --desc is required — what the capability makes possible and how you will be able to tell, in two or three sentences. GOOD "No gate reports a pass it did not earn. The four cross-script dependencies fail closed instead of open; the destructive-command attestation leaves a record; the issue source field is a constrained enum so drift data has a reliable who-raised-this dimension" (F-0009). GOOD "The harness installs into any repo and can prove it is actually live there. Root resolution decoupled from script location, harness deploy and harness verify as CLI commands with machine-readable output, and a read-only sandbox that works on Linux as well as darwin" (F-0013). BAD "makes deploys better" — no mechanism and nothing a story could be written against.');
  }

  const design = join(ctx.gov, 'design.json');
  refusing(cli, () => ensureFile(design, DESIGN_SEED));

  // `for dep in $(… jq -r '.[]')` -- unquoted, so field-split. See shellWords.
  for (const dep of shellWords(f.deps)) {
    if (!refExists(design, dep, (r) => (field(r, 'kind') === 'feature' ? field(r, 'id') : undefined))) {
      cli.die(`feature: --dep ${dep} not found`);
    }
  }

  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  const id = refusing(cli, () => {
    const res = appendWithId(
      design,
      // The allocator's stream is narrowed to THIS kind, because five kinds
      // share the file and `F-` ids must not be counted against `S-` ones.
      (doc) => entriesOf(doc).filter((r) => field(r, 'kind') === 'feature').map((r) => field(r, 'id')),
      'F',
      (doc, newId) => {
        const entry: { [k: string]: JsonValue } = {
          kind: 'feature', id: newId, name: f.name, description: f.desc,
        };
        if (f.deps.length > 0) entry['dependencies'] = [...f.deps];
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

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'new':
        return featureNew(cli, nounContext(ctx), ctx.io, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun feature — the only verb is 'new'. See: scrumux help feature`,
        );
    }
  },
};
