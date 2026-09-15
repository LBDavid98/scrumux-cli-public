/**
 * The `decide` noun.
 *
 * FOUR VERBS SINCE D-S039: `new` records, and `ratify` / `reject` /
 * `acknowledge` (decide-acts.ts) are a person's acts on what was recorded.
 *
 * THE REFUSALS ARE THE PRODUCT. Four of the five required-field
 * messages carry a full GOOD/BAD worked example lifted from this repo's own
 * ratified decisions (D-0084's title, decision and rationale). Article 5 at
 * maximum density: the refusal is the only teaching surface an agent gets
 * before it writes governance prose, so the message IS the spec for what a
 * good field looks like, and shortening one to "field X is required" deletes
 * a training signal rather than trimming a string (docs/port/modules/
 * design-nouns.md). They are reproduced verbatim, cited record ids included.
 *
 * TWO JOURNAL WRITES, NOT ONE, AND THEY ARE NOT ATOMIC TOGETHER.
 * `--supersedes D-OLD` appends the new decision under one lock, then stamps
 * `superseded_by` onto the old entry under a SECOND `write_json`. A crash
 * between them leaves a new ratified decision whose predecessor does not yet
 * know it is dead. That gap is OQ-DN4 (design-nouns.md), open and unruled;
 * this keeps the two-write shape rather than closing it, because wrapping
 * both in one transaction would change which write wins on partial failure
 * and nothing has ruled on that.
 *
 * WHY THE BACK-STAMP EXISTS AT ALL. `supersedes` only ever pointed FORWARD, so
 * a reader who landed on the old decision -- which is what happens when
 * something cites it, or when an agent greps the journal for a rule -- saw
 * current law with no signal. Six decisions were in that state when the stamp
 * was added, D-0059 among them, still readable as binding seven days after it
 * was contradicted. It mutates a ratified decision on purpose and narrowly: it
 * records the record's STANDING, never what was decided.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import type { JsonValue } from '../journal/jqformat.js';
import { refExists, requireTaskRef } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { appendWithId, ensureFile, writeJson, type WriteOptions } from '../journal/write.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { entriesOf, field } from './lib/jqlike.js';
import { appendEntry, mapEntries, warnReseal } from './lib/writers.js';
import { authorityGuard } from '../journal/guards.js';
import { AUTHORITY_NONE, authorityProblem } from '../journal/standing.js';
import { decideAct } from './decide-acts.js';

export const VERBS = ['new', 'ratify', 'reject', 'acknowledge'] as const;

const VERBS_TSV = `new\trecord a decision — ratified with --authority, otherwise proposed (D-S039)
ratify\ta person ratifies a proposed or authority-less decision
reject\ta person rejects one, with a reason
acknowledge\ta person keeps an authority-less record as it is, and says so
`;
const USAGE = NOUN_USAGE['decide'] ?? '';

/** `{"entries": []}` -- the literal 16 bytes `ensure_file` seeds (P-49). */
const SEED = '{"entries": []}';

export interface DecideFlags {
  title: string;
  decision: string;
  rationale: string;
  by: string;
  authority: string;
  scope: string;
  supersedes: string;
  task: string;
  issue: string;
  pushHold: string;
}

/**
 * The flag loop: nothing is validated until the whole line is parsed, so an
 * unknown flag is refused even when a required one is also missing.
 *
 * A FLAG WITH NO VALUE REFUSES IN THIS CLI'S OWN VOCABULARY, DELIBERATELY
 * (R-002's 2026-09-02 amendment; cmd-task.md open question 1, open and
 * unruled across every noun that uses this idiom). A raw shell
 * parameter-expansion diagnostic for a truncated flag varies by shell in
 * both text and exit code, and carries a source path and line number that
 * mean nothing here -- there is no single behavior worth reproducing, so
 * this refuses at exit 2 with the noun's own wording instead.
 */
export function parseDecideFlags(args: readonly string[], die: (m: string) => never): DecideFlags {
  const f: DecideFlags = {
    title: '', decision: '', rationale: '', by: '', authority: '',
    scope: '', supersedes: '', task: '', issue: '', pushHold: '',
  };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`decide: ${flag} needs a value — see: scrumux help decide`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--title': f.title = value(a); break;
      case '--decision': f.decision = value(a); break;
      case '--rationale': f.rationale = value(a); break;
      case '--by': f.by = value(a); break;
      case '--authority': f.authority = value(a); break;
      case '--scope': f.scope = value(a); break;
      case '--supersedes': f.supersedes = value(a); break;
      case '--task': f.task = value(a); break;
      case '--issue': f.issue = value(a); break;
      case '--push-hold': f.pushHold = value(a); break;
      default: die(`decide: unknown flag ${a} — see: scrumux help decide`);
    }
  }
  return f;
}

/**
 * The entry `append_with_id`'s filter builds, key order included.
 *
 * STANDING (D-S039). `authorityOk` says whether `--authority` resolved. When
 * it did, the decision is `status: ratified` with that authority and
 * `ratified_by` as before. When it did not — none given, or one that does not
 * resolve — the decision is `status: proposed`, `authority: none`, and it
 * carries NO `ratified_by`: nobody ratified it. A non-empty value that did not
 * resolve is kept as `authority_claimed`, for the person who reviews it.
 * `recorded_by` names who ran the command, in both cases.
 *
 * Dependencies: none (pure).
 */
export function decideEntry(f: DecideFlags, id: string, today: string, authorityOk = false): JsonValue {
  // `{…} + (scope) + {refs:…} + {supersedes:…}` -- jq's `+` appends a key that
  // is not already present, so this order IS the order on disk.
  const refs: { [k: string]: JsonValue } = {};
  if (f.task !== '') refs['task'] = f.task;
  if (f.issue !== '') refs['issue'] = f.issue;
  if (f.pushHold !== '') refs['push_hold'] = f.pushHold;

  const entry: { [k: string]: JsonValue } = {
    id,
    date: today,
    title: f.title,
    decision: f.decision,
    rationale: f.rationale,
  };
  if (authorityOk) {
    entry['ratified_by'] = f.by;
    entry['status'] = 'ratified';
    entry['authority'] = f.authority;
  } else {
    entry['status'] = 'proposed';
    entry['authority'] = AUTHORITY_NONE;
    if (f.authority !== '') entry['authority_claimed'] = f.authority;
  }
  entry['recorded_by'] = f.by;
  // `(if $sc=="" then {} else {scope:$sc} end)` -- an omitted scope leaves NO
  // key, rather than a null one. Every optional field in this module works
  // that way; `supersedes` is the single exception, and it is explicit below.
  if (f.scope !== '') entry['scope'] = f.scope;
  entry['refs'] = refs;
  entry['supersedes'] = f.supersedes === '' ? null : f.supersedes;
  return entry;
}

function decideNew(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const f = parseDecideFlags(args, (m) => cli.die(m));

  if (f.title === '') {
    cli.die('decide: --title is required — the ruling itself in one line, so a reader who greps the journal gets the answer without opening it. GOOD "Parallel dispatch admission: a per-sprint cap declared at planning" (D-0084). GOOD "Rulings whose machinery was deleted are retired" (D-0081). GOOD "Four gates became advice, and the rulings still say fail" (D-0082). BAD "sprint changes" — names the area and withholds the ruling, which is the whole content.');
  }
  if (f.decision === '') {
    cli.die('decide: --decision is required (what was decided) — the rule as it will be applied: the shape, the defaults, and what each surface does about it. Write it so an implementer can act without asking a follow-up. GOOD "A sprint carries parallel (integer >= 1, default 1), declared at scrumux sprint new --parallel N. The CLI admits a task to in_progress while the same RATIFIED sprint has fewer than parallel tasks in_progress, and still refuses a task whose in-flight neighbour belongs to a DIFFERENT sprint. The cap may be changed only while the sprint is proposed; changing it after ratification is a re-ratification, not an edit. --hotfix implies parallel 1" (D-0084). BAD "we will allow parallel work" — a direction, not a rule; every surface would have to invent its own version of it.');
  }
  if (f.rationale === '') {
    cli.die('decide: --rationale is required (why) — what was weighed, including the options that were REJECTED and what was wrong with each. That is the part a later session needs when it is tempted to undo this. GOOD "Three shapes were put to User. A: a per-sprint cap declared at planning. B: per-worktree admission. C: the app is the gate. User ruled A. The sprint is already the unit he ratifies, so the cap is declared where the plan is made; B ties a governance rule to a git detail no journal models; C moves a guard out of the CLI into the app and would leave a hand-driven session ungated entirely" (D-0084). BAD "it is better this way" — it gives the next reader nothing to weigh against.');
  }
  if (f.by === '') {
    cli.die('decide: --by is required — name who is recording this (yourself, if you are an agent). With --authority direct|app:<session>|standing:D-XXXX the decision is recorded ratified; without one it is recorded PROPOSED until a person ratifies it (D-S039). Decisions are ratified, never assumed.');
  }
  if (!(f.scope === '' || f.scope === 'repo' || f.scope === 'cross-repo')) {
    cli.die('decide: --scope must be repo or cross-repo');
  }

  // THE REF CHECKS RUN BEFORE `ensure_file`, so `--supersedes` against a repo
  // with no decisions.json refuses rather than seeding one and then refusing.
  const decisions = join(ctx.gov, 'decisions.json');
  if (f.supersedes !== '' && !refExists(decisions, f.supersedes)) {
    cli.die(`decide: --supersedes ${f.supersedes} not found in decisions.json`);
  }
  if (f.task !== '') refusing(cli, () => requireTaskRef(ctx.gov, f.task));
  if (f.issue !== '' && !refExists(join(ctx.gov, 'issues.json'), f.issue)) {
    cli.die(`decide: --issue ${f.issue} not found in issues.json`);
  }

  // NEVER A REFUSAL (D-S039): the same question the reserved acts ask, with
  // the answer recorded instead of enforced.
  const problem = authorityProblem(() => authorityGuard(ctx.gov, f.authority, 'decide'));
  const ratified = problem === null;

  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  const id = refusing(cli, () => {
    ensureFile(decisions, SEED);
    const res = appendWithId(
      decisions,
      (doc) => entriesOf(doc).map((r) => field(r, 'id')),
      'D',
      (doc, newId) => appendEntry(doc, decideEntry(f, newId, ctx.today, ratified)),
      opts,
    );
    warnReseal(cli, res.resealWarning);
    // A PROPOSED decision retires nothing: the back-stamp waits for `decide
    // ratify`, and every reader ignores a non-binding `supersedes`.
    if (f.supersedes !== '' && ratified) {
      // The SECOND write, under its own lock. `.superseded_by=$new` adds the
      // key at the end of the row when it is absent and replaces it in place
      // when it is not -- the same assignment semantics jq has.
      const stamp = writeJson(
        decisions,
        (doc) => mapEntries(doc, (row) => {
          if (field(row, 'id') !== f.supersedes) return row;
          return { ...(row as { [k: string]: JsonValue }), superseded_by: res.id };
        }),
        opts,
      );
      warnReseal(cli, stamp.resealWarning);
    }
    return res.id;
  });

  sealBootstrap(ctx.gov, ctx.today);
  cli.data({ status: ratified ? 'ratified' : 'proposed', authority: ratified ? f.authority : AUTHORITY_NONE });
  if (!ratified) {
    // Stderr, so `ID=$(scrumux decide new ...)` still captures only the id.
    cli.sayAlways(
      `TELL: ${id} is recorded PROPOSED (authority: none${f.authority === '' ? '' : `; '${f.authority}' did not resolve — ${problem ?? ''}`}). `
      + `It binds nothing until a person ratifies it — in scrumux-app, or: scrumux decide ratify ${id} --by WHO --authority direct|app:<session>. `
      + 'An operator message in a session is not a ratification; say what you recorded and let the person act.',
    );
  }
  return emitted(cli, id);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'new':
        return decideNew(cli, nounContext(ctx), ctx.io, args);
      case 'ratify':
      case 'reject':
      case 'acknowledge':
        return decideAct(cli, nounContext(ctx), ctx.io, verb, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun decide — verbs: new, ratify, reject, acknowledge. See: scrumux help decide`,
        );
    }
  },
};
