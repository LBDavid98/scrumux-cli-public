/**
 * The `exception` noun.
 *
 * WHY THIS IS NOT `issue`, ruled by User 2026-08-27: an ISSUE is a code-level
 * discovery -- the schema is wrong, the gateway needs parameter X, I am
 * blocked by Y. An EXCEPTION is a finding about whether the WORK FOLLOWED THE
 * RULES. Filing one as the other would put process findings into the journal
 * that hotfix promotion reads, and make the issue validator's verdicts
 * meaningless for half its contents.
 *
 * A REVIEWER IS NEVER A BLOCKER, and that is the load-bearing constraint.
 * `--disposition` is a RECOMMENDATION -- four values, validated and then
 * simply stored. Nothing in this module moves a task, ratifies a sprint or
 * corrects a record, and `resolve` RECORDS what a person did rather than doing
 * it. Those acts have their own verbs and their own authority; performing one
 * from here would make a reviewer's recommendation self-executing.
 *
 * TWO THINGS ARE ODD, AND BOTH ARE DELIBERATE.
 *
 *   `resolve` IS THE ONE WRITE IN THIS FAMILY THAT DOES NOT `sealBootstrap`,
 *   and it reseals its journal TWICE -- once inside `guardedWrite`'s own
 *   write engine, once explicitly afterwards via a second `resealOne` call,
 *   OUTSIDE the lock the first reseal already released (OQ-DN1, unruled).
 *   The second call is kept in the same place and with the same lock
 *   lifetime rather than "cleaned up" into one, because collapsing it would
 *   narrow the laundering window observably.
 *
 *   `list` WRITES ITS ROWS STRAIGHT TO STDOUT, not through `say` -- so under
 *   `--json` they land on stdout AHEAD of the envelope and the caller gets
 *   prose followed by an object. This is deliberate, because the alternative
 *   would silently repair a surface a machine consumer may already be
 *   working around.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFile } from '../util/fs-predicates.js';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { refExists, requireTaskRef } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { resealOne, sealBootstrap } from '../journal/seals.js';
import { ensureFile } from '../journal/write.js';
import { interp } from './lib/jqlike.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';
import { appendEntry, flagValue, guardedAppend, guardedWrite, idStream, mapEntries, warnReseal } from './lib/writers.js';
import { authorityGuard } from '../journal/guards.js';
import { AUTHORITY_NONE, authorityProblem } from '../journal/standing.js';
import { exceptionAct } from './exception-acts.js';
import { STANDING_FIELDS, withoutKeys } from './lib/standing-acts.js';

export const VERBS = ['new', 'resolve', 'list', 'ratify', 'reject', 'acknowledge'] as const;

const VERBS_TSV = `new\tfile a process finding on a session
resolve\trecord what was done about one — ratified with --authority, otherwise proposed (D-S039)
list\tthe open findings, and resolutions awaiting a person
ratify\ta person ratifies a proposed or authority-less resolution
reject\ta person rejects a resolution, reopening the finding
acknowledge\ta person keeps an authority-less resolution as it is
`;

const SEED = '{"entries": []}';

const DISPOSITIONS = [
  'accept_and_track', 'requires_ratification', 'correct_the_record', 'reject_the_task',
] as const;
const RESOLUTIONS = ['tracked', 'ratified', 'corrected', 'rejected', 'withdrawn'] as const;

const exceptionsPath = (ctx: NounContext): string => join(ctx.gov, 'exceptions.json');

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

// ---------------------------------------------------------------------- new
function exceptionNew(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  let lens = '';
  let severity = 'yellow';
  let ref = '';
  let finding = '';
  let disposition = 'accept_and_track';
  // `${GOV_ACTOR:-claude}` -- the actor the harness was dispatched as, and
  // `claude` when nothing set one.
  let source = ctx.env['GOV_ACTOR'] === undefined || ctx.env['GOV_ACTOR'] === '' ? 'claude' : ctx.env['GOV_ACTOR'];
  let session = '';
  let task = '';
  let sprint = '';
  let rule = '';

  for (let i = 0; i < args.length; ) {
    const f = args[i]!;
    const v = (): string => flagValue(cli, args, i + 1, 'exception');
    if (f === '--lens') { lens = v(); i += 2; continue; }
    if (f === '--severity') { severity = v(); i += 2; continue; }
    if (f === '--ref') { ref = v(); i += 2; continue; }
    if (f === '--finding') { finding = v(); i += 2; continue; }
    if (f === '--disposition') { disposition = v(); i += 2; continue; }
    if (f === '--source') { source = v(); i += 2; continue; }
    if (f === '--session') { session = v(); i += 2; continue; }
    if (f === '--task') { task = v(); i += 2; continue; }
    if (f === '--sprint') { sprint = v(); i += 2; continue; }
    if (f === '--rule') { rule = v(); i += 2; continue; }
    cli.die(`exception: unknown flag ${f} — see: scrumux help exception`);
  }

  if (lens === '') {
    cli.die(
      'exception: --lens is required (which reviewer raised it) — name the question the reviewer was asking, not the reviewer. GOOD "Scope against the order". GOOD "Repo standards" (X-0001). GOOD "scripts_run" (X-0002). BAD "review" — every finding comes from a review, so it separates nothing when the list is grouped.',
    );
  }
  if (ref === '') {
    cli.die(
      'exception: --ref is required (what it is about — a task, a file, a rule) — point at the exact thing, with a line number where there is one. GOOD "harness .claude/scripts/lib/cmd-records.sh:264" (X-0001). GOOD "T-0217" for a task. GOOD "issue-validation.md" for a rule. BAD "the CLI" — nobody can open it.',
    );
  }
  if (finding === '') {
    cli.die(
      'exception: --finding is required (what was found, in a sentence a person can act on) — say what happened, what is believed to explain it, and what remains unproven, because the person deciding was not there. GOOD "Running records check through the control plane appended printf: write error: Broken pipe to the output the app displayed. The cause is believed to be grep -q closing the pipe under printf, which only reports when the parent has SIGPIPE ignored — as Node does. Eleven call sites were hardened and 497 harness tests stay green, but the symptom was NOT reproduced in eight attempts, so the fix is not confirmed to address it" (X-0001). GOOD "The command refused by block-upstream-edit was re-run after the refusal, but the first run has null exitCode in scriptsRun; the evidence does not show whether it exited nonzero or was blocked pre-execution" (X-0002). BAD "the session did not follow the rules" — no act, no rule named, nothing a person can settle.',
    );
  }
  if (severity !== 'red' && severity !== 'yellow') {
    cli.die(
      `exception: --severity must be red or yellow, got '${severity}'. There is no green: a finding nobody needs to see is not filed.`,
    );
  }
  if (!(DISPOSITIONS as readonly string[]).includes(disposition)) {
    cli.die(
      `exception: --disposition must be one of accept_and_track, requires_ratification, correct_the_record, reject_the_task — got '${disposition}'`,
    );
  }
  // `--session`, `--sprint` and `--rule` are UNVALIDATED free text; only
  // `--task` resolves. Schema enforcement is a separate, later pass
  // (`records check`), never a write-time gate here.
  if (task !== '') refusing(cli, () => requireTaskRef(ctx.gov, task));

  const path = exceptionsPath(ctx);
  refusing(cli, () => ensureFile(path, SEED));
  const d = ctx.today;
  const r = guardedAppend(cli, ctx, ictx.io, path, idStream, 'X', (doc, id) =>
    appendEntry(doc, {
      id,
      lens,
      severity,
      ref,
      finding,
      disposition,
      status: 'open',
      source,
      created_at: d,
      session: session === '' ? null : session,
      task: task === '' ? null : task,
      sprint: sprint === '' ? null : sprint,
      rule: rule === '' ? null : rule,
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return emitted(cli, r.id);
}

// ------------------------------------------------------------------ resolve
function exceptionResolve(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const id = args[0] ?? '';
  // AN UNRULED DIVERGENCE, narrow and deliberate: a raw shell
  // parameter-expansion diagnostic would carry a source line number and an
  // exit code that is neither of the two the CLI's own contract documents.
  // The MESSAGE -- which is the part Article 5 makes product surface -- is
  // kept; the frame around it is this CLI's own refusal. See
  // docs/port/modules/cmd-task.md open question 1.
  if (id === '') {
    cli.die('exception: which exception? Example: scrumux exception resolve X-0001 --status tracked --by user');
  }
  const rest = args.slice(1);

  let status = '';
  let by = '';
  let note = '';
  let authority = '';
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    const v = (): string => flagValue(cli, rest, i + 1, 'exception');
    if (f === '--status') { status = v(); i += 2; continue; }
    if (f === '--by') { by = v(); i += 2; continue; }
    if (f === '--note') { note = v(); i += 2; continue; }
    if (f === '--authority') { authority = v(); i += 2; continue; }
    cli.die(`exception: unknown flag ${f} — see: scrumux help exception`);
  }

  const path = exceptionsPath(ctx);
  if (!isFile(path)) cli.die('exception: this repo has no exceptions.json yet');
  if (!refExists(path, id)) cli.die(`exception: no ${id} in this repo`);
  if (status === '') cli.die('exception: --status is required (tracked|ratified|corrected|rejected|withdrawn)');
  if (status === 'open') cli.die('exception: --status open is the filing state; resolve moves it off open');
  if (!(RESOLUTIONS as readonly string[]).includes(status)) {
    cli.die(
      `exception: --status must be one of tracked, ratified, corrected, rejected, withdrawn — got '${status}'`,
    );
  }
  if (by === '') cli.die('exception: --by is required. A finding settled by nobody is not settled.');

  // NEVER A REFUSAL (D-S039): without a resolvable authority the resolution
  // is recorded PROPOSED for a person to ratify, reject or acknowledge.
  const problem = authorityProblem(() => authorityGuard(ctx.gov, authority, 'exception resolve'));
  const ratified = problem === null;
  guardedWrite(cli, ctx, ictx.io, path, (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== id) return row;
      // `. + {…}`: `status` keeps its position, `resolved_by` and
      // `resolution` are appended in the RHS object's order. A re-resolve
      // replaces the standing fields of the previous one.
      const base = withoutKeys(row, STANDING_FIELDS);
      return {
        ...base, status, resolved_by: by, resolution: note === '' ? null : note,
        resolution_status: ratified ? 'ratified' : 'proposed',
        authority: ratified ? authority : AUTHORITY_NONE,
        recorded_by: by,
        ...(ratified ? { ratified_by: by } : authority === '' ? {} : { authority_claimed: authority }),
      };
    }),
  );
  cli.data({ resolution_status: ratified ? 'ratified' : 'proposed', authority: ratified ? authority : AUTHORITY_NONE });
  if (!ratified) {
    cli.sayAlways(
      `TELL: ${id}'s resolution is recorded PROPOSED (authority: none${authority === '' ? '' : `; '${authority}' did not resolve`}). `
      + `A person ratifies it — in scrumux-app, or: scrumux exception ratify ${id} --by WHO --authority direct|app:<session>.`,
    );
  }
  // THE SECOND RESEAL (OQ-DN1). Redundant in the common case and outside the
  // lock `write_json` has already released; kept, because the fix is a ruling
  // rather than a port decision. NOTE there is no `seal_bootstrap` here --
  // this is the one write verb in the family that has none.
  warnReseal(cli, resealOne(ctx.gov, path, ctx.today, ctx.env));
  return emitted(cli, id);
}

// --------------------------------------------------------------------- list
function exceptionList(cli: Cli, ctx: NounContext, io: Io): never {
  const path = exceptionsPath(ctx);
  if (!isFile(path)) {
    cli.say('no exceptions recorded in this repo');
    // `return 0` -- the dispatcher's safety net writes the summary, so it is
    // reproduced by calling finish rather than by typing the sentence twice.
    return cli.finish();
  }
  // STRAIGHT TO STDOUT, in both modes. See the header.
  let shown = 0;
  for (const row of rows(path)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as { [k: string]: JsonValue };
    // A resolution nobody with authority has ratified is still a person's
    // to settle (D-S039), so it is listed beside the open findings, marked.
    const proposed = r['status'] !== 'open' && r['resolution_status'] === 'proposed' && r['acknowledged_by'] === undefined;
    if (r['status'] !== 'open' && !proposed) continue;
    shown += 1;
    const mark = proposed ? `  [resolution PROPOSED: ${interp(r['status'])} by ${interp(r['recorded_by'])} — needs a person]` : '';
    io.out(
      `${interp(r['id'])}  ${interp(r['severity'])}  ${interp(r['disposition'])}  ` +
        `${interp(r['lens'])} — ${interp(r['ref'])}: ${interp(r['finding'])}${mark}\n`,
    );
  }
  // A JOURNAL WITH NOTHING OPEN IN IT USED TO PRINT NOTHING AT ALL, so the
  // whole answer was the dispatcher's `scrumux exception list: ok.` -- thinner
  // than every other empty state in the CLI (`(no open tasks)`, `(none open)`,
  // `(none declared)`) and indistinguishable, to a reader, from a command that
  // did not run. Through `say`, like the missing-file line above and like
  // backlog's, so `--json` still gets one object on stdout.
  if (shown === 0) cli.say('(no open exceptions)');
  return cli.finish();
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => NOUN_USAGE['exception'] ?? '',
  run(cli, ictx, verb, args): never {
    const ctx = nounContext(ictx);
    switch (verb) {
      case 'new': return exceptionNew(cli, ctx, ictx, args);
      case 'resolve': return exceptionResolve(cli, ctx, ictx, args);
      case 'list': return exceptionList(cli, ctx, ictx.io);
      case 'ratify':
      case 'reject':
      case 'acknowledge':
        return exceptionAct(cli, ctx, ictx.io, verb, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun exception — try new, resolve, list, ratify, reject or acknowledge. See: scrumux help exception`,
        );
    }
  },
};
