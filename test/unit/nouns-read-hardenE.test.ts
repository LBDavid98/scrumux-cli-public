/**
 * Unit cover for the READ verbs -- `status`, `backlog`, and the refusal and
 * branch surfaces of `rank`, `issue`, `health`, `session` and `views-render`
 * that no fixture reaches.
 *
 * WHY THIS FILE EXISTS, given that the differential harness already compares
 * every one of these against `.deploy-claude/scripts/lib/cmd-*.sh` byte for
 * byte.
 *
 * A READ VERB'S OUTPUT IS ITS ENTIRE PRODUCT (Article 5). `status session` is
 * wired to the SessionStart hook and is the first thing an agent reads in a
 * session; `status sprint` and `backlog tasks` are what a planning session
 * decides from. There is no post-state to compare and no id to check -- the
 * PROSE is the contract, so the prose is asserted here as an ABSOLUTE, whole
 * report at a time, rather than only as "the same bytes bash produced".
 *
 * FIVE CLASSES OF BEHAVIOUR A DIFFERENTIAL FIXTURE CANNOT REACH, and this
 * file is built out of them:
 *
 *   1. THE JOURNAL STATES A CORPUS DOES NOT CONTAIN. A repo with zero
 *      journals, a repo whose `tasks.json` does not parse, a task title
 *      carrying a NEWLINE, two entries sharing one id, an epic whose
 *      `features` is `null`. Every one of those is a real journal state
 *      (T-0204, CLI-14, I-0102) and none of them is a state any command can
 *      WRITE -- so the corpus, which is built by running commands, cannot
 *      hold one. They are hand-built here.
 *
 *   2. THE FOUR PROPERTIES `src/nouns/status.ts` NAMES AS "DO NOT IMPROVE".
 *      The uncapped brief with its per-line `^SP-|^  T-` filter (I-0122 plus
 *      T-0204), the wrong-SHAPE journal that reports silently wrong at exit 0,
 *      the candidate list that excludes PROPOSED sprints as well as ratified
 *      ones (T-0094/I-0039), and the git line that is simply ABSENT outside a
 *      repository. A property whose only defence is a source comment is a
 *      property the next simplification pass removes; each is pinned below.
 *
 *   3. THE TWO DISPOSITIONS OF ONE FACT (PHILOSOPHY.md P-16). An unreadable
 *      journal is printed INTO the report by `status`, once per FILE, at exit
 *      0 -- and REFUSES at exit 2 in `backlog`, after the header line has
 *      already been written. Both halves run here, in the same file, because
 *      the pair is the ruling and either half alone reads like an accident.
 *
 *   4. THE `--json` SWALLOW, which is the LOSSIER mode (P-53). `backlog`'s
 *      refusal fires inside `capture_report`'s redirect, so stdout AND stderr
 *      are empty and only the exit code survives. That is measured bash
 *      behaviour reproduced on purpose; a port that "fixed" it would pass
 *      every differential case it has, because no fixture asks for a corrupt
 *      journal under `--json`.
 *
 *   5. THE REFUSAL PARAGRAPHS. `rank`, `issue` and `health` refuse in ways
 *      that name the command an operator runs next. A fixture pins one shape
 *      per case and the corpus cannot afford forty; they are asserted here as
 *      exact strings so a message that loses its repair path goes red without
 *      needing a second implementation to disagree with.
 *
 * NOTHING HERE MAY BE "FIXED". Several shapes below are deliberate and are
 * flagged as such in the source: a duplicate id repeating a brief line rather
 * than being deduped (CLI-14), `pending:` counting non-empty LINES rather than
 * jq outputs so one issue with a newline in its summary counts twice, an
 * out-of-range rank CLAMPING instead of refusing (OQ-DN3, unruled), and
 * `health`'s refusal saying "see: scrumux help" where every sibling noun names
 * itself. They are pinned AS THEY ARE; a change that repairs one must change
 * these assertions on purpose, with a ruling.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { RawNumber } from '../../src/journal/jqformat.js';
import { cmp, interp } from '../../src/nouns/lib/jqlike.js';
import { nounContext, todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as backlog } from '../../src/nouns/backlog.js';
import { MODULE as health } from '../../src/nouns/health.js';
import { MODULE as issue } from '../../src/nouns/issue.js';
import { MODULE as rank } from '../../src/nouns/rank.js';
import { MODULE as session } from '../../src/nouns/session.js';
import { MODULE as status } from '../../src/nouns/status.js';
import { renderViews } from '../../src/nouns/views-render.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
/** A REAL, EXECUTABLE bash CLI. `renderViews` gates its graph rebuild on
 *  `[ -x $SCRIPTS/scrumux ]` and nothing spawns it any more (Wave 5I), so this
 *  only has to EXIST with the execute bit to take the rebuilding arm. */
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');

/** `date +%F`, captured once, exactly as `lib.sh:99` captures it per run. */
const TODAY = todayStamp();

/** `jq`-ish pretty JSON with the trailing newline a journal file carries. */
const J = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scrumux-readE-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}

/** Write a journal (or any bytes, when handed a string) under `governance/`. */
function put(root: string, name: string, v: unknown): void {
  writeFileSync(join(root, 'governance', name), typeof v === 'string' ? v : J(v));
}

/** `{entries: [...]}` -- the shape every journal in this repo has. */
const entries = (...es: unknown[]): unknown => ({ entries: es });

function ctxFor(root: string, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: TODAY,
    io: captureIo(),
    scriptsDir: SCRIPTS,
    env: {},
    cwd: root,
    ...over,
  };
}

interface Driven {
  io: CapturedIo;
  rc: number;
}

/**
 * The dispatcher's own call, minus the dispatcher. The command string is
 * `"<noun> <verb>"` because that is what `src/cli/dispatch.ts:187` builds, and
 * it is the string every refusal below is prefixed with on stderr -- asserting
 * `scrumux status session: error: ...` is only meaningful if the command name
 * matches production.
 */
function drive(mod: NounModule, ctx: DispatchContext, noun: string, verb: string, args: string[], json = false): Driven {
  const io = captureIo();
  const cli = new Cli(`${noun} ${verb}`, args, json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctx, io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

/** The parsed `--json` envelope. */
interface Envelope {
  command: string;
  ok: boolean;
  exit: number;
  summary: string;
  checks: Array<{ name: string; ok: boolean; tier: string; detail: string }>;
  data: { lines?: string[]; id?: string };
  error?: { kind: string; message: string };
}

function envelopeOf(io: CapturedIo): Envelope {
  return JSON.parse(io.stdout) as Envelope;
}

// ===================================================================
//  status session -- the orientation block, and it ALWAYS exits 0
// ===================================================================

const NEXT_LINE =
  'next: state the active sprint before touching code (minimum-planning-requirements);'
  + ' no ratified sprint -> session-open skill; implementing -> implement-sop;'
  + ' closing -> session-review. Details: session-start skill.';

const NO_SPRINT_VERDICT =
  'VERDICT: no ratified sprint in flight — clear to assemble one'
  + ' (scrumux sprint new --epic E-XXXX, then scrumux sprint add; User ratifies).';

const unfinishedVerdict = (n: number): string =>
  `VERDICT: a ratified sprint has ${n} unfinished task(s) — working that sprint is usually right,`
  + " but planning alongside it is User's call (D-0004 was a gate; T-0144 made it advice).";

describe('status session — the brief an agent reads before it does anything', () => {
  it('renders the whole brief from an EMPTY governance directory, at rc 0', () => {
    // A fresh deployment is the state this verb meets most often and the one
    // no corpus fixture is built in: every journal is absent, and every
    // section has to say so rather than say nothing.
    const root = scratch();
    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(rc).toBe(0);
    expect(io.stderr).toBe('');
    expect(io.stdout).toBe(
      [
        `=== SESSION BRIEF (${TODAY}) — generated by scrumux status session ===`,
        NO_SPRINT_VERDICT,
        'in_progress: none',
        'awaiting User: tasks[none] proposed-sprints[none] (ratify/accept are theirs alone)',
        'recent log:',
        '  (none)',
        'recent decisions:',
        '  (none)',
        'open issues: 0',
        NEXT_LINE,
        '',
      ].join('\n'),
    );
  });

  it('renders every section from a fully populated repo', () => {
    const root = scratch();
    put(root, 'sprints.json', entries(
      { id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001', 'T-0002'] },
      { id: 'SP-0002', status: 'proposed', epic: 'E-0002', tasks: ['T-0003'] },
      { id: 'SP-0003', status: 'complete', epic: 'E-0003', tasks: ['T-0009'] },
    ));
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'First task', status: 'in_progress' },
      { id: 'T-0002', title: 'Second task', status: 'accepted' },
      { id: 'T-0003', title: 'Third task', status: 'ready' },
      // D-0076/T-0187: what awaits User is an in_review task with NO
      // acceptance recorded on it...
      { id: 'T-0004', title: 'Fourth task', status: 'in_review' },
      // ...and one already accepted is NOT waiting, even while in_review.
      { id: 'T-0005', title: 'Fifth task', status: 'in_review', acceptance: { accepted: true } },
    ));
    put(root, 'log.json', entries(
      { id: 'L-0001', title: 'oldest' },
      { id: 'L-0002', title: 'second' },
      { id: 'L-0003', title: 'third' },
      { id: 'L-0004', title: 'newest' },
    ));
    put(root, 'decisions.json', entries(
      { id: 'D-0001', title: 'retired' },
      { id: 'D-0002', title: 'the replacement', supersedes: 'D-0001' },
      { id: 'D-0003', title: 'current' },
    ));
    put(root, 'issues.json', entries(
      { id: 'I-0001', status: 'open' },
      { id: 'I-0002', status: 'open' },
      { id: 'I-0003', status: 'resolved' },
    ));

    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      [
        `=== SESSION BRIEF (${TODAY}) — generated by scrumux status session ===`,
        unfinishedVerdict(1),
        // The brief's task list has NO SIZE CAP (I-0122) -- both sprints and
        // all three of their tasks are here, header lines included.
        'SP-0001 [ratified] epic E-0001:',
        '  T-0001 [in_progress] First task',
        '  T-0002 [accepted] Second task',
        'SP-0002 [proposed] epic E-0002:',
        '  T-0003 [ready] Third task',
        'in_progress: T-0001 First task',
        'awaiting User: tasks[T-0004] proposed-sprints[SP-0002] (ratify/accept are theirs alone)',
        'recent log:',
        '  L-0002 second',
        '  L-0003 third',
        '  L-0004 newest',
        'recent decisions:',
        // D-0001 is superseded and never loads as context (T-0039, S-0026).
        '  D-0002 the replacement',
        '  D-0003 current',
        'open issues: 2 (I-0001 I-0002)',
        NEXT_LINE,
        '',
      ].join('\n'),
    );
  });

  it('keeps a NEWLINE-carrying task title out of the brief (T-0204)', () => {
    // The `^SP-|^  T-` filter is not decoration. A title with a newline in it
    // emits a bare, unindented continuation line inside `$FLIGHT`, and only
    // the anchors keep it out. `status sprint`, which does not filter, still
    // shows it -- both halves are asserted so a "simplification" that drops
    // the filter cannot pass by changing only one of them.
    const root = scratch();
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001'] }));
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'headline\nSMUGGLED', status: 'ready' }));

    const brief = drive(status, ctxFor(root), 'status', 'session', []);
    expect(brief.io.stdout).toContain('  T-0001 [ready] headline\n');
    expect(brief.io.stdout).not.toContain('SMUGGLED');

    const sprint = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(sprint.io.stdout).toContain('  T-0001 [ready] headline\nSMUGGLED\n');
  });

  it('repeats the line for a DUPLICATE id rather than deduping it (CLI-14)', () => {
    // `$t[] | select(.id==$tid)` emits every match. A duplicate id is a real
    // journal state and the brief showing it twice is how an operator sees it.
    const root = scratch();
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001'] }));
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'the first copy', status: 'ready' },
      { id: 'T-0001', title: 'the second copy', status: 'blocked' },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(io.stdout).toContain('  T-0001 [ready] the first copy\n  T-0001 [blocked] the second copy\n');
    // Both copies are unfinished, so the verdict counts two.
    expect(io.stdout).toContain(unfinishedVerdict(2));
  });

  it('prints the unreadable-journal refusal ONCE PER FILE, and still exits 0', () => {
    // `tasks.json` is opened by TWO loaders in this verb (`load_tasks` and the
    // awaiting-User projection). A journal read by two sections must not say
    // the same thing twice -- and a failure here would be a failure to START
    // WORK, so it never reaches the exit code (PHILOSOPHY.md P-02).
    const root = scratch();
    put(root, 'tasks.json', '{ this is not json');
    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(rc).toBe(0);
    expect(io.stderr).toBe('');
    const refusal =
      'scrumux status: error: governance/tasks.json is not valid JSON — restore it from git,'
      + ' or repair it with scrumux repair journal tasks.json\n'
      + '  the section(s) below that read it are EMPTY because it could not be read,'
      + ' not because there is nothing in it.\n';
    expect(io.stdout).toContain(refusal);
    expect(io.stdout.split('scrumux status: error:').length - 1).toBe(1);
    // The sections that read it render their EMPTY default, not a lie about
    // there being nothing in them.
    expect(io.stdout).toContain('in_progress: none\n');
    expect(io.stdout).toContain('awaiting User: tasks[none] proposed-sprints[none]');
  });

  it('names each unreadable journal separately when there are several', () => {
    const root = scratch();
    put(root, 'tasks.json', 'nope');
    put(root, 'issues.json', 'also nope');
    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('repair it with scrumux repair journal tasks.json');
    expect(io.stdout).toContain('repair it with scrumux repair journal issues.json');
    expect(io.stdout.split('scrumux status: error:').length - 1).toBe(2);
    // A journal that could not be read contributes NO open issues, and the
    // count renders as the section's default rather than as a refusal.
    expect(io.stdout).toContain('open issues: 0\n');
  });

  it('reports silently wrong at exit 0 when a journal PARSES but has the wrong shape', () => {
    // Open question 1 of the brief, REPRODUCED not closed: `read_journal` asks
    // "is this JSON at all", never "does it have .entries". A port that
    // validated the shape would invent a refusal this system does not raise.
    const root = scratch();
    put(root, 'tasks.json', { entries: 'not an array' });
    put(root, 'issues.json', { but_no_entries_key: true });
    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(rc).toBe(0);
    expect(io.stdout).not.toContain('error:');
    expect(io.stdout).toContain('in_progress: none\n');
    expect(io.stdout).toContain('open issues: 0\n');
  });

  it('prints the git position, with [DIRTY TREE], from inside a repository', () => {
    const root = scratch();
    writeFileSync(join(root, 'README.md'), 'read me\n');
    spawnSync('git', ['init', '-q', '.'], { cwd: root });
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'the subject line'], { cwd: root });
    const head = spawnSync('git', ['log', '-1', '--format=%h %s'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    const clean = drive(status, ctxFor(root), 'status', 'session', []);
    expect(clean.io.stdout).toContain(`\ncommit: ${head}\n`);
    expect(clean.io.stdout).not.toContain('[DIRTY TREE]');

    writeFileSync(join(root, 'stray.txt'), 'untracked\n');
    const dirty = drive(status, ctxFor(root), 'status', 'session', []);
    expect(dirty.io.stdout).toContain(`\ncommit: ${head} [DIRTY TREE]\n`);
  });

  it('OMITS the git line entirely outside a repository — no else, no placeholder', () => {
    // Open question 2: adding "(not a git repository)" is an observable change
    // with no ruling behind it.
    const root = scratch();
    const { io } = drive(status, ctxFor(root), 'status', 'session', []);
    expect(io.stdout).not.toContain('commit:');
    expect(io.stdout).not.toContain('git');
    expect(io.stdout.split('\n')[1]).toBe(NO_SPRINT_VERDICT);
  });

  it('reads git from WORK_ROOT, not from ROOT — the records may be elsewhere', () => {
    // A dispatched session's code is in its worktree while its records sit on
    // main. Collapsing the two roots here would report the wrong commit in the
    // one line an operator uses to place the session.
    const records = scratch();
    const work = scratch();
    writeFileSync(join(work, 'code.js'), 'export const x = 1;\n');
    spawnSync('git', ['init', '-q', '.'], { cwd: work });
    spawnSync('git', ['add', '-A'], { cwd: work });
    spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'work tree'], { cwd: work });
    const head = spawnSync('git', ['log', '-1', '--format=%h %s'], { cwd: work, encoding: 'utf8' }).stdout.trim();

    const ctx = ctxFor(records);
    ctx.roots.workRoot = work;
    const { io } = drive(status, ctx, 'status', 'session', []);
    expect(io.stdout).toContain(`\ncommit: ${head}\n`);
  });

  it('under --json files every line under .data.lines and drops the blanks', () => {
    const root = scratch();
    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', [], true);
    expect(rc).toBe(0);
    const env = envelopeOf(io);
    expect(env.command).toBe('status session');
    expect(env.ok).toBe(true);
    // status session raises NO row at all: nothing it does can move the
    // verdict, which is the mechanical half of "ALWAYS exits 0".
    expect(env.checks).toEqual([]);
    expect(env.data.lines?.[0]).toBe(`=== SESSION BRIEF (${TODAY}) — generated by scrumux status session ===`);
    expect(env.data.lines?.at(-1)).toBe(NEXT_LINE);
    expect(env.data.lines).not.toContain('');
  });

  it('refuses SURPLUS ARGV at exit 2 — "could not run", not "the records said no"', () => {
    const root = scratch();
    const { io, rc } = drive(status, ctxFor(root), 'status', 'session', ['extra']);
    expect(rc).toBe(2);
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('scrumux status session: error: status session takes no arguments\n');
  });
});

// ===================================================================
//  status sprint
// ===================================================================

describe('status sprint — the five sections and their empty states', () => {
  it('says what is absent, section by section, in an empty repo', () => {
    const root = scratch();
    const { io, rc } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      [
        `=== SPRINT STATUS (${TODAY}) ===`,
        '',
        '--- Sprints in flight ---',
        '(no sprints.json yet — first sprint: scrumux sprint new --epic E-XXXX)',
        '',
        '--- Epic coverage (epic -> features -> stories -> tasks) ---',
        '(no design.json — design gate first: scrumux feature new / scrumux story new)',
        '',
        '--- Backlog tasks not sprint-ready ---',
        '(no tasks.json)',
        '',
        '--- Open issues ---',
        '(no issues.json)',
        '',
        '--- Candidates for next sprint (dependency-ordered by feature) ---',
        '',
        NO_SPRINT_VERDICT,
        '',
      ].join('\n'),
    );
  });

  it('distinguishes "no sprints.json" from "a sprints.json with nothing live in it"', () => {
    const root = scratch();
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'complete', epic: 'E-0001', tasks: [] }));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain('--- Sprints in flight ---\n(none proposed or ratified)\n');
  });

  it('heads a HOTFIX sprint with its source issue instead of an epic', () => {
    const root = scratch();
    put(root, 'sprints.json', entries(
      { id: 'SP-0007', status: 'ratified', hotfix: true, source_issue: 'I-0042', epic: 'E-0001', tasks: [] },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain('SP-0007 [ratified] HOTFIX from I-0042:\n');
    expect(io.stdout).not.toContain('epic E-0001:');
  });

  it('renders the epic coverage map, the NO STORIES / NO TASKS hints and the orphans', () => {
    const root = scratch();
    put(root, 'design.json', entries(
      { id: 'E-0001', kind: 'epic', name: 'Core', features: ['F-0001', 'F-0002'] },
      // `[(.epics // [])[].features // []] | flatten` is the STREAM form of
      // `//`: an epic whose `features` is null contributes NOTHING rather than
      // an empty list, so F-0003 below stays an orphan.
      { id: 'E-0002', kind: 'epic', name: 'Empty', features: null },
      { id: 'F-0001', kind: 'feature', name: 'Alpha', stories: ['S-0001'] },
      { id: 'F-0002', kind: 'feature', name: 'Beta', stories: [] },
      { id: 'F-0003', kind: 'feature', name: 'Orphan', stories: ['S-0002'] },
    ));
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'a', status: 'ready', feature: 'F-0001', story: 'S-0001', task_order: {} },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain(
      [
        'E-0001 Core:',
        '  F-0001 Alpha: stories=1 tasks=1',
        '  F-0002 Beta: stories=0 tasks=0  <- NO STORIES: scrumux story new --feature F-0002 ...  <- NO TASKS',
        'E-0002 Empty:',
        '',
        'Features not in any epic:',
        '  F-0003 Orphan  <- assign: scrumux epic new --name ... --desc ...'
        + ' --feature F-0003 (or extend an epic later)',
        '',
      ].join('\n'),
    );
  });

  it('says "(none)" when every feature belongs to an epic', () => {
    const root = scratch();
    put(root, 'design.json', entries(
      { id: 'E-0001', kind: 'epic', name: 'Core', features: ['F-0001'] },
      { id: 'F-0001', kind: 'feature', name: 'Alpha', stories: ['S-0001'] },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain('Features not in any epic:\n  (none)\n');
  });

  it('names the exact missing half of a task that is not sprint-ready', () => {
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'ready enough', status: 'ready', story: 'S-0001', task_order: {} },
      { id: 'T-0002', title: 'neither', status: 'ready' },
      { id: 'T-0003', title: 'no story', status: 'proposed', task_order: {} },
      { id: 'T-0004', title: 'no order', status: 'ready', story: 'S-0001' },
      // Only proposed/ready are candidates for this section at all.
      { id: 'T-0005', title: 'in flight', status: 'in_progress' },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain(
      [
        '--- Backlog tasks not sprint-ready ---',
        '  T-0002 neither  MISSING story (scrumux task order T-0002 --story S-XXXX ...)'
        + '  MISSING order (scrumux task order T-0002 --scope ... --verify ... --file "path | why")',
        '  T-0003 no story  MISSING story (scrumux task order T-0003 --story S-XXXX ...)',
        '  T-0004 no order  MISSING order (scrumux task order T-0004 --scope ... --verify ...'
        + ' --file "path | why")',
        '',
      ].join('\n'),
    );
    expect(io.stdout).not.toContain('T-0005');
  });

  it('says so when every proposed/ready task has its story and its order', () => {
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'ready enough', status: 'ready', story: 'S-0001', task_order: {} },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain(
      '--- Backlog tasks not sprint-ready ---\n  (all proposed/ready tasks have story + task order)\n',
    );
  });

  it('splits the open-issue guidance by TYPE: idea goes to backlog, everything else to the hotfix lane', () => {
    const root = scratch();
    put(root, 'issues.json', entries(
      { id: 'I-0001', status: 'open', type: 'defect', severity: 'high', summary: 'it broke' },
      { id: 'I-0002', status: 'open', type: 'idea', summary: 'it could be nicer' },
      { id: 'I-0003', status: 'resolved', type: 'defect', severity: 'low', summary: 'was fixed' },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain(
      [
        '--- Open issues ---',
        '  I-0001 [defect/high] it broke',
        '      hotfix lane if urgent: scrumux sprint new --hotfix --issue I-0001',
        // An absent severity reads `unrated` HERE and `unset` in the sweep --
        // two words for one state, in two reports, and both are surface.
        '  I-0002 [idea/unrated] it could be nicer',
        '      feature-request shaped -> backlog process (scrumux feature + scrumux story), not promotion',
        '',
      ].join('\n'),
    );
    expect(io.stdout).not.toContain('I-0003');
  });

  it('says "(none open)" for an issues.json with nothing open in it', () => {
    const root = scratch();
    put(root, 'issues.json', entries({ id: 'I-0001', status: 'resolved', type: 'defect', summary: 'done' }));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain('--- Open issues ---\n  (none open)\n');
  });

  it('orders candidates dependency-free-first and excludes tasks a PROPOSED sprint holds (T-0094/I-0039)', () => {
    // Narrowing the exclusion to "ratified" reads like a cleanup and re-creates
    // duplicate "READY: scrumux sprint add" hints for work already committed.
    const root = scratch();
    put(root, 'design.json', entries(
      { id: 'F-0001', kind: 'feature', name: 'Alpha', stories: ['S-0001'], dependencies: [] },
      { id: 'F-0002', kind: 'feature', name: 'Beta', stories: [], dependencies: ['F-0001'] },
    ));
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'held by a proposed sprint', status: 'ready', feature: 'F-0001', story: 'S-0001', task_order: {} },
      { id: 'T-0002', title: 'free and ready', status: 'ready', feature: 'F-0001', story: 'S-0001', task_order: {} },
      { id: 'T-0003', title: 'free but unordered', status: 'proposed', feature: 'F-0002' },
      { id: 'T-0004', title: 'already accepted', status: 'accepted', feature: 'F-0001' },
    ));
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'proposed', epic: 'E-0001', tasks: ['T-0001'] }));

    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain(
      [
        '--- Candidates for next sprint (dependency-ordered by feature) ---',
        'F-0001 Alpha:',
        '  T-0002 free and ready  [READY: scrumux sprint add SP-XXXX T-0002]',
        'F-0002 Beta (after F-0001):',
        '  T-0003 free but unordered  [not ready — see section above]',
        '',
      ].join('\n'),
    );
    expect(io.stdout).not.toContain('T-0001 held by a proposed sprint  [READY');
    expect(io.stdout).not.toContain('T-0004');
  });

  it('raises the sprint-in-flight TELL as an ADVISORY — it prints, and it never moves the verdict', () => {
    // T-0144 turned D-0004's gate into advice: refusing to plan while a sprint
    // is in flight is a workflow opinion and it is User's call.
    const root = scratch();
    put(root, 'sprints.json', entries(
      { id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001'] },
      { id: 'SP-0002', status: 'ratified', epic: 'E-0002', tasks: ['T-0002'] },
    ));
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'a', status: 'ready' },
      { id: 'T-0002', title: 'b', status: 'in_progress' },
    ));
    const human = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(human.rc).toBe(0);
    // The TELL names EVERY ratified sprint, joined -- it used to interpolate a
    // variable nothing assigned, and rendered with the id missing.
    expect(human.io.stdout).toContain(
      '  TELL sprint-in-flight         SP-0001, SP-0002 has 2 unfinished task(s) —',
    );

    const json = drive(status, ctxFor(root), 'status', 'sprint', [], true);
    const env = envelopeOf(json.io);
    expect(json.rc).toBe(0);
    expect(env.ok).toBe(true);
    expect(env.checks).toEqual([
      {
        name: 'sprint-in-flight',
        ok: true,
        tier: 'tell',
        detail:
          'SP-0001, SP-0002 has 2 unfinished task(s) — working that sprint is usually right,'
          + " but planning alongside it is User's call (D-0004 was a gate; T-0144 made it advice).",
      },
    ]);
  });

  it('falls back to "the ratified sprint" when only a PROPOSED sprint is unfinished', () => {
    // No ratified sprint means no unfinished count, so the TELL never fires --
    // the fallback string is reachable only through the verdict line.
    const root = scratch();
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'proposed', epic: 'E-0001', tasks: ['T-0001'] }));
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    const { io } = drive(status, ctxFor(root), 'status', 'sprint', []);
    expect(io.stdout).toContain(NO_SPRINT_VERDICT);
    expect(io.stdout).not.toContain('TELL');
  });
});

// ===================================================================
//  status sweep
// ===================================================================

describe('status sweep — the issues nobody has ruled on', () => {
  it('reports zero, and names the absent journal, in an empty repo', () => {
    const root = scratch();
    const { io, rc } = drive(status, ctxFor(root), 'status', 'sweep', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      `=== ISSUES PENDING VALIDATION (${TODAY}) — rule on these before planning (T-0042) ===\n`
      + 'pending: 0 (no issues.json)\n',
    );
  });

  it('excludes AUTHORIZED-but-unvalidated issues — authorization is its own gate-pass (T-0189)', () => {
    const root = scratch();
    put(root, 'issues.json', entries(
      { id: 'I-0001', status: 'open', severity: 'high', summary: 'pending, rated' },
      { id: 'I-0002', status: 'open', summary: 'pending, unrated' },
      { id: 'I-0003', status: 'open', summary: 'ruled on', validation: { verdict: 'reproduced' } },
      { id: 'I-0004', status: 'open', summary: 'authorized', authorization: { by: 'User' } },
      { id: 'I-0005', status: 'resolved', summary: 'closed' },
    ));
    const { io, rc } = drive(status, ctxFor(root), 'status', 'sweep', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      [
        `=== ISSUES PENDING VALIDATION (${TODAY}) — rule on these before planning (T-0042) ===`,
        'I-0001 high pending, rated',
        'I-0002 unset pending, unrated',
        'pending: 2 — dispatch the issue-validator agent per issue;'
        + ' record verdicts via scrumux issue validate',
        '',
      ].join('\n'),
    );
  });

  it('truncates a summary at 100 CODEPOINTS, never at 100 UTF-16 units', () => {
    // The unit matters: an emoji at the boundary would otherwise be cut
    // through its surrogate pair and the report would carry half a character.
    const root = scratch();
    const summary = '😀'.repeat(120);
    put(root, 'issues.json', entries({ id: 'I-0001', status: 'open', summary }));
    const { io } = drive(status, ctxFor(root), 'status', 'sweep', []);
    expect(io.stdout).toContain(`I-0001 unset ${'😀'.repeat(100)}\n`);
    expect(io.stdout).not.toContain('😀'.repeat(101));
    // A UTF-16 slice would have stopped at 50 whole emoji plus half of the
    // 51st, so the two units are distinguishable by this fixture alone.
    expect(summary.slice(0, 100)).toBe('😀'.repeat(50));
  });

  it('counts NON-EMPTY LINES, so one issue whose summary carries a newline counts twice', () => {
    // `COUNT=$(printf '%s' "$LIST" | grep -c .)` counts lines of the joined
    // text, which is not the number of jq outputs. Reproduced, not repaired:
    // the count is what an operator sees and changing it is a surface change.
    const root = scratch();
    put(root, 'issues.json', entries(
      { id: 'I-0001', status: 'open', summary: 'single line' },
      { id: 'I-0002', status: 'open', summary: 'first\nsecond' },
    ));
    const { io } = drive(status, ctxFor(root), 'status', 'sweep', []);
    expect(io.stdout).toContain('I-0002 unset first\nsecond\n');
    expect(io.stdout).toContain('pending: 3 — dispatch');
  });

  it('reports zero WITHOUT the dispatch clause when the journal exists and nothing is pending', () => {
    const root = scratch();
    put(root, 'issues.json', entries({ id: 'I-0001', status: 'resolved', summary: 'done' }));
    const { io } = drive(status, ctxFor(root), 'status', 'sweep', []);
    expect(io.stdout).toBe(
      `=== ISSUES PENDING VALIDATION (${TODAY}) — rule on these before planning (T-0042) ===\n`
      + 'pending: 0\n',
    );
  });

  it('prints the refusal into the report and reports zero for an unreadable issues.json', () => {
    const root = scratch();
    put(root, 'issues.json', '}{');
    const { io, rc } = drive(status, ctxFor(root), 'status', 'sweep', []);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('scrumux status: error: governance/issues.json is not valid JSON');
    expect(io.stdout).toContain('pending: 0 (no issues.json)\n');
  });
});

// ===================================================================
//  status planning, and the dispatch surface
// ===================================================================

describe('status planning and the verb surface', () => {
  it('is the two reports plus its own header, in one capture', () => {
    const root = scratch();
    const { io, rc } = drive(status, ctxFor(root), 'status', 'planning', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      [
        `=== PLANNING STATUS (${TODAY}) — generated by scrumux status planning ===`,
        '',
        `=== SPRINT STATUS (${TODAY}) ===`,
        '',
        '--- Sprints in flight ---',
        '(no sprints.json yet — first sprint: scrumux sprint new --epic E-XXXX)',
        '',
        '--- Epic coverage (epic -> features -> stories -> tasks) ---',
        '(no design.json — design gate first: scrumux feature new / scrumux story new)',
        '',
        '--- Backlog tasks not sprint-ready ---',
        '(no tasks.json)',
        '',
        '--- Open issues ---',
        '(no issues.json)',
        '',
        '--- Candidates for next sprint (dependency-ordered by feature) ---',
        '',
        NO_SPRINT_VERDICT,
        '',
        `=== ISSUES PENDING VALIDATION (${TODAY}) — rule on these before planning (T-0042) ===`,
        'pending: 0 (no issues.json)',
        '',
      ].join('\n'),
    );
  });

  it('carries the sprint-in-flight TELL too — one definition, two callers (T-0144)', () => {
    const root = scratch();
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001'] }));
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    const { io } = drive(status, ctxFor(root), 'status', 'planning', [], true);
    const env = envelopeOf(io);
    expect(env.checks.map((c) => c.name)).toEqual(['sprint-in-flight']);
    expect(env.checks[0]!.detail.startsWith('SP-0001 has 1 unfinished task(s) —')).toBe(true);
  });

  it('does NOT raise the TELL for sweep or session, which have no planning opinion', () => {
    const root = scratch();
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001'] }));
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    for (const verb of ['sweep', 'session']) {
      const { io } = drive(status, ctxFor(root), 'status', verb, [], true);
      expect(envelopeOf(io).checks).toEqual([]);
    }
  });

  it('checks SURPLUS ARGV before it recognises the verb — bogus + extra refuses on the argument', () => {
    // `status bogus extra` names the verb it was given rather than reporting an
    // unknown verb. That ordering is bash's and it is reproduced exactly.
    const root = scratch();
    const surplus = drive(status, ctxFor(root), 'status', 'bogus', ['extra']);
    expect(surplus.rc).toBe(2);
    expect(surplus.io.stderr).toBe('scrumux status bogus: error: status bogus takes no arguments\n');

    const unknown = drive(status, ctxFor(root), 'status', 'bogus', []);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(
      "scrumux status bogus: error: unknown verb 'bogus' for noun status —"
      + ' verbs: session, planning, sprint, sweep. See: scrumux help status\n',
    );
  });

  it('publishes its verb table and a usage block', () => {
    expect(status.verbs()).toBe(
      'session\tthe orientation block; ALWAYS exits 0\n'
      + 'planning\tsprint report + decision queue + validation sweep\n'
      + 'sprint\tthe sprint report alone\n'
      + 'sweep\tthe validation sweep alone\n',
    );
    expect(status.usage()).toContain('scrumux status');
  });
});

// ===================================================================
//  backlog -- the OTHER disposition of an unreadable journal
// ===================================================================

describe('backlog tasks', () => {
  it('names the absent journal rather than claiming there is no work', () => {
    const root = scratch();
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      `=== BACKLOG (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <#|T-XXXX> <new-#> ===\n`
      + '(no tasks.json — nothing to rank)\n',
    );
  });

  it('says "(no open tasks)" only when the journal was READ and held none', () => {
    const root = scratch();
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'done', status: 'accepted' }));
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('\n(no open tasks)\n');
  });

  it('numbers the ranked, bullets the never-ranked, and counts the split', () => {
    // Ranked means someone deliberately set a priority. An absent rank is NO
    // DECISION, so it is listed WITHOUT a number and under its own banner.
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'First', status: 'ready', feature: 'F-0001', story: 'S-0001', rank: 2 },
      { id: 'T-0002', title: 'Second', status: 'proposed', rank: 1 },
      { id: 'T-0005', title: 'Fifth', status: 'ready', feature: 'F-0002' },
      { id: 'T-0003', title: 'Never ranked', status: 'blocked' },
      { id: 'T-0004', title: 'retired', status: 'superseded' },
      { id: 'T-0006', title: 'signed off', status: 'accepted' },
    ));
    put(root, 'sprints.json', entries(
      { id: 'SP-0001', status: 'ratified', tasks: ['T-0001'] },
      // A task committed to a sprint that is no longer LIVE carries no marker.
      { id: 'SP-0002', status: 'complete', tasks: ['T-0002'] },
    ));
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      [
        `=== BACKLOG (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <#|T-XXXX> <new-#> ===`,
        '1. T-0002 [proposed] Second',
        '2. T-0001 [ready] First  (F-0001/S-0001)  [SP-0001 ratified]',
        '',
        '--- Never ranked (2) — no priority set. Place one: scrumux rank set <T-XXXX> <#> ---',
        '- T-0003 [blocked] Never ranked',
        '- T-0005 [ready] Fifth  (F-0002)',
        '',
      ].join('\n'),
    );
  });

  it('sorts ranks NUMERICALLY, which is the bug a second jq helper once reintroduced', () => {
    // Ranks 1, 2 and 10 sort 1, 2, 10 in jq and sorted 1, 10, 2 through a
    // helper that had never heard of RawNumber -- `backlog tasks` reordered
    // its own priority list the moment a tenth item was ranked.
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0010', title: 'tenth', status: 'ready', rank: 10 },
      { id: 'T-0002', title: 'second', status: 'ready', rank: 2 },
      { id: 'T-0001', title: 'first', status: 'ready', rank: 1 },
    ));
    const { io } = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    expect(io.stdout).toContain(
      '1. T-0001 [ready] first\n2. T-0002 [ready] second\n3. T-0010 [ready] tenth\n',
    );
  });

  it('truncates the description at 150 codepoints by default and prints it whole under --full', () => {
    // The description is where the ranking rationale lives (I-0048), so it is
    // truncated rather than dropped, and the flag that shows it is NAMED in
    // the truncation itself.
    const root = scratch();
    const long = 'x'.repeat(140) + '\nand a second line that pushes it past the cap';
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'long', status: 'ready', rank: 1, description: long },
      { id: 'T-0002', title: 'short', status: 'ready', rank: 2, description: 'brief\nrationale' },
      { id: 'T-0003', title: 'none', status: 'ready', rank: 3, description: '' },
    ));

    const plain = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    const flat = long.replace(/\n/g, ' ');
    expect(plain.io.stdout).toContain(`     ${flat.slice(0, 150)}…  (scrumux backlog tasks --full)\n`);
    expect(plain.io.stdout).toContain('     brief rationale\n');
    // An empty description contributes NO continuation line at all.
    expect(plain.io.stdout).toContain('3. T-0003 [ready] none\n');
    expect(plain.io.stdout.split('\n').filter((l) => l.startsWith('     '))).toHaveLength(2);

    const full = drive(backlog, ctxFor(root), 'backlog', 'tasks', ['--full']);
    expect(full.io.stdout).toContain(`     ${flat}\n`);
    expect(full.io.stdout).not.toContain('(scrumux backlog tasks --full)');
  });

  it('REFUSES at exit 2 on an unreadable tasks.json, after the header is already out', () => {
    // The other disposition of the fact `status` prints into its report
    // (PHILOSOPHY.md P-16): backlog has no report to print a caveat into that
    // would not be a lie about the list's completeness, so it stops. Exit 2 is
    // "could not run", not "the assertion did not hold" (D-0085/OQ-16).
    const root = scratch();
    put(root, 'tasks.json', 'not json at all');
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    expect(rc).toBe(2);
    expect(io.stdout).toBe(
      `=== BACKLOG (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <#|T-XXXX> <new-#> ===\n`,
    );
    expect(io.stderr).toBe(
      'scrumux backlog tasks: error: governance/tasks.json is not valid JSON — restore it from git,'
      + ' or repair it with scrumux repair journal tasks.json\n',
    );
  });

  it('REFUSES on an unreadable sprints.json too — the third guard, which was the missing one', () => {
    // sprints.json is OPTIONAL, and optional means ABSENT, not unreadable: a
    // corrupt one slurped in unchecked tells the same lie the other two told
    // (I-0078/I-0083).
    const root = scratch();
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    put(root, 'sprints.json', '[[[');
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      'scrumux backlog tasks: error: governance/sprints.json is not valid JSON — restore it from git,'
      + ' or repair it with scrumux repair journal sprints.json\n',
    );
  });

  it('swallows the refusal ENTIRELY under --json: no stdout, no stderr, exit 2 (P-53)', () => {
    // Measured against bash and reproduced: the refusal fires inside
    // capture_report's redirect, so its envelope goes to a temp file nothing
    // reads and its stderr line to /dev/null. `--json` is the LOSSIER mode.
    const root = scratch();
    put(root, 'tasks.json', 'not json at all');
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', [], true);
    expect(rc).toBe(2);
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('');
  });

  it('swallows a BAD FLAG under --json the same way, because the loop is inside the capture', () => {
    const root = scratch();
    const silent = drive(backlog, ctxFor(root), 'backlog', 'tasks', ['--nope'], true);
    expect(silent.rc).toBe(2);
    expect(silent.io.stdout).toBe('');
    expect(silent.io.stderr).toBe('');

    const loud = drive(backlog, ctxFor(root), 'backlog', 'tasks', ['--nope']);
    expect(loud.rc).toBe(2);
    expect(loud.io.stderr).toBe(
      'scrumux backlog tasks: error: backlog: unknown flag --nope —'
      + ' usage: scrumux backlog tasks|features [--full]\n',
    );
    // The header was written through before the flag loop refused.
    expect(loud.io.stdout).toBe('');
  });

  it('files the report under .data.lines under --json, blank separator dropped', () => {
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', title: 'ranked', status: 'ready', rank: 1 },
      { id: 'T-0002', title: 'unranked', status: 'ready' },
    ));
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'tasks', [], true);
    expect(rc).toBe(0);
    const env = envelopeOf(io);
    expect(env.data.lines).toEqual([
      `=== BACKLOG (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <#|T-XXXX> <new-#> ===`,
      '1. T-0001 [ready] ranked',
      '--- Never ranked (1) — no priority set. Place one: scrumux rank set <T-XXXX> <#> ---',
      '- T-0002 [ready] unranked',
    ]);
  });
});

describe('backlog features — the other address space', () => {
  it('names the absent design journal', () => {
    const root = scratch();
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'features', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      `=== FEATURES (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <F-XXXX> <new-#> ===\n`
      + '(no design.json — nothing to rank)\n',
    );
  });

  it('says "(no features)" for a design journal that holds only epics', () => {
    const root = scratch();
    put(root, 'design.json', entries({ id: 'E-0001', kind: 'epic', name: 'Core', features: [] }));
    const { io } = drive(backlog, ctxFor(root), 'backlog', 'features', []);
    expect(io.stdout).toContain('\n(no features)\n');
  });

  it('attributes each feature to its epic and counts its OPEN tasks only', () => {
    const root = scratch();
    put(root, 'design.json', entries(
      { id: 'E-0001', kind: 'epic', name: 'Core', features: ['F-0001'] },
      { id: 'F-0001', kind: 'feature', name: 'Alpha', stories: ['S-0001', 'S-0002'], rank: 2 },
      { id: 'F-0002', kind: 'feature', name: 'Beta', stories: [], rank: 1, description: 'why it matters' },
      { id: 'F-0003', kind: 'feature', name: 'Gamma' },
    ));
    put(root, 'tasks.json', entries(
      { id: 'T-0001', feature: 'F-0001', status: 'ready' },
      { id: 'T-0002', feature: 'F-0001', status: 'accepted' },
      { id: 'T-0003', feature: 'F-0001', status: 'superseded' },
      { id: 'T-0004', feature: 'F-0002', status: 'in_progress' },
    ));
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'features', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      [
        `=== FEATURES (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <F-XXXX> <new-#> ===`,
        '1. F-0002 Beta  (unassigned)  stories=0 open-tasks=1',
        '     why it matters',
        '2. F-0001 Alpha  (E-0001)  stories=2 open-tasks=1',
        '',
        '--- Never ranked (1) — no priority set. Place one: scrumux rank set <F-XXXX> <#> ---',
        '- F-0003 Gamma  (unassigned)  stories=0 open-tasks=0',
        '',
      ].join('\n'),
    );
  });

  it('REFUSES on an unreadable design.json, and on an unreadable tasks.json in the SAME branch', () => {
    // The tasks read in the features branch was a bare `cat` once, so a
    // corrupt tasks.json reached the view and rendered as though the journal
    // were empty -- the I-0102 shape in the one branch that still read
    // unchecked.
    const bad = scratch();
    put(bad, 'design.json', '<<<');
    const d = drive(backlog, ctxFor(bad), 'backlog', 'features', []);
    expect(d.rc).toBe(2);
    expect(d.io.stderr).toContain('governance/design.json is not valid JSON');

    const half = scratch();
    put(half, 'design.json', entries({ id: 'F-0001', kind: 'feature', name: 'Alpha', stories: [] }));
    put(half, 'tasks.json', '<<<');
    const t = drive(backlog, ctxFor(half), 'backlog', 'features', []);
    expect(t.rc).toBe(2);
    expect(t.io.stderr).toContain('governance/tasks.json is not valid JSON');
    expect(t.io.stdout).toBe(
      `=== FEATURES (${TODAY}) — ranked = deliberate priority. Move: scrumux rank set <F-XXXX> <new-#> ===\n`,
    );
  });

  it('refuses an unknown verb by name', () => {
    const root = scratch();
    const { io, rc } = drive(backlog, ctxFor(root), 'backlog', 'items', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      "scrumux backlog items: error: unknown verb 'items' for noun backlog —"
      + ' verbs: tasks, features. See: scrumux help backlog\n',
    );
  });

  it('publishes its verb table', () => {
    expect(backlog.verbs()).toBe(
      'tasks\topen tasks in priority order\n'
      + 'features\tfeatures in priority order, their own address space\n',
    );
    expect(backlog.usage()).toContain('scrumux backlog');
  });
});

// ===================================================================
//  rank -- the refusals, and the FEATURE branch that exits early
// ===================================================================

/** The journal as it stands on disk, parsed. */
function journal(root: string, name: string): { entries: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(root, 'governance', name), 'utf8')) as {
    entries: Array<Record<string, unknown>>;
  };
}

describe('rank — the argv surface and its refusals', () => {
  it('refuses the wrong arity per verb, and an unknown verb by name', () => {
    const root = scratch();
    const one = drive(rank, ctxFor(root), 'rank', 'set', ['T-0001']);
    expect(one.rc).toBe(2);
    expect(one.io.stderr).toBe(
      'scrumux rank set: error: rank set takes <#|T-0001|F-0001> <new-#> —'
      + ' current numbering: scrumux backlog tasks\n',
    );

    const two = drive(rank, ctxFor(root), 'rank', 'clear', ['T-0001', '2']);
    expect(two.rc).toBe(2);
    expect(two.io.stderr).toBe('scrumux rank clear: error: rank clear takes one <#|T-0001|F-0001>\n');

    const bogus = drive(rank, ctxFor(root), 'rank', 'shuffle', []);
    expect(bogus.rc).toBe(2);
    expect(bogus.io.stderr).toBe(
      "scrumux rank shuffle: error: unknown verb 'shuffle' for noun rank —"
      + ' verbs: set, clear. See: scrumux help rank\n',
    );
  });

  it('refuses an EMPTY ref with the usage line each mode owns', () => {
    const root = scratch();
    const set = drive(rank, ctxFor(root), 'rank', 'set', ['', '1']);
    expect(set.rc).toBe(2);
    expect(set.io.stderr).toBe(
      'scrumux rank set: error: usage: scrumux rank set <#|T-0001> <new-#|--clear> —'
      + ' current numbering: .claude/scripts/scrumux backlog tasks\n',
    );

    const clear = drive(rank, ctxFor(root), 'rank', 'clear', ['']);
    expect(clear.rc).toBe(2);
    expect(clear.io.stderr).toBe(
      'scrumux rank clear: error: usage: scrumux rank set <#|T-0001> --clear —'
      + ' current numbering: .claude/scripts/scrumux backlog tasks\n',
    );
  });

  it('refuses a non-integer and a below-one position, in that order', () => {
    const root = scratch();
    const word = drive(rank, ctxFor(root), 'rank', 'set', ['T-0001', 'first']);
    expect(word.rc).toBe(2);
    expect(word.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: new-# must be a positive integer,'
      + ' or --clear to remove the rank\n',
    );

    const zero = drive(rank, ctxFor(root), 'rank', 'set', ['T-0001', '0']);
    expect(zero.rc).toBe(2);
    expect(zero.io.stderr).toBe('scrumux rank set: error: scrumux rank: new-# must be >= 1\n');
  });

  it('refuses before it looks at any journal — the argv checks come first', () => {
    // Both refusals above fire in a repo with no tasks.json and no design.json,
    // so a reordering that put the journal probe first would change WHICH
    // sentence an operator gets for a typo.
    const root = scratch();
    expect(drive(rank, ctxFor(root), 'rank', 'set', ['T-0001', 'x']).io.stderr)
      .toContain('new-# must be a positive integer');
  });
});

describe('rank over FEATURES — a disjoint address space that exits before the task guard', () => {
  const design = (): unknown => entries(
    { id: 'F-0001', kind: 'feature', name: 'Alpha', rank: 1 },
    { id: 'F-0002', kind: 'feature', name: 'Beta', rank: 2 },
    { id: 'F-0003', kind: 'feature', name: 'Gamma' },
    // The `kind` arm comes FIRST in the feature filter, so this entry is
    // untouched even though it shares an id with the feature being cleared.
    // That is the reason the feature and task filters are two functions.
    { id: 'F-0001', kind: 'epic', name: 'A shadow', rank: 9 },
  );

  it('ranks a feature in a repo that has NO tasks.json at all (dispatch-by-exit)', () => {
    // `emit` ends the process, so the unconditional `[ -f tasks.json ]` guard
    // that follows the case in bash is unreachable for a feature ref. Verified
    // against bash: rc 0, and the sentence names the new position.
    const root = scratch();
    put(root, 'design.json', design());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'set', ['F-0003', '1']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('F-0003 -> rank 1\n');
    expect(io.stderr).toBe('');
    const rows = journal(root, 'design.json').entries;
    expect(rows.map((r) => [r['id'], r['kind'], r['rank']])).toEqual([
      ['F-0001', 'feature', 2],
      ['F-0002', 'feature', 3],
      ['F-0003', 'feature', 1],
      ['F-0001', 'epic', 9],
    ]);
  });

  it('CLAMPS an out-of-range feature position rather than refusing (OQ-DN3, unruled)', () => {
    const root = scratch();
    put(root, 'design.json', design());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'set', ['F-0003', '999']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('F-0003 -> rank 3\n');
    expect(journal(root, 'design.json').entries.map((r) => r['rank'])).toEqual([1, 2, 3, 9]);
  });

  it('DELETES the rank key on clear — not null, not zero', () => {
    // `backlog` partitions on `rank == null` and the schema declares rank as an
    // integer with minimum 1, so only deletion is both correct and legal.
    const root = scratch();
    put(root, 'design.json', design());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'clear', ['F-0001']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('F-0001 -> rank cleared\n');
    const rows = journal(root, 'design.json').entries;
    expect(Object.prototype.hasOwnProperty.call(rows[0]!, 'rank')).toBe(false);
    expect(rows[1]!['rank']).toBe(1);
    // The shadow epic still carries the rank it always had.
    expect(rows[3]!['rank']).toBe(9);
  });

  it('refuses a feature ref with no design.json, an unknown feature, and a clear with nothing to clear', () => {
    const empty = scratch();
    const none = drive(rank, ctxFor(empty), 'rank', 'set', ['F-0001', '1']);
    expect(none.rc).toBe(2);
    expect(none.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: no design.json yet — nothing to rank\n',
    );

    const root = scratch();
    put(root, 'design.json', design());
    const missing = drive(rank, ctxFor(root), 'rank', 'set', ['F-0009', '1']);
    expect(missing.rc).toBe(2);
    expect(missing.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: feature F-0009 not found in design.json —'
      + ' list them: .claude/scripts/scrumux backlog tasks --features\n',
    );

    const unranked = drive(rank, ctxFor(root), 'rank', 'clear', ['F-0003']);
    expect(unranked.rc).toBe(2);
    expect(unranked.io.stderr).toBe(
      'scrumux rank clear: error: scrumux rank: F-0003 has no rank to clear —'
      + ' it is already unprioritised: .claude/scripts/scrumux backlog tasks --features\n',
    );
    // Nothing was written by any of the three.
    expect(journal(root, 'design.json').entries.map((r) => r['rank'])).toEqual([1, 2, undefined, 9]);
  });
});

describe('rank over TASKS — the list-# address, and the arms the feature filter inverts', () => {
  const tasks = (): unknown => entries(
    { id: 'T-0001', title: 'first', status: 'ready', rank: 1 },
    { id: 'T-0002', title: 'second', status: 'ready', rank: 2 },
    { id: 'T-0003', title: 'never ranked', status: 'proposed' },
    // An ACCEPTED task is skipped by the task filter's status arm and keeps
    // whatever rank it was carrying when it was signed off.
    { id: 'T-0004', title: 'signed off', status: 'accepted', rank: 7 },
  );

  it('resolves a bare LIST NUMBER against the ranked order, not against every open task', () => {
    const root = scratch();
    put(root, 'tasks.json', tasks());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'set', ['2', '1']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('T-0002 -> rank 1\n');
    const rows = journal(root, 'tasks.json').entries;
    expect(rows.map((r) => [r['id'], r['rank']])).toEqual([
      ['T-0001', 2],
      ['T-0002', 1],
      ['T-0003', undefined],
      ['T-0004', 7],
    ]);
  });

  it('never stamps a rank onto work nobody prioritised (I-0044/T-0096)', () => {
    const root = scratch();
    put(root, 'tasks.json', tasks());
    drive(rank, ctxFor(root), 'rank', 'set', ['T-0001', '2']);
    const rows = journal(root, 'tasks.json').entries;
    expect(Object.prototype.hasOwnProperty.call(rows[2]!, 'rank')).toBe(false);
    // ...and ranking is ordering metadata, not work: no updated_at is stamped.
    expect(Object.prototype.hasOwnProperty.call(rows[0]!, 'updated_at')).toBe(false);
  });

  it('promotes an UNRANKED open task into the ranked list at the position asked for', () => {
    const root = scratch();
    put(root, 'tasks.json', tasks());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'set', ['T-0003', '1']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('T-0003 -> rank 1\n');
    expect(journal(root, 'tasks.json').entries.map((r) => r['rank'])).toEqual([2, 3, 1, 7]);
  });

  it('refuses an unknown id, a non-id first argument, and a # outside the ranked range', () => {
    const root = scratch();
    put(root, 'tasks.json', tasks());

    const unknown = drive(rank, ctxFor(root), 'rank', 'set', ['T-9999', '1']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: T-9999 is not an open task —'
      + ' see the list: .claude/scripts/scrumux backlog tasks\n',
    );

    const word = drive(rank, ctxFor(root), 'rank', 'set', ['banana', '1']);
    expect(word.rc).toBe(2);
    expect(word.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: first arg must be a list # or a task id (T-0001)\n',
    );

    // The range is the RANKED list (two entries), not the open list (three).
    const far = drive(rank, ctxFor(root), 'rank', 'set', ['3', '1']);
    expect(far.rc).toBe(2);
    expect(far.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: # 3 is out of range 1..2 —'
      + ' see the list: .claude/scripts/scrumux backlog tasks\n',
    );
  });

  it('refuses clearing a task that was never prioritised', () => {
    const root = scratch();
    put(root, 'tasks.json', tasks());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'clear', ['T-0003']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      'scrumux rank clear: error: scrumux rank: T-0003 has no rank to clear —'
      + ' it is already unprioritised: .claude/scripts/scrumux backlog tasks\n',
    );
  });

  it('refuses when there is no tasks.json, and when every task is accepted', () => {
    const empty = scratch();
    const none = drive(rank, ctxFor(empty), 'rank', 'set', ['T-0001', '1']);
    expect(none.rc).toBe(2);
    expect(none.io.stderr).toBe(
      'scrumux rank set: error: scrumux rank: no tasks.json yet — nothing to rank\n',
    );

    const closed = scratch();
    put(closed, 'tasks.json', entries({ id: 'T-0001', title: 'done', status: 'accepted', rank: 1 }));
    const shut = drive(rank, ctxFor(closed), 'rank', 'set', ['T-0001', '1']);
    expect(shut.rc).toBe(2);
    expect(shut.io.stderr).toBe('scrumux rank set: error: scrumux rank: no open tasks to rank\n');
  });

  it('clears a task rank and re-densifies the survivors from 1', () => {
    const root = scratch();
    put(root, 'tasks.json', tasks());
    const { io, rc } = drive(rank, ctxFor(root), 'rank', 'clear', ['T-0001']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('T-0001 -> rank cleared\n');
    const rows = journal(root, 'tasks.json').entries;
    expect(Object.prototype.hasOwnProperty.call(rows[0]!, 'rank')).toBe(false);
    expect(rows[1]!['rank']).toBe(1);
    expect(rows[3]!['rank']).toBe(7);
  });
});

// ===================================================================
//  issue -- the refusal paragraphs, and the argv-shape quirk
// ===================================================================

const NEW_OK = ['--type', 'defect', '--source', 'claude', '--summary', 'it broke here', '--fix', 'repair it there'];

describe('issue new — every gate on the way to a record', () => {
  it('writes the record with the key order the filter builds, and prints only the id', () => {
    const root = scratch();
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    const { io, rc } = drive(issue, ctxFor(root), 'issue', 'new', [
      ...NEW_OK,
      '--severity', 'high',
      '--task', 'T-0001',
      // `--file` is NOT checked against the filesystem, and neither `--file`
      // nor `--waives` dedupes. Both reproduced.
      '--file', 'src/nowhere.ts',
      '--file', 'src/nowhere.ts',
      '--waives', 'T-0001',
      '--waives', 'T-0001',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('I-0001\n');
    const row = journal(root, 'issues.json').entries[0]!;
    expect(Object.keys(row)).toEqual([
      'id', 'type', 'source', 'summary', 'resolution_pointer', 'status', 'created_at',
      'severity', 'waives', 'refs',
    ]);
    expect(row['waives']).toEqual(['T-0001', 'T-0001']);
    expect(row['refs']).toEqual({ files: ['src/nowhere.ts', 'src/nowhere.ts'], task: 'T-0001' });
    expect(row['status']).toBe('open');
    expect(row['created_at']).toBe(TODAY);
  });

  it('omits the optional keys entirely rather than writing them empty', () => {
    const root = scratch();
    drive(issue, ctxFor(root), 'issue', 'new', NEW_OK);
    const row = journal(root, 'issues.json').entries[0]!;
    expect(Object.keys(row)).toEqual([
      'id', 'type', 'source', 'summary', 'resolution_pointer', 'status', 'created_at', 'refs',
    ]);
    expect(row['refs']).toEqual({ files: [] });
  });

  it('closes the type vocabulary, and closes the SOURCE vocabulary too (T-0130)', () => {
    const root = scratch();
    const noType = drive(issue, ctxFor(root), 'issue', 'new', ['--source', 'claude']);
    expect(noType.rc).toBe(2);
    expect(noType.io.stderr).toBe(
      'scrumux issue new: error: issue: --type must be drift|defect|idea|governance|harness\n',
    );

    const noSource = drive(issue, ctxFor(root), 'issue', 'new', ['--type', 'defect']);
    expect(noSource.rc).toBe(2);
    expect(noSource.io.stderr).toBe(
      'scrumux issue new: error: issue: --source is required (hook name, agent name, or "human")\n',
    );

    const prose = drive(issue, ctxFor(root), 'issue', 'new', ['--type', 'defect', '--source', 'my-agent']);
    expect(prose.rc).toBe(2);
    expect(prose.io.stderr).toContain(
      "issue: --source 'my-agent' is not one of the recorded sources —"
      + ' it is a closed vocabulary, not prose (T-0130).',
    );
    expect(prose.io.stderr).toContain('Valid: User human claude monitor implement-sop');
  });

  it('lets only User and human file drift, idea and governance — an agent files BUGS (D-0079)', () => {
    const root = scratch();
    for (const type of ['drift', 'idea', 'governance']) {
      const agent = drive(issue, ctxFor(root), 'issue', 'new', ['--type', type, '--source', 'claude']);
      expect(agent.rc).toBe(2);
      expect(agent.io.stderr).toContain(`issue: --type ${type} is not an agent's to file — an agent files bugs.`);
      expect(agent.io.stderr).toContain('is not filed at all (D-0079).');
    }
    // The gate is on the SOURCE only; the vocabulary is unchanged for User.
    const user = drive(issue, ctxFor(root), 'issue', 'new', [
      '--type', 'idea', '--source', 'User', '--summary', 's', '--fix', 'f',
    ]);
    expect(user.rc).toBe(0);
    expect(journal(root, 'issues.json').entries[0]!['type']).toBe('idea');
  });

  it('requires a summary and a fix, and each refusal carries its worked examples', () => {
    const root = scratch();
    const noSummary = drive(issue, ctxFor(root), 'issue', 'new', ['--type', 'defect', '--source', 'claude']);
    expect(noSummary.rc).toBe(2);
    expect(noSummary.io.stderr).toContain(
      'issue: --summary is required — what you SAW, at which site, and the command or observation that shows it.',
    );
    expect(noSummary.io.stderr).toContain('BAD "deploy is broken" — no site, no repro');

    const noFix = drive(issue, ctxFor(root), 'issue', 'new', [
      '--type', 'defect', '--source', 'claude', '--summary', 'it broke',
    ]);
    expect(noFix.rc).toBe(2);
    expect(noFix.io.stderr).toContain(
      'issue: --fix is required (resolution_pointer — the rule/skill/script/step that resolves it,'
      + ' so no scope creep)',
    );
    expect(noFix.io.stderr).toContain('it BOUNDS the work, it is not the work.');
  });

  it('closes the severity vocabulary and resolves --task against tasks.json', () => {
    const root = scratch();
    const sev = drive(issue, ctxFor(root), 'issue', 'new', [...NEW_OK, '--severity', 'urgent']);
    expect(sev.rc).toBe(2);
    expect(sev.io.stderr).toBe(
      'scrumux issue new: error: issue: --severity must be low|medium|high|critical\n',
    );

    const task = drive(issue, ctxFor(root), 'issue', 'new', [...NEW_OK, '--task', 'T-9999']);
    expect(task.rc).toBe(2);
    expect(task.io.stderr).toBe(
      'scrumux issue new: error: task T-9999 not found in governance/tasks.json —'
      + ' create it first: scrumux task new --title ... --check ...\n',
    );
  });

  it('checks a --waives ref AS THE FLAG IS READ, ahead of an unknown flag later on the line', () => {
    // The check lives inside the loop, so a bad waiver refuses before argv is
    // even finished being parsed. Reproduced by keeping it there.
    const root = scratch();
    const { io, rc } = drive(issue, ctxFor(root), 'issue', 'new', [
      ...NEW_OK, '--waives', 'T-9999', '--nonsense',
    ]);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task T-9999 not found in governance/tasks.json');
    expect(io.stderr).not.toContain('--nonsense');
  });

  it('refuses an unknown flag, and a flag with no value at all', () => {
    const root = scratch();
    const unknown = drive(issue, ctxFor(root), 'issue', 'new', [...NEW_OK, '--nope', 'x']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(
      'scrumux issue new: error: issue: unknown flag --nope — see: scrumux help issue\n',
    );

    const dangling = drive(issue, ctxFor(root), 'issue', 'new', ['--type']);
    expect(dangling.rc).toBe(2);
    expect(dangling.io.stderr).toBe('scrumux issue new: error: issue: --type needs a value\n');
  });
});

describe('issue update and authorize', () => {
  const seeded = (): string => {
    const root = scratch();
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    put(root, 'issues.json', entries(
      { id: 'I-0001', type: 'defect', source: 'claude', summary: 's', status: 'open', resolution_pointer: 'p' },
      { id: 'I-0002', type: 'defect', source: 'User', summary: 't', status: 'open', refs: { files: ['a.ts'] } },
    ));
    return root;
  };

  it('updates status, severity and refs.task, CREATING refs when the row has none', () => {
    const root = seeded();
    const { io, rc } = drive(issue, ctxFor(root), 'issue', 'update', [
      'I-0001', '--status', 'accepted', '--severity', 'medium', '--task', 'T-0001',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('I-0001 updated\n');
    const row = journal(root, 'issues.json').entries[0]!;
    expect(row['status']).toBe('accepted');
    expect(row['severity']).toBe('medium');
    expect(row['refs']).toEqual({ task: 'T-0001' });
    expect(row['updated_at']).toBe(TODAY);
  });

  it('MERGES into an existing refs object rather than replacing it', () => {
    const root = seeded();
    drive(issue, ctxFor(root), 'issue', 'update', ['I-0002', '--task', 'T-0001']);
    expect(journal(root, 'issues.json').entries[1]!['refs']).toEqual({ files: ['a.ts'], task: 'T-0001' });
  });

  it('REPLACES --waives rather than appending (OQ-DN2, unruled)', () => {
    const root = seeded();
    drive(issue, ctxFor(root), 'issue', 'update', ['I-0001', '--waives', 'T-0001', '--waives', 'T-0001']);
    expect(journal(root, 'issues.json').entries[0]!['waives']).toEqual(['T-0001', 'T-0001']);
    drive(issue, ctxFor(root), 'issue', 'update', ['I-0001', '--waives', 'T-0001']);
    expect(journal(root, 'issues.json').entries[0]!['waives']).toEqual(['T-0001']);
  });

  it('refuses a missing id, an unknown id, an empty update and each closed vocabulary', () => {
    const root = seeded();
    const noId = drive(issue, ctxFor(root), 'issue', 'update', []);
    expect(noId.rc).toBe(2);
    expect(noId.io.stderr).toBe(
      'scrumux issue update: error: usage: scrumux issue update I-0001 [--status ...]'
      + ' [--severity ...] [--task T-0001] [--fix TEXT]\n',
    );

    const missing = drive(issue, ctxFor(root), 'issue', 'update', ['I-9999', '--status', 'open']);
    expect(missing.rc).toBe(2);
    expect(missing.io.stderr).toBe(
      'scrumux issue update: error: issue update: I-9999 not found in issues.json —'
      + ' list them: scrumux issue list --status all\n',
    );

    const nothing = drive(issue, ctxFor(root), 'issue', 'update', ['I-0001']);
    expect(nothing.rc).toBe(2);
    expect(nothing.io.stderr).toBe(
      'scrumux issue update: error: issue update: nothing to update —'
      + ' pass --status, --severity, --task, --fix, and/or --waives\n',
    );

    const badStatus = drive(issue, ctxFor(root), 'issue', 'update', ['I-0001', '--status', 'wontfix']);
    expect(badStatus.io.stderr).toBe(
      'scrumux issue update: error: issue update: --status must be open|accepted|resolved|rejected\n',
    );

    const badSev = drive(issue, ctxFor(root), 'issue', 'update', ['I-0001', '--severity', 'spicy']);
    expect(badSev.io.stderr).toBe(
      'scrumux issue update: error: issue update: --severity must be low|medium|high|critical\n',
    );

    const badTask = drive(issue, ctxFor(root), 'issue', 'update', ['I-0001', '--task', 'T-9999']);
    expect(badTask.io.stderr).toContain('task T-9999 not found in governance/tasks.json');

    const badFlag = drive(issue, ctxFor(root), 'issue', 'update', ['I-0001', '--close']);
    expect(badFlag.io.stderr).toBe(
      'scrumux issue update: error: issue update: unknown flag --close — see: scrumux help issue\n',
    );
  });

  it('records an authorization and NEVER touches .validation (I-0010)', () => {
    // `sprint new --hotfix --issue` reads both fields and refuses on neither
    // being present, so an authorize that wrote a validation would open the
    // fast lane on an unconfirmed report.
    const root = seeded();
    const plain = drive(issue, ctxFor(root), 'issue', 'authorize', ['I-0001', '--by', 'User']);
    expect(plain.rc).toBe(0);
    expect(plain.io.stdout).toBe('I-0001 authorized by User\n');
    let row = journal(root, 'issues.json').entries[0]!;
    expect(row['authorization']).toEqual({ by: 'User', date: TODAY });
    expect(row['validation']).toBeUndefined();

    const noted = drive(issue, ctxFor(root), 'issue', 'authorize', [
      'I-0001', '--by', 'User', '--note', 'do it anyway',
    ]);
    expect(noted.rc).toBe(0);
    row = journal(root, 'issues.json').entries[0]!;
    // The note is the THIRD key, after by and date -- key order is bytes.
    expect(Object.keys(row['authorization'] as object)).toEqual(['by', 'date', 'note']);
  });

  it('refuses an authorize with no id, an unknown id, no --by, and an unknown flag', () => {
    const root = seeded();
    const noId = drive(issue, ctxFor(root), 'issue', 'authorize', []);
    expect(noId.rc).toBe(2);
    expect(noId.io.stderr).toBe(
      'scrumux issue authorize: error: usage: scrumux issue authorize I-0001 --by WHO [--note TEXT] —'
      + ' records fix authorization; it does NOT validate the claim (I-0010)\n',
    );

    const missing = drive(issue, ctxFor(root), 'issue', 'authorize', ['I-9999', '--by', 'User']);
    expect(missing.io.stderr).toContain('issue authorize: I-9999 not found in issues.json');

    const noBy = drive(issue, ctxFor(root), 'issue', 'authorize', ['I-0001']);
    expect(noBy.io.stderr).toBe(
      'scrumux issue authorize: error: issue authorize: --by is required'
      + ' (whose word authorizes the fix — normally User)\n',
    );

    const badFlag = drive(issue, ctxFor(root), 'issue', 'authorize', ['I-0001', '--why', 'x']);
    expect(badFlag.io.stderr).toBe(
      'scrumux issue authorize: error: issue authorize: unknown flag --why — see: scrumux help issue\n',
    );
  });

  it('routes `issue new authorize ...` to the AUTHORIZE branch — the argv shape is bash\'s', () => {
    // `issue_run new` calls `issue_impl "$@"` with the verb already stripped,
    // while the other three put it back. So the first word of `issue new`'s
    // arguments is read as a verb. Reproduced rather than tidied: an
    // argv-shape change here is a silent surface change.
    const root = seeded();
    const { io, rc } = drive(issue, ctxFor(root), 'issue', 'new', ['authorize', 'I-0001', '--by', 'User']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('I-0001 authorized by User\n');
    expect(journal(root, 'issues.json').entries).toHaveLength(2);
  });

  it('refuses an unknown verb by name', () => {
    const root = scratch();
    const { io, rc } = drive(issue, ctxFor(root), 'issue', 'close', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      "scrumux issue close: error: unknown verb 'close' for noun issue —"
      + ' verbs: new, update, validate, authorize, list, find. See: scrumux help issue\n',
    );
  });
});

// ===================================================================
//  health -- registration only, and the flag loop is the whole surface
// ===================================================================

describe('health add — the guards that decide whether a row is written', () => {
  it('accepts every --type in the vocabulary and refuses anything else', () => {
    for (const type of ['build', 'test', 'run', 'lint', 'other']) {
      const root = scratch();
      const { io, rc } = drive(health, ctxFor(root), 'health', 'add', [
        '--name', type, '--command', 'true', '--type', type,
      ]);
      expect(rc).toBe(0);
      expect(io.stdout).toBe(`health check '${type}' registered\n`);
      expect(journal(root, 'repo-health.json').entries[0]).toEqual({ name: type, command: 'true', type });
    }
    const root = scratch();
    const bad = drive(health, ctxFor(root), 'health', 'add', [
      '--name', 'n', '--command', 'true', '--type', 'smoke',
    ]);
    expect(bad.rc).toBe(2);
    expect(bad.io.stderr).toBe('scrumux health add: error: health: --type must be build|test|run|lint|other\n');
  });

  it('ACCEPTS --timeout 0, and refuses anything with a non-digit in it', () => {
    // The bash guard is a glob that excludes only non-digit characters, so 0
    // and an absurdly large value both pass. Not tightened: a refusal this
    // port invented would refuse input the deployed CLI accepts.
    const root = scratch();
    const zero = drive(health, ctxFor(root), 'health', 'add', [
      '--name', 'z', '--command', 'true', '--timeout', '0',
    ]);
    expect(zero.rc).toBe(0);
    expect(journal(root, 'repo-health.json').entries[0]!['timeout_seconds']).toBe(0);

    const huge = drive(health, ctxFor(root), 'health', 'add', [
      '--name', 'h', '--command', 'true', '--timeout', '99999999999999999999',
    ]);
    expect(huge.rc).toBe(0);
    // The decNumber literal survives a round trip that a JS double would not.
    expect(readFileSync(join(root, 'governance/repo-health.json'), 'utf8'))
      .toContain('"timeout_seconds": 99999999999999999999');

    const word = drive(health, ctxFor(root), 'health', 'add', [
      '--name', 'w', '--command', 'true', '--timeout', '30s',
    ]);
    expect(word.rc).toBe(2);
    expect(word.io.stderr).toBe(
      'scrumux health add: error: health: --timeout must be an integer (seconds)\n',
    );
  });

  it('requires a name and a command, and says what the command has to do', () => {
    const root = scratch();
    const noName = drive(health, ctxFor(root), 'health', 'add', ['--command', 'true']);
    expect(noName.rc).toBe(2);
    expect(noName.io.stderr).toBe('scrumux health add: error: health: --name is required\n');

    const noCmd = drive(health, ctxFor(root), 'health', 'add', ['--name', 'n']);
    expect(noCmd.rc).toBe(2);
    expect(noCmd.io.stderr).toBe(
      'scrumux health add: error: health: --command is required'
      + ' (POSIX shell command; exit 0 = healthy)\n',
    );
  });

  it('reports a dangling value for EACH flag, and names no noun in the pointer (contract, not a typo)', () => {
    // Every other noun in this group says "scrumux help <noun>"; this one says
    // "see: scrumux help". The wording is Article 5 surface.
    const root = scratch();
    for (const flag of ['--name', '--command', '--type', '--timeout']) {
      const { io, rc } = drive(health, ctxFor(root), 'health', 'add', [flag]);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(`scrumux health add: error: health: ${flag} needs a value — see: scrumux help\n`);
    }
    const unknown = drive(health, ctxFor(root), 'health', 'add', ['--label', 'x']);
    expect(unknown.io.stderr).toBe('scrumux health add: error: health: unknown flag --label — see: scrumux help\n');
  });

  it('writes NO key for an omitted --type or --timeout — the defaults live at the other end', () => {
    // The runner supplies test/120 when it reads the row back, so the journal
    // records what the operator said rather than what the system will do.
    const root = scratch();
    drive(health, ctxFor(root), 'health', 'add', ['--name', 'bare', '--command', 'npm test']);
    expect(journal(root, 'repo-health.json').entries[0]).toEqual({ name: 'bare', command: 'npm test' });
  });

  it('refuses an unknown verb, and the message names the only verb there is', () => {
    const root = scratch();
    const { io, rc } = drive(health, ctxFor(root), 'health', 'list', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      "scrumux health list: error: unknown verb 'list' for noun health —"
      + " the only verb is 'add'. See: scrumux help health\n",
    );
    expect(health.verbs()).toBe('add\tthe only verb\n');
  });

  it('says so on stderr when the RESEAL fails, and still writes the row (D-0085)', () => {
    // resealOne returned 0 on its own write failure once, so the seal quietly
    // stopped matching a file scrumux had just legitimately written and the
    // next records check reported it as tampering, pointing at the wrong
    // culprit. `repo-health.json` is in SEALED_JOURNALS (T-0100), so a
    // seals.json that is valid JSON but the wrong SHAPE takes that arm.
    const root = scratch();
    writeFileSync(join(root, 'governance/seals.json'), '"a string, not an object"\n');
    const warning =
      'seals.json: could not update the seal for repo-health.json —'
      + ' the next records check will report it as changed outside scrumux, wrongly.'
      + ' Re-run the write, or reseal with: scrumux repair journal repo-health.json\n';

    const human = drive(health, ctxFor(root), 'health', 'add', ['--name', 'n', '--command', 'true']);
    expect(human.rc).toBe(0);
    expect(human.io.stderr).toBe(warning);
    expect(human.io.stdout).toBe("health check 'n' registered\n");
    // The row was still appended: a failed reseal is a warning, not a refusal.
    expect(journal(root, 'repo-health.json').entries).toHaveLength(1);

    // The same warning becomes a `reseal` WARN row ONLY under --json, and a
    // WARN never moves the verdict.
    const json = drive(health, ctxFor(root), 'health', 'add', ['--name', 'n2', '--command', 'true'], true);
    expect(json.rc).toBe(0);
    const env = envelopeOf(json.io);
    expect(env.ok).toBe(true);
    expect(env.checks).toEqual([
      { name: 'reseal', ok: true, tier: 'warn', detail: warning.trimEnd() },
    ]);
  });

  it('answers usage() from the ONE generated table, for every noun in this file', () => {
    // `src/cli/usage-text.ts` is generated from the bash heredocs by
    // `npm run gen:usage`, and the seam still requires each module to ANSWER.
    // A module whose `usage()` silently returned '' would ship a help screen
    // with a hole in it and no test would notice.
    expect(health.usage()).toContain('scrumux health');
    expect(rank.usage()).toContain('scrumux rank');
    expect(issue.usage()).toContain('scrumux issue');
    expect(session.usage()).toContain('scrumux session — the session close.');
    expect(rank.verbs()).toBe('set\tmove a backlog item to a position\nclear\treturn an item to never-prioritised\n');
    expect(issue.verbs()).toContain('validate\trecord a read-only agent\'s verdict on the claim\n');
    expect(session.verbs()).toBe(
      'check\tthe close: six deterministic checks over receipts, journals and git\n',
    );
  });
});

// ===================================================================
//  session check -- the arms a green close never takes
// ===================================================================

describe('session check — the ways a green receipt can lie', () => {
  it('names every failing receipt property at once, and the verdict is the exit code', () => {
    const root = scratch();
    writeFileSync(join(root, 'covered.ts'), 'export const x = 1;\n');
    put(root, 'tasks.json', entries(
      { id: 'T-0001', status: 'in_review', updated_at: TODAY },
      { id: 'T-0002', status: 'in_review', receipt: { rc: 3 } },
      {
        id: 'T-0003',
        status: 'in_review',
        receipt: { rc: 0, command: 'npm test', at_epoch: 1 },
        task_order: { verification_command: 'npm run verify' },
      },
      { id: 'T-0004', status: 'in_review', receipt: { rc: 0, at_epoch: 1, checks_run: 0 } },
      {
        id: 'T-0005',
        status: 'in_review',
        // at_epoch 1 is 1970, so a file that exists at all is newer.
        receipt: { rc: 0, at_epoch: 1 },
        task_order: { context: { files: [{ path: 'covered.ts' }] } },
      },
    ));
    const { io, rc } = drive(session, ctxFor(root), 'session', 'check', []);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(
      '  FAIL receipt present          claimed done with no receipt: T-0001 — nothing ran to prove it\n',
    );
    expect(io.stdout).toContain(
      '  FAIL receipt green            claimed done on a red receipt: T-0002(rc=3) —'
      + ' the command it named did not pass\n',
    );
    expect(io.stdout).toContain(
      '  FAIL command match            receipt ran a different command than the order names: T-0003\n',
    );
    expect(io.stdout).toContain(
      '  FAIL receipt fresh            files changed after the receipt was written: T-0005:covered.ts —'
      + ' the receipt no longer covers the code\n',
    );
    expect(io.stdout).toContain(
      '  FAIL checks ran               receipt reports zero checks run: T-0004 — a green that proved nothing\n',
    );
    expect(io.stdout).toContain('VERDICT: session NOT clean — each FAIL above names work that is not finished.');
  });

  it('WARNs rather than fails when a receipt predates the freshness stamp', () => {
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', status: 'in_review', receipt: { rc: 0, command: 'c', checks_run: 1 } },
    ));
    const { io } = drive(session, ctxFor(root), 'session', 'check', []);
    expect(io.stdout).toContain(
      '  WARN receipt fresh            receipt predates the freshness stamp, cannot be judged: T-0001\n',
    );
  });

  it('scopes the claim set to in_review plus THIS SESSION\'S acceptances (I-0006)', () => {
    // Not "everything touched today" -- a task whose metadata moved is not a
    // task that was worked -- and not every accepted task in history, because
    // re-judging one User already signed is post-hoc record policing.
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', status: 'accepted', updated_at: TODAY },
      { id: 'T-0002', status: 'accepted', updated_at: '2020-01-01' },
      { id: 'T-0003', status: 'ready', updated_at: TODAY },
    ));
    const { io, rc } = drive(session, ctxFor(root), 'session', 'check', []);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('claimed done with no receipt: T-0001 — nothing ran to prove it\n');
    expect(io.stdout).not.toContain('T-0002');
    expect(io.stdout).not.toContain('T-0003 —');
  });

  it('splits the mid-flight verdict on SCRUMUX_TASK, three ways (D-0084)', () => {
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', status: 'in_progress' },
      { id: 'T-0002', status: 'in_progress' },
    ));

    // (a) dispatched under one of them: a FAIL, and the other is NAMED as not
    //     this session's to move.
    const mine = drive(session, ctxFor(root, { env: { SCRUMUX_TASK: 'T-0001' } }), 'session', 'check', []);
    expect(mine.rc).toBe(1);
    expect(mine.io.stdout).toContain(
      "  FAIL nothing mid-flight       still in_progress at close: T-0001 — this session was dispatched under it;"
      + " also in flight, and not this session's to move: T-0002\n",
    );

    // (b) dispatched under something else entirely: a WARN. With more than one
    //     task per sprint, "nothing is in_progress" stopped being a fact about
    //     THIS session, so a second agent still working must not fail the
    //     first one's close.
    const theirs = drive(session, ctxFor(root, { env: { SCRUMUX_TASK: 'T-0009' } }), 'session', 'check', []);
    expect(theirs.io.stdout).toContain(
      "  WARN nothing mid-flight       this session's task (T-0009) is not in flight; another session's is:"
      + ' T-0001,T-0002 — named, not failed (D-0084)\n',
    );

    // (c) no dispatch at all: the whole repo is this session's problem.
    const solo = drive(session, ctxFor(root), 'session', 'check', []);
    expect(solo.rc).toBe(1);
    expect(solo.io.stdout).toContain(
      '  FAIL nothing mid-flight       still in_progress at close: T-0001,T-0002\n',
    );
  });

  it('counts a COMPLETE sprint as sprint discipline, not only a ratified one', () => {
    const root = scratch();
    put(root, 'tasks.json', entries(
      { id: 'T-0001', status: 'accepted', updated_at: TODAY, receipt: { rc: 0, at_epoch: 1, checks_run: 1 } },
      { id: 'T-0002', status: 'ready', updated_at: TODAY },
    ));
    put(root, 'sprints.json', entries({ id: 'SP-0001', status: 'complete', tasks: ['T-0001'] }));
    const { io } = drive(session, ctxFor(root), 'session', 'check', []);
    expect(io.stdout).toContain(
      '  WARN sprint discipline        worked outside any ratified sprint: T-0002\n',
    );
    expect(io.stdout).not.toContain('sprint: T-0001');
  });

  it('warns on a live stub and, separately, on one whose issue is closed or unknown', () => {
    const root = scratch();
    writeFileSync(join(root, 'live.ts'), 'const a = 1; // STUB(I-0001)\n');
    writeFileSync(join(root, 'stale.ts'), '// STUB(I-0002) and STUB(I-0003)\n');
    put(root, 'issues.json', entries(
      { id: 'I-0001', status: 'open' },
      { id: 'I-0002', status: 'resolved' },
    ));
    const { io, rc } = drive(session, ctxFor(root), 'session', 'check', []);
    // Parked debt is visible, never a block (D-0015).
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      '  WARN live stubs               stub marker(s) whose issue is resolved/rejected/unknown:'
      + ' stale.ts:1->I-0002(resolved) stale.ts:1->I-0003(unknown)\n',
    );
    expect(io.stdout).toContain(
      '  WARN live stubs               1 live stub(s) parked on open issue(s): I-0001\n',
    );
  });

  it('carries on past a path it cannot stat or read, exactly as `find 2>/dev/null` does', () => {
    // A completeness check here would be a tightening nobody ruled on: find
    // prints to stderr and walks on, silently omitting whatever it could not
    // reach. Two shapes reach the two guards -- a DANGLING SYMLINK (stat
    // throws) and a file the process cannot open (read throws) -- and the
    // scan must still report the markers it did reach.
    const root = scratch();
    writeFileSync(join(root, 'readable.ts'), '// STUB(I-0001)\n');
    symlinkSync(join(root, 'nowhere-at-all'), join(root, 'dangling'));
    const locked = join(root, 'locked.ts');
    writeFileSync(locked, '// STUB(I-0001)\n');
    chmodSync(locked, 0o000);
    put(root, 'issues.json', entries({ id: 'I-0001', status: 'open' }));

    const { io, rc } = drive(session, ctxFor(root), 'session', 'check', []);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      `  WARN ${'live stubs'.padEnd(24)} 1 live stub(s) parked on open issue(s): I-0001\n`,
    );
    // Restored so the temp tree can be cleaned up by whatever cleans it.
    chmodSync(locked, 0o644);
  });

  it('warns rather than failing outside a git repository, and passes a clean close', () => {
    const root = scratch();
    const { io, rc } = drive(session, ctxFor(root), 'session', 'check', []);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('  WARN strays/secrets           not a git repo — stray check unavailable\n');
    expect(io.stdout).toContain(`  ok   ${'live stubs'.padEnd(24)} no stub markers in live code\n`);
    // Eight rows: the six checks plus the two advisories that never move it.
    expect(io.stdout).toContain('SUMMARY: 0 fail(s) of 8 check(s)');
    expect(io.stdout).toContain("VERDICT: clean. Push is User's call.");
  });

  it('refuses arguments and an unknown verb', () => {
    const root = scratch();
    const extra = drive(session, ctxFor(root), 'session', 'check', ['--fast']);
    expect(extra.rc).toBe(2);
    expect(extra.io.stderr).toBe('scrumux session check: error: session check takes no arguments\n');

    const bogus = drive(session, ctxFor(root), 'session', 'close', []);
    expect(bogus.rc).toBe(2);
    expect(bogus.io.stderr).toBe(
      "scrumux session close: error: unknown verb 'close' for noun session —"
      + " the only verb is 'check'. See: scrumux help session\n",
    );
  });
});

// ===================================================================
//  views render -- the two degradations
// ===================================================================

describe('renderViews — the arms a healthy repo never takes', () => {
  it('renders an UNPARSEABLE journal as the banner and nothing else', () => {
    // bash pipes the file straight into `jq -r` here, so a parse error prints
    // a diagnostic, emits nothing, and the redirect still creates the view.
    // The view is the banner. Reproduced rather than turned into a refusal.
    const root = scratch();
    writeFileSync(join(root, 'governance/log.json'), 'not json');
    const r = renderViews(nounContext(ctxFor(root)));
    expect(r.written).toContain('AI_LOG.MD');
    expect(readFileSync(join(root, 'AI_LOG.MD'), 'utf8')).toBe(
      '# AI_LOG.MD\n'
      + '<!-- GENERATED VIEW — source of truth: governance/log.json (append-only).\n'
      + '     Do not edit by hand; run: .claude/scripts/scrumux views render -->\n\n',
    );
  });

  it('flags a FAILED graph build without aborting the render (P-14)', () => {
    // A stale graph must never abort a transaction here; `views render` is the
    // caller that turns the same fact into a non-zero exit. The failure is
    // provoked by making the index path a DIRECTORY, which is the one way to
    // make the writer throw without corrupting anything.
    const root = scratch();
    put(root, 'tasks.json', entries({ id: 'T-0001', title: 'a', status: 'ready' }));
    mkdirSync(join(root, 'governance/governance-graph.json'), { recursive: true });
    const r = renderViews(nounContext(ctxFor(root)));
    expect(r.graphBuildFailed).toBe(true);
    expect(r.warnings).toEqual([
      'scrumux: warning: graph gov build failed — governance/governance-graph.json is now STALE.'
      + ' Run .claude/scripts/scrumux graph gov build to see why.\n',
    ]);
    // The views were still written: the render is not the graph.
    expect(r.written).toEqual(['BACKLOG.MD']);
    expect(readFileSync(join(root, 'BACKLOG.MD'), 'utf8')).toContain('## ready\n- **T-0001** a\n');
  });

  it('warns that every query is answering from old data when the harness CLI is missing', () => {
    const root = scratch();
    const noScripts = scratch();
    const ctx = nounContext(ctxFor(root, { scriptsDir: noScripts }));
    const r = renderViews(ctx);
    expect(r.graphBuildFailed).toBe(true);
    expect(r.warnings).toEqual([
      'scrumux: warning: .claude/scripts/scrumux is missing or not executable —'
      + ' governance/governance-graph.json is STALE and every query over it is answering from old data.\n',
    ]);
  });
});

// ===================================================================
//  jqlike -- the last corner of the total order
// ===================================================================

describe("jq's total order over OBJECTS, which sort_by can reach and no view does", () => {
  it('compares keys first, then values, and puts objects last of all', () => {
    // jq: null < false < true < numbers < strings < arrays < objects.
    expect(cmp({}, { a: new RawNumber('1') })).toBe(-1);
    expect(cmp({ a: new RawNumber('1') }, { b: new RawNumber('1') })).toBe(-1);
    expect(cmp({ a: new RawNumber('1') }, { a: new RawNumber('2') })).toBe(-1);
    expect(cmp({ a: new RawNumber('1') }, { a: new RawNumber('1') })).toBe(0);
    expect(cmp({ b: new RawNumber('1') }, { a: new RawNumber('9') })).toBe(1);
    expect(cmp([new RawNumber('1')], {})).toBe(-1);
    // Key ORDER in the literal is not key order in the comparison.
    expect(cmp({ b: null, a: null }, { a: null, b: null })).toBe(0);
    // And the rendering of an object is jq's compact encoding, key order kept.
    expect(interp({ b: new RawNumber('1.10'), a: null })).toBe('{"b":1.10,"a":null}');
  });
});
