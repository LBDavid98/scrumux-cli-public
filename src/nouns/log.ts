/**
 * The `log` noun.
 *
 * THE APPEND-ONLY WORK LOG, and the receipt a cold session reads. Both
 * required fields refuse with a worked example from this repo's own L-0285,
 * and the `--did` message is explicit that the field carries EVIDENCE -- the
 * verify command and its rc, the diffstat, every refusal hit and what was done
 * about it -- rather than a narrative. Reproduced verbatim.
 *
 * `--actor` DEFAULTS FROM THE ENVIRONMENT: `${GOV_ACTOR:-claude}`. It is read
 * from `ctx.env` rather than `process.env` so the default is reachable from a
 * test without mutating the process, and an EMPTY `GOV_ACTOR` falls back the
 * same way `:-` does (unset and empty are one case here, which is not true of
 * `GOV_ROOT` two files over -- see src/journal/paths.ts).
 *
 * TWO JOURNALS, TWO LOCKS, NOT ATOMIC TOGETHER. `--task T-0001` appends the
 * log entry to `log.json`, then pushes the new id into that task's
 * `log_entries` under a SECOND `write_json` against `tasks.json`. A crash
 * between them leaves a log entry the task does not reference. OQ-DN4
 * (design-nouns.md), open and unruled; the two-write shape is reproduced
 * rather than closed, because closing it would change which write wins on
 * partial failure and nothing has ruled on that.
 *
 * `tasks.json` IS NOT `ensure_file`d BEFORE THE SECOND WRITE, and it does not
 * need to be: `require_task_ref` has already proved the file exists and holds
 * the id, and it ran before anything was written.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import type { JsonValue } from '../journal/jqformat.js';
import { requireTaskRef } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { appendWithId, ensureFile, writeJson, type WriteOptions } from '../journal/write.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { asArray, entriesOf, field } from './lib/jqlike.js';
import { appendEntry, mapEntries, warnReseal } from './lib/writers.js';
import { logShow } from './log-show.js';

export const VERBS = ['new', 'show'] as const;

const VERBS_TSV = 'new\tappend one entry\nshow\tread entries by id, or every entry of a task (--task T-0001)\n';
const USAGE = NOUN_USAGE['log'] ?? '';

/** `{"entries": []}` -- the literal 16 bytes `ensure_file` seeds (P-49). */
const SEED = '{"entries": []}';

export interface LogFlags {
  title: string;
  did: string;
  task: string;
  verified: string;
  actor: string;
  pending: string[];
}

export function parseLogFlags(
  args: readonly string[],
  die: (m: string) => never,
  env: NodeJS.ProcessEnv,
): LogFlags {
  const govActor = env['GOV_ACTOR'];
  const f: LogFlags = {
    title: '', did: '', task: '', verified: '',
    actor: govActor === undefined || govActor === '' ? 'claude' : govActor,
    pending: [],
  };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`log: ${flag} needs a value — see: scrumux help log`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--title': f.title = value(a); break;
      case '--did': f.did = value(a); break;
      case '--task': f.task = value(a); break;
      case '--verified': f.verified = value(a); break;
      case '--actor': f.actor = value(a); break;
      case '--pending': f.pending.push(value(a)); break;
      default: die(`log: unknown flag ${a} — see: scrumux help log`);
    }
  }
  return f;
}

/** The entry `append_with_id`'s filter builds, key order included. */
export function logEntry(f: LogFlags, id: string, today: string): JsonValue {
  const entry: { [k: string]: JsonValue } = {
    id,
    date: today,
    // `task:(if $task=="" then null else $task end)` -- THE ONE optional field
    // in this entry that is written as an explicit null rather than omitted.
    // AI_LOG.MD's renderer tests `if .task then …`, so null and absent read
    // the same there; the schema is what wants the key present.
    task: f.task === '' ? null : f.task,
    actor: f.actor,
    title: f.title,
    what_was_done: f.did,
  };
  if (f.verified !== '') entry['verification'] = f.verified;
  if (f.pending.length > 0) entry['pending'] = [...f.pending];
  return entry;
}

function logNew(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const f = parseLogFlags(args, (m) => cli.die(m), ctx.env);

  if (f.title === '') {
    cli.die('log: --title is required — one sentence naming what changed and the record ids it settles, in the past tense. GOOD (build) "The prune stopped eating the two files deploy promises never to overwrite (I-0152, I-0153)" (L-0285). GOOD (defect) "A wall stops recording a sub-agent refusal as the session own (I-0154)". GOOD (governance) "Repair applied to governance/decisions.json" (L-0284). BAD "fixed hook" — eight words of jargon that name neither the hook nor what stopped being wrong.');
  }
  if (f.did === '') {
    cli.die('log: --did is required (what_was_done) — the EVIDENCE, not a story: the verify command and its rc, git diff --stat, and every refusal you hit and what you did about it. GOOD "harness deploy seeding lane creates .claude/rules/project-standards.md and .claude/project-walls.conf create-if-absent; the I-0143 prune then removed any path the previous manifest names that payload.list lacks. Fixed by writing each seeded path into TMPD/seeded.list and skipping it in the prune. sh tests/harness-tests.sh rc=0; 3 files changed, 61 insertions" (L-0285). GOOD "scrumux repair on governance/decisions.json. Reason: stamping the back-references for D-0081 and D-0082, without which the twenty dead rulings go on rendering as current law" (L-0284). BAD "created X, verified Y" — nothing there can be checked by a reader who was not present.');
  }
  if (f.task !== '') refusing(cli, () => requireTaskRef(ctx.gov, f.task));

  const logPath = join(ctx.gov, 'log.json');
  const opts: WriteOptions = { gov: ctx.gov, today: ctx.today, env: ctx.env, err: (s) => io.err(s) };
  const id = refusing(cli, () => {
    ensureFile(logPath, SEED);
    const res = appendWithId(
      logPath,
      (doc) => entriesOf(doc).map((r) => field(r, 'id')),
      'L',
      (doc, newId) => appendEntry(doc, logEntry(f, newId, ctx.today)),
      opts,
    );
    warnReseal(cli, res.resealWarning);
    if (f.task !== '') {
      const back = writeJson(
        join(ctx.gov, 'tasks.json'),
        (doc) => mapEntries(doc, (row) => {
          if (field(row, 'id') !== f.task) return row;
          const o = row as { [k: string]: JsonValue };
          return { ...o, log_entries: [...(asArray(field(row, 'log_entries')) ?? []), res.id] };
        }),
        opts,
      );
      warnReseal(cli, back.resealWarning);
    }
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
        return logNew(cli, nounContext(ctx), ctx.io, args);
      case 'show':
        return logShow(cli, nounContext(ctx), args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun log — verbs: new, show. See: scrumux help log`,
        );
    }
  },
};
