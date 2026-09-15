/**
 * The `story` noun.
 *
 * ONE VERB, `new`, AND ONE FILTER THAT WRITES TWICE INSIDE ONE LOCK. The
 * append and the parent feature's `stories` back-reference are two stages of
 * a SINGLE jq program (`.entries += [ … ] | .entries |= map( … )`), so they
 * land in one `append_with_id` call, under one lock, in one atomic rename.
 * That is the shape `decide --supersedes` and `log --task` do NOT have (they
 * take two separate locks), and the difference matters: there is no window
 * here in which a story exists and its feature does not know about it.
 *
 * THE BACK-REFERENCE CANNOT MATCH THE ROW JUST APPENDED. The map runs after
 * the append and selects `kind=="feature"`; the new row is `kind=="story"`.
 * Reproduced as written rather than restructured, because the ORDER of the two
 * stages is what makes that true.
 *
 * `--criterion` IS THE ONE REPEATED FLAG IN THIS GROUP WITH A MINIMUM. At
 * least one is required (`acceptance_criteria`, minItems 1) and the refusal
 * carries the worked examples; beyond the count, nothing is checked -- no
 * length, no sentence shape, no "and" split. The GOOD/BAD examples are the
 * entire quality mechanism and it is a social one (design-nouns.md).
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
import { asArray, entriesOf, field } from './lib/jqlike.js';
import { appendEntry, mapEntries, warnReseal } from './lib/writers.js';

export const VERBS = ['new'] as const;

const VERBS_TSV = 'new\tthe only verb\n';
const USAGE = NOUN_USAGE['story'] ?? '';

/** `design_ensure` -- the literal 16 bytes, never jq's rendering (P-49). */
const DESIGN_SEED = '{"entries": []}';

export interface StoryFlags {
  feature: string;
  narrative: string;
  criteria: string[];
}

export function parseStoryFlags(args: readonly string[], die: (m: string) => never): StoryFlags {
  const f: StoryFlags = { feature: '', narrative: '', criteria: [] };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`story: ${flag} needs a value — see: scrumux help story`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--feature': f.feature = value(a); break;
      case '--narrative': f.narrative = value(a); break;
      case '--criterion': f.criteria.push(value(a)); break;
      default: die(`story: unknown flag ${a} — see: scrumux help story`);
    }
  }
  return f;
}

function storyNew(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const f = parseStoryFlags(args, (m) => cli.die(m));

  if (f.feature === '') cli.die('story: --feature is required');
  if (f.narrative === '') {
    cli.die('story: --narrative is required — "As the <specific who>, I <do what> so that <outcome>". The who is a named person or system, never "a user". GOOD "As User, I accept a task directly — my documented approval is the review — and acceptance refuses any task whose verify receipt is red, so a false close cannot recur" (S-0069). GOOD "As User, I deploy the harness into another repo and every registered command actually runs there, and a cold agent in either lane arrives at working code without hunting" (S-0070). BAD "As a user, I want acceptance to work" — no named who, no outcome, and nothing an acceptance criterion could be written against.');
  }
  // `[ "$(… jq 'length')" -gt 0 ]` -- the COUNT, not the content.
  if (f.criteria.length === 0) {
    cli.die('story: at least one --criterion is required (acceptance_criteria, minItems 1) — each one an observable check a person could confirm or deny by looking at the running thing or its record: a shape returned, a refusal given, a record written, a command exiting a stated code. One behaviour per criterion; a criterion with "and" in it is usually two. GOOD "scrumux accept T-XXXX --authority refuses a red or missing receipt and is write-once" (S-0069). GOOD "harness verify executes every registered surface" (S-0070). GOOD "cold probes of the standalone and app lanes pass with task-verify under 15s and close under 10s" (S-0070). BAD "acceptance is reliable" — an adjective, not a check.');
  }

  const design = join(ctx.gov, 'design.json');
  // The seed runs BEFORE the feature ref check, unlike `decide`, so a story
  // against a missing feature on a fresh repo SEEDS design.json and then
  // refuses. That ordering is observable in the post-state.
  refusing(cli, () => ensureFile(design, DESIGN_SEED));

  if (!refExists(design, f.feature, (r) => (field(r, 'kind') === 'feature' ? field(r, 'id') : undefined))) {
    cli.die(`story: feature ${f.feature} not found — add it first: scrumux feature new --name ... --desc ...`);
  }

  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  const id = refusing(cli, () => {
    const res = appendWithId(
      design,
      (doc) => entriesOf(doc).filter((r) => field(r, 'kind') === 'story').map((r) => field(r, 'id')),
      'S',
      (doc, newId) => {
        const appended = appendEntry(doc, {
          kind: 'story',
          id: newId,
          feature: f.feature,
          narrative: f.narrative,
          acceptance_criteria: [...f.criteria],
        });
        // Stage two of the same filter: `.stories = ((.stories // []) + [$id])`
        // on the parent feature. Assignment, so an absent key lands at the END
        // of the row and a present one keeps its position.
        return mapEntries(appended, (r) => {
          if (field(r, 'kind') !== 'feature' || field(r, 'id') !== f.feature) return r;
          const o = r as { [k: string]: JsonValue };
          return { ...o, stories: [...(asArray(field(r, 'stories')) ?? []), newId] };
        });
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
        return storyNew(cli, nounContext(ctx), ctx.io, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun story — the only verb is 'new'. See: scrumux help story`,
        );
    }
  },
};
