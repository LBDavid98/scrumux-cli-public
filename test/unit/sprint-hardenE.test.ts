/**
 * Unit cover for the `sprint` noun -- `src/nouns/sprint.ts`.
 *
 * WHY THIS FILE EXISTS. The module was at 43% cover, and that is where its two
 * fail-opens lived. `{"validation": ["reproduced"]}` allocated a hotfix sprint
 * at exit 0 where it must refuse at exit 2, and `{"status": ["proposed"]}`
 * walked past the D-0084 re-ratification guard and widened a RATIFIED plan.
 * Neither had a test, and both were one `String()` call away from being
 * invisible forever. The lesson is not "add two cases": it is that a gate with
 * no exhaustive arm-by-arm cover is a gate nobody has actually checked. So
 * every arm of every verb is driven here, and the two gates are driven from
 * both directions -- the input they must refuse AND the input they must admit,
 * because a guard test with no positive control is equally satisfied by a verb
 * that refuses everything.
 *
 * TWO THINGS IT DOES THAT A PER-CASE ASSERTION DOES NOT:
 *
 *   1. THE BATTERY. Sixty-odd argv shapes, each run over an identical freshly
 *      deployed repo, with exit code, stdout, stderr and the post-state
 *      `sprints.json` pinned as ONE golden per case. Adding a shape costs one
 *      line, which is the whole point. It was a comparison against the bash
 *      CLI until the cutover made that half inert -- the flip routes the same
 *      argv to this code, so it compared this code with itself -- and the
 *      cases survived the comparison by becoming goldens.
 *
 *   2. THE JOURNAL BYTES, ASSERTED AS ABSOLUTES. `unique` is a SORT-and-dedupe
 *      (adding T-0001 to a sprint holding T-0009 REORDERS the array),
 *      `--parallel 007` records the NUMBER 7, `descoped` appends rather than
 *      replaces, and `ratified` carries `{by, date, authority}` in that key
 *      order. Each is pinned as a literal below, on the record rather than on
 *      the process, so a change that moves the output and the record together
 *      still goes red here.
 *
 * NOTHING HERE MAY BE "FIXED". Several assertions pin behaviour that reads as
 * a bug and is a ruling:
 *
 *   - `sprint descope SP-0001` (ONE positional) refuses with "unknown flag
 *     SP-0001", not with the usage line two statements below it: with fewer
 *     than two arguments argv is left alone, so the id reaches the flag loop.
 *     The usage refusal is unreachable for that shape.
 *   - `sprint add SP-0001 T-0001 EXTRA` silently ignores the third positional.
 *   - A `task_order` that is a NUMBER takes the storyless-lane test to `false`
 *     and lands in the "one user story per task" refusal rather than earning
 *     one of its own (D-0073's relaxation is carried by the ORDER, so an
 *     unreadable order is simply not a light one).
 *   - `sprint update` tests `hotfix` BEFORE `status`, so a ratified hotfix
 *     sprint is refused as a hotfix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as sprint, VERBS } from '../../src/nouns/sprint.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');
const CLI = join(SCRIPTS, 'scrumux');

const TODAY = todayStamp();
const J = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

// --------------------------------------------------------------- the seed --

/**
 * ONE journal set, shared by both sides of the battery.
 *
 * Every row exists to reach an arm: `E-0002` is an `E-` id whose `.kind` is
 * NOT `epic` (the polymorphic `design.json` select, which a plain
 * `.entries[].id` stream would wave through); `T-0005`'s `task_order` is an
 * explicit `null` rather than absent, because jq's `!= null` cannot tell the
 * two apart and a port that used `in` could; `SP-0004` has NO `tasks` key at
 * all, which is jq's `length`-of-null-is-0 and the shape `ratify`'s "no
 * tasks" refusal and `descope`'s "not carried" refusal both have to survive.
 */
function seed(root: string): void {
  const gov = join(root, 'governance');
  mkdirSync(gov, { recursive: true });

  writeFileSync(join(gov, 'design.json'), J({
    entries: [
      { id: 'E-0001', kind: 'epic', name: 'the epic', desc: 'd', status: 'proposed', created_at: '2026-08-01' },
      { id: 'E-0002', kind: 'feature', name: 'an E- id that is not an epic', created_at: '2026-08-01' },
      { id: 'S-0001', kind: 'story', name: 'a story', created_at: '2026-08-01' },
    ],
  }));

  writeFileSync(join(gov, 'issues.json'), J({
    entries: [
      {
        id: 'I-0001', type: 'defect', source: 'claude', summary: 'validated', status: 'open',
        created_at: '2026-08-01', validation: { verdict: 'reproduced', evidence: 'e', by: 'debugger', date: '2026-08-01' },
      },
      {
        id: 'I-0002', type: 'defect', source: 'User', summary: 'authorized', status: 'open',
        created_at: '2026-08-01', authorization: { by: 'User', date: '2026-08-01' },
      },
    ],
  }));

  const order = { scope: 's', verify: 'v', files: [{ path: 'src/app.js', why: 'w' }] };
  writeFileSync(join(gov, 'tasks.json'), J({
    entries: [
      { id: 'T-0001', title: 'ordered and storied', status: 'proposed', acceptance_check: 'c', story: 'S-0001', task_order: order },
      { id: 'T-0002', title: 'ordered, no story', status: 'proposed', acceptance_check: 'c', task_order: order },
      { id: 'T-0003', title: 'no order', status: 'proposed', acceptance_check: 'c', story: 'S-0001' },
      { id: 'T-0004', title: 'light order, no story', status: 'proposed', acceptance_check: 'c', task_order: { ...order, light: true } },
      { id: 'T-0005', title: 'order is an explicit null', status: 'proposed', acceptance_check: 'c', task_order: null },
      { id: 'T-0009', title: 'sorts after T-0001', status: 'proposed', acceptance_check: 'c', story: 'S-0001', task_order: order },
    ],
  }));

  writeFileSync(join(gov, 'sprints.json'), J({
    entries: [
      { id: 'SP-0001', epic: 'E-0001', hotfix: false, source_issue: null, tasks: ['T-0009'], status: 'proposed', parallel: 1, created_at: '2026-08-01' },
      { id: 'SP-0002', epic: 'E-0001', hotfix: false, source_issue: null, tasks: ['T-0009'], status: 'ratified', parallel: 1, created_at: '2026-08-01' },
      { id: 'SP-0003', epic: null, hotfix: true, source_issue: 'I-0001', tasks: [], status: 'proposed', parallel: 1, created_at: '2026-08-01' },
      { id: 'SP-0004', epic: 'E-0001', hotfix: false, source_issue: null, status: 'proposed', parallel: 1, created_at: '2026-08-01' },
    ],
  }));

  writeFileSync(join(gov, 'decisions.json'), J({
    entries: [{ id: 'D-0001', title: 'a standing delegation', status: 'ratified', created_at: '2026-08-01' }],
  }));

  // TWO log entries against T-0009, which is what `descope`'s T-0144 TELL
  // counts. A repo that has never logged is silent instead, and that arm has
  // its own case below.
  writeFileSync(join(gov, 'log.json'), J({
    entries: [
      { id: 'L-0001', task: 'T-0009', what: 'worked it', created_at: '2026-08-01' },
      { id: 'L-0002', task: 'T-0009', what: 'worked it again', created_at: '2026-08-01' },
      { id: 'L-0003', task: 'T-0001', what: 'a different task', created_at: '2026-08-01' },
    ],
  }));
}

// ------------------------------------------------------------ the harness --

let skeleton: string | null = null;
let scratchRoot: string | null = null;

/**
 * A REAL DEPLOYED REPO, because the bash side is a real CLI.
 *
 * `scrumux` resolves ROOT/GOV/HARNESS_DIR from a deployed `.claude/`, and a
 * hand-built `governance/` gets it none of that. Deployed ONCE in `beforeAll`
 * and `cpSync`'d per case, which is the pattern
 * `test/unit/rulings-hardenE.test.ts` established -- a deploy is ~80 payload
 * items and sixty of them would dominate the suite.
 */
function deploySkeleton(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-spE-skel-')));
  writeFileSync(join(dir, 'README.md'), 'sprint Harden E skeleton\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.js'), 'export function hello() { return 1; }\n');
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'base'], { cwd: dir });
  const r = spawnSync(process.execPath, [CLI, 'harness', 'deploy', dir], { cwd: CHECKOUT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`sprint Harden E: skeleton deploy failed (rc=${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  seed(dir);
  return dir;
}

beforeAll(() => {
  scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-spE-')));
  skeleton = deploySkeleton();
}, 180_000);

afterAll(() => {
  if (scratchRoot !== null) rmSync(scratchRoot, { recursive: true, force: true });
  if (skeleton !== null) rmSync(skeleton, { recursive: true, force: true });
});

/** A deployed, seeded repo of its own. */
function caseRepo(): string {
  const root = realpathSync(mkdtempSync(join(scratchRoot!, 'case-')));
  cpSync(skeleton!, root, { recursive: true });
  return root;
}

/**
 * A BARE `governance/` -- no deploy, no bash.
 *
 * Used only where the case is about a journal shape bash cannot be handed
 * (an `entries` array holding a number, a `sprints.json` that is a directory),
 * so paying for a deploy would buy nothing.
 */
function bareRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-spE-bare-')));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}

function ctxFor(root: string): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: TODAY,
    io: captureIo(),
    scriptsDir: SCRIPTS,
    env: {},
    cwd: root,
  };
}

interface Driven { io: CapturedIo; rc: number }

function sprintsText(root: string): string {
  return readFileSync(join(root, 'governance', 'sprints.json'), 'utf8');
}

interface Row { [k: string]: unknown }
function sprintRow(root: string, id: string): Row {
  const doc = JSON.parse(sprintsText(root)) as { entries: unknown[] };
  // Tolerant on purpose: one case below writes a journal whose `entries` holds
  // a number, a string and a null alongside the real row.
  const hit = doc.entries.find((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && (r as Row)['id'] === id);
  return hit as Row;
}

// ------------------------------------------------------------ the battery --

/**
 * Every argv the port and bash are both asked to answer.
 *
 * `label` is what a failure prints, so it names the ARM rather than the flags.
 * Ordering is by verb, and the success rows deliberately sit next to the
 * refusals that guard them: a battery of refusals alone is passed by a noun
 * that refuses everything.
 */
const BATTERY: readonly { label: string; argv: readonly string[] }[] = [
  // ---- new --------------------------------------------------------------
  { label: 'new: the epic lane, default parallel', argv: ['sprint', 'new', '--epic', 'E-0001'] },
  { label: 'new: --parallel 007 is canonicalised by jq\'s own parse', argv: ['sprint', 'new', '--epic', 'E-0001', '--parallel', '007'] },
  { label: 'new: an E- id whose .kind is not epic', argv: ['sprint', 'new', '--epic', 'E-0002'] },
  { label: 'new: an epic that does not exist', argv: ['sprint', 'new', '--epic', 'E-9999'] },
  { label: 'new: neither --epic nor --hotfix', argv: ['sprint', 'new'] },
  { label: 'new: parallel_guard on a non-numeric cap', argv: ['sprint', 'new', '--epic', 'E-0001', '--parallel', 'lots'] },
  { label: 'new: parallel_guard on zero', argv: ['sprint', 'new', '--epic', 'E-0001', '--parallel', '0'] },
  { label: 'new: an unknown flag', argv: ['sprint', 'new', '--nope'] },
  { label: 'new: --hotfix with no --issue', argv: ['sprint', 'new', '--hotfix'] },
  { label: 'new: --hotfix on an issue that does not exist', argv: ['sprint', 'new', '--hotfix', '--issue', 'I-9999'] },
  { label: 'new: --hotfix and --epic are mutually exclusive', argv: ['sprint', 'new', '--hotfix', '--issue', 'I-0001', '--epic', 'E-0001'] },
  { label: 'new: --hotfix opens on a reproduced verdict', argv: ['sprint', 'new', '--hotfix', '--issue', 'I-0001'] },
  { label: 'new: --hotfix opens on User\'s authorization alone (I-0010)', argv: ['sprint', 'new', '--hotfix', '--issue', 'I-0002'] },
  { label: 'new: --hotfix refuses a cap it cannot honour', argv: ['sprint', 'new', '--hotfix', '--issue', 'I-0001', '--parallel', '2'] },
  { label: 'new: --hotfix accepts the cap it CAN honour', argv: ['sprint', 'new', '--hotfix', '--issue', 'I-0001', '--parallel', '1'] },

  // ---- add --------------------------------------------------------------
  { label: 'add: no positionals', argv: ['sprint', 'add'] },
  { label: 'add: one positional', argv: ['sprint', 'add', 'SP-0001'] },
  { label: 'add: a sprint that does not exist', argv: ['sprint', 'add', 'SP-9999', 'T-0001'] },
  { label: 'add: a task that does not exist', argv: ['sprint', 'add', 'SP-0001', 'T-9999'] },
  { label: 'add: a task with no order (D-0005)', argv: ['sprint', 'add', 'SP-0001', 'T-0003'] },
  { label: 'add: a task whose order is an explicit null', argv: ['sprint', 'add', 'SP-0001', 'T-0005'] },
  { label: 'add: a plain order with no story', argv: ['sprint', 'add', 'SP-0001', 'T-0002'] },
  { label: 'add: the hotfix storyless lane', argv: ['sprint', 'add', 'SP-0003', 'T-0002'] },
  { label: 'add: the light storyless lane (D-0073)', argv: ['sprint', 'add', 'SP-0001', 'T-0004'] },
  { label: 'add: unique SORTS -- T-0001 lands ahead of T-0009', argv: ['sprint', 'add', 'SP-0001', 'T-0001'] },
  { label: 'add: unique DEDUPES -- T-0009 is already carried', argv: ['sprint', 'add', 'SP-0001', 'T-0009'] },
  { label: 'add: a sprint with no tasks key at all', argv: ['sprint', 'add', 'SP-0004', 'T-0001'] },
  { label: 'add: a third positional is silently ignored', argv: ['sprint', 'add', 'SP-0001', 'T-0001', 'EXTRA'] },

  // ---- update -----------------------------------------------------------
  { label: 'update: no id', argv: ['sprint', 'update'] },
  { label: 'update: nothing to update', argv: ['sprint', 'update', 'SP-0001'] },
  { label: 'update: parallel_guard', argv: ['sprint', 'update', 'SP-0001', '--parallel', 'lots'] },
  { label: 'update: an unknown flag', argv: ['sprint', 'update', 'SP-0001', '--nope'] },
  { label: 'update: a sprint that does not exist', argv: ['sprint', 'update', 'SP-9999', '--parallel', '2'] },
  { label: 'update: a hotfix sprint has no second slot', argv: ['sprint', 'update', 'SP-0003', '--parallel', '2'] },
  { label: 'update: THE RE-RATIFICATION GUARD (D-0084)', argv: ['sprint', 'update', 'SP-0002', '--parallel', '2'] },
  { label: 'update: a proposed sprint IS widened', argv: ['sprint', 'update', 'SP-0001', '--parallel', '3'] },

  // ---- descope ----------------------------------------------------------
  { label: 'descope: no positionals', argv: ['sprint', 'descope'] },
  { label: 'descope: ONE positional reaches the flag loop (the shift quirk)', argv: ['sprint', 'descope', 'SP-0001'] },
  { label: 'descope: --reason is required', argv: ['sprint', 'descope', 'SP-0001', 'T-0009'] },
  { label: 'descope: an unknown flag', argv: ['sprint', 'descope', 'SP-0001', 'T-0009', '--nope', 'x'] },
  { label: 'descope: a sprint that does not exist', argv: ['sprint', 'descope', 'SP-9999', 'T-0009', '--reason', 'r'] },
  { label: 'descope: a task that does not exist', argv: ['sprint', 'descope', 'SP-0001', 'T-9999', '--reason', 'r'] },
  { label: 'descope: a task the sprint does not carry', argv: ['sprint', 'descope', 'SP-0001', 'T-0001', '--reason', 'r'] },
  { label: 'descope: a sprint with no tasks key carries nothing', argv: ['sprint', 'descope', 'SP-0004', 'T-0009', '--reason', 'r'] },
  { label: 'descope: T-0144 TELLS and descopes anyway', argv: ['sprint', 'descope', 'SP-0001', 'T-0009', '--reason', 'superseded by T-0217'] },

  // ---- ratify -----------------------------------------------------------
  { label: 'ratify: no id', argv: ['sprint', 'ratify'] },
  { label: 'ratify: --by is required (it used to default to User)', argv: ['sprint', 'ratify', 'SP-0001'] },
  { label: 'ratify: authority_guard, empty', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'User'] },
  { label: 'ratify: authority_guard, outside the vocabulary', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'User', '--authority', 'because'] },
  { label: 'ratify: a standing delegation that does not resolve', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'User', '--authority', 'standing:D-9999'] },
  { label: 'ratify: a standing delegation that DOES resolve', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'User', '--authority', 'standing:D-0001'] },
  { label: 'ratify: bare app is the control-plane act', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'scrumux-app', '--authority', 'app'] },
  { label: 'ratify: app:<session>', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'agent', '--authority', 'app:sess-1'] },
  { label: 'ratify: direct', argv: ['sprint', 'ratify', 'SP-0001', '--by', 'User', '--authority', 'direct'] },
  { label: 'ratify: a sprint that does not exist', argv: ['sprint', 'ratify', 'SP-9999', '--by', 'User', '--authority', 'direct'] },
  { label: 'ratify: an empty task list is not a plan', argv: ['sprint', 'ratify', 'SP-0003', '--by', 'User', '--authority', 'direct'] },
  { label: 'ratify: an ABSENT task list is not a plan either', argv: ['sprint', 'ratify', 'SP-0004', '--by', 'User', '--authority', 'direct'] },
  { label: 'ratify: an unknown flag', argv: ['sprint', 'ratify', 'SP-0001', '--nope'] },

  // ---- status -----------------------------------------------------------
  { label: 'status: no positionals', argv: ['sprint', 'status'] },
  { label: 'status: no state', argv: ['sprint', 'status', 'SP-0001'] },
  { label: 'status: a state this verb does not own', argv: ['sprint', 'status', 'SP-0001', 'ratified'] },
  { label: 'status: a sprint that does not exist', argv: ['sprint', 'status', 'SP-9999', 'complete'] },
  { label: 'status: complete', argv: ['sprint', 'status', 'SP-0001', 'complete'] },
  { label: 'status: abandoned', argv: ['sprint', 'status', 'SP-0001', 'abandoned'] },

  // ---- the dispatcher's own arm ----------------------------------------
  { label: 'an unknown verb', argv: ['sprint', 'nope'] },
];

/**
 * The CLI, driven at the module seam the dispatcher drives it at.
 *
 * `new Cli(\`sprint ${verb}\`, ...)` is not decoration: `Cli.refuse` renders
 * `scrumux <command>: error: <message>`, so a harness that passed the bare
 * verb would produce `scrumux new: error: ...` and every stderr assertion
 * below would be pinning the wrong string.
 */
function drive(mod: NounModule, root: string, verb: string, args: readonly string[], json = false): Driven {
  const io = captureIo();
  const cli = new Cli(`sprint ${verb}`, [...args], json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctxFor(root), io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

/**
 * REDACTION, so a snapshot is about BEHAVIOUR and not about where the case ran.
 * The scratch root is a fresh mkdtemp per case and the stamp is today's date;
 * both appear inside messages, and neither is what the battery is pinning.
 */
function redact(text: string, root: string): string {
  return text.split(root).join('<ROOT>').split(todayStamp()).join('<DATE>');
}

describe('sprint: every arm, pinned as a golden rather than remembered', () => {
  // WAS A COMPARISON AGAINST BASH, one CLI per case, and the cutover made that
  // half inert — the flip routes the same argv to this code, so it compared
  // this code with itself. The CASES are the value and they are all still here:
  // every arm of every verb, both dispositions, run once and pinned. A golden
  // notices a change in any of the four channels the comparison used to cover
  // (exit code, stdout, stderr, post-state) without needing a second
  // implementation to be standing there.
  for (const { label, argv } of BATTERY) {
    it(label, () => {
      const verb = argv[1]!;
      const args = argv.slice(2);

      const tsRoot = caseRepo();
      try {
        const ts = drive(sprint, tsRoot, verb, args);
        expect({
          rc: ts.rc,
          stdout: redact(ts.io.stdout, tsRoot),
          stderr: redact(ts.io.stderr, tsRoot),
          sprints: redact(sprintsText(tsRoot), tsRoot),
        }, label).toMatchSnapshot();
      } finally {
        rmSync(tsRoot, { recursive: true, force: true });
      }
    });
  }

  it('the battery really does exercise both dispositions of every verb', () => {
    // A battery that had drifted into refusals-only would still be green
    // above, and would prove nothing about the write paths. Counted rather
    // than trusted.
    const verbs = new Set(BATTERY.map((c) => c.argv[1]!));
    for (const v of VERBS) expect(verbs, `verb ${v} is in the battery`).toContain(v);
    expect(BATTERY.length).toBeGreaterThanOrEqual(60);
  });
});

// -------------------------------------------------- the records, absolutely --

/**
 * Byte-parity proves AGREEMENT. It does not prove the agreed record is the
 * right one, and every field below is a contract something reads back.
 */
describe('sprint: the journal bytes each verb writes', () => {
  it('new --epic records parallel as a NUMBER, and the null-or-value shapes', () => {
    const root = caseRepo();
    try {
      const { io, rc } = drive(sprint, root, 'new', ['--epic', 'E-0001', '--parallel', '007']);
      expect(rc).toBe(0);
      expect(io.stdout, 'the bare id, so ID=$(scrumux sprint new ...) keeps working').toBe('SP-0005\n');
      expect(sprintRow(root, 'SP-0005')).toEqual({
        id: 'SP-0005',
        epic: 'E-0001',
        hotfix: false,
        source_issue: null,
        tasks: [],
        status: 'proposed',
        // jq's own parse canonicalises `007`; `parallel_guard` admits any run
        // of digits, so the guard is not what normalises it.
        parallel: 7,
        created_at: TODAY,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('new --hotfix forces parallel to 1 and carries source_issue, never an epic', () => {
    const root = caseRepo();
    try {
      expect(drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']).rc).toBe(0);
      expect(sprintRow(root, 'SP-0005')).toEqual({
        id: 'SP-0005',
        epic: null,
        hotfix: true,
        source_issue: 'I-0001',
        tasks: [],
        status: 'proposed',
        parallel: 1,
        created_at: TODAY,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('add SORTS: T-0001 lands AHEAD of the T-0009 that was already there', () => {
    // jq's `unique` is sort-and-dedupe. The reorder is observable in
    // BACKLOG.MD and in the post-state, so it is the contract, not a detail.
    const root = caseRepo();
    try {
      const { io, rc } = drive(sprint, root, 'add', ['SP-0001', 'T-0001']);
      expect(rc).toBe(0);
      expect(io.stdout).toBe('T-0001 added to SP-0001\n');
      expect(sprintRow(root, 'SP-0001')['tasks']).toEqual(['T-0001', 'T-0009']);
      expect(sprintRow(root, 'SP-0001')['updated_at']).toBe(TODAY);
      // …and it touched nothing else.
      expect(sprintRow(root, 'SP-0002')['tasks']).toEqual(['T-0009']);
      expect(sprintRow(root, 'SP-0002')).not.toHaveProperty('updated_at');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('add DEDUPES: adding a task the sprint already carries is a no-op on the array', () => {
    const root = caseRepo();
    try {
      expect(drive(sprint, root, 'add', ['SP-0001', 'T-0009']).rc).toBe(0);
      expect(sprintRow(root, 'SP-0001')['tasks']).toEqual(['T-0009']);
      // The write still HAPPENED -- `updated_at` moves -- which is the half
      // an "optimise the no-op away" change would silently drop.
      expect(sprintRow(root, 'SP-0001')['updated_at']).toBe(TODAY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('add creates the tasks array when the sprint has no tasks key', () => {
    const root = caseRepo();
    try {
      expect(drive(sprint, root, 'add', ['SP-0004', 'T-0001']).rc).toBe(0);
      expect(sprintRow(root, 'SP-0004')['tasks']).toEqual(['T-0001']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('descope APPENDS to .descoped and leaves a prior entry standing', () => {
    const root = caseRepo();
    try {
      // A sprint that has already been descoped once. The second descope must
      // not replace the first: `.descoped = ((.descoped // []) + [...])`.
      const gov = join(root, 'governance');
      const doc = JSON.parse(readFileSync(join(gov, 'sprints.json'), 'utf8')) as { entries: Row[] };
      const sp = doc.entries.find((r) => r['id'] === 'SP-0001')!;
      sp['tasks'] = ['T-0001', 'T-0009'];
      sp['descoped'] = [{ task: 'T-0042', reason: 'an earlier ruling', date: '2026-08-01' }];
      writeFileSync(join(gov, 'sprints.json'), J(doc));

      const { io, rc } = drive(sprint, root, 'descope', ['SP-0001', 'T-0009', '--reason', 'superseded by T-0217']);
      expect(rc).toBe(0);
      expect(io.stdout).toContain('TELL: T-0009 has 2 log entry/entries');
      expect(io.stdout).toContain('descoping does not erase them');
      expect(io.stdout.endsWith('T-0009 descoped from SP-0001\n')).toBe(true);

      const row = sprintRow(root, 'SP-0001');
      expect(row['tasks'], 'only the named task leaves').toEqual(['T-0001']);
      expect(row['descoped']).toEqual([
        { task: 'T-0042', reason: 'an earlier ruling', date: '2026-08-01' },
        { task: 'T-0009', reason: 'superseded by T-0217', date: TODAY },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('descope is SILENT when the repo has never logged, and when nothing matches', () => {
    // The TELL is computed only when `log.json` EXISTS -- a repo that has
    // never logged is silent rather than told, which is the same silence as
    // zero matches. Both arms, because one of them is an `existsSync` and the
    // other is a count, and a refactor that collapsed them would keep this
    // green only by accident.
    for (const [what, write] of [
      ['no log.json at all', (gov: string) => rmSync(join(gov, 'log.json'), { force: true })],
      ['a log.json with no matching task', (gov: string) => writeFileSync(join(gov, 'log.json'), J({ entries: [{ id: 'L-0001', task: 'T-0001' }] }))],
      // `rows()` is tolerant by design: `jq -r` on an unreadable journal hands
      // bash nothing, so an unparseable log is zero matches and not a crash.
      ['an UNPARSEABLE log.json', (gov: string) => writeFileSync(join(gov, 'log.json'), '{not json\n')],
      ['a log.json that is not an object', (gov: string) => writeFileSync(join(gov, 'log.json'), '[]\n')],
      ['a log.json whose entries is not an array', (gov: string) => writeFileSync(join(gov, 'log.json'), J({ entries: 3 }))],
    ] as const) {
      const root = caseRepo();
      try {
        write(join(root, 'governance'));
        const { io, rc } = drive(sprint, root, 'descope', ['SP-0001', 'T-0009', '--reason', 'r']);
        expect(rc, what).toBe(0);
        expect(io.stdout, what).toBe('T-0009 descoped from SP-0001\n');
        expect(sprintRow(root, 'SP-0001')['tasks'], what).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('ratify records by, date and authority -- the basis, not the actor (P-21)', () => {
    const root = caseRepo();
    try {
      const { io, rc } = drive(sprint, root, 'ratify', ['SP-0001', '--by', 'agent-7', '--authority', 'app:sess-1']);
      expect(rc).toBe(0);
      expect(io.stdout).toBe('SP-0001 ratified\n');
      const row = sprintRow(root, 'SP-0001');
      expect(row['status']).toBe('ratified');
      expect(row['ratified']).toEqual({ by: 'agent-7', date: TODAY, authority: 'app:sess-1' });
      expect(row['updated_at']).toBe(TODAY);
      // NOTHING VERIFIES WHO IS CALLING. `--by agent-7` is recorded verbatim,
      // which is the point of removing the `User` default rather than a gap
      // in this test.
      expect(String(readFileSync(join(root, 'governance', 'sprints.json'), 'utf8'))).toContain('"by": "agent-7"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('update writes the number and the stamp, and only on the named sprint', () => {
    const root = caseRepo();
    try {
      const { io, rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '030']);
      expect(rc).toBe(0);
      expect(io.stdout, 'the summary echoes the RAW flag, not the parsed number').toBe(
        'SP-0001 updated — up to 030 task(s) in flight once it is ratified\n',
      );
      expect(sprintRow(root, 'SP-0001')['parallel'], 'the record carries the number').toBe(30);
      expect(sprintRow(root, 'SP-0001')['updated_at']).toBe(TODAY);
      expect(sprintRow(root, 'SP-0004')['parallel']).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('status moves only status and updated_at', () => {
    const root = caseRepo();
    try {
      const { io, rc } = drive(sprint, root, 'status', ['SP-0001', 'abandoned']);
      expect(rc).toBe(0);
      expect(io.stdout).toBe('SP-0001 -> abandoned\n');
      expect(sprintRow(root, 'SP-0001')).toEqual({
        id: 'SP-0001', epic: 'E-0001', hotfix: false, source_issue: null,
        tasks: ['T-0009'], status: 'abandoned', parallel: 1,
        created_at: '2026-08-01', updated_at: TODAY,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------- the two gates --

/**
 * THE PROMOTION GATE AND THE RE-RATIFICATION GUARD, from both directions.
 *
 * `test/unit/rulings-hardenE.test.ts` pins the R-011 family -- a `.validation`
 * that is not an object -- against bash per side. What is here is the arm
 * *inside* the gate: a `.validation` that IS an object, whose `verdict` is a
 * shape `jqRaw` has to render rather than a string. `{"verdict":["reproduced"]}`
 * is the SAME one-element-array trick one level deeper, and the fix that closed
 * `{"validation":["reproduced"]}` closed this too -- but nothing was holding it.
 */
describe('the hotfix promotion gate: one level deeper than R-011', () => {
  function withValidation(root: string, validation: unknown): void {
    writeFileSync(join(root, 'governance', 'issues.json'), J({
      entries: [{
        id: 'I-0001', type: 'defect', source: 'claude', summary: 's',
        status: 'open', created_at: '2026-08-01', validation,
      }],
    }));
  }

  const GATE = 'carries a validation verdict this gate does not recognise';

  it('a verdict that is a one-element ARRAY does not read as the word inside it', () => {
    // THE REGRESSION TEST FOR THE FAIL-OPEN, at the `.verdict` level rather
    // than the `.validation` level. `String(['reproduced'])` is the bare word
    // `reproduced`; JSON text is `["reproduced"]`, which matches no arm.
    for (const [verdict, rendered] of [
      [['reproduced'], '["reproduced"]'],
      [['evidenced'], '["evidenced"]'],
      [['invalidated'], '["invalidated"]'],
      [42, '42'],
      [true, 'true'],
      [false, 'false'],
      [{ verdict: 'reproduced' }, '{"verdict":"reproduced"}'],
    ] as const) {
      const root = caseRepo();
      try {
        withValidation(root, { verdict });
        const before = sprintsText(root);
        const { io, rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
        expect(rc, `verdict ${JSON.stringify(verdict)}`).toBe(2);
        expect(io.stderr, `verdict ${JSON.stringify(verdict)}`).toContain(`${GATE} (verdict: ${rendered})`);
        // A GATE THAT REFUSES AND ALLOCATES AN SP ID ANYWAY HAS NOT REFUSED.
        expect(sprintsText(root), `verdict ${JSON.stringify(verdict)}`).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('a NUMERIC `.validation` is rendered as the number, box and all', () => {
    // THE OTHER HALF OF THE SAME REPAIR, and it is `obj()` rather than
    // `jqRaw`. `parsePreservingNumbers` boxes every number so jq's byte-exact
    // output can be reproduced, and the box is a JavaScript object -- so a
    // predicate that tested only `typeof v === 'object'` handed this gate an
    // "object" with no `verdict` key, and the refusal quoted the four letters
    // `null` instead of the number the operator can see in the file. The
    // correct predicate has been in `src/nouns/task/shared.ts` since Wave 4G;
    // this was the un-updated copy.
    //
    // The literal below is DELIBERATELY wider than a JS double: 20 digits
    // round in `Number`, and the box exists precisely so they do not. A port
    // that unboxed through arithmetic would print 12345678901234567000 here.
    //
    // R-011 governs the WORDS this refusal uses; what it must never do is
    // fall through, which the exit code below is standing in for.
    const root = caseRepo();
    try {
      writeFileSync(join(root, 'governance', 'issues.json'),
        '{"entries": [{"id": "I-0001", "summary": "s", "status": "open", "validation": 12345678901234567890}]}\n');
      const { io, rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain(`${GATE} (verdict: 12345678901234567890)`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('…and the POSITIVE CONTROL: the two passing verdicts still open the lane', () => {
    // Without this, everything above is satisfied by a gate that refuses every
    // hotfix -- a different defect with identical test results.
    for (const verdict of ['reproduced', 'evidenced']) {
      const root = caseRepo();
      try {
        withValidation(root, { verdict, evidence: 'e' });
        const { rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
        expect(rc, `verdict ${verdict}`).toBe(0);
        expect(sprintRow(root, 'SP-0005')['hotfix']).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('the duplicate arm renders duplicate_of the way jq\'s `// "?"` does', () => {
    // `null` and `false` both become `?`; `0` and `""` do NOT, because jq's
    // alternative operator is falsy on exactly null and false. A JS `||` here
    // would print `?` for the empty string and for zero.
    for (const [dup, shown] of [
      ['I-0002', 'I-0002'],
      [null, '?'],
      [false, '?'],
      [0, '0'],
      ['', ''],
      [['I-0002'], '["I-0002"]'],
    ] as const) {
      const root = caseRepo();
      try {
        withValidation(root, { verdict: 'duplicate', duplicate_of: dup });
        const { io, rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
        expect(rc, `duplicate_of ${JSON.stringify(dup)}`).toBe(2);
        expect(io.stderr, `duplicate_of ${JSON.stringify(dup)}`).toContain(
          `sprint new: I-0001 is a duplicate of ${shown} — work the original`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('an ABSENT duplicate_of is `?` too', () => {
    const root = caseRepo();
    try {
      withValidation(root, { verdict: 'duplicate' });
      const ts = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
      expect(ts.rc).toBe(2);
      expect(ts.io.stderr).toContain('is a duplicate of ? — work the original');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('`.validation: null` is `none`, so authorization alone still decides it', () => {
    // The gate reads TWO DISJOINT FIELDS (I-0010) and an explicit null
    // validation is not a verdict. Both dispositions, on the same shape.
    const refused = caseRepo();
    const opened = caseRepo();
    try {
      writeFileSync(join(refused, 'governance', 'issues.json'), J({
        entries: [{ id: 'I-0001', summary: 's', status: 'open', validation: null, authorization: null }],
      }));
      const a = drive(sprint, refused, 'new', ['--hotfix', '--issue', 'I-0001']);
      expect(a.rc).toBe(2);
      expect(a.io.stderr).toContain('has neither validation nor authorization');

      writeFileSync(join(opened, 'governance', 'issues.json'), J({
        entries: [{ id: 'I-0001', summary: 's', status: 'open', validation: null, authorization: { by: 'User' } }],
      }));
      expect(drive(sprint, opened, 'new', ['--hotfix', '--issue', 'I-0001']).rc).toBe(0);
    } finally {
      rmSync(refused, { recursive: true, force: true });
      rmSync(opened, { recursive: true, force: true });
    }
  });
});

describe('the D-0084 re-ratification guard: every status that is not `proposed`', () => {
  function withStatus(root: string, status: unknown, extra: Record<string, unknown> = {}): void {
    writeFileSync(join(root, 'governance', 'sprints.json'), J({
      entries: [{ id: 'SP-0001', epic: 'E-0001', hotfix: false, source_issue: null, tasks: ['T-0009'], status, parallel: 1, created_at: '2026-08-01', ...extra }],
    }));
  }

  it('refuses every non-`proposed` status, quoting it as jq -r would render it', () => {
    for (const [status, shown] of [
      ['ratified', 'ratified'],
      ['complete', 'complete'],
      ['abandoned', 'abandoned'],
      // THE FAIL-OPEN. `["proposed"]` rendered through `String()` as the bare
      // word and walked past this guard, widening a RATIFIED plan.
      [['proposed'], '["proposed"]'],
      [{ name: 'proposed' }, '{"name":"proposed"}'],
      [42, '42'],
      [true, 'true'],
      [null, 'null'],
    ] as const) {
      const root = caseRepo();
      try {
        withStatus(root, status);
        const { io, rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '3']);
        expect(rc, `status ${JSON.stringify(status)}`).toBe(2);
        expect(io.stderr, `status ${JSON.stringify(status)}`).toContain(
          `sprint update: SP-0001 is ${shown} — changing how many tasks a RATIFIED plan runs at once is a re-ratification, not an edit (D-0084).`,
        );
        expect(sprintsText(root), 'and the cap is untouched').toContain('"parallel": 1');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('…and the POSITIVE CONTROL: `proposed` IS widened, to the number asked for', () => {
    const root = caseRepo();
    try {
      withStatus(root, 'proposed');
      const { rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '3']);
      expect(rc).toBe(0);
      expect(sprintRow(root, 'SP-0001')['parallel']).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the hotfix test runs BEFORE the status test, so a hotfix is refused as one', () => {
    // Not an accident of reading order: bash tests `$SPHOT` first, so a
    // RATIFIED hotfix sprint earns the "one issue, one task, one slot"
    // refusal and never the re-ratification one. A port that reordered the
    // two would change which paragraph an operator reads.
    const root = caseRepo();
    try {
      withStatus(root, 'ratified', { hotfix: true });
      const { io, rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '3']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('is a hotfix sprint — one issue, one task, one slot');
      expect(io.stderr).not.toContain('re-ratification');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a hotfix flag that is not the boolean true does NOT close the hotfix arm', () => {
    // `jq -r .hotfix` is compared against the four bytes `true`. The STRING
    // "true" renders as those four bytes and DOES close it; `1` and
    // `["true"]` do not. Pinned because it is the same rendering seam as the
    // two fail-opens, read from the other side.
    for (const [hot, closes] of [
      [true, true],
      ['true', true],
      [1, false],
      [['true'], false],
      [false, false],
      [null, false],
    ] as const) {
      const root = caseRepo();
      try {
        withStatus(root, 'proposed', { hotfix: hot });
        const { io, rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '3']);
        if (closes) {
          expect(rc, `hotfix ${JSON.stringify(hot)}`).toBe(2);
          expect(io.stderr, `hotfix ${JSON.stringify(hot)}`).toContain('is a hotfix sprint');
        } else {
          expect(rc, `hotfix ${JSON.stringify(hot)}`).toBe(0);
          expect(sprintRow(root, 'SP-0001')['parallel'], `hotfix ${JSON.stringify(hot)}`).toBe(3);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

// ------------------------------------------- malformed journal shapes --

describe('sprint: malformed journal shapes', () => {
  it('a `tasks` value that is not an array is read as "carries nothing"', () => {
    // A non-array `tasks` is treated as empty, so the verb reaches the "not
    // carried by" refusal rather than throwing. Four shapes, one disposition.
    for (const tasks of [42, 'T-0009', { '0': 'T-0009' }, null]) {
      const root = caseRepo();
      try {
        writeFileSync(join(root, 'governance', 'sprints.json'), J({
          entries: [{ id: 'SP-0001', hotfix: false, tasks, status: 'proposed', parallel: 1 }],
        }));
        const { io, rc } = drive(sprint, root, 'descope', ['SP-0001', 'T-0009', '--reason', 'r']);
        expect(rc, `tasks ${JSON.stringify(tasks)}`).toBe(2);
        expect(io.stderr, `tasks ${JSON.stringify(tasks)}`).toContain(
          'sprint descope: T-0009 is not carried by SP-0001',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('a non-object row in `entries` is skipped, not crashed on', () => {
    // `jq -r '.entries[] | select(.id==$id)'` on a number is an error and
    // bash's `ref_exists` is `jq -e`, so this journal never gets past the
    // reference check on that side. The port must not throw either: `rows`
    // and `obj` are tolerant precisely so a malformed row says nothing about
    // the other rows.
    const root = bareRepo();
    try {
      writeFileSync(join(root, 'governance', 'sprints.json'),
        '{"entries": [42, "SP-0001", null, ["SP-0001"], {"id": "SP-0001", "hotfix": false, "tasks": [], "status": "proposed", "parallel": 1}]}\n');
      const { rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '2']);
      expect(rc, 'the real row is still found behind the junk').toBe(0);
      expect(sprintRow(root, 'SP-0001')['parallel']).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an UNPARSEABLE sprints.json is "not found", not a crash', () => {
    // `jq -e` on a corrupt file is non-zero, which is bash's "does not exist"
    // for every reference helper. Reproduced, not tightened: a reference check
    // is not the surface that reports a corrupt journal.
    const root = bareRepo();
    try {
      writeFileSync(join(root, 'governance', 'sprints.json'), '{not json\n');
      const { io, rc } = drive(sprint, root, 'update', ['SP-0001', '--parallel', '2']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('sprint update: SP-0001 not found in sprints.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a task_order that is a NUMBER is not a light order', () => {
    // D-0073's relaxation is carried by the ORDER, so an order the light test
    // cannot read is simply not a light one and the story requirement stands.
    //
    // R-011-CLASS, UNRULED: bash reaches the identical refusal at exit 2, but
    // `jq -r '.task_order.light == true'` errors first and prints
    // `Cannot index number with string "light"` to stderr naming the
    // journal's absolute path. Measured below, asserted per side. NOT a
    // fixture, for the same reason R-011 is not one.
    const root = caseRepo();
    try {
      writeFileSync(join(root, 'governance', 'tasks.json'), J({
        entries: [{ id: 'T-0006', title: 'odd order', status: 'proposed', acceptance_check: 'c', task_order: 42 }],
      }));
      const { io, rc } = drive(sprint, root, 'add', ['SP-0001', 'T-0006']);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(
        'scrumux sprint add: error: one user story per task: T-0006 has no story — set it via scrumux task order T-0006 --story S-XXXX ... (hotfix sprints and light orders are the storyless lanes; mint a light one with scrumux task order T-0006 --light ...)\n',
      );
      // The CLI has the value in hand, so it needs no interpreter diagnostic:
      // the refusal is the whole of what the operator sees.
      expect(io.stderr).not.toContain('Cannot index');
      expect(io.stderr).not.toContain('jq: error');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a light flag that is not the boolean true does not open the storyless lane', () => {
    // `.task_order.light == true` is STRICT. The string "true" does not open
    // it, which is the opposite of `sprint update`'s `.hotfix` test -- that
    // one goes through `jq -r` and compares four bytes. Two probes over two
    // fields with two different semantics; collapsing them is the change this
    // notices.
    for (const [light, opens] of [
      [true, true],
      ['true', false],
      [1, false],
      [null, false],
    ] as const) {
      const root = caseRepo();
      try {
        writeFileSync(join(root, 'governance', 'tasks.json'), J({
          entries: [{ id: 'T-0006', title: 't', status: 'proposed', acceptance_check: 'c', task_order: { scope: 's', light } }],
        }));
        const { io, rc } = drive(sprint, root, 'add', ['SP-0001', 'T-0006']);
        if (opens) {
          expect(rc, `light ${JSON.stringify(light)}`).toBe(0);
          expect(sprintRow(root, 'SP-0001')['tasks']).toEqual(['T-0006', 'T-0009']);
        } else {
          expect(rc, `light ${JSON.stringify(light)}`).toBe(2);
          expect(io.stderr, `light ${JSON.stringify(light)}`).toContain('one user story per task: T-0006 has no story');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('a story that is an explicit null is no story', () => {
    const root = caseRepo();
    try {
      writeFileSync(join(root, 'governance', 'tasks.json'), J({
        entries: [{ id: 'T-0006', title: 't', status: 'proposed', acceptance_check: 'c', story: null, task_order: { scope: 's' } }],
      }));
      const { io, rc } = drive(sprint, root, 'add', ['SP-0001', 'T-0006']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('one user story per task: T-0006 has no story');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a DIRECTORY where sprints.json belongs refuses rather than throwing', () => {
    // `ensure_file` is `printf … > "$1" || die "cannot create $1"`, and a
    // directory in the way is the one shape that reaches the `die`. The port
    // routes the same refusal through `refusing()`, which is what stops an
    // engine exception surfacing as a stack trace where bash printed a
    // sentence.
    const root = bareRepo();
    try {
      mkdirSync(join(root, 'governance', 'sprints.json'), { recursive: true });
      writeFileSync(join(root, 'governance', 'design.json'), J({
        entries: [{ id: 'E-0001', kind: 'epic', name: 'e' }],
      }));
      const { io, rc } = drive(sprint, root, 'new', ['--epic', 'E-0001']);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(
        `scrumux sprint new: error: cannot create ${join(root, 'governance', 'sprints.json')}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sprints.json is SEEDED when it does not exist yet', () => {
    // The positive half of the same statement: a fresh repo opens its first
    // sprint rather than refusing, and the seed is `{"entries": []}` before
    // the append rewrites it.
    const root = bareRepo();
    try {
      writeFileSync(join(root, 'governance', 'design.json'), J({
        entries: [{ id: 'E-0001', kind: 'epic', name: 'e' }],
      }));
      const { io, rc } = drive(sprint, root, 'new', ['--epic', 'E-0001']);
      expect(rc).toBe(0);
      expect(io.stdout).toBe('SP-0001\n');
      expect(sprintRow(root, 'SP-0001')['epic']).toBe('E-0001');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------- the flag seam --

describe('sprint: the flag loops', () => {
  /**
   * A FLAG WITH NO VALUE. bash reads `${2?}`, and an unset positional in a
   * non-interactive `sh` aborts the shell with the shell's OWN diagnostic --
   * not a `die`, so there is no `scrumux …: error:` line and no envelope. The
   * port refuses in the CLI's own voice instead. Asserted here as the port's
   * absolute; the exit code is the half that agrees.
   */
  for (const [verb, flag] of [
    ['new', '--epic'],
    ['new', '--issue'],
    ['new', '--parallel'],
    ['update', '--parallel'],
    ['ratify', '--by'],
    ['ratify', '--authority'],
    ['descope', '--reason'],
  ] as const) {
    it(`${verb} ${flag} with no value refuses in the CLI's own voice`, () => {
      const root = caseRepo();
      try {
        const args = verb === 'new' ? [flag] : verb === 'descope' ? ['SP-0001', 'T-0009', flag] : ['SP-0001', flag];
        const { io, rc } = drive(sprint, root, verb, args);
        expect(rc).toBe(2);
        expect(io.stderr).toBe(`scrumux sprint ${verb}: error: sprint ${verb}: ${flag} needs a value\n`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('a repeated flag keeps the LAST value, on every verb that takes one', () => {
    const root = caseRepo();
    try {
      expect(drive(sprint, root, 'new', ['--epic', 'E-9999', '--epic', 'E-0001']).rc).toBe(0);
      expect(sprintRow(root, 'SP-0005')['epic']).toBe('E-0001');
      expect(drive(sprint, root, 'update', ['SP-0001', '--parallel', '2', '--parallel', '5']).rc).toBe(0);
      expect(sprintRow(root, 'SP-0001')['parallel']).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--hotfix is a BARE flag: it consumes one token, not two', () => {
    // If it consumed two, `--hotfix --issue I-0001` would eat `--issue` and
    // then refuse for want of one -- which is exactly what the bug looks like.
    const root = caseRepo();
    try {
      const { rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
      expect(rc).toBe(0);
      expect(sprintRow(root, 'SP-0005')['source_issue']).toBe('I-0001');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------- the module --

describe('sprint: the module seam', () => {
  it('the verb table lists exactly the verbs the dispatcher accepts', () => {
    const listed = sprint.verbs().trimEnd().split('\n').map((l) => l.split('\t')[0]!);
    expect(listed).toEqual([...VERBS]);
    // …and each carries a description, because `scrumux help` renders this
    // table and a bare verb name is not help.
    for (const line of sprint.verbs().trimEnd().split('\n')) {
      expect(line.split('\t')[1] ?? '', line).not.toBe('');
    }
  });

  it('the usage text names every verb and the D-0084 rule', () => {
    const u = sprint.usage();
    for (const v of VERBS) expect(u, `usage names ${v}`).toContain(`scrumux sprint ${v}`);
    expect(u).toContain('D-0084');
  });

  it('an unknown verb is a USAGE refusal that names the six', () => {
    const root = caseRepo();
    try {
      const { io, rc } = drive(sprint, root, 'nope', []);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(
        "scrumux sprint nope: error: unknown verb 'nope' for noun sprint — verbs: new, add, update, descope, ratify, status. See: scrumux help sprint\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--json: a success carries .data.id and a refusal carries .error.kind', () => {
    const root = caseRepo();
    try {
      const ok = drive(sprint, root, 'new', ['--epic', 'E-0001'], true);
      expect(ok.rc).toBe(0);
      const env = JSON.parse(ok.io.stdout) as { ok: boolean; data: { id: string }; command: string };
      expect(env.ok).toBe(true);
      expect(env.command).toBe('sprint new');
      expect(env.data.id).toBe('SP-0005');

      const bad = drive(sprint, root, 'update', ['SP-0002', '--parallel', '2'], true);
      expect(bad.rc).toBe(2);
      const denv = JSON.parse(bad.io.stdout) as { ok: boolean; exit: number; error: { kind: string; message: string } };
      expect(denv.ok).toBe(false);
      expect(denv.exit).toBe(2);
      expect(denv.error.kind).toBe('refused');
      expect(denv.error.message).toContain('re-ratification, not an edit (D-0084)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
