/**
 * The `backlog` noun. Brief: docs/port/modules/read-verbs-small.md.
 *
 * TWO SECTIONS, BECAUSE THEY MEAN DIFFERENT THINGS:
 *   ranked   — a priority someone deliberately set with `scrumux rank set`.
 *   unranked — never prioritised. Listed WITHOUT numbers, so an absent
 *              decision can never read as a priority decision.
 *
 * Listing features and listing tasks are two different questions, which is why
 * `--features` became a VERB: a boolean flag made them look like one question
 * with a modifier.
 *
 * ABSENT IS NORMAL, UNREADABLE REFUSES — and here the refusal is exit 2, not a
 * line in the report. This is the OTHER disposition of the same fact `status`
 * handles by printing into the brief (PHILOSOPHY.md P-16): `backlog` has no
 * report to print a caveat into that would not be a lie about the list's
 * completeness, so it stops. Exit 2 is the right code — "could not run", not
 * "the assertion did not hold" (D-0085/OQ-16).
 *
 * THREE JOURNALS, THREE GUARDS, and the third one is the one that was missing.
 * `design.json` and `tasks.json` are both checked in the features branch and
 * `tasks.json` and `sprints.json` in the tasks branch; the sprints guard exists
 * because a corrupt optional journal slurped in unchecked fails the same way
 * and tells the same lie — "(no open tasks)" when the truth is "I could not
 * read it" (I-0078/I-0083).
 *
 * THE REFUSAL LANDS AFTER THE HEADER LINE, and under `--json` it lands
 * NOWHERE. The header is already printed by the time a journal is read, so
 * human mode shows it and then the error; under `--json` the whole thing is
 * inside the report's capture, so stdout and stderr are both EMPTY and only
 * the exit code survives. This is deliberate — see src/cli/capture.ts.
 */
import { Report, ReportRefusal } from '../cli/capture.js';
import { readJournal, journalUnreadable } from '../journal/read.js';
import type { JsonValue } from '../journal/jqformat.js';
import type { NounModule } from './registry.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import {
  arrayOf, clength, cslice, entriesOf, field, interp, sortBy, truthy,
} from './lib/jqlike.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The verbs, in the order the usage block lists them. */
export const VERBS = ['tasks', 'features'] as const;

const VERBS_TSV = `tasks\topen tasks in priority order
features\tfeatures in priority order, their own address space
`;

/**
 * The text is NOT re-typed here: `src/cli/usage-text.ts` is the one home for
 * every noun's usage block. The seam still requires every module to ANSWER
 * `usage()`, so it answers — from that one table.
 */
const USAGE = NOUN_USAGE['backlog'] ?? '';

/**
 * `jq -e . <file>` — "is this JSON at all", nothing about its shape. Absent is
 * NOT this function's business: every call site tests the file's existence
 * first, because absence is normal and unreadability is not.
 */
function requireParses(path: string, message: string): JsonValue {
  const r = readJournal(path);
  if (r.kind === 'unreadable') throw new ReportRefusal(message);
  return r.value;
}

/**
 * The description as a CONTINUATION line, never inline: one row plus at most
 * one description line per item, so the numbering stays readable. The
 * description is where the ranking rationale lives (I-0048) — the post-MVP
 * markers, the "soonish" requirement, User's recorded rulings — so it is
 * truncated by default and whole under `--full`.
 *
 * The 150 is counted in CODEPOINTS and the slice is taken in codepoints, which
 * is jq's unit and not JavaScript's: a description ending in an emoji would
 * otherwise be cut through a surrogate pair.
 */
function descLine(e: JsonValue, full: boolean, verb: string): string[] {
  const raw = field(e, 'description');
  const d = typeof raw === 'string' ? raw : '';
  if (clength(d) === 0) return [];
  const flat = d.replace(/\n/g, ' ');
  if (full) return [`     ${flat}`];
  return [clength(d) > 150
    ? `     ${cslice(flat, 0, 150)}…  (scrumux backlog ${verb} --full)`
    : `     ${flat}`];
}

/**
 * The ranked/unranked split, shared by both verbs because both print it the
 * same way. Ranked items are NUMBERED from 1 in rank order; unranked ones come
 * after a counted separator and carry a `- ` bullet instead of a number.
 */
function ranked(items: readonly JsonValue[], row: (e: JsonValue) => string, desc: (e: JsonValue) => string[], separator: string): string[] {
  const withRank = sortBy(items.filter((e) => field(e, 'rank') !== null), (e) => field(e, 'rank'));
  const without = sortBy(items.filter((e) => field(e, 'rank') === null), (e) => field(e, 'id'));
  const out: string[] = [];
  withRank.forEach((e, i) => {
    out.push(`${i + 1}. ${row(e)}`);
    out.push(...desc(e));
  });
  if (without.length > 0) {
    out.push('');
    out.push(`--- Never ranked (${without.length}) — no priority set. Place one: ${separator} ---`);
    for (const e of without) {
      out.push(`- ${row(e)}`);
      out.push(...desc(e));
    }
  }
  return out;
}

// ------------------------------------------------------------- features -----
function listFeatures(r: Report, gov: string, today: string, full: boolean): void {
  r.line(`=== FEATURES (${today}) — ranked = deliberate priority. Move: scrumux rank set <F-XXXX> <new-#> ===`);
  const designPath = join(gov, 'design.json');
  if (!existsSync(designPath)) {
    r.line('(no design.json — nothing to rank)');
    return;
  }
  // A corrupt journal must not read as an empty one. Without this, jq leaks a
  // parse error to stderr and the view prints "(no features)", which says
  // "there are none" when the truth is "I could not read it".
  const design = requireParses(designPath, journalUnreadable(designPath));

  // GUARDED, exactly as design.json is. This was a bare `cat`, so a corrupt
  // tasks.json reached the view and it rendered as though the journal were
  // empty — the I-0102 shape, in the one branch that still read unchecked.
  let tasks: JsonValue = { entries: [] };
  const tasksPath = join(gov, 'tasks.json');
  if (existsSync(tasksPath)) tasks = requireParses(tasksPath, journalUnreadable(tasksPath));

  const es = entriesOf(design);
  const epics = es.filter((e) => field(e, 'kind') === 'epic');
  const feats = es.filter((e) => field(e, 'kind') === 'feature');
  const taskEntries = entriesOf(tasks);

  const epicOf = (fid: JsonValue): string => {
    const owning = epics.filter((e) => arrayOf(e, 'features').some((x) => x === fid));
    return owning.length === 0 ? 'unassigned' : interp(field(owning[0]!, 'id'));
  };
  const counts = (f: JsonValue): string => {
    const ns = arrayOf(f, 'stories').length;
    const nt = taskEntries.filter((t) =>
      field(t, 'feature') === field(f, 'id')
      && field(t, 'status') !== 'accepted'
      && field(t, 'status') !== 'superseded').length;
    return `stories=${ns} open-tasks=${nt}`;
  };
  const row = (f: JsonValue): string =>
    `${interp(field(f, 'id'))} ${interp(field(f, 'name'))}  (${epicOf(field(f, 'id'))})  ${counts(f)}`;

  const list = ranked(feats, row, (f) => descLine(f, full, 'features'), 'scrumux rank set <F-XXXX> <#>');
  // `if [ -n "$FLIST" ]` — the whole block is one string, so a list that is
  // empty prints the placeholder and one that is not prints verbatim,
  // internal blank line included.
  if (list.length > 0) r.line(list.join('\n'));
  else r.line('(no features)');
}

// ---------------------------------------------------------------- tasks -----
function listTasks(r: Report, gov: string, today: string, full: boolean): void {
  r.line(`=== BACKLOG (${today}) — ranked = deliberate priority. Move: scrumux rank set <#|T-XXXX> <new-#> ===`);
  const tasksPath = join(gov, 'tasks.json');
  if (!existsSync(tasksPath)) {
    r.line('(no tasks.json — nothing to rank)');
    return;
  }
  const tasks = requireParses(tasksPath, journalUnreadable(tasksPath));

  // sprints.json is optional: a repo can have tasks before it has sprints.
  // Optional means ABSENT, not unreadable — a corrupt one tells the same lie.
  let sprints: JsonValue = { entries: [] };
  const sprintsPath = join(gov, 'sprints.json');
  if (existsSync(sprintsPath)) sprints = requireParses(sprintsPath, journalUnreadable(sprintsPath));
  const sprintEntries = entriesOf(sprints);

  // A task is "committed" only to a sprint that is still LIVE.
  const sprintOf = (tid: JsonValue): string => {
    const live = sprintEntries.filter((s) => {
      const st = field(s, 'status');
      return (st === 'ratified' || st === 'proposed') && arrayOf(s, 'tasks').some((x) => x === tid);
    });
    return live.length === 0 ? '' : `  [${interp(field(live[0]!, 'id'))} ${interp(field(live[0]!, 'status'))}]`;
  };
  const row = (t: JsonValue): string => {
    const feature = field(t, 'feature');
    const story = field(t, 'story');
    return `${interp(field(t, 'id'))} [${interp(field(t, 'status'))}] ${interp(field(t, 'title'))}`
      + (truthy(feature)
        ? `  (${interp(feature)}${truthy(story) ? `/${interp(story)}` : ''})`
        : '')
      + sprintOf(field(t, 'id'));
  };

  // A superseded task is retired, not open work — leaving it listed is exactly
  // the misleading surface T-0115 exists to remove (I-0059).
  const open = entriesOf(tasks).filter((t) =>
    field(t, 'status') !== 'accepted' && field(t, 'status') !== 'superseded');
  const list = ranked(open, row, (t) => descLine(t, full, 'tasks'), 'scrumux rank set <T-XXXX> <#>');
  if (list.length > 0) r.line(list.join('\n'));
  else r.line('(no open tasks)');
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    if (verb !== 'tasks' && verb !== 'features') {
      return cli.dieUsage(`unknown verb '${verb}' for noun backlog — verbs: tasks, features. See: scrumux help backlog`);
    }
    const report = new Report(cli.json, ctx.io);
    try {
      // The flag loop lives INSIDE the captured report, which is why a bad
      // flag under `--json` is as silent as a corrupt journal is: the
      // refusal never leaves the capture.
      let full = false;
      for (const a of args) {
        if (a === '--full') full = true;
        else throw new ReportRefusal(`backlog: unknown flag ${a} — usage: scrumux backlog tasks|features [--full]`);
      }
      if (verb === 'features') listFeatures(report, ctx.roots.gov, ctx.today, full);
      else listTasks(report, ctx.roots.gov, ctx.today, full);
    } catch (e) {
      if (!(e instanceof ReportRefusal)) throw e;
      // Under --json the refusal fired inside the report's capture, so
      // neither its object nor its stderr line ever reach a real stream.
      // Empty stdout, empty stderr, exit 2.
      if (cli.json) ctx.io.exit(2);
      return cli.die(e.detail);
    }
    if (cli.json) cli.data({ lines: report.dataLines() as unknown as JsonValue });
    return cli.emit('');
  },
};
