/**
 * The `status` noun. Brief: docs/port/modules/cmd-status.md.
 *
 * THE journal reader: four read-only reports — `session`, `sprint`, `sweep`,
 * `planning` — in place of four scripts that each re-opened the same seven
 * journals, "three of them in the same planning breath and two of them in the
 * same session start".
 *
 * `status session` NEVER EXITS NONZERO ON THE RECORDS' STATE. It is wired to
 * the SessionStart hook, so a failure there would be a failure to start work.
 * Mechanically that holds because this module raises no `fail` and no `warn`
 * row — it has exactly one row, a `tell` — so nothing it does can move the
 * verdict. Surplus argv is the one exception and it exits 2: "could not run",
 * not "the records said no". (PHILOSOPHY.md P-02.)
 *
 * FOUR NON-OBVIOUS PROPERTIES, EASY TO "IMPROVE" BY ACCIDENT:
 *
 *  1. **The brief's task list has NO SIZE CAP, and that was a fix.** It ended
 *     in `| head -8` once (I-0122); the cap counted header lines against the
 *     same budget as task lines, so two five-task sprints hid four tasks each
 *     and a seven-task sprint hid the NEXT sprint's header entirely. A reader
 *     takes the list as complete. The `^SP-|^  T-` filter that stayed is NOT
 *     decoration: a task title containing a newline emits a bare, unindented
 *     continuation line, and only the anchors keep it out of the brief
 *     (T-0204). It is reproduced here as a per-line prefix test, never as one
 *     multiline regex — see docs/port/modules/cmd-status.md open question 4.
 *
 *  2. **A journal that parses but has the wrong SHAPE reports silently wrong,
 *     at exit 0.** `read_journal`'s check is "is this JSON at all", not "does
 *     it have `.entries`". Every projection here is assigned from a command
 *     substitution with no fallback, so a jq error leaves the value empty and
 *     the section renders its default text. That gap is open question 1 of the
 *     brief and it is deliberate, not an oversight: validating shape here
 *     would invent a refusal this system does not raise. Each computed value below
 *     therefore catches its own failure and falls back to the empty/default
 *     rendering rather than throwing.
 *
 *  3. **Candidates exclude tasks held by a PROPOSED sprint, not only a
 *     ratified one** (T-0094/I-0039). Narrowing that to "ratified" reads like
 *     a cleanup and re-creates six duplicate "READY: scrumux sprint add" hints
 *     in one report, which is the double-add invitation the exclusion exists
 *     to remove.
 *
 *  4. **The git position line is simply ABSENT when the tree is not a git
 *     repository.** No `else`, no "(not a git repository)". Adding one is an
 *     observable change with no ruling (brief, open question 2).
 *
 * A refusal for an unreadable journal is printed INTO the report, once per
 * file, and never onto the exit code. Once per FILE is this module's own
 * property, not `read_journal`'s: `tasks.json` is opened by two loaders and a
 * journal read by two sections must not say the same thing twice.
 */
import type { Cli } from '../cli/envelope.js';
import { Report } from '../cli/capture.js';
import { readJournal, journalUnreadable } from '../journal/read.js';
import type { JsonValue } from '../journal/jqformat.js';
import type { NounModule } from './registry.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import {
  arrayOf, cslice, entriesOf, field, interp, joinJq, truthy,
} from './lib/jqlike.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bindingSupersedes, standingOf } from '../journal/standing.js';

/** The verbs, in the order the usage block lists them. */
export const VERBS = ['session', 'planning', 'sprint', 'sweep'] as const;

const VERBS_TSV = `session\tthe orientation block; ALWAYS exits 0
planning\tsprint report + decision queue + validation sweep
sprint\tthe sprint report alone
sweep\tthe validation sweep alone
`;

/**
 * The text is NOT re-typed here: `src/cli/usage-text.ts` is the one home for
 * every noun's usage block. The seam still requires every module to ANSWER
 * `usage()`, so it answers — from that one table.
 */
const USAGE = NOUN_USAGE['status'] ?? '';

/** A task as `T_VIEW` projects it — seven fields of a 690KB journal. */
interface TaskView {
  id: JsonValue; title: JsonValue; status: JsonValue; feature: JsonValue; story: JsonValue; ordered: boolean; review: JsonValue;
}

/**
 * The per-invocation journal state: one object holding a per-journal
 * "opened at most once per run" memoisation, with that contract visible in
 * one place rather than spread across call sites.
 */
class State {
  readonly refused = new Set<string>();
  private readonly loaded = new Map<string, JsonValue | null>();

  tasksLoaded = false;
  taskView: TaskView[] = [];

  designLoaded = false;
  design: JsonValue | null = null;

  sprintComputed = false;
  unfinished = 0;
  flight = '';
  active = 0;
  ratified = '';

  constructor(readonly gov: string, readonly report: Report) {}

  /** `refuse_journal` — one visible refusal per FILE, and it goes in the report. */
  refuse(path: string): void {
    if (this.refused.has(path)) return;
    this.refused.add(path);
    this.report.line(`scrumux status: error: ${journalUnreadable(path)}`);
    this.report.line('  the section(s) below that read it are EMPTY because it could not be read, not because there is nothing in it.');
  }

  /**
   * The memoised loader. Returns the parsed journal, or null for BOTH
   * absent and unreadable, because every use site treats the two the same
   * way (falls back to a default rendering). The two states stay
   * distinguishable where it matters: only the unreadable one prints, and
   * it prints here.
   */
  load(name: string): JsonValue | null {
    const hit = this.loaded.get(name);
    if (hit !== undefined) return hit;
    const path = join(this.gov, name);
    const r = readJournal(path);
    let v: JsonValue | null;
    if (r.kind === 'ok') v = r.value;
    else if (r.kind === 'absent') v = null;
    else { this.refuse(path); v = null; }
    this.loaded.set(name, v);
    return v;
  }
}

// ---------------------------------------------------------------- helpers --
/**
 * The filter's lines, or the default line when the journal was absent or
 * unreadable. The default is a LINE, printed as-is, not a value to be
 * rendered further.
 */
function jv(j: JsonValue | null, fallback: string, lines: (j: JsonValue) => string[]): string[] {
  if (j === null) return [fallback];
  try {
    return lines(j);
  } catch {
    // A shape error inside a jq pipeline leaves the substitution empty and
    // the section renders nothing. Reproduced, per open question 1.
    return [];
  }
}

// --------------------------------------------------------- journal loading --
function loadTasks(st: State): void {
  if (st.tasksLoaded) return;
  st.tasksLoaded = true;
  const path = join(st.gov, 'tasks.json');
  const r = readJournal(path);
  if (r.kind === 'absent') return;
  if (r.kind === 'unreadable') { st.refuse(path); return; }
  try {
    st.taskView = entriesOf(r.value).map((e) => ({
      id: field(e, 'id'),
      title: field(e, 'title'),
      status: field(e, 'status'),
      feature: field(e, 'feature'),
      story: field(e, 'story'),
      ordered: field(e, 'task_order') !== null,
      review: field(e, 'review'),
    }));
  } catch {
    st.taskView = [];
  }
}

/** Does `tasks.json` exist at all? Two sections branch on the FILE (`[ -f ]`),
 *  not on whether the read succeeded — an unreadable one still takes the
 *  present arm and renders its (empty) projection. */
function tasksFilePresent(st: State): boolean {
  return existsSync(join(st.gov, 'tasks.json'));
}

/**
 * `design_view` — the per-kind projection of the entries-shape design journal
 * (T-0082). The guard sits HERE and not inside the projection, because
 * `records check`'s sweep is the projection's other caller and burying a
 * brief-shaped refusal in it would put a brief sentence on a path that is not
 * the brief.
 */
interface DesignView { epics: JsonValue[]; features: JsonValue[] }

function loadDesign(st: State): void {
  if (st.designLoaded) return;
  st.designLoaded = true;
  const path = join(st.gov, 'design.json');
  const r = readJournal(path);
  if (r.kind === 'absent') return;
  if (r.kind === 'unreadable') { st.refuse(path); return; }
  st.design = r.value;
}

function designView(st: State): DesignView | null {
  if (st.design === null) return null;
  const es = entriesOf(st.design);
  return {
    epics: es.filter((e) => field(e, 'kind') === 'epic'),
    features: es.filter((e) => field(e, 'kind') === 'feature'),
  };
}

// ------------------------------------------------------------ sprint state --
function computeSprint(st: State): void {
  if (st.sprintComputed) return;
  st.sprintComputed = true;
  loadTasks(st);
  const sprints = st.load('sprints.json');
  if (sprints === null) return;

  let live: JsonValue[];
  try {
    live = entriesOf(sprints).filter((s) => {
      const t = field(s, 'status');
      return t === 'proposed' || t === 'ratified';
    });
  } catch {
    return;
  }
  st.active = live.length;
  if (st.active === 0) return;

  // A duplicate id is a real journal state (CLI-14), and `$t[] | select(.id==$tid)`
  // emits EVERY match, so the line is repeated rather than deduped. Reproduced.
  const matches = (tid: JsonValue): TaskView[] => st.taskView.filter((t) => t.id === tid);

  const out: string[] = [];
  for (const s of live) {
    const head = `${interp(field(s, 'id'))} [${interp(field(s, 'status'))}]`
      + (truthy(field(s, 'hotfix'))
        ? ` HOTFIX from ${interp(field(s, 'source_issue'))}`
        : ` epic ${interp(field(s, 'epic'))}`)
      + ':';
    out.push(head);
    for (const tid of arrayOf(s, 'tasks')) {
      for (const t of matches(tid)) {
        out.push(`  ${interp(tid)} [${interp(t.status)}] ${interp(t.title)}`);
      }
    }
  }
  st.flight = out.join('\n');

  let unfinished = 0;
  for (const s of live) {
    if (field(s, 'status') !== 'ratified') continue;
    for (const tid of arrayOf(s, 'tasks')) {
      for (const t of matches(tid)) if (t.status !== 'accepted') unfinished += 1;
    }
  }
  st.unfinished = unfinished;

  // The TELL below names this sprint. It used to interpolate a variable
  // nothing assigned, so the sentence rendered with the id missing from the
  // one place it was promised.
  const rat = joinJq(live.filter((s) => field(s, 'status') === 'ratified').map((s) => field(s, 'id')), ', ');
  st.ratified = rat !== '' ? rat : 'the ratified sprint';
}

function sprintVerdictLine(st: State): string {
  return st.unfinished > 0
    ? `VERDICT: a ratified sprint has ${st.unfinished} unfinished task(s) — working that sprint is usually right, but planning alongside it is User's call (D-0004 was a gate; T-0144 made it advice).`
    : 'VERDICT: no ratified sprint in flight — clear to assemble one (scrumux sprint new --epic E-XXXX, then scrumux sprint add; User ratifies).';
}

// ------------------------------------------------------- section: sprint ----
function sectionSprint(st: State, today: string): void {
  computeSprint(st);
  loadDesign(st);
  const issues = st.load('issues.json');
  const r = st.report;
  const dv = designView(st);

  r.line(`=== SPRINT STATUS (${today}) ===`);
  r.line('');

  // --- 1. Sprints in flight -------------------------------------------
  r.line('--- Sprints in flight ---');
  if (st.load('sprints.json') !== null) {
    if (st.active > 0) r.line(st.flight);
    else r.line('(none proposed or ratified)');
  } else {
    r.line('(no sprints.json yet — first sprint: scrumux sprint new --epic E-XXXX)');
  }
  r.line('');

  // --- 2. Epic coverage map -------------------------------------------
  r.line('--- Epic coverage (epic -> features -> stories -> tasks) ---');
  if (dv !== null) {
    for (const e of dv.epics) {
      r.line(`${interp(field(e, 'id'))} ${interp(field(e, 'name'))}:`);
      for (const fid of arrayOf(e, 'features')) {
        for (const f of dv.features.filter((x) => field(x, 'id') === fid)) {
          const ft = st.taskView.filter((t) => t.feature === fid);
          const ns = arrayOf(f, 'stories').length;
          r.line(
            `  ${interp(fid)} ${interp(field(f, 'name'))}: stories=${ns} tasks=${ft.length}`
            + (ns === 0 ? `  <- NO STORIES: scrumux story new --feature ${interp(fid)} ...` : '')
            + (ft.length === 0 ? '  <- NO TASKS' : ''),
          );
        }
      }
    }
    r.line('');
    r.line('Features not in any epic:');
    // `[(.epics // [])[].features // []] | flatten` — the STREAM form of `//`,
    // so an epic whose `features` is null drops out rather than contributing.
    const streamed = dv.epics.map((e) => field(e, 'features')).filter(truthy);
    const inEpic = (streamed.length === 0 ? [[] as JsonValue[]] : streamed)
      .flatMap((v) => (Array.isArray(v) ? (v as JsonValue[]) : [v]));
    const orphans = dv.features.filter((f) => !inEpic.some((i) => i === field(f, 'id')));
    if (orphans.length === 0) r.line('  (none)');
    else for (const f of orphans) {
      r.line(`  ${interp(field(f, 'id'))} ${interp(field(f, 'name'))}  <- assign: scrumux epic new --name ... --desc ... --feature ${interp(field(f, 'id'))} (or extend an epic later)`);
    }
  } else {
    r.line('(no design.json — design gate first: scrumux feature new / scrumux story new)');
  }
  r.line('');

  // --- 3. Tasks not sprint-ready --------------------------------------
  r.line('--- Backlog tasks not sprint-ready ---');
  if (st.tasksLoaded && tasksFilePresent(st)) {
    const notReady = st.taskView
      .filter((t) => t.status === 'proposed' || t.status === 'ready')
      .filter((t) => t.ordered === false || t.story === null);
    if (notReady.length === 0) r.line('  (all proposed/ready tasks have story + task order)');
    else for (const t of notReady) {
      r.line(
        `  ${interp(t.id)} ${interp(t.title)}`
        + (t.story === null ? `  MISSING story (scrumux task order ${interp(t.id)} --story S-XXXX ...)` : '')
        + (t.ordered === false ? `  MISSING order (scrumux task order ${interp(t.id)} --scope ... --verify ... --file "path | why")` : ''),
      );
    }
  } else {
    r.line('(no tasks.json)');
  }
  r.line('');

  // --- 4. Open issues (promotion guidance per the planning rule) -------
  r.line('--- Open issues ---');
  r.lines(jv(issues, '(no issues.json)', (j) => {
    const open = entriesOf(j).filter((i) => field(i, 'status') === 'open');
    if (open.length === 0) return ['  (none open)'];
    // The guidance clause is a `\n` INSIDE one jq output value, so it is a
    // second line of the same `say`. Kept as one string for that reason.
    return open.map((i) => {
      const sev = truthy(field(i, 'severity')) ? interp(field(i, 'severity')) : 'unrated';
      const head = `  ${interp(field(i, 'id'))} [${interp(field(i, 'type'))}/${sev}] ${interp(field(i, 'summary'))}`;
      return head + (field(i, 'type') === 'idea'
        ? '\n      feature-request shaped -> backlog process (scrumux feature + scrumux story), not promotion'
        : `\n      hotfix lane if urgent: scrumux sprint new --hotfix --issue ${interp(field(i, 'id'))}`);
    });
  }));
  r.line('');

  // --- 5. Sprint candidates, dependency-ordered -----------------------
  r.line('--- Candidates for next sprint (dependency-ordered by feature) ---');
  if (dv !== null && tasksFilePresent(st)) {
    const sprints = st.load('sprints.json');
    const sprinted: JsonValue[] = sprints === null ? [] : entriesOf(sprints)
      .filter((s) => field(s, 'status') === 'proposed' || field(s, 'status') === 'ratified')
      .flatMap((s) => arrayOf(s, 'tasks'));
    // Features with no deps first, then the rest: a single-pass partial order.
    const ordered = [
      ...dv.features.filter((f) => arrayOf(f, 'dependencies').length === 0),
      ...dv.features.filter((f) => arrayOf(f, 'dependencies').length > 0),
    ];
    for (const f of ordered) {
      const fid = field(f, 'id');
      const ft = st.taskView.filter((t) =>
        t.feature === fid
        && (t.status === 'proposed' || t.status === 'ready')
        && !sprinted.some((s) => s === t.id));
      if (ft.length === 0) continue;
      const deps = arrayOf(f, 'dependencies');
      r.line(`${interp(fid)} ${interp(field(f, 'name'))}`
        + (deps.length > 0 ? ` (after ${joinJq(deps, ', ')})` : '')
        + ':');
      for (const t of ft) {
        r.line(`  ${interp(t.id)} ${interp(t.title)}`
          + (t.ordered && t.story !== null
            ? `  [READY: scrumux sprint add SP-XXXX ${interp(t.id)}]`
            : '  [not ready — see section above]'));
      }
    }
  }
  r.line('');
  r.line(sprintVerdictLine(st));
}

// -------------------------------------------------------- section: sweep ----
/**
 * Every OPEN issue with neither a validation verdict nor a recorded
 * authorization — the set the issue-validator agent must rule on. Since T-0189
 * this is a User inspection view rather than a planning-entry gate: an issue
 * is validated when it is PROMOTED, not on a cadence. Authorized-but-
 * unvalidated issues are NOT pending; authorization is its own gate-pass.
 */
function sectionSweep(st: State, today: string): void {
  const issues = st.load('issues.json');
  const r = st.report;
  r.line(`=== ISSUES PENDING VALIDATION (${today}) — rule on these before planning (T-0042) ===`);
  if (issues === null) {
    r.line('pending: 0 (no issues.json)');
    return;
  }
  let list: string[];
  try {
    list = entriesOf(issues)
      .filter((i) => field(i, 'status') === 'open' && field(i, 'validation') === null && field(i, 'authorization') === null)
      .map((i) => {
        const sev = truthy(field(i, 'severity')) ? interp(field(i, 'severity')) : 'unset';
        return `${interp(field(i, 'id'))} ${sev} ${cslice(interp(field(i, 'summary')), 0, 100)}`;
      });
  } catch {
    list = [];
  }
  // `COUNT=$(printf '%s' "$LIST" | grep -c .)` counts NON-EMPTY lines of the
  // joined text, which is not the same as the number of jq outputs when a
  // summary itself carries a newline.
  const text = list.join('\n');
  const count = text === '' ? 0 : text.split('\n').filter((l) => l.length > 0).length;
  if (text !== '') r.line(text);
  r.line(`pending: ${count}${count !== 0 ? ' — dispatch the issue-validator agent per issue; record verdicts via scrumux issue validate' : ''}`);
}

// ------------------------------------------------------ section: session ----
function gitLine(workRoot: string): string | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: workRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  if (git(['rev-parse', '--git-dir']) === null) return null;
  // Trailing newlines are stripped.
  const head = (git(['log', '-1', '--format=%h %s']) ?? '').replace(/\n+$/, '');
  const dirty = (git(['status', '--porcelain']) ?? '') !== '' ? ' [DIRTY TREE]' : '';
  return `commit: ${head}${dirty}`;
}

function sectionSession(st: State, today: string, workRoot: string): void {
  const r = st.report;
  r.line(`=== SESSION BRIEF (${today}) — generated by scrumux status session ===`);

  const g = gitLine(workRoot);
  if (g !== null) r.line(g);

  computeSprint(st);
  r.line(sprintVerdictLine(st));

  // No cap (I-0122). The filter is a PER-LINE prefix test and is load-bearing:
  // a title containing a newline emits a bare continuation line that only
  // these anchors keep out of the brief (T-0204).
  if (st.flight !== '') {
    for (const l of st.flight.split('\n')) {
      if (l.startsWith('SP-') || l.startsWith('  T-')) r.line(l);
    }
  }

  loadTasks(st);
  const ip = joinJq(st.taskView
    .filter((t) => t.status === 'in_progress')
    .map((t) => `${interp(t.id)} ${interp(t.title)}`), '; ');
  r.line(`in_progress: ${ip === '' ? 'none' : ip}`);

  // What awaits User is the TASK — an in_review task with no acceptance
  // recorded on it (D-0076/T-0187). It used to be the task's current review
  // record, which no command accepts any more.
  const tasks = st.load('tasks.json');
  const wait = jv(tasks, '', (j) => [joinJq(entriesOf(j)
    .filter((e) => {
      if (field(e, 'status') !== 'in_review') return false;
      const a = field(e, 'acceptance');
      return a === null ? true : field(a, 'accepted') !== true;
    })
    .map((e) => field(e, 'id')), ' ')])[0] ?? '';
  const sprints = st.load('sprints.json');
  const prop = jv(sprints, '', (j) => [joinJq(entriesOf(j)
    .filter((s) => field(s, 'status') === 'proposed')
    .map((s) => field(s, 'id')), ' ')])[0] ?? '';
  r.line(`awaiting User: tasks[${wait === '' ? 'none' : wait}] proposed-sprints[${prop === '' ? 'none' : prop}] (ratify/accept are theirs alone)`);

  const log = st.load('log.json');
  const decisions = st.load('decisions.json');
  // Recorded without authority and not yet acted on (D-S039). Printed only
  // when there are any, so a repo with none reads exactly as before.
  const proposedDecisions = jv(decisions, '', (j) => [joinJq(entriesOf(j)
    .filter((e) => standingOf(e).status === 'proposed' && standingOf(e).acknowledgedBy === '')
    .map((e) => field(e, 'id')), ' ')])[0] ?? '';
  if (proposedDecisions !== '') {
    r.line(`awaiting User: proposed-decisions[${proposedDecisions}] (recorded without authority — binding only once User ratifies)`);
  }
  r.line('recent log:');
  r.lines(jv(log, '  (none)', (j) => entriesOf(j).slice(-3)
    .map((e) => `  ${interp(field(e, 'id'))} ${interp(field(e, 'title'))}`)));
  r.line('recent decisions:');
  // Superseded decisions never load as context (T-0039, S-0026).
  r.lines(jv(decisions, '  (none)', (j) => {
    const es = entriesOf(j);
    // Only a binding decision retires another, and a rejected one is no
    // context at all; a proposed one is shown, marked (D-S039).
    const dead = es.map((e) => bindingSupersedes(e)).filter((s) => s !== null);
    return es.filter((e) => !dead.some((d) => d === field(e, 'id')) && standingOf(e).status !== 'rejected').slice(-2)
      .map((e) => `  ${interp(field(e, 'id'))} ${interp(field(e, 'title'))}${standingOf(e).status === 'proposed' ? ' [PROPOSED — not ratified]' : ''}`);
  }));

  const issues = st.load('issues.json');
  const nopen = jv(issues, '0', (j) => [String(entriesOf(j).filter((i) => field(i, 'status') === 'open').length)])[0] ?? '';
  const ids = jv(issues, '', (j) => {
    const open = entriesOf(j).filter((i) => field(i, 'status') === 'open').map((i) => field(i, 'id'));
    return [open.length === 0 ? '' : ` (${joinJq(open, ' ')})`];
  })[0] ?? '';
  r.line(`open issues: ${nopen}${ids}`);

  r.line('next: state the active sprint before touching code (minimum-planning-requirements); no ratified sprint -> session-open skill; implementing -> implement-sop; closing -> session-review. Details: session-start skill.');
}

/**
 * The planning report is the two sections plus its own header — ONE function
 * so the capture has one thing to run, rather than four capture calls whose
 * outputs would each land under their own `.data.lines`.
 */
function statusPlanning(st: State, today: string): void {
  st.report.line(`=== PLANNING STATUS (${today}) — generated by scrumux status planning ===`);
  st.report.line('');
  sectionSprint(st, today);
  st.report.line('');
  sectionSweep(st, today);
}

/**
 * T-0144: refusing to PLAN while a sprint is in flight is a workflow opinion,
 * not a safety property — and it is User's call, not a script's.
 * One definition, called from both `sprint` and `planning`; it was written out
 * twice, identically, in the old dispatch block.
 */
function tellUnfinished(cli: Cli, st: State): void {
  if (st.unfinished <= 0) return;
  cli.tell('sprint-in-flight', `${st.ratified} has ${st.unfinished} unfinished task(s) — working that sprint is usually right, but planning alongside it is User's call (D-0004 was a gate; T-0144 made it advice).`);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    // The argv check comes FIRST, before the verb is recognised: `status
    // bogus extra` refuses on the surplus argument and names the verb it
    // was given, not on the unknown verb.
    if (args.length > 0) cli.dieUsage(`status ${verb} takes no arguments`);

    const report = new Report(cli.json, ctx.io);
    const st = new State(ctx.roots.gov, report);

    switch (verb) {
      case 'session': sectionSession(st, ctx.today, ctx.roots.workRoot); break;
      case 'sprint': sectionSprint(st, ctx.today); break;
      case 'sweep': sectionSweep(st, ctx.today); break;
      case 'planning': statusPlanning(st, ctx.today); break;
      default:
        return cli.dieUsage(`unknown verb '${verb}' for noun status — verbs: session, planning, sprint, sweep. See: scrumux help status`);
    }
    if (verb === 'sprint' || verb === 'planning') tellUnfinished(cli, st);
    if (cli.json) cli.data({ lines: report.dataLines() as unknown as JsonValue });
    return cli.emit('');
  },
};
