/**
 * Unit cover for the `task` noun -- `src/nouns/task.ts` and `src/nouns/task/**`.
 *
 * WHY THIS FILE EXISTS, given that the differential harness already compares
 * `task` against `.deploy-claude/scripts/lib/cmd-task.sh` byte for byte.
 *
 * A fixture proves the two implementations AGREE. It does not prove they agree
 * on the right thing, and it cannot reach three whole classes of behaviour that
 * this noun is made of:
 *
 *   1. THE REFUSAL SURFACE IS THE PRODUCT (Article 5). `task` refuses in ~40
 *      distinct ways, and most of them are paragraphs that name the repair
 *      command an operator is meant to run next. A differential case pins one
 *      shape per fixture and the corpus cannot afford forty; the refusals are
 *      therefore asserted here as ABSOLUTES -- the exact exit code, and the
 *      clause an operator would search for -- so a message that quietly loses
 *      its repair path goes red without needing a second implementation to
 *      disagree with.
 *
 *   2. THE TWO IMMUTABILITY PROBES DIFFER ON PURPOSE, and only a hand-built
 *      journal shows it. `acceptedTrue` is `// empty | first` (the string
 *      `"true"` counts, `false` does not); `acceptedStrictly` is
 *      `== true` (strictly boolean). Two probes over one field is the shape a
 *      later "simplification" collapses, and collapsing it either lets a
 *      rejected task be re-accepted or lets a hand-written `"true"` pass the
 *      final-authority gate. Both are exercised against journals a fixture
 *      would never produce, because `task accept` cannot write them.
 *
 *   3. THE GRAPH SHELL-OUT. `task lint` and `task brief` shell out to the
 *      sibling bash CLI for `graph gov bearing` and `graph code callers`, and
 *      the answer decides between a TELL, a FAIL and a WARN. Under the
 *      differential both sides consult the same real graph, so every branch
 *      the graph does NOT take that day is invisible. Here the child is a
 *      three-line stub whose canned answer is chosen per test (`fakeScripts`),
 *      which is the only way to see the I-0137 zero-decisions carve-out, the
 *      ">8 omitted refs" tail and the "callers: UNAVAILABLE" degradation in
 *      the same run.
 *
 * ALSO REACHED HERE AND NOWHERE ELSE: the two `write_receipt` guards in
 * `task verify` (a read-only `governance/` and a held journal lock -- both
 * assert that the verdict SURVIVES a failed receipt write, which is the whole
 * point of D-0007's subshell), and `rerunExit`'s 128+signal arm in
 * `task accept` (a verification command that kills itself).
 *
 * NOTHING HERE MAY BE "FIXED". Several shapes asserted below are deliberate
 * defects reproduced from bash and flagged in the source: the `@tsv` round
 * trip that EXECUTES an escaped health command, and the direct-print seam that
 * puts loose prose on stdout ahead of the `--json` envelope. They are pinned
 * AS THEY ARE; a change that repairs one must change these assertions on
 * purpose, with a ruling.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { RawNumber } from '../../src/journal/jqformat.js';
import { nounContext, todayStamp, type DispatchContext, type NounContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as task, _acceptedTrue, _rejectPrior } from '../../src/nouns/task.js';
import {
  arr,
  cliPath,
  bearingChangeIds,
  bearingChangedPaths,
  bearingRecordLines,
  directOut,
  interp,
  jqRaw,
  obj,
  rawOr,
  rowById,
  rows,
  runScrumux,
  sprintsPath,
  stripTrailingNewlines,
  tailOfCapture,
  tasksPath,
} from '../../src/nouns/task/shared.js';

const TODAY = todayStamp();
const J = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scrumux-taskE-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}

/**
 * A scripts directory with NO `scrumux` in it -- the default for these tests.
 *
 * `task lint` and `task brief` gate their shell-out on `[ -x $SCRIPTS/scrumux ]`,
 * so pointing at an empty directory takes the "graph unavailable" arm
 * deterministically. Pointing at this checkout's own `.deploy-claude/scripts`
 * instead would run the real CLI against a temp repo, which is slow, and would
 * make the branch a test takes depend on whether a graph index happens to
 * exist on the machine.
 */
const NO_SCRIPTS = mkdtempSync(join(tmpdir(), 'scrumux-taskE-noscripts-'));

interface FakeGraph {
  /** stdout for `graph gov bearing --task <id>`. */
  bearing?: string;
  /** stdout for `graph code callers <path>` -- the ANSWER stream. */
  callers?: string;
  callersRc?: number;
  callees?: string;
  calleesRc?: number;
  /**
   * STDERR, which is a separate channel here because the real `graph code`
   * writes its provenance banner, its NOT INDEXED notices and its staleness
   * line there on EVERY query, by design (P-20: a reader never withholds an
   * answer, it stamps it). A fixture that could only write stdout could not
   * express the input that produced the F5 defect.
   */
  callersErr?: string;
  calleesErr?: string;
}

/**
 * A stand-in for the sibling CLI: `<dir>/scrumux`, mode 755, answering only
 * the three subcommands these verbs ask for. `runScrumux` spawns this with
 * `process.execPath` now (bash retired), so the stub is a synthetic node
 * script, not a shell one — argv[4] is the verb (`graph`, `gov`, VERB, ...).
 */
function fakeScripts(g: FakeGraph): string {
  const dir = mkdtempSync(join(tmpdir(), 'scrumux-taskE-scripts-'));
  const arm = (verb: string, out: string | undefined, err: string | undefined, rc: number | undefined): string =>
    `  case ${JSON.stringify(verb)}: `
    + `${err !== undefined ? `process.stderr.write(${JSON.stringify(err)});` : ''} `
    + `process.stdout.write(${JSON.stringify(out ?? '')}); process.exit(${String(rc ?? 0)});\n`;
  const body =
    'switch (process.argv[4]) {\n' +
    arm('bearing', g.bearing, undefined, 0) +
    arm('callers', g.callers, g.callersErr, g.callersRc) +
    arm('callees', g.callees, g.calleesErr, g.calleesRc) +
    '  default: process.exit(0);\n}\n';
  const p = join(dir, 'scrumux');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return dir;
}

function ctxFor(root: string, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: TODAY,
    io: captureIo(),
    scriptsDir: NO_SCRIPTS,
    env: {},
    cwd: root,
    ...over,
  };
}

/** The resolved shape the `task/` helpers take, for the direct calls below. */
function nctx(root: string, scriptsDir = NO_SCRIPTS): NounContext {
  return nounContext(ctxFor(root, { scriptsDir }));
}

interface Driven {
  io: CapturedIo;
  rc: number;
}

function drive(mod: NounModule, ctx: DispatchContext, verb: string, args: string[], json = false): Driven {
  const io = captureIo();
  const cli = new Cli(`task ${verb}`, args, json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctx, io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

const gov = (root: string, name: string): string => join(root, 'governance', name);
function plant(root: string, name: string, doc: unknown): void {
  writeFileSync(gov(root, name), J(doc));
}
function entriesOf(root: string, name: string): Record<string, unknown>[] {
  return (JSON.parse(readFileSync(gov(root, name), 'utf8')) as { entries: Record<string, unknown>[] }).entries;
}
function entryOf(root: string, id: string, name = 'tasks.json'): Record<string, unknown> {
  return entriesOf(root, name).find((e) => e['id'] === id)!;
}

const seedTask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T-0001',
  title: 'Task one',
  acceptance_check: 'the thing is true',
  status: 'proposed',
  created_at: '2026-08-01',
  ...over,
});

/** A complete, lint-clean order, so a test can vary exactly one field. */
const fullOrder = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scope: 'change src/a.ts',
  out_of_scope: ['everything else'],
  verification_command: 'true',
  context: {
    files: [{ path: 'src/a.ts', why: 'the site' }],
    refs: [],
    commands: [],
    interfaces: [],
    data_shapes: [],
  },
  ...over,
});

const greenReceipt = (command = 'true'): Record<string, unknown> => ({
  date: '2026-08-20',
  at_epoch: 1755648000,
  command,
  rc: 0,
  checks_run: 1,
  checks_failed: 0,
});

// ===========================================================================
// task new
// ===========================================================================
describe('task new — the two required sentences and the promotion gate', () => {
  it('refuses an unknown flag, naming it', () => {
    const root = scratch();
    const { io, rc } = drive(task, ctxFor(root), 'new', ['--titel', 'oops']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      'scrumux task new: error: task new: unknown flag --titel — see: scrumux help task\n',
    );
  });

  it('refuses a truncated flag in this CLI\'s vocabulary, not the shell\'s (cmd-task.md OQ-1)', () => {
    // bash reaches `${2?}` here and prints an absolute path and a source line
    // number at exit 1. The port refuses at exit 2 in its own words rather
    // than pinning that rough edge as contract.
    const root = scratch();
    const { io, rc } = drive(task, ctxFor(root), 'new', ['--title']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task new: error: task: --title needs a value — see: scrumux help task\n');
  });

  it('refuses without --title, and the refusal carries the GOOD/BAD examples', () => {
    const root = scratch();
    const { io, rc } = drive(task, ctxFor(root), 'new', ['--check', 'c']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task new: --title is required');
    expect(io.stderr).toContain('BAD "fix session-check"');
  });

  it('refuses without --check, because the check is stated BEFORE work starts', () => {
    const root = scratch();
    const { io, rc } = drive(task, ctxFor(root), 'new', ['--title', 't']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task new: --check is required (the acceptance check, stated BEFORE work starts)');
    expect(io.stderr).toContain('BAD "works", "tests pass", "the fix is applied"');
  });

  it('writes the record with jq\'s key order, unranked, and emits the bare id', () => {
    const root = scratch();
    plant(root, 'design.json', {
      entries: [
        { id: 'F-0001', kind: 'feature', name: 'Feature one' },
        { id: 'S-0001', kind: 'story', narrative: 'as a user' },
      ],
    });
    const { io, rc } = drive(task, ctxFor(root), 'new', [
      '--title', 'The graph does not crash',
      '--check', 'tests exit 0',
      '--feature', 'F-0001',
      '--story', 'S-0001',
      '--desc', 'a longer description',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('T-0001\n');
    // The whole record, key order included: journals are compared byte for
    // byte, so where `description` lands is contract and not a detail.
    expect(JSON.stringify(entryOf(root, 'T-0001'))).toBe(
      JSON.stringify({
        id: 'T-0001',
        title: 'The graph does not crash',
        acceptance_check: 'tests exit 0',
        status: 'proposed',
        created_at: TODAY,
        feature: 'F-0001',
        story: 'S-0001',
        description: 'a longer description',
      }),
    );
  });

  it('leaves feature and story NULL rather than absent when neither is given (I-0040)', () => {
    const root = scratch();
    drive(task, ctxFor(root), 'new', ['--title', 't', '--check', 'c']);
    const row = entryOf(root, 'T-0001');
    expect(Object.keys(row)).toEqual(['id', 'title', 'acceptance_check', 'status', 'created_at', 'feature', 'story']);
    expect(row['feature']).toBeNull();
    expect(row['story']).toBeNull();
  });

  it('selects design.json on .kind as well as .id — a story id is not a feature', () => {
    const root = scratch();
    plant(root, 'design.json', { entries: [{ id: 'S-0001', kind: 'story', narrative: 'n' }] });
    const asFeature = drive(task, ctxFor(root), 'new', ['--title', 't', '--check', 'c', '--feature', 'S-0001']);
    expect(asFeature.rc).toBe(2);
    expect(asFeature.io.stderr).toContain('task new: feature S-0001 not found in design.json');
    const asStory = drive(task, ctxFor(root), 'new', ['--title', 't', '--check', 'c', '--story', 'S-0001']);
    expect(asStory.rc).toBe(0);
  });

  it('refuses a story that does not resolve, naming the story-new repair', () => {
    const root = scratch();
    plant(root, 'design.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'new', ['--title', 't', '--check', 'c', '--story', 'S-0009']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task new: story S-0009 not found in design.json — add it: scrumux story new');
  });

  describe('the --issue promotion gate (T-0113/I-0056)', () => {
    const withIssue = (validation: unknown): string => {
      const root = scratch();
      plant(root, 'issues.json', { entries: [{ id: 'I-0001', summary: 's', ...(validation === undefined ? {} : { validation }) }] });
      return root;
    };
    const promote = (root: string): Driven =>
      drive(task, ctxFor(root), 'new', ['--title', 't', '--check', 'c', '--issue', 'I-0001']);

    it('refuses an issue that is not in issues.json at all', () => {
      const root = scratch();
      plant(root, 'issues.json', { entries: [] });
      const { io, rc } = promote(root);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('task new: issue I-0001 not found in issues.json');
    });

    it('opens for a reproduced verdict', () => {
      expect(promote(withIssue({ verdict: 'reproduced' })).rc).toBe(0);
    });

    it('opens for an evidenced verdict', () => {
      expect(promote(withIssue({ verdict: 'evidenced' })).rc).toBe(0);
    });

    it('refuses an invalidated issue — the disproof is the deliverable (D-0011)', () => {
      const { io, rc } = promote(withIssue({ verdict: 'invalidated' }));
      expect(rc).toBe(2);
      expect(io.stderr).toContain('task new: I-0001 was invalidated — close it instead of building on it');
      expect(io.stderr).toContain('scrumux issue update I-0001 --status rejected');
    });

    it('refuses a duplicate, pointing at the task that owns the fix', () => {
      const { io, rc } = promote(withIssue({ verdict: 'duplicate' }));
      expect(rc).toBe(2);
      expect(io.stderr).toContain('task new: I-0001 is a duplicate — attach it to the task that owns the fix');
    });

    it('refuses an unvalidated issue and names the identity rule for the validator', () => {
      const { io, rc } = promote(withIssue(undefined));
      expect(rc).toBe(2);
      expect(io.stderr).toContain('task new: I-0001 has no validation verdict');
      expect(io.stderr).toContain('whose identity is NOT the source that raised I-0001');
    });

    it('treats a FALSE verdict as no verdict — `// ""` swallows false as well as null', () => {
      // `.validation.verdict // ""`. Hand-written, and the point: a port that
      // read the field with `??` would fall through to the "unknown verdict"
      // arm differently, and a `false` verdict must not open the gate.
      const { io, rc } = promote(withIssue({ verdict: false }));
      expect(rc).toBe(2);
      expect(io.stderr).toContain('has no validation verdict');
    });

    it('treats a NULL validation object as no verdict', () => {
      const { rc, io } = promote(withIssue(null));
      expect(rc).toBe(2);
      expect(io.stderr).toContain('has no validation verdict');
    });
  });
});

// ===========================================================================
// task status
// ===========================================================================
describe('task status — the transition guards', () => {
  it('prints the usage line when the id or the status is missing', () => {
    const root = scratch();
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      'usage: scrumux task status T-0001 <proposed|ready|in_progress|in_review|blocked|accepted|superseded>',
    );
  });

  it('refuses a status outside the seven, quoting what it was given', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'done']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      "task status: invalid status 'done' — one of proposed|ready|in_progress|in_review|blocked|accepted|superseded",
    );
  });

  it('refuses to move an ACCEPTED task, and says there is no reversing command (I-0147)', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'accepted', acceptance: { accepted: true, by: 'User', date: '2026-08-20' } })] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'in_progress']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain("T-0001 is ACCEPTED and cannot be moved to 'in_progress' by a status change");
    expect(io.stderr).toContain('There is NO command that reverses an acceptance');
    expect(io.stderr).toContain('scrumux repair journal tasks.json');
    // and nothing moved.
    expect(entryOf(root, 'T-0001')['status']).toBe('accepted');
  });

  it('admits the string "true" to that guard — `// empty | first` then a string compare', () => {
    // A HAND-WRITTEN journal: `task accept` writes a boolean, so only a
    // damaged or migrated record has the string. bash's `jq -r` renders both
    // as the four bytes `true`, and the guard compares the rendered text.
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ acceptance: { accepted: 'true', by: 'User', date: '2026-08-20' } })] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'ready']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('is ACCEPTED and cannot be moved');
  });

  it('lets superseded through the acceptance guard, because retiring is not moving', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'accepted', acceptance: { accepted: true, by: 'User', date: '2026-08-20' } })] });
    const { rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'superseded', '--reason', 'replaced by T-0002']);
    expect(rc).toBe(0);
    expect(entryOf(root, 'T-0001')['status']).toBe('superseded');
  });

  it('refuses a flag that is not --reason or --by', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'ready', '--why', 'x']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task status: unknown flag --why — only --reason (superseded, blocked) and --by (superseded)');
  });

  it('refuses a truncated --reason', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'superseded', '--reason']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task: --reason needs a value — see: scrumux help task');
  });

  it('refuses superseded with no --reason (I-0059)', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'superseded']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task status: superseded needs --reason TEXT');
    expect(io.stderr).toContain('BAD "no longer needed"');
  });

  it('refuses a --by that does not resolve to a task', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'superseded', '--reason', 'r', '--by', 'T-0099']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task T-0099 not found in governance/tasks.json');
  });

  it('refuses --reason on any status but superseded and blocked (SX-006)', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'ready', '--reason', 'r']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task status: error: task status: --reason belongs to superseded and blocked, --by to superseded only\n');
  });

  it('records the supersession as a nested object, with --by only when given', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask(), seedTask({ id: 'T-0002', title: 'the successor' })] });
    const { rc } = drive(task, ctxFor(root), 'status', [
      'T-0001', 'superseded', '--reason', 'D-0084 replaced the rule', '--by', 'T-0002',
    ]);
    expect(rc).toBe(0);
    expect(JSON.stringify(entryOf(root, 'T-0001'))).toBe(
      JSON.stringify({
        id: 'T-0001',
        title: 'Task one',
        acceptance_check: 'the thing is true',
        status: 'superseded',
        created_at: '2026-08-01',
        updated_at: TODAY,
        superseded: { reason: 'D-0084 replaced the rule', by: 'T-0002' },
      }),
    );
    // The other row is untouched, which is what `map(if .id==$id ...)` promises.
    expect(entryOf(root, 'T-0002')['updated_at']).toBeUndefined();
  });

  it('refuses an id that is not in tasks.json', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'ready']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      'task T-0001 not found in governance/tasks.json — create it first: scrumux task new --title ... --check ...',
    );
  });

  describe('in_progress and the D-0084 admission arithmetic', () => {
    it('keeps D-0006 for a task in no ratified sprint: one at a time', () => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask(), seedTask({ id: 'T-0002', status: 'in_progress' })] });
      const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'in_progress']);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(
        'scrumux task status: error: one task at a time: T-0002 is already in_progress — ' +
          'finish or move it first (scrumux task status T-0002 in_review|blocked)\n',
      );
    });

    it('refuses work in another sprint with the one-sprint-at-a-time refusal', () => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask(), seedTask({ id: 'T-0003', status: 'in_progress' })] });
      plant(root, 'sprints.json', { entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001'], parallel: 2 }] });
      const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'in_progress']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('one sprint at a time: T-0003 is in no ratified sprint');
      expect(io.stderr).toContain('or run this task under the sprint that is already in flight (D-0084)');
    });

    it("refuses at the sprint's declared cap, and calls widening it a re-ratification", () => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask(), seedTask({ id: 'T-0002', status: 'in_progress' })] });
      plant(root, 'sprints.json', {
        entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 1 }],
      });
      const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'in_progress']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('SP-0001 allows 1 in flight: T-0002 already in_progress');
      expect(io.stderr).toContain('The cap is the plan\'s, so widening it is a re-ratification, not an edit (D-0084)');
    });

    it('admits the second task under a cap of 2', () => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask(), seedTask({ id: 'T-0002', status: 'in_progress' })] });
      plant(root, 'sprints.json', {
        entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 2 }],
      });
      const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'in_progress']);
      expect(rc).toBe(0);
      expect(entryOf(root, 'T-0001')['status']).toBe('in_progress');
      expect(io.stdout).toContain('  T-0001 is the work in flight. Its acceptance check is the one thing that settles it.');
      expect(io.stdout).toContain('  next: scrumux task order T-0001 names the single command that proves it');
      expect(io.stdout.trimEnd().endsWith('T-0001 -> in_progress')).toBe(true);
    });
  });

  describe('a hand-driven move to accepted (T-0187/D-0076)', () => {
    it('refuses when there is no recorded acceptance', () => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_review' })] });
      const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'accepted']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain("acceptance is User's: T-0001 has no recorded acceptance");
      expect(io.stderr).toContain('scrumux task accept T-0001 --by User --authority direct|standing:D-XXXX');
    });

    it('refuses the STRING "true" here, where the I-0147 guard admitted it', () => {
      // The two probes differ on purpose: this one is `== true`, strictly
      // boolean. A journal carrying the string passes the guard above (which
      // is why it cannot be moved elsewhere) and still cannot be marked
      // accepted by hand.
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask({ acceptance: { accepted: 'true', by: 'User', date: '2026-08-20' } })] });
      const { io, rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'accepted']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('has no recorded acceptance');
    });

    it('allows it when acceptance.accepted is boolean true', () => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask({ acceptance: { accepted: true, by: 'User', date: '2026-08-20' } })] });
      const { rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'accepted']);
      expect(rc).toBe(0);
      expect(entryOf(root, 'T-0001')['status']).toBe('accepted');
    });
  });

  describe('the beats, which are human-mode only (cmd-task.sh:135-151)', () => {
    const move = (to: string, json = false): Driven => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask()] });
      return drive(task, ctxFor(root), 'status', ['T-0001', to], json);
    };

    it('in_review is ATTESTED, and says who may verify it', () => {
      const { io } = move('in_review');
      expect(io.stdout).toContain('  T-0001 recorded as ATTESTED — your claim about your own work, pending verification.');
      expect(io.stdout).toContain('  You may initiate verification; you may not be the thing that verifies it.');
      expect(io.stdout).toContain("  next: report it to whoever accepts; acceptance re-runs the order's verification command");
    });

    it('blocked tells the operator to capture the blocker rather than route around it', () => {
      const { io } = move('blocked');
      expect(io.stdout).toContain('  T-0001 is blocked and the sprint knows it.');
      expect(io.stdout).toContain('  next: capture what blocks it with scrumux issue; do not work around it');
    });

    it('says none of it under --json, where stdout carries exactly one object', () => {
      const { io, rc } = move('in_review', true);
      expect(rc).toBe(0);
      expect(io.stdout).not.toContain('ATTESTED');
      const env = JSON.parse(io.stdout) as { summary: string; data: { id: string; status: string } };
      expect(env.summary).toBe('T-0001 -> in_review');
      expect(env.data).toEqual({ id: 'T-0001', status: 'in_review' });
    });
  });
});

// ===========================================================================
// task order
// ===========================================================================
describe('task order — D-0005 completeness, enforced at the point of writing', () => {
  const withTask = (over: Record<string, unknown> = {}): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask(over)] });
    return root;
  };

  it('prints the usage line with no id', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'order', []);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task order T-0001 --scope ... --verify ... --file "path | why [| expected diff]"');
  });

  it('resolves the task BEFORE parsing its flags', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'order', ['T-0001', '--nonsense']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task T-0001 not found in governance/tasks.json');
  });

  it('refuses an unknown flag', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', ['T-0001', '--scoop', 'x']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: unknown flag --scoop — see: scrumux help task');
  });

  it('requires --scope, and the refusal names the three things a scope must state', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', ['T-0001', '--verify', 'true', '--file', 'a | b']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: --scope is required (what this task changes)');
    expect(io.stderr).toContain('BAD "fix the graph"');
  });

  it('requires exactly ONE --verify command, and says why a bare path is not one', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', ['T-0001', '--scope', 's', '--file', 'a | b']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: --verify is required');
    expect(io.stderr).toContain('27 of the 38 suites are mode 644 and exit 126 when invoked bare (D-0041)');
    expect(io.stderr).toContain('BAD "sh tests/a.sh && sh tests/b.sh"');
  });

  it('requires at least one --file: context is assembled, not searched (D-0005)', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', ['T-0001', '--scope', 's', '--verify', 'true']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: at least one --file "path | why" is required');
    expect(io.stderr).toContain('A file the task will CREATE goes on --artifact, not here.');
  });

  it('requires a why on every --file, and says the why is not the filename', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', [
      'T-0001', '--scope', 's', '--verify', 'true', '--file', 'src/a.ts | why', '--file', 'src/b.ts',
    ]);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: every --file needs a why');
    expect(io.stderr).toContain('BAD "path | the session check script"');
  });

  it('refuses a --story that does not resolve', () => {
    const root = withTask();
    plant(root, 'design.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'order', [
      'T-0001', '--scope', 's', '--verify', 'true', '--file', 'a | b', '--story', 'S-0002',
    ]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task order: error: task order: story S-0002 not found in design.json\n');
  });

  it('refuses refs that are not governance ids, listing every offender', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', [
      'T-0001', '--scope', 's', '--verify', 'true', '--file', 'a | b',
      '--ref', 'D-0001', '--ref', 'X-0001', '--ref', 'D-1',
    ]);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: --ref must be a governance id (D-/I-/C-/S-/F-/E-/L-NNNN), got: X-0001, D-1');
  });

  it('refuses an --artifact with whitespace, because session-check matches them as words', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'order', [
      'T-0001', '--scope', 's', '--verify', 'true', '--file', 'a | b', '--artifact', 'src/a b.ts',
    ]);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task order: --artifact paths cannot contain whitespace');
    expect(io.stderr).toContain('got: src/a b.ts');
  });

  it('writes the whole order, with the light mark first and the split --file segments', () => {
    const root = withTask();
    plant(root, 'design.json', { entries: [{ id: 'S-0001', kind: 'story', narrative: 'n' }] });
    const { io, rc } = drive(task, ctxFor(root), 'order', [
      'T-0001',
      '--light',
      '--story', 'S-0001',
      '--scope', 'change src/a.ts',
      '--verify', 'sh tests/a.sh',
      '--out', 'the other file',
      '--out', 'and that one',
      '--file', 'src/a.ts | the site | +10 -2',
      '--file', 'src/b.ts | context only',
      '--file', 'src/c.ts | why | diff | a fourth segment jq ignores',
      '--ref', 'D-0001',
      '--command', 'sh tests/a.sh',
      '--interface', 'run(x) -> y',
      '--shape', '{id: string}',
      '--artifact', 'src/new.ts',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('T-0001 order set');
    const row = entryOf(root, 'T-0001');
    expect(row['story']).toBe('S-0001');
    expect(row['updated_at']).toBe(TODAY);
    expect(JSON.stringify(row['task_order'])).toBe(
      JSON.stringify({
        light: true,
        scope: 'change src/a.ts',
        out_of_scope: ['the other file', 'and that one'],
        verification_command: 'sh tests/a.sh',
        context: {
          files: [
            { path: 'src/a.ts', why: 'the site', expected_diff: '+10 -2' },
            { path: 'src/b.ts', why: 'context only' },
            { path: 'src/c.ts', why: 'why', expected_diff: 'diff' },
          ],
          refs: ['D-0001'],
          commands: ['sh tests/a.sh'],
          interfaces: ['run(x) -> y'],
          data_shapes: ['{id: string}'],
          expected_artifacts: ['src/new.ts'],
        },
      }),
    );
  });

  it('omits expected_artifacts entirely when none were given, and carries no light key', () => {
    const root = withTask();
    drive(task, ctxFor(root), 'order', ['T-0001', '--scope', 's', '--verify', 'true', '--file', 'a | b']);
    const order = entryOf(root, 'T-0001')['task_order'] as Record<string, unknown>;
    expect(Object.keys(order)).toEqual(['scope', 'out_of_scope', 'verification_command', 'context']);
    expect(Object.keys(order['context'] as object)).toEqual(['files', 'refs', 'commands', 'interfaces', 'data_shapes']);
  });
});

// ===========================================================================
// task update
// ===========================================================================
describe('task update — the last route around an acceptance, closed 2026-08-27', () => {
  const withTask = (over: Record<string, unknown> = {}): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask(over)] });
    return root;
  };

  it('prints the usage line with no id', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'update', []);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task update T-0001 [--feature F-0001] [--story S-0001] [--title TEXT]');
  });

  it('refuses an ACCEPTED task and sends the correction through repair journal', () => {
    const root = withTask({ status: 'accepted', acceptance: { accepted: true, by: 'User', date: '2026-08-20' } });
    const { io, rc } = drive(task, ctxFor(root), 'update', ['T-0001', '--title', 'a new title']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task update: T-0001 is ACCEPTED and its record is closed');
    expect(io.stderr).toContain('this was the last route around it');
    expect(io.stderr).toContain("scrumux repair journal tasks.json --apply '<jq>' --why '<reason>'");
    expect(entryOf(root, 'T-0001')['title']).toBe('Task one');
  });

  it('still updates a REJECTED task — accepted:false is not an acceptance', () => {
    const root = withTask({ acceptance: { accepted: false, by: 'User', date: '2026-08-21', reason: 'sent back' } });
    const { rc } = drive(task, ctxFor(root), 'update', ['T-0001', '--title', 'reworked']);
    expect(rc).toBe(0);
    expect(entryOf(root, 'T-0001')['title']).toBe('reworked');
  });

  it('refuses an unknown flag', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'update', ['T-0001', '--rename', 'x']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task update: unknown flag --rename — see: scrumux help task');
  });

  it('refuses a no-op update', () => {
    const { io, rc } = drive(task, ctxFor(withTask()), 'update', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      'scrumux task update: error: task update: nothing to update — pass at least one of --feature/--story/--title/--desc\n',
    );
  });

  it('refuses a feature that does not resolve', () => {
    const root = withTask();
    plant(root, 'design.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'update', ['T-0001', '--feature', 'F-0009']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task update: feature F-0009 not found in design.json — add it: scrumux feature new');
  });

  it('refuses a story that does not resolve', () => {
    const root = withTask();
    plant(root, 'design.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'update', ['T-0001', '--story', 'S-0009']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task update: story S-0009 not found in design.json — add it: scrumux story new');
  });

  it('applies description, feature, story and title in jq\'s order and stamps updated_at last', () => {
    const root = withTask();
    plant(root, 'design.json', {
      entries: [
        { id: 'F-0001', kind: 'feature', name: 'f' },
        { id: 'S-0001', kind: 'story', narrative: 'n' },
      ],
    });
    const { io, rc } = drive(task, ctxFor(root), 'update', [
      'T-0001', '--desc', 'd', '--feature', 'F-0001', '--story', 'S-0001', '--title', 'renamed',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('T-0001 updated');
    expect(JSON.stringify(entryOf(root, 'T-0001'))).toBe(
      JSON.stringify({
        id: 'T-0001',
        title: 'renamed',
        acceptance_check: 'the thing is true',
        status: 'proposed',
        created_at: '2026-08-01',
        description: 'd',
        feature: 'F-0001',
        story: 'S-0001',
        updated_at: TODAY,
      }),
    );
  });
});

// ===========================================================================
// task accept
// ===========================================================================
describe('task accept — write-once, receipt-gated, and re-run rather than read', () => {
  const acceptable = (over: Record<string, unknown> = {}, vc = 'true'): string => {
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [seedTask({ status: 'in_review', task_order: fullOrder({ verification_command: vc }), receipt: greenReceipt(vc), ...over })],
    });
    return root;
  };

  it('points an R- target at the task, because the review panel is gone (D-0076)', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'accept', ['R-0001', '--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      'acceptance targets the task now: scrumux accept T-XXXX --by User --authority direct|standing:D-XXXX',
    );
  });

  it('prints the usage line when called with nothing at all', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'accept', []);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task accept T-0001 --by WHO --authority direct|app:<session>|standing:D-0001');
  });

  it('reads argv[0] as the id, so a leading flag becomes an unknown flag', () => {
    // `scrumux task accept --by User T-0001` -- the id is positional and
    // FIRST; the loop then meets `User` as a flag. Pinned because the shape
    // is easy to "improve" into a permissive parse, and a permissive parse
    // would accept an id in an unrecorded position.
    const { io, rc } = drive(task, ctxFor(scratch()), 'accept', ['--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: unknown flag User — see: scrumux help');
  });

  it("requires --by, because it used to default to 'User'", () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'accept', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: --by is required — name who is accepting.');
    expect(io.stderr).toContain("It used to default to 'User', which put his name on acts he did not take.");
  });

  it('requires an --authority, in the shared vocabulary (boundary 2)', () => {
    const { io, rc } = drive(task, ctxFor(acceptable()), 'accept', ['T-0001', '--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: --authority is required — direct (a person said so in this session)');
  });

  it('refuses an authority outside the three forms', () => {
    const { io, rc } = drive(task, ctxFor(acceptable()), 'accept', ['T-0001', '--by', 'User', '--authority', 'because']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain("accept: --authority must be direct, app:<session>, or standing:D-XXXX, got 'because'");
  });

  it('refuses a standing delegation that does not resolve to a ratified decision', () => {
    const { io, rc } = drive(task, ctxFor(acceptable()), 'accept', [
      'T-0001', '--by', 'User', '--authority', 'standing:D-0042',
    ]);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: --authority standing:D-0042 does not resolve in governance/decisions.json');
  });

  it('refuses a second acceptance, quoting who took the first and when', () => {
    const root = acceptable({ acceptance: { accepted: true, by: 'User', date: '2026-08-20', authority: 'direct' } });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('T-0001 was already accepted by User on 2026-08-20 (authority: direct)');
    expect(io.stderr).toContain('an acceptance is write-once');
  });

  it('says "unrecorded" for a prior acceptance that named no authority', () => {
    const root = acceptable({ acceptance: { accepted: true, by: 'an agent', date: '2026-08-19' } });
    const { io } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(io.stderr).toContain('T-0001 was already accepted by an agent on 2026-08-19 (authority: unrecorded)');
  });

  it('refuses work that was never verified (CLAUDE.MD boundary 5)', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_review', task_order: fullOrder() })] });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: T-0001 has no task-verify receipt — acceptance refuses work that was never verified');
    expect(io.stderr).toContain('.claude/scripts/scrumux task verify T-0001');
  });

  it('treats a FALSE receipt as no receipt at all (`.receipt // empty`)', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_review', task_order: fullOrder(), receipt: false })] });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('has no task-verify receipt');
  });

  it('refuses a RED receipt, quoting rc, checks_failed and the date', () => {
    const root = acceptable({ receipt: { date: '2026-08-22', command: 'true', rc: 1, checks_run: 3, checks_failed: 2 } });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain("accept: T-0001's last task-verify receipt is RED (rc=1, checks_failed=2, dated 2026-08-22)");
  });

  it('defaults a receipt with no rc/checks_failed/date to red, and prints ? for the date', () => {
    // `.rc // "1"`, `.checks_failed // "0"`, `.date // "?"` -- a receipt
    // missing its measured facts is not a green one.
    const root = acceptable({ receipt: { command: 'true' } });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('receipt is RED (rc=1, checks_failed=0, dated ?)');
  });

  it('refuses a task with no verification_command — there is nothing to re-run (I-0139)', () => {
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [seedTask({ status: 'in_review', task_order: { scope: 's' }, receipt: greenReceipt() })],
    });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: T-0001 has no verification_command in its task order');
    expect(io.stderr).toContain('Acceptance re-runs rather than reading a receipt (I-0139)');
  });

  it('quotes only the LAST FIVE lines of a failed re-run, and says why a receipt is not enough', () => {
    const vc = "printf 'l1\\nl2\\nl3\\nl4\\nl5\\nl6\\nl7\\n'; exit 3";
    const root = acceptable({}, vc);
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain("T-0001's own verification command FAILED when re-run just now (exit 3)");
    expect(io.stderr).toContain('output:  l3\nl4\nl5\nl6\nl7');
    // `l2` survives only inside the echoed COMMAND, never as an output line.
    expect(io.stderr).not.toContain('\nl2');
    expect(io.stderr).toContain('Either the tree changed since the receipt, or the command does not do what the receipt implies.');
    // and the acceptance was NOT recorded.
    expect(entryOf(root, 'T-0001')['acceptance']).toBeUndefined();
  });

  it('reports a re-run killed by a signal as 128+signal, as the shell would', () => {
    // `rerunExit`'s signal arm: `$?` after `sh -c` is 128+N when the child
    // died on a signal, and a port that reported the raw null would call this
    // exit 127 and blame a missing shell.
    const root = acceptable({}, 'kill -9 $$');
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('FAILED when re-run just now (exit 137)');
  });

  it('records the acceptance, keeps progress chatter on stderr, and beats VERIFIED', () => {
    const root = acceptable();
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'app:s-42']);
    expect(rc).toBe(0);
    // stdout's first line is the machine-readable answer; the chatter is not on it.
    expect(io.stdout.split('\n')[0]).toBe('T-0001 accepted');
    expect(io.stderr).toBe("re-running T-0001's verification before accepting: true\n  re-run passed (exit 0)\n");
    expect(io.stdout).toContain('  VERIFIED — its command was re-run by the acceptor, not read off the receipt.');
    expect(io.stdout).toContain('  next: the attested claim is now confirmed by something that is not its author');
    const row = entryOf(root, 'T-0001');
    // D-S018 (SX-013): the receipt acceptance gated on is copied in and frozen.
    expect(JSON.stringify(row['acceptance'])).toBe(
      // D-S045: and the fingerprint of the files the check references (`true` names none).
      JSON.stringify({ accepted: true, by: 'User', date: TODAY, authority: 'app:s-42', reverified: true, receipt: row['receipt'], check_fingerprint: { algo: 'sha256', files: {} } }),
    );
    expect(row['status']).toBe('accepted');
    expect(row['updated_at']).toBe(TODAY);
  });

  it('completes the ratified sprint when this was its last unaccepted task (T-0054)', () => {
    const root = acceptable();
    const tasks = entriesOf(root, 'tasks.json');
    plant(root, 'tasks.json', { entries: [...tasks, seedTask({ id: 'T-0002', status: 'accepted' })] });
    plant(root, 'sprints.json', {
      entries: [
        { id: 'SP-0000', status: 'complete', tasks: [] },
        { id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 2 },
      ],
    });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct'], true);
    expect(rc).toBe(0);
    const env = JSON.parse(io.stdout) as { data: Record<string, unknown> };
    expect(env.data['sprint_completed']).toBe('SP-0001');
    expect(entryOf(root, 'SP-0001', 'sprints.json')['status']).toBe('complete');
    // the cascade writes exactly one row.
    expect(entryOf(root, 'SP-0000', 'sprints.json')['status']).toBe('complete');
    expect(Object.keys(entryOf(root, 'SP-0000', 'sprints.json'))).toEqual(['id', 'status', 'tasks']);
  });

  it('leaves the sprint alone while any of its tasks is unaccepted', () => {
    const root = acceptable();
    const tasks = entriesOf(root, 'tasks.json');
    plant(root, 'tasks.json', { entries: [...tasks, seedTask({ id: 'T-0002', status: 'in_progress' })] });
    plant(root, 'sprints.json', {
      entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 2 }],
    });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(0);
    expect(io.stdout).not.toContain('SP-0001 -> complete');
    expect(entryOf(root, 'SP-0001', 'sprints.json')['status']).toBe('ratified');
  });

  it('ignores a sprint that was never ratified — only a ratified plan cascades', () => {
    const root = acceptable();
    plant(root, 'sprints.json', { entries: [{ id: 'SP-0001', status: 'proposed', tasks: ['T-0001'] }] });
    const { rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(0);
    expect(entryOf(root, 'SP-0001', 'sprints.json')['status']).toBe('proposed');
  });
});

// ===========================================================================
// task reject
// ===========================================================================
describe('task reject — records the ruling and hands the work straight back', () => {
  const rejectable = (over: Record<string, unknown> = {}): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_review', ...over })] });
    return root;
  };

  it('refuses an unknown flag but takes a bare word as the id', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'reject', ['--cause', 'x']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('reject: unknown flag --cause — see: scrumux help');
  });

  it('prints the usage line when no id was given', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'reject', ['--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task reject T-0001 --by WHO --reason TEXT');
  });

  it('requires --by', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'reject', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain("reject: --by is required — name who is rejecting.");
  });

  it('points an R- target at the task', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'reject', ['R-0001', '--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('acceptance targets the task now: scrumux reject T-XXXX --by User');
  });

  it('requires --reason, and says what a usable one names', () => {
    const { io, rc } = drive(task, ctxFor(rejectable()), 'reject', ['T-0001', '--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('reject: --reason TEXT is required');
    expect(io.stderr).toContain('BAD "not done"');
  });

  it('refuses to overwrite a recorded acceptance', () => {
    const root = rejectable({ acceptance: { accepted: true, by: 'User', date: '2026-08-20' } });
    const { io, rc } = drive(task, ctxFor(root), 'reject', ['T-0001', '--by', 'User', '--reason', 'changed my mind']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('reject: T-0001 is already accepted — rejection would overwrite a recorded final-authority ruling');
  });

  it('records the rejection and returns the task to in_progress', () => {
    const root = rejectable();
    const { io, rc } = drive(task, ctxFor(root), 'reject', ['T-0001', '--by', 'User', '--reason', 'the command does not match the order']);
    expect(rc).toBe(0);
    expect(io.stdout.trimEnd().endsWith('T-0001 rejected -> in_progress')).toBe(true);
    const row = entryOf(root, 'T-0001');
    expect(JSON.stringify(row['acceptance'])).toBe(
      JSON.stringify({ accepted: false, by: 'User', date: TODAY, reason: 'the command does not match the order' }),
    );
    expect(row['status']).toBe('in_progress');
  });

  it('TELLS about work in another sprint and records the rejection anyway (T-0144)', () => {
    const root = rejectable();
    const tasks = entriesOf(root, 'tasks.json');
    plant(root, 'tasks.json', { entries: [...tasks, seedTask({ id: 'T-0003', status: 'in_progress' })] });
    plant(root, 'sprints.json', { entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001'], parallel: 2 }] });
    const { io, rc } = drive(task, ctxFor(root), 'reject', ['T-0001', '--by', 'User', '--reason', 'r']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      'TELL: rejected work resumes immediately, but one sprint at a time — T-0003 is in no ratified sprint.',
    );
    expect(io.stdout).toContain('Recording the rejection anyway.');
    expect(entryOf(root, 'T-0001')['status']).toBe('in_progress');
  });

  it("TELLS about the sprint's own cap and records the rejection anyway", () => {
    const root = rejectable();
    const tasks = entriesOf(root, 'tasks.json');
    plant(root, 'tasks.json', { entries: [...tasks, seedTask({ id: 'T-0002', status: 'in_progress' })] });
    plant(root, 'sprints.json', {
      entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 1 }],
    });
    const { io, rc } = drive(task, ctxFor(root), 'reject', ['T-0001', '--by', 'User', '--reason', 'r']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      'TELL: rejected work resumes immediately, but SP-0001 allows 1 in flight: T-0002 already in_progress.',
    );
    expect(entryOf(root, 'T-0001')['acceptance']).toBeDefined();
  });
});

// ===========================================================================
// the two acceptance probes, directly
// ===========================================================================
describe('the acceptance probes, over journals no verb can write', () => {
  const write = (acceptance: unknown): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [acceptance === undefined ? seedTask() : seedTask({ acceptance })] });
    return gov(root, 'tasks.json');
  };

  it('_acceptedTrue: boolean true and the string "true" both count', () => {
    expect(_acceptedTrue(write({ accepted: true }), 'T-0001')).toBe(true);
    expect(_acceptedTrue(write({ accepted: 'true' }), 'T-0001')).toBe(true);
  });

  it('_acceptedTrue: false, null, absent and a non-matching truthy value do not', () => {
    expect(_acceptedTrue(write({ accepted: false }), 'T-0001')).toBe(false);
    expect(_acceptedTrue(write({ accepted: null }), 'T-0001')).toBe(false);
    expect(_acceptedTrue(write({ by: 'User' }), 'T-0001')).toBe(false);
    // `// empty` keeps a truthy value, and the string compare then rejects it.
    expect(_acceptedTrue(write({ accepted: 'yes' }), 'T-0001')).toBe(false);
    expect(_acceptedTrue(write(undefined), 'T-0001')).toBe(false);
    expect(_acceptedTrue(write({ accepted: true }), 'T-0002')).toBe(false);
  });

  it('_acceptedTrue over a missing journal is false, not a throw (bash carries 2>/dev/null)', () => {
    expect(_acceptedTrue(join(scratch(), 'governance', 'tasks.json'), 'T-0001')).toBe(false);
  });

  it('_rejectPrior: the explicit three-way, never `// "none"`', () => {
    expect(_rejectPrior(write(undefined), 'T-0001')).toBe('none');
    expect(_rejectPrior(write(null), 'T-0001')).toBe('none');
    expect(_rejectPrior(write({ by: 'User' }), 'T-0001')).toBe('null');
    expect(_rejectPrior(write({ accepted: null }), 'T-0001')).toBe('null');
    expect(_rejectPrior(write({ accepted: false }), 'T-0001')).toBe('false');
    expect(_rejectPrior(write({ accepted: true }), 'T-0001')).toBe('true');
  });

  it('_rejectPrior joins every matching row, because bash captures every line jq printed', () => {
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [seedTask({ acceptance: { accepted: false } }), seedTask({ acceptance: { accepted: true } })],
    });
    expect(_rejectPrior(gov(root, 'tasks.json'), 'T-0001')).toBe('false\ntrue');
  });
});

// ===========================================================================
// dispatch
// ===========================================================================
describe('the noun module seam', () => {
  it('refuses an unknown verb as a USAGE error, listing all nine', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'close', []);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      "unknown verb 'close' for noun task — verbs: new, order, status, update, lint, brief, verify, accept, reject",
    );
  });

  it('publishes one TAB-separated gloss per verb, and the set matches the dispatcher', () => {
    const lines = task.verbs().trimEnd().split('\n');
    expect(lines.map((l) => l.split('\t')[0])).toEqual([
      'new', 'order', 'status', 'update', 'lint', 'brief', 'verify', 'accept', 'reject',
    ]);
    for (const l of lines) expect(l.split('\t')).toHaveLength(2);
  });

  it('publishes a usage block naming the noun', () => {
    expect(task.usage()).toContain('task');
  });
});

// ===========================================================================
// task brief
// ===========================================================================
describe('task brief — the frame an implementer opens with', () => {
  const briefRoot = (over: Record<string, unknown> = {}): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask(over)] });
    return root;
  };

  it('refuses an argument that is neither a task id nor --allow-unsprinted', () => {
    const { io, rc } = drive(task, ctxFor(briefRoot()), 'brief', ['T-1']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task brief: error: usage: scrumux task brief T-0001 [--allow-unsprinted]\n');
  });

  it('refuses with no id at all', () => {
    const { io, rc } = drive(task, ctxFor(briefRoot()), 'brief', ['--allow-unsprinted']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task brief T-0001 [--allow-unsprinted]');
  });

  it('refuses when there is no tasks.json to read', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'brief', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task brief: error: no governance/tasks.json\n');
  });

  it('refuses an id the journal does not carry', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [] });
    const { io, rc } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('T-0001 not found in governance/tasks.json — check the task id');
  });

  it('FAILS the brief at exit 1 when there is no order, and prints the header regardless', () => {
    const root = briefRoot();
    const { io, rc } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(`=== TASK BRIEF T-0001 (${TODAY}) ===`);
    expect(io.stdout).toContain('Title:  Task one\nStatus: proposed\nStory:  NONE\nFeature: NONE\nAcceptance check: the thing is true');
    expect(io.stdout).toContain(`  FAIL ${'T-0001/order'.padEnd(24)} T-0001 has no order. There is nothing to work from.\n`);
    expect(io.stdout).toContain('VERDICT: gates FAILED — fix the named items before implementing. Do not start.');
    // and the scope/reading-list blocks are not printed at all.
    expect(io.stdout).not.toContain('--- Scope ---');
  });

  it('renders NULL story and feature as NONE, and a present one raw', () => {
    const root = briefRoot({ story: 'S-0001', feature: null });
    const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(io.stdout).toContain('Story:  S-0001\nFeature: NONE');
  });

  it('prints the SENT BACK block for a rejected task — `tostring`, never `//`', () => {
    // The measured shape (T-0005 in scrumux-agents): a returned task arrived
    // looking exactly like new work. `.acceptance.accepted // "none"` would
    // have yielded "none" for the very value under test.
    const root = briefRoot({
      acceptance: { accepted: false, by: 'User', date: '2026-08-21', reason: 'the command does not match the order' },
    });
    const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(io.stdout).toContain('--- THIS TASK WAS REJECTED AND SENT BACK ---');
    expect(io.stdout).toContain('by:     User\ndate:   2026-08-21\nreason: the command does not match the order');
    expect(io.stdout).toContain('This is NOT new work. Fix what the reason names.');
  });

  it('prints the SENT BACK block for the STRING "false" too, and fills unknowns', () => {
    const root = briefRoot({ acceptance: { accepted: 'false' } });
    const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(io.stdout).toContain('by:     unknown\ndate:   unknown\nreason: (none recorded)');
  });

  it('prints no SENT BACK block for an accepted task', () => {
    const root = briefRoot({ acceptance: { accepted: true, by: 'User', date: '2026-08-20' } });
    const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(io.stdout).not.toContain('SENT BACK');
  });

  describe('the sprint gate', () => {
    it('is OK inside a ratified sprint', () => {
      const root = briefRoot();
      plant(root, 'sprints.json', { entries: [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001'], parallel: 1 }] });
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('sprint: T-0001 is in ratified sprint SP-0001 — OK (D-0004)');
    });

    it('accepts a STRING tasks field, because jq indexes a string too', () => {
      // `.tasks | index($t)` on a string is a SUBSTRING search in jq, and a
      // hand-edited sprint can hold one. Reproduced rather than tightened.
      const root = briefRoot();
      plant(root, 'sprints.json', { entries: [{ id: 'SP-0002', status: 'ratified', tasks: 'T-0001 T-0009' }] });
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('sprint: T-0001 is in ratified sprint SP-0002 — OK (D-0004)');
    });

    it('names the bootstrap under --allow-unsprinted', () => {
      const { io } = drive(task, ctxFor(briefRoot()), 'brief', ['T-0001', '--allow-unsprinted']);
      expect(io.stdout).toContain(
        'sprint: NOT in a ratified sprint — proceeding on --allow-unsprinted (User-directed bootstrap only; session-check will flag it)',
      );
    });

    it('TELLS rather than blocks when unsprinted (T-0144/I-0074)', () => {
      const { io } = drive(task, ctxFor(briefRoot()), 'brief', ['T-0001']);
      expect(io.stdout).toContain('sprint: TELL — T-0001 is not in any ratified sprint (D-0004)');
      expect(io.stdout).toContain('Proceeding; session-check will name it at close.');
    });
  });

  describe('the parallel gate — the SAME arithmetic the writer refuses on', () => {
    const withTasks = (extra: Record<string, unknown>[], sprints?: unknown[]): string => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask(), ...extra] });
      if (sprints !== undefined) plant(root, 'sprints.json', { entries: sprints });
      return root;
    };

    it('is OK at 1 of 1 for a task in no ratified sprint with nothing else running', () => {
      const { io } = drive(task, ctxFor(withTasks([])), 'brief', ['T-0001']);
      expect(io.stdout).toContain('parallel: OK (1 of 1 slot — this task is in no ratified sprint)');
    });

    it('TELLS one-task-at-a-time when unsprinted work is already running', () => {
      const root = withTasks([seedTask({ id: 'T-0002', status: 'in_progress' })]);
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain(
        'parallel: TELL — T-0001 is in no ratified sprint, so it is one task at a time and T-0002 already in_progress.',
      );
      expect(io.stdout).toContain('scrumux will refuse the status transition until you do.');
    });

    it('TELLS one-sprint-at-a-time when the other work is outside this sprint', () => {
      const root = withTasks(
        [seedTask({ id: 'T-0003', status: 'in_progress' })],
        [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001'], parallel: 2 }],
      );
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('parallel: TELL — one sprint at a time: T-0003 is in no ratified sprint.');
    });

    it("TELLS the sprint's cap when it is already full", () => {
      const root = withTasks(
        [seedTask({ id: 'T-0002', status: 'in_progress' })],
        [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 1 }],
      );
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('parallel: TELL — SP-0001 allows 1 in flight: T-0002 already in_progress.');
    });

    it('counts the slots when the sprint has room', () => {
      const root = withTasks(
        [seedTask({ id: 'T-0002', status: 'in_progress' })],
        [{ id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0002'], parallel: 3 }],
      );
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('parallel: OK (2 of 3 slots)');
    });
  });

  describe('the order blocks', () => {
    const ordered = (order: Record<string, unknown>): string => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask({ task_order: order })] });
      return root;
    };

    it('prints scope, the OUT list and the reading list with expected diffs', () => {
      const root = ordered(
        fullOrder({
          scope: 'change src/a.ts',
          out_of_scope: ['everything else', 'and this'],
          verification_command: 'sh tests/a.sh',
          context: {
            files: [
              { path: 'src/a.ts', why: 'the site', expected_diff: '+10 -2' },
              { path: 'src/b.ts', why: 'read only' },
            ],
            refs: [],
            commands: [],
            interfaces: [],
            data_shapes: [],
          },
        }),
      );
      const { io, rc } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(rc).toBe(0);
      expect(io.stdout).toContain('IN:  change src/a.ts\nVERIFY WITH: sh tests/a.sh\nOUT (do not touch):\n  - everything else\n  - and this\n');
      expect(io.stdout).toContain('  src/a.ts\n    why: the site\n    expected diff: +10 -2\n');
      expect(io.stdout).toContain('  src/b.ts\n    why: read only\n');
      expect(io.stdout).toContain('VERDICT: gates pass. Set in_progress (scrumux task status T-0001 in_progress) and implement within scope.');
    });

    it('resolves refs one prefix at a time, and says which kind of miss it was', () => {
      const root = ordered(
        fullOrder({
          context: { files: [], refs: ['D-0001', 'D-0003', 'Z-0001', 'I-0009'], commands: [], interfaces: [], data_shapes: [] },
        }),
      );
      plant(root, 'decisions.json', {
        entries: [
          { id: 'D-0001', title: 'the first ruling' },
          { id: 'D-0002', title: 'the replacement', supersedes: 'D-0003' },
          { id: 'D-0003', title: 'the retired ruling' },
        ],
      });
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('  D-0001: the first ruling\n');
      // supersession is resolved HERE and only here (T-0082): a brief must not
      // render a retired ruling as current law.
      expect(io.stdout).toContain('  D-0003: the retired ruling [SUPERSEDED by D-0002 — read that instead]\n');
      expect(io.stdout).toContain('  Z-0001: UNKNOWN PREFIX\n');
      expect(io.stdout).toContain('  I-0009: UNRESOLVED\n');
    });

    it('prints (none declared) for ground truth, and the two optional blocks when present', () => {
      const bare = ordered(fullOrder());
      expect(drive(task, ctxFor(bare), 'brief', ['T-0001']).io.stdout).toContain(
        '--- Ground truth (run these before assuming) ---\n  (none declared)\n',
      );
      const rich = ordered(
        fullOrder({
          context: {
            files: [],
            refs: [],
            commands: ['sh tests/a.sh', 'git status'],
            interfaces: ['run(x) -> y'],
            data_shapes: ['{id: string}'],
          },
        }),
      );
      const { io } = drive(task, ctxFor(rich), 'brief', ['T-0001']);
      expect(io.stdout).toContain('  sh tests/a.sh\n  git status\n');
      expect(io.stdout).toContain('Interfaces to honor:\n  - run(x) -> y\n');
      expect(io.stdout).toContain('Data shapes:\n  - {id: string}\n');
      expect(io.stdout).not.toContain('(none declared)');
    });

    it('renders a NULL row in the reading list as null rather than crashing', () => {
      const root = ordered(
        fullOrder({ context: { files: [null], refs: [], commands: [], interfaces: [], data_shapes: [] } }),
      );
      const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
      expect(io.stdout).toContain('  null\n    why: null\n');
    });

    describe('the graph blocks, which must DEGRADE LOUDLY', () => {
      it('says the graph is missing, and says it is NOT "nothing calls these files"', () => {
        const root = ordered(fullOrder());
        const { io } = drive(task, ctxFor(root), 'brief', ['T-0001']);
        expect(io.stdout).toContain(
          '  (no answer — the governance graph is missing or unreadable; run: .claude/scripts/scrumux graph gov build. It self-heals, D-0043)',
        );
        expect(io.stdout).toContain(
          "  (no .claude/scripts/scrumux — the code graph is unavailable, so nothing below was checked; this is NOT 'nothing calls these files')",
        );
      });

      it('lists the CHANGES set, hides refs already in the order, and counts both', () => {
        const bearing = [
          'path changes src/a.ts',
          'path reads src/b.ts',
          'D-0001 [changes src/a.ts] the cited ruling',
          'D-0002 [changes src/a.ts] an uncited ruling',
          'I-0005 [reads src/b.ts] an uncited issue',
        ].join('\n');
        const root = ordered(
          fullOrder({ context: { files: [], refs: ['D-0001'], commands: [], interfaces: [], data_shapes: [] } }),
        );
        const { io } = drive(task, ctxFor(root, { scriptsDir: fakeScripts({ bearing }) }), 'brief', ['T-0001']);
        expect(io.stdout).toContain('  this order CHANGES: src/a.ts\n');
        expect(io.stdout).toContain('  D-0002 [changes src/a.ts] an uncited ruling\n');
        expect(io.stdout).toContain('  I-0005 [reads src/b.ts] an uncited issue\n');
        expect(io.stdout).not.toContain('  D-0001 [changes');
        expect(io.stdout).toContain("  3 bearing record(s) over this file set; 1 already in this order's refs and resolved below.\n");
      });

      it('says so when the order changes nothing it lists (I-0070)', () => {
        const root = ordered(fullOrder());
        const dir = fakeScripts({ bearing: 'path reads src/b.ts\n' });
        const { io } = drive(task, ctxFor(root, { scriptsDir: dir }), 'brief', ['T-0001']);
        expect(io.stdout).toContain(
          "  this order changes nothing it lists — every path is read-only, so task-lint's bearing checks stay silent (I-0070)",
        );
        expect(io.stdout).toContain('  this order changes no file it lists — nothing to trace (I-0070)');
      });

      it('re-derives the changed set from expected_diff and expected_artifacts when the graph is silent', () => {
        // The identical rule the graph applies, applied locally: `unique` is
        // jq's sort-and-dedupe, so the order below is not the order given.
        const root = ordered(
          fullOrder({
            context: {
              files: [
                { path: 'src/z.ts', why: 'w', expected_diff: '+1' },
                { path: 'src/read-only.ts', why: 'w' },
              ],
              refs: [],
              commands: [],
              interfaces: [],
              data_shapes: [],
              expected_artifacts: ['src/a.ts'],
            },
          }),
        );
        const dir = fakeScripts({ callers: '', callees: '' });
        const { io } = drive(task, ctxFor(root, { scriptsDir: dir }), 'brief', ['T-0001']);
        const codeBlock = io.stdout.slice(io.stdout.indexOf('--- Code graph'));
        expect(codeBlock).toContain('  src/a.ts\n');
        expect(codeBlock).toContain('  src/z.ts\n');
        expect(codeBlock.indexOf('  src/a.ts\n')).toBeLessThan(codeBlock.indexOf('  src/z.ts\n'));
        expect(codeBlock).not.toContain('src/read-only.ts');
        expect(codeBlock).toContain('    callers: none in the index\n    callees: none in the index\n');
      });

      /**
       * THE ANSWER IS STDOUT, AND THE BANNER IS NOT AN ANSWER.
       *
       * `graph code` stamps every query with its provenance on STDERR -- and
       * its NOT INDEXED notices, and its staleness line -- because a reader
       * never withholds an answer, it stamps it (P-20). `task brief` captured
       * the two streams merged, so the emptiness check below could never be
       * true: `none in the index` was UNREACHABLE, and a file with no callers
       * rendered as `callers: graph code: index built from 47591175 …`. Read
       * literally, that names the banner as a caller -- a WRONG ANSWER, in the
       * one section implement-sop tells an implementer to read before the
       * first edit. Measured on the 2026-09-02 E2E operator run.
       *
       * The banner still reaches the operator: it goes to the brief's OWN
       * stderr, which is where `graph code` put it. What changed is that it is
       * no longer counted as content.
       */
      it('does not read graph code\'s stderr banner as an answer — none in the index stays reachable', () => {
        const root = ordered(
          fullOrder({ context: { files: [{ path: 'src/a.ts', why: 'w', expected_diff: '+1' }], refs: [], commands: [], interfaces: [], data_shapes: [] } }),
        );
        const banner = 'graph code: index built from 47591175 at 2026-09-02T09:00:00Z; HEAD is 47591175. Current.\n';
        const dir = fakeScripts({
          callers: '', callersErr: banner,
          callees: '', calleesErr: banner,
        });
        const { io } = drive(task, ctxFor(root, { scriptsDir: dir }), 'brief', ['T-0001']);
        expect(io.stdout).toContain('    callers: none in the index\n    callees: none in the index\n');
        // The banner is nowhere in the ANSWER…
        expect(io.stdout).not.toContain('index built from');
        // …and it is not swallowed either: it comes out on the brief's stderr,
        // once per query, which is the stream `graph code` chose for it.
        expect(io.stderr).toContain('index built from 47591175');
      });

      it('counts a real answer that arrives alongside a banner, and only the answer', () => {
        const root = ordered(
          fullOrder({ context: { files: [{ path: 'src/a.ts', why: 'w', expected_diff: '+1' }], refs: [], commands: [], interfaces: [], data_shapes: [] } }),
        );
        // A STALE index still answers, at rc 0, stamped (P-20) -- the arm
        // where the banner is longest and the answer is real. Without the
        // stream split, the two would have been indistinguishable.
        const dir = fakeScripts({
          callers: 'src/b.ts:12 caller()\n',
          callersErr: 'graph code: index built from 47591175 at 2026-09-02T09:00:00Z; HEAD is 47591175 — 3 commit(s) behind. STALE: 2 file(s) changed. Refresh from a harness checkout: scrumux graph code build --repo /x\n',
          callees: '', calleesErr: '',
        });
        const { io } = drive(task, ctxFor(root, { scriptsDir: dir }), 'brief', ['T-0001']);
        expect(io.stdout).toContain('    callers: src/b.ts:12 caller()\n');
        expect(io.stdout).toContain('    callees: none in the index\n');
        expect(io.stdout).not.toContain('STALE');
        expect(io.stderr).toContain('STALE: 2 file(s) changed');
      });

      it('reports an unavailable index per relation, with the first line of what it said', () => {
        const root = ordered(
          fullOrder({ context: { files: [{ path: 'src/a.ts', why: 'w', expected_diff: '+1' }], refs: [], commands: [], interfaces: [], data_shapes: [] } }),
        );
        const dir = fakeScripts({
          callers: 'graph code: no index for this repo\nsecond line nobody prints',
          callersRc: 2,
          callees: 'graph code: rebuilt the index\nsrc/b.ts:12 caller()\n',
        });
        const { io } = drive(task, ctxFor(root, { scriptsDir: dir }), 'brief', ['T-0001']);
        expect(io.stdout).toContain(
          '    callers: UNAVAILABLE — graph code: no index for this repo. Nothing was traced for this file. Rebuild: .claude/scripts/scrumux graph code build',
        );
        expect(io.stdout).not.toContain('second line nobody prints');
        // the self-heal notice is not an answer line and is not counted as one.
        expect(io.stdout).toContain('    callees: src/b.ts:12 caller()\n');
        expect(io.stdout).not.toContain('callees: graph code: rebuilt');
      });

      it('truncates a relation at 12 answers and says how many more there are', () => {
        const lines = Array.from({ length: 15 }, (_, i) => `src/caller${String(i + 1)}.ts`).join('\n');
        const root = ordered(
          fullOrder({ context: { files: [{ path: 'src/a.ts', why: 'w', expected_diff: '+1' }], refs: [], commands: [], interfaces: [], data_shapes: [] } }),
        );
        const { io } = drive(task, ctxFor(root, { scriptsDir: fakeScripts({ callers: lines }) }), 'brief', ['T-0001']);
        expect(io.stdout).toContain('    callers: src/caller12.ts\n');
        expect(io.stdout).not.toContain('src/caller13.ts');
        expect(io.stdout).toContain('    callers: (+3 more)\n');
      });

      it('stops tracing after 8 files and calls that a task-size problem', () => {
        // zero-padded, so `unique`'s lexicographic sort is also the numeric one.
        const arts = Array.from({ length: 12 }, (_, i) => `src/f${String(i + 1).padStart(2, '0')}.ts`);
        const root = ordered(
          fullOrder({ context: { files: [], refs: [], commands: [], interfaces: [], data_shapes: [], expected_artifacts: arts } }),
        );
        const { io } = drive(task, ctxFor(root, { scriptsDir: fakeScripts({}) }), 'brief', ['T-0001']);
        expect(io.stdout).toContain(
          '  (+ more changed paths not traced — an order changing more than 8 files is a task-size problem, not a brief-length one)',
        );
        expect(io.stdout).toContain('  src/f08.ts\n');
        expect(io.stdout).not.toContain('  src/f09.ts\n');
      });
    });
  });

  describe('the history block, which is a DIRECT print', () => {
    const briefWithLog = (log: string | undefined): CapturedIo => {
      const root = scratch();
      plant(root, 'tasks.json', { entries: [seedTask({ task_order: fullOrder() })] });
      if (log !== undefined) writeFileSync(gov(root, 'log.json'), log);
      return drive(task, ctxFor(root), 'brief', ['T-0001']).io;
    };

    it('says when there is no log.json', () => {
      expect(briefWithLog(undefined).stdout).toContain('--- History for T-0001 ---\n  (no log.json)\n');
    });

    it('says when the log holds nothing for this task', () => {
      expect(briefWithLog(J({ entries: [{ id: 'L-0001', task: 'T-0002', title: 'other work' }] })).stdout).toContain(
        '  (no log entries yet)\n',
      );
    });

    it('prints id and title for every entry of this task', () => {
      const io = briefWithLog(
        J({ entries: [{ id: 'L-0001', task: 'T-0001', title: 'first pass' }, { id: 'L-0002', task: 'T-0001', title: 'second pass' }] }),
      );
      expect(io.stdout).toContain('  L-0001 first pass\n  L-0002 second pass\n');
    });

    it('prints NOTHING for a corrupt log, exactly as bash\'s jq does', () => {
      // bash's jq errors to stderr and prints nothing to stdout; the port adds
      // no stderr of its own (found-not-fixed in the source: the leaked jq
      // diagnostic is a raw parse error, not product surface).
      const io = briefWithLog('{not json');
      expect(io.stdout).toContain('--- History for T-0001 ---\n\n');
      expect(io.stdout).not.toContain('no log.json');
      expect(io.stdout).not.toContain('no log entries');
    });

    it('prints nothing for a log with no entries array — `.entries[]` is a jq ERROR there', () => {
      const io = briefWithLog(J({ rows: [] }));
      expect(io.stdout).not.toContain('no log entries yet');
      expect(io.stdout).toContain('--- History for T-0001 ---\n\n');
    });
  });

  it('puts its direct-print blocks on stdout AHEAD of the --json envelope (the seam)', () => {
    // bash's own behaviour, measured and reproduced rather than repaired: the
    // `printf | jq -r` blocks are unconditional, so a --json consumer of
    // `task brief` gets loose text before the one object. Pinned so a change
    // that "fixes" it has to be a ruling.
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ task_order: fullOrder() })] });
    const { io, rc } = drive(task, ctxFor(root), 'brief', ['T-0001'], true);
    expect(rc).toBe(0);
    expect(io.stdout.startsWith('Title:  Task one\n')).toBe(true);
    // the say() prose IS suppressed -- only the direct prints leak.
    expect(io.stdout).not.toContain('--- Gates ---');
    const at = io.stdout.indexOf('{\n  "schema"');
    expect(at).toBeGreaterThan(0);
    const env = JSON.parse(io.stdout.slice(at)) as { summary: string; exit: number };
    expect(env.exit).toBe(0);
    expect(env.summary).toContain('VERDICT: gates pass.');
  });
});

// ===========================================================================
// task lint
// ===========================================================================
describe('task lint — atomicity (D-0006) and completeness (D-0005)', () => {
  const lintRoot = (over: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask(over), ...extra] });
    return root;
  };
  const lint = (root: string, args: string[], scriptsDir = NO_SCRIPTS): Driven =>
    drive(task, ctxFor(root, { scriptsDir }), 'lint', args);

  it('refuses before anything else when there is no tasks.json', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'lint', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      'scrumux task lint: error: no governance/tasks.json — create tasks first: scrumux task new --title ... --check ...\n',
    );
  });

  it('refuses an argument that is neither a task id nor a known flag', () => {
    const { io, rc } = lint(lintRoot(), ['nonsense']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      'usage: scrumux task lint T-0001 [T-0002 ...] | scrumux task lint --feature F-0001 [--hotfix]',
    );
  });

  it('refuses with no ids at all', () => {
    const { io, rc } = lint(lintRoot(), ['--hotfix']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task lint T-0001 [...] | scrumux task lint --feature F-0001');
  });

  it('refuses a --feature with no value', () => {
    const { io, rc } = lint(lintRoot(), ['--feature']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('task: --feature needs a value — see: scrumux help task');
  });

  it('refuses a --feature nothing matches, naming the creation command', () => {
    const { io, rc } = lint(lintRoot(), ['--feature', 'F-0009']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('no tasks for feature F-0009 — create them: scrumux task new --feature F-0009 ...');
  });

  it('lints every task of a --feature', () => {
    const root = lintRoot({ feature: 'F-0001' }, [seedTask({ id: 'T-0002', feature: 'F-0001' })]);
    const { io } = lint(root, ['--feature', 'F-0001']);
    expect(io.stdout).toContain('== T-0001 ==');
    expect(io.stdout).toContain('== T-0002 ==');
  });

  it('does NOT refuse an empty --feature that follows an explicit id (the space-joined accumulator)', () => {
    // bash's `IDS="$IDS ..."` and its emptiness test over the WHOLE string.
    // Reproduced deliberately: the check is not per-flag.
    const { io, rc } = lint(lintRoot(), ['T-0001', '--feature', 'F-0009']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('== T-0001 ==');
    expect(io.stderr).toBe('');
  });

  it('FAILS a task the journal does not carry, and moves to the next id', () => {
    const { io, rc } = lint(lintRoot(), ['T-0001', 'T-0009']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('T-0009 not found in tasks.json — scrumux task new first');
    // three: T-0001's own two findings, plus the id that does not exist.
    expect(io.stdout).toContain('task lint: 3 failure(s) — fix each named item, then re-run. Proceed only on exit 0.');
  });

  it('prints the ratified check beside the order, and FAILS when there is none', () => {
    const withCheck = lint(lintRoot({ task_order: fullOrder(), story: 'S-0001' }), ['T-0001']);
    expect(withCheck.io.stdout).toContain('  check: the thing is true');
    const without = lint(lintRoot({ acceptance_check: '' }), ['T-0001']);
    expect(without.io.stdout).toContain(
      'no acceptance_check — stated before work starts (CLAUDE.MD); checks are immutable after task new',
    );
    expect(without.rc).toBe(1);
  });

  it('FAILS a missing story in the plain lane and names the repair', () => {
    const { io, rc } = lint(lintRoot({ task_order: fullOrder() }), ['T-0001']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('  FAIL T-0001');
    expect(io.stdout).toContain('no story — atomicity needs exactly one user story (D-0006): scrumux task order T-0001 --story S-XXXX ...');
  });

  it('skips the story check entirely under --hotfix', () => {
    const { io } = lint(lintRoot({ task_order: fullOrder() }), ['T-0001', '--hotfix']);
    expect(io.stdout).not.toContain('no story —');
  });

  it('FAILS a story that is NAMED and does not resolve, in either lane', () => {
    const root = lintRoot({ story: 'S-0009', task_order: fullOrder({ light: true }) });
    const { io, rc } = lint(root, ['T-0001']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('  FAIL T-0001');
    expect(io.stdout).toContain('story S-0009 does not resolve in design.json — create it: scrumux story new --feature F-XXXX ...');
  });

  it('demotes exactly two findings in the light lane, and says which (D-0073/T-0189)', () => {
    const root = lintRoot({
      task_order: {
        light: true,
        scope: 's',
        out_of_scope: ['x'],
        verification_command: 'sh tests/a.sh',
        context: { files: [], refs: [], commands: ['c'], interfaces: [], data_shapes: [] },
      },
    });
    const { io, rc } = lint(root, ['T-0001']);
    // A light order with no story and no context files: BOTH are TELLs, so the
    // command is green. Boundary 4 is untouched -- see the next test.
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      '  lane: light (D-0073) — story and context-files findings are TELLs here; the acceptance check and the one verification command are not (boundary 4)',
    );
    expect(io.stdout).toContain('  TELL T-0001');
    expect(io.stdout).toContain('no story — atomicity needs exactly one user story');
    expect(io.stdout).toContain('context.files empty — the reading list IS the anti-search mechanism (D-0005)');
    expect(io.stdout).not.toContain('  FAIL');
    expect(io.stdout).toContain('task lint: all checks pass (manual one-sitting judgment still yours).');
  });

  it('keeps boundary 4 a FAIL in the light lane: the check and the one command', () => {
    const root = lintRoot({
      acceptance_check: '',
      task_order: {
        light: true,
        scope: 's',
        out_of_scope: ['x'],
        verification_command: 'sh a.sh && sh b.sh',
        context: { files: [{ path: 'p', why: 'w' }], refs: [], commands: ['c'], interfaces: [], data_shapes: [] },
      },
    });
    const { io, rc } = lint(root, ['T-0001', '--hotfix']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('no acceptance_check');
    expect(io.stdout).toContain(
      "verification_command looks composite ('sh a.sh && sh b.sh') — atomicity wants exactly ONE command",
    );
  });

  it('FAILS a task with no order at all and stops linting it there', () => {
    const { io, rc } = lint(lintRoot({ story: 'S-0001' }), ['T-0001']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(
      'no task_order (D-0005): scrumux task order T-0001 --scope ... --verify ... --file "path | why"',
    );
    // nothing downstream of the order ran.
    expect(io.stdout).not.toContain('READER (§4b)');
  });

  it('FAILS an empty verification_command', () => {
    const root = lintRoot({ task_order: fullOrder({ verification_command: '' }) });
    const { io } = lint(root, ['T-0001', '--hotfix']);
    expect(io.stdout).toContain('empty verification_command — one command that proves the acceptance check (D-0006)');
  });

  it('TELLS about a bare suite path, on the STRING rule that never stats the file (D-0041)', () => {
    const root = lintRoot({ task_order: fullOrder({ verification_command: 'tests/a.sh' }) });
    const { io } = lint(root, ['T-0001', '--hotfix']);
    expect(io.stdout).toContain("verification_command 'tests/a.sh' names a suite without an interpreter — write 'sh tests/a.sh'");
    expect(io.stdout).toContain('27 of 38 suites are not');
  });

  it("asks the reader's question as a NOTE, which moves no counter", () => {
    const root = lintRoot({ story: 'S-0001', task_order: fullOrder() });
    plant(root, 'design.json', { entries: [{ id: 'S-0001', kind: 'story', narrative: 'n' }] });
    const { io, rc } = lint(root, ['T-0001']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain("READER (§4b): weakest artifact that passes 'true' — would you accept it?");
    expect(io.stdout).toContain('MANUAL: one-sitting check');
    expect(io.stdout).toContain('  ..   T-0001');
  });

  it('TELLS an empty out_of_scope and WARNS an empty commands list', () => {
    const root = lintRoot({ task_order: fullOrder({ out_of_scope: [] }) });
    const { io } = lint(root, ['T-0001', '--hotfix']);
    expect(io.stdout).toContain('out_of_scope is empty — name what must NOT be touched (D-0005)');
    expect(io.stdout).toContain('no ground-truth commands — fine for pure-doc tasks, wrong for code tasks');
    expect(io.stdout).toContain('  WARN T-0001');
  });

  it('FAILS a context file with no why, and skips a row whose path is empty', () => {
    const root = lintRoot({
      task_order: fullOrder({
        context: {
          files: [{ path: 'src/a.ts', why: '' }, { path: '', why: '' }, 'not an object'],
          refs: [],
          commands: ['c'],
          interfaces: [],
          data_shapes: [],
        },
      }),
    });
    const { io, rc } = lint(root, ['T-0001', '--hotfix']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('context file src/a.ts has no why — every file needs its reason');
    expect(io.stdout.match(/has no why/g)).toHaveLength(1);
  });

  it('FAILS a ref that resolves in no journal', () => {
    const root = lintRoot({
      task_order: fullOrder({ context: { files: [{ path: 'p', why: 'w' }], refs: ['D-0001'], commands: ['c'], interfaces: [], data_shapes: [] } }),
    });
    const { io, rc } = lint(root, ['T-0001', '--hotfix']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('ref D-0001 does not resolve in any journal — fix the id or create the record');
  });

  it('TELLS about a path the scope SENTENCE names and the order does not list (I-0130)', () => {
    const root = lintRoot({
      task_order: fullOrder({
        scope: 'edit src/a.ts, then tools/x.sh, then src/a.ts again; see D-0001.md and prose words',
        context: {
          files: [{ path: 'src/a.ts', why: 'w' }],
          refs: [],
          commands: ['c'],
          interfaces: [],
          data_shapes: [],
          expected_artifacts: ['tools/x.sh'],
        },
      }),
    });
    const { io, rc } = lint(root, ['T-0001', '--hotfix']);
    expect(rc).toBe(0);
    // src/a.ts is listed; tools/x.sh is an expected artifact; D-0001.md is a
    // governance id; "prose" and "words" are not path-shaped. Nothing left.
    expect(io.stdout).not.toContain('the scope text names path(s)');
  });

  it('flags each unlisted path once, recall-first, and says the imprecision is the price', () => {
    const root = lintRoot({
      task_order: fullOrder({
        scope: 'edit src/b.ts and src/b.ts and docs/notes.md',
        context: { files: [{ path: 'src/a.ts', why: 'w' }], refs: [], commands: ['c'], interfaces: [], data_shapes: [] },
      }),
    });
    const { io } = lint(root, ['T-0001', '--hotfix']);
    expect(io.stdout).toContain('the scope text names path(s) the order does not list: src/b.ts docs/notes.md —');
    // SX-011: the wording now says URLs/routes/hosts are not counted.
    expect(io.stdout).toContain('URLs, HTTP routes, host strings and package-relative spellings of listed paths are not counted (SX-011, SX-027); some of these may still be prose rather than paths, which is the cost of catching the real ones.');
  });

  describe('the bearing block, which degrades to a TELL and never a FAIL', () => {
    const ordered = (order: Record<string, unknown>, decisions?: unknown[]): string => {
      const root = lintRoot({ task_order: order });
      if (decisions !== undefined) plant(root, 'decisions.json', { entries: decisions });
      return root;
    };

    it('TELLS when the graph answers nothing', () => {
      const { io, rc } = lint(ordered(fullOrder()), ['T-0001', '--hotfix']);
      expect(rc).toBe(0);
      expect(io.stdout).toContain('graph gov bearing returned nothing for T-0001 — the governance graph is missing or unreadable');
      expect(io.stdout).toContain('Rebuild it: .claude/scripts/scrumux graph gov build (it self-heals, D-0043)');
    });

    it('TELLS rather than FAILS an uncited CHANGES set in a repo with no decisions (I-0137)', () => {
      const root = ordered(fullOrder());
      const dir = fakeScripts({ bearing: 'path changes src/a.ts\n' });
      const { io, rc } = lint(root, ['T-0001', '--hotfix'], dir);
      expect(rc).toBe(0);
      expect(io.stdout).toContain(
        'this order CHANGES src/a.ts and cites no governance refs, and this repo has recorded no decisions yet — so there is nothing to cite and nothing to fix here.',
      );
    });

    it('FAILS the same shape once decisions exist, and counts them', () => {
      const root = ordered(fullOrder(), [{ id: 'D-0001', title: 't' }, { id: 'D-0002', title: 't' }]);
      const dir = fakeScripts({ bearing: 'path changes src/a.ts\npath changes src/b.ts\n' });
      const { io, rc } = lint(root, ['T-0001', '--hotfix'], dir);
      expect(rc).toBe(1);
      expect(io.stdout).toContain('this order CHANGES src/a.ts src/b.ts and cites no governance refs — 2 decision(s) exist');
      // F4: this used to print `scrumux task order T-0001 --ref D-XXXX`, and
      // following it -- once its three required flags were satisfied -- wiped
      // the order it was fixing. The instruction now names the replace.
      expect(io.stdout).toContain('task order REPLACES the order rather than amending it');
      expect(io.stdout).toContain('scrumux task brief T-0001');
      expect(io.stdout).toContain('--ref D-XXXX');
    });

    it('WARNS about bearing records the order does not cite, capping the list at 8', () => {
      const ids = Array.from({ length: 10 }, (_, i) => `D-00${String(i + 10)}`);
      const bearing = ['path changes src/a.ts', ...ids.map((d) => `${d} [changes src/a.ts] a ruling`)].join('\n');
      const root = ordered(
        fullOrder({ context: { files: [{ path: 'p', why: 'w' }], refs: ['D-0001'], commands: ['c'], interfaces: [], data_shapes: [] } }),
        [{ id: 'D-0001', title: 't' }],
      );
      const { io, rc } = lint(root, ['T-0001', '--hotfix'], fakeScripts({ bearing }));
      // advisory only: bearing is reachability, not relevance.
      expect(rc).toBe(0);
      expect(io.stdout).toContain('10 record(s) bear on the files this order CHANGES and are not in its refs: D-0010 D-0011 D-0012 D-0013 D-0014 D-0015 D-0016 D-0017 (+2 more)');
      expect(io.stdout).toContain('Advisory: bearing is reachability, not relevance');
    });

    it('says nothing when every bearing record is already cited', () => {
      const bearing = 'path changes src/a.ts\nD-0001 [changes src/a.ts] the cited ruling\n';
      const root = ordered(
        fullOrder({ context: { files: [{ path: 'p', why: 'w' }], refs: ['D-0001'], commands: ['c'], interfaces: [], data_shapes: [] } }),
        [{ id: 'D-0001', title: 't' }],
      );
      const { io, rc } = lint(root, ['T-0001', '--hotfix'], fakeScripts({ bearing }));
      expect(rc).toBe(0);
      expect(io.stdout).not.toContain('bear on the files this order CHANGES');
    });
  });
});

// ===========================================================================
// task verify
// ===========================================================================
describe('task verify — the exit code is the verdict, and the receipt is only evidence', () => {
  const verifiable = (vc: string, health?: unknown[]): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ task_order: fullOrder({ verification_command: vc }) })] });
    if (health !== undefined) plant(root, 'repo-health.json', { entries: health });
    return root;
  };

  it('prints the usage line with no id', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'verify', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task verify: error: usage: scrumux task verify T-0001\n');
  });

  it('refuses when there is no tasks.json', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'verify', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux task verify: error: no governance/tasks.json\n');
  });

  it('refuses a task with no verification_command, and a task that is not there at all', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain(
      'T-0001 has no task_order.verification_command — task-breakdown skill first (scrumux task order T-0001 --verify ...)',
    );
    // an id with no row takes the identical path -- `row === undefined` and a
    // non-object order both answer "no command".
    expect(drive(task, ctxFor(root), 'verify', ['T-0009']).io.stderr).toContain('T-0009 has no task_order.verification_command');
  });

  it("counts the order's OWN command as a check, and writes what this run measured", () => {
    const root = verifiable("printf 'suite ok\\n'");
    const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(`=== TASK VERIFY T-0001 (${TODAY}) ===`);
    expect(io.stdout).toContain("EVIDENCE-BEGIN\n--- verification_command for T-0001\n$ printf 'suite ok\\n'\nsuite ok\nRESULT: PASS (exit 0)\n");
    expect(io.stdout).toContain(
      '--- repo-health: none registered (scrumux health add --name ... --command ... — tracked as T-0016)',
    );
    expect(io.stdout).toContain('EVIDENCE-END');
    expect(io.stdout).toContain('RECEIPT: recorded on T-0001 (rc=0, checks_run=1, checks_failed=0)');
    expect(io.stdout).toContain('VERDICT: all checks pass. Log it (scrumux log new --task T-0001 --verified "<EVIDENCE block>")');
    const receipt = entryOf(root, 'T-0001')['receipt'] as Record<string, unknown>;
    // `file_hashes` (SX-024): the covered files' content, for the close.
    expect(Object.keys(receipt)).toEqual(['date', 'at_epoch', 'command', 'rc', 'checks_run', 'checks_failed', 'file_hashes']);
    expect(receipt['date']).toBe(TODAY);
    expect(receipt['command']).toBe("printf 'suite ok\\n'");
    expect(receipt['rc']).toBe(0);
    expect(typeof receipt['at_epoch']).toBe('number');
  });

  it('carries a red command into the exit code, the row and the receipt', () => {
    const root = verifiable("printf 'boom\\n'; exit 3");
    const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('RESULT: FAIL (exit 3)');
    expect(io.stdout).toContain(`  FAIL ${'verification_command for T-0001'.padEnd(24)} exit 3\n`);
    expect(io.stdout).toContain(
      'VERDICT: 1 check(s) FAILED. The task stays in_progress (D-0006). If the cause is not obvious, dispatch the debugger agent',
    );
    expect(entryOf(root, 'T-0001')['receipt']).toMatchObject({ rc: 3, checks_run: 1, checks_failed: 1 });
  });

  it('bounds the evidence at the last 20 lines', () => {
    const root = verifiable('i=1; while [ $i -le 30 ]; do echo $i; i=$((i+1)); done');
    const { io } = drive(task, ctxFor(root), 'verify', ['T-0001']);
    expect(io.stdout).toContain('\n11\n12\n');
    expect(io.stdout).toContain('\n30\nRESULT: PASS (exit 0)\n');
    expect(io.stdout).not.toContain('\n10\n');
  });

  describe('the repo-health collation (T-0135)', () => {
    it('counts a PASS, FAILS a red test check, and TELLS a red lint check (T-0193/I-0117)', () => {
      const root = verifiable('true', [
        { name: 'ok-check', command: 'true' },
        { name: 'red-test', command: 'exit 4' },
        { name: 'red-lint', command: 'exit 5', type: 'lint' },
      ]);
      const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001'], true);
      expect(rc).toBe(1);
      const at = io.stdout.indexOf('{\n  "schema"');
      const env = JSON.parse(io.stdout.slice(at)) as {
        checks: { name: string; tier: string; detail: string }[];
        data: { receipt: { checks_run: number; checks_failed: number } };
      };
      const byName = Object.fromEntries(env.checks.map((c) => [c.name, c]));
      expect(byName['repo-health/ok-check']!.tier).toBe('pass');
      expect(byName['repo-health/red-test']!.tier).toBe('fail');
      expect(byName['repo-health/red-test']!.detail).toBe('exit 4');
      expect(byName['repo-health/red-lint']!.tier).toBe('tell');
      expect(byName['repo-health/red-lint']!.detail).toContain(
        "type=lint check exited 5 — a red linter is a finding, not this task's failure (T-0144/D-0072 boundary 7). Not counted in checks_failed.",
      );
      // four checks ran; only the red TEST counts against the task.
      expect(env.data.receipt.checks_run).toBe(4);
      expect(env.data.receipt.checks_failed).toBe(1);
    });

    it('prints the advisory line for a red linter in human mode too', () => {
      const root = verifiable('true', [{ name: 'red-lint', command: 'exit 5', type: 'lint' }]);
      const { io } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(io.stdout).toContain(
        'RESULT: TELL (advisory — type=lint check exited 5; a red linter is a finding, not this task\'s failure: T-0144/D-0072 boundary 7. Not counted in checks_failed.)',
      );
    });

    it('skips a nameless entry and a non-object one, exactly as the @tsv guard does', () => {
      const root = verifiable('true', ['a bare string', { command: 'exit 9' }, { name: null, command: 'exit 9' }]);
      const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(rc).toBe(0);
      expect(io.stdout).not.toContain('--- repo-health:');
      expect(entryOf(root, 'T-0001')['receipt']).toMatchObject({ checks_run: 1, checks_failed: 0 });
    });

    it('re-reads the registry for the `$ ...` line, so duplicate names show every command', () => {
      const root = verifiable('true', [
        { name: 'dup', command: 'true' },
        { name: 'dup', command: 'echo second' },
      ]);
      const { io } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(io.stdout).toContain('--- repo-health: dup\n$ true\necho second\n');
    });

    it('honours a STRING timeout_seconds and calls the timeout a FAIL, ahead of the lint carve-out', () => {
      // `.timeout_seconds // 120` is a jq default, not a type check, so a
      // string that parses is honoured. D-0085/OQ-15: TIMEOUT is tested
      // BEFORE type=lint, because a linter that burned its whole timeout
      // produced no findings and calling that a TELL would assert it ran.
      const root = verifiable('true', [{ name: 'slow', command: 'sleep 5', timeout_seconds: '0.4', type: 'lint' }]);
      const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(rc).toBe(1);
      expect(io.stdout).toContain('RESULT: FAIL (TIMED OUT — declared timeout_seconds exceeded, T-0078)');
      expect(io.stdout).toContain(`  FAIL ${'repo-health/slow'.padEnd(24)} TIMED OUT (T-0078)\n`);
      expect(entryOf(root, 'T-0001')['receipt']).toMatchObject({ checks_failed: 1 });
    }, 20000);

    it('falls back to the 120-second default for a timeout that is not a number', () => {
      // `.timeout_seconds // 120` only defaults null and false; a value that
      // is present but unparseable would otherwise become NaN, and a NaN
      // timeout kills every check the moment it starts.
      const root = verifiable('true', [{ name: 'odd', command: 'true', timeout_seconds: 'soon' }]);
      const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(rc).toBe(0);
      expect(io.stdout).toContain('--- repo-health: odd\n$ true\nRESULT: PASS (exit 0)\n');
    });

    it('EXECUTES the @tsv-escaped command while DISPLAYING the original (reproduced-with-flag)', () => {
      // bash's `@tsv` escapes the backslash and `read -r` does not unescape,
      // so a registered `printf 'ok\n'` runs as `printf 'ok\\n'` and prints a
      // literal backslash-n with no newline -- while the `$ ...` display line
      // re-reads the registry and shows the ORIGINAL. A bash defect this port
      // must not paper over; pinned so repairing it takes a ruling.
      const root = verifiable('true', [{ name: 'esc', command: "printf 'ok\\n'" }]);
      const { io } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(io.stdout).toContain("--- repo-health: esc\n$ printf 'ok\\n'\n");
      expect(io.stdout).toContain('ok\\nRESULT: PASS (exit 0)');
      expect(io.stdout).not.toContain('ok\nRESULT: PASS');
    });

    it('prints nothing at all for a check that produced no output', () => {
      const root = verifiable('true', [{ name: 'quiet', command: 'true' }]);
      const { io } = drive(task, ctxFor(root), 'verify', ['T-0001']);
      expect(io.stdout).toContain('--- repo-health: quiet\n$ true\nRESULT: PASS (exit 0)\n');
    });
  });

  describe('the two write_receipt guards (D-0007) — the verdict must survive both', () => {
    it('says so and stands its verdict when governance/ is not writable', () => {
      const root = verifiable('true');
      chmodSync(join(root, 'governance'), 0o555);
      try {
        const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001']);
        expect(rc).toBe(0);
        expect(io.stderr).toBe(
          `task verify: could not record the receipt on T-0001 — governance/ is not writable (read-only agent sandbox?). ` +
            `The verdict above stands; re-run outside the sandbox to leave a receipt for scrumux task accept.\n`,
        );
        expect(io.stdout).not.toContain('RECEIPT: recorded');
        expect(entryOf(root, 'T-0001')['receipt']).toBeUndefined();
      } finally {
        chmodSync(join(root, 'governance'), 0o755);
      }
    });

    it('says so and stands its verdict when the write itself refuses', () => {
      // A held journal lock: the writer refuses, and the subshell keeps that
      // refusal from taking the script's exit code with it.
      const root = verifiable('true');
      mkdirSync(join(root, 'governance', 'tasks.json.lock'));
      const ctx = ctxFor(root, { env: { JOURNAL_LOCK_TRIES: '1' } });
      const { io, rc } = drive(task, ctx, 'verify', ['T-0001']);
      expect(rc).toBe(0);
      expect(io.stderr).toBe(
        'task verify: the receipt write on T-0001 FAILED — the verdict above stands, but scrumux task accept ' +
          'will refuse T-0001 until a receipt exists. Retry: .claude/scripts/scrumux task verify T-0001\n',
      );
      expect(entryOf(root, 'T-0001')['receipt']).toBeUndefined();
    });
  });
});

// ===========================================================================
// the branches a happy path never reaches
// ===========================================================================
describe('the shapes only a hand-damaged journal produces', () => {
  it('task status with no arguments at all prints the usage line', () => {
    const { io, rc } = drive(task, ctxFor(scratch()), 'status', []);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('usage: scrumux task status T-0001');
  });

  it('the strict acceptance probe walks past a non-object row', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: ['a bare string', seedTask({ acceptance: { accepted: true } })] });
    const { rc } = drive(task, ctxFor(root), 'status', ['T-0001', 'accepted']);
    expect(rc).toBe(0);
  });

  it('task order and task update leave every other row untouched', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask(), seedTask({ id: 'T-0002', title: 'the other one' })] });
    drive(task, ctxFor(root), 'order', ['T-0001', '--scope', 's', '--verify', 'true', '--file', 'a | b']);
    drive(task, ctxFor(root), 'update', ['T-0001', '--title', 'renamed']);
    expect(JSON.stringify(entryOf(root, 'T-0002'))).toBe(JSON.stringify(seedTask({ id: 'T-0002', title: 'the other one' })));
  });

  it('accept treats a receipt that is not an object as RED, never as green', () => {
    // `.receipt // empty` keeps a truthy scalar, so the gate above passes it;
    // then `.receipt.rc // "1"` over a non-object defaults to 1 and the red
    // refusal is what an operator gets. A port that answered "no receipt" here
    // would send them to `task verify` for a receipt that already exists.
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [seedTask({ status: 'in_review', task_order: fullOrder(), receipt: 'green, I promise' })],
    });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain("accept: T-0001's last task-verify receipt is RED (rc=1, checks_failed=0, dated ?)");
  });

  it('accept refuses a task whose order is missing entirely, not just its command', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_review', receipt: greenReceipt() })] });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('accept: T-0001 has no verification_command in its task order');
  });

  it('the sprint cascade does not complete on a task id the journal does not carry', () => {
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [seedTask({ status: 'in_review', task_order: fullOrder(), receipt: greenReceipt() })],
    });
    plant(root, 'sprints.json', {
      entries: [
        { id: 'SP-0000', status: 'ratified', tasks: ['T-0500'] },
        { id: 'SP-0001', status: 'ratified', tasks: ['T-0001', 'T-0099'] },
      ],
    });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(0);
    expect(io.stdout).not.toContain('-> complete');
    expect(entryOf(root, 'SP-0001', 'sprints.json')['status']).toBe('ratified');
  });

  it('_rejectPrior calls a non-object acceptance "null", so a rejection still records', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ acceptance: 'accepted, honest' })] });
    expect(_rejectPrior(gov(root, 'tasks.json'), 'T-0001')).toBe('null');
    const { rc } = drive(task, ctxFor(root), 'reject', ['T-0001', '--by', 'User', '--reason', 'r']);
    expect(rc).toBe(0);
  });

  it('a re-run killed by a signal the shell has no number for is exit 128', () => {
    // `128 + (n[signal] ?? 0)`: the map holds the eight signals bash names,
    // and anything else contributes nothing rather than crashing the accept.
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [seedTask({ status: 'in_review', task_order: fullOrder({ verification_command: 'kill -USR1 $$' }), receipt: greenReceipt() })],
    });
    const { io, rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('FAILED when re-run just now (exit 128)');
  });

  it('brief and lint survive an order with no context object at all', () => {
    const root = scratch();
    plant(root, 'tasks.json', {
      entries: [
        seedTask({
          story: 'S-0001',
          task_order: { light: true, scope: 'edit (src/x.ts)', out_of_scope: [], verification_command: 'true' },
        }),
      ],
    });
    plant(root, 'design.json', { entries: [{ id: 'S-0001', kind: 'story', narrative: 'n' }] });
    const b = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(b.rc).toBe(0);
    expect(b.io.stdout).toContain('--- Reading list (open these, for these reasons — do not search) ---\n\n');
    expect(b.io.stdout).toContain('  (none declared)');
    const l = drive(task, ctxFor(root), 'lint', ['T-0001']);
    expect(l.rc).toBe(0);
    expect(l.io.stdout).toContain('context.files empty — the reading list IS the anti-search mechanism (D-0005)');
    // the scope scan tokenizes leading punctuation into an empty token, which
    // is dropped rather than reported as a path.
    expect(l.io.stdout).toContain('the scope text names path(s) the order does not list: src/x.ts —');
  });

  it('brief walks past a non-object sprint row and past a log.json that is not an object', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ task_order: fullOrder() })] });
    plant(root, 'sprints.json', { entries: ['junk', { id: 'SP-0001', status: 'ratified', tasks: ['T-0001'] }] });
    writeFileSync(gov(root, 'log.json'), J([1, 2]));
    const { io, rc } = drive(task, ctxFor(root), 'brief', ['T-0001']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('sprint: T-0001 is in ratified sprint SP-0001 — OK (D-0004)');
    expect(io.stdout).toContain('--- History for T-0001 ---\n\n');
  });
});

// ===========================================================================
// the shared helpers, directly
// ===========================================================================
describe('src/nouns/task/shared.ts — jq -r\'s rendering rules, in one place', () => {
  it('jqRaw renders a string raw, everything else as JSON, and absence as null', () => {
    expect(jqRaw(undefined)).toBe('null');
    expect(jqRaw(null)).toBe('null');
    expect(jqRaw('a string')).toBe('a string');
    expect(jqRaw(true)).toBe('true');
    expect(jqRaw(false)).toBe('false');
    expect(jqRaw(3)).toBe('3');
    expect(jqRaw([1, 2])).toBe('[1,2]');
    expect(jqRaw({ a: 'b' })).toBe('{"a":"b"}');
    // a number that kept its source literal renders its LITERAL, so a journal
    // holding 1.50 does not become 1.5 in a refusal that quotes it.
    expect(jqRaw(new RawNumber('1.50'))).toBe('1.50');
  });

  it('interp is jqRaw — `"\\(.x)"` and `jq -r .x` agree for these types', () => {
    expect(interp).toBe(jqRaw);
  });

  it('rawOr swallows false as well as null, which `??` does not', () => {
    expect(rawOr(undefined, 'd')).toBe('d');
    expect(rawOr(null, 'd')).toBe('d');
    expect(rawOr(false, 'd')).toBe('d');
    expect(rawOr(0, 'd')).toBe('0');
    expect(rawOr('', 'd')).toBe('');
    expect(rawOr(true, 'd')).toBe('true');
  });

  it('obj answers null for everything that is not a jq object', () => {
    expect(obj(null)).toBeNull();
    expect(obj(undefined)).toBeNull();
    expect(obj([1])).toBeNull();
    expect(obj('s')).toBeNull();
    expect(obj(new RawNumber('1'))).toBeNull();
    expect(obj({ a: 1 })).toEqual({ a: 1 });
  });

  it('arr answers the empty array for everything that is not one', () => {
    expect(arr(undefined)).toEqual([]);
    expect(arr(null)).toEqual([]);
    expect(arr({ a: 1 })).toEqual([]);
    expect(arr([1, 2])).toEqual([1, 2]);
  });

  it('rows is a TOLERANT read: absent, corrupt and mis-shaped all answer nothing', () => {
    const root = scratch();
    const p = gov(root, 'tasks.json');
    expect(rows(p)).toEqual([]);
    writeFileSync(p, '{not json');
    expect(rows(p)).toEqual([]);
    writeFileSync(p, '[1,2]');
    expect(rows(p)).toEqual([]);
    writeFileSync(p, J({ entries: { a: 1 } }));
    expect(rows(p)).toEqual([]);
    writeFileSync(p, J({ entries: [{ id: 'T-0001' }] }));
    expect(rows(p)).toEqual([{ id: 'T-0001' }]);
  });

  it('rowById takes the FIRST match and skips rows that are not objects', () => {
    const root = scratch();
    const p = gov(root, 'tasks.json');
    // string values, deliberately: a JSON number comes back as a RawNumber
    // (the literal-preserving reader), which is a different assertion.
    writeFileSync(p, J({ entries: ['junk', { id: 'T-0001', n: 'first' }, { id: 'T-0001', n: 'second' }] }));
    expect(rowById(p, 'T-0001')).toEqual({ id: 'T-0001', n: 'first' });
    expect(rowById(p, 'T-0009')).toBeNull();
  });

  it('stripTrailingNewlines strips EVERY trailing newline, as `$(...)` does', () => {
    expect(stripTrailingNewlines('a\n\n\n')).toBe('a');
    expect(stripTrailingNewlines('a\nb')).toBe('a\nb');
    expect(stripTrailingNewlines('')).toBe('');
    expect(stripTrailingNewlines('\n')).toBe('');
  });

  it('tailOfCapture prints one BLANK line for an empty capture, and that shape is contract', () => {
    // `printf '%s\\n' "$OUT" | tail -20` re-adds exactly one newline, so an
    // empty capture is one empty line rather than nothing.
    expect(tailOfCapture('', 20)).toEqual(['']);
    expect(tailOfCapture('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailOfCapture('only\n', 20)).toEqual(['only']);
  });

  it('directOut adds the newline the caller does not', () => {
    const io = captureIo();
    directOut(io)('a line');
    expect(io.stdout).toBe('a line\n');
  });

  it('the three bearing readers each answer their own question', () => {
    const bearing = [
      'path changes src/a.ts',
      '  path changes src/b.ts  ',
      'path reads src/c.ts',
      'path changes',
      'D-0001 [changes src/a.ts] a ruling',
      'I-0002 [reads src/c.ts] an issue',
      'T-0003 [changes src/a.ts] not a D or an I',
      'noise',
    ].join('\n');
    expect(bearingChangedPaths(bearing)).toBe('src/a.ts src/b.ts');
    expect(bearingChangeIds(bearing)).toEqual(['D-0001']);
    expect(bearingRecordLines(bearing)).toEqual([
      'D-0001 [changes src/a.ts] a ruling',
      'I-0002 [reads src/c.ts] an issue',
    ]);
  });

  it('the path helpers name the files the verbs actually read and write', () => {
    const root = scratch();
    const ctx = nctx(root);
    // asserted against a REAL write, not against a re-spelled join: this is
    // the seam that decides which journal every task verb touches.
    drive(task, ctxFor(root), 'new', ['--title', 't', '--check', 'c']);
    expect(existsSync(tasksPath(ctx))).toBe(true);
    expect(readFileSync(tasksPath(ctx), 'utf8')).toContain('T-0001');
    expect(sprintsPath(ctx)).toBe(join(root, 'governance', 'sprints.json'));
    expect(cliPath(ctx)).toBe(join(NO_SCRIPTS, 'scrumux'));
    // NOT asserted here: `designPath`, shared.ts:75. It is exported and
    // imported by nothing -- every design.json read in this noun goes through
    // task.ts's own private `designPathOf` (task.ts:159) -- so a test of it
    // would raise the function count of this file without pinning any
    // behaviour a regression could break. Reported, not covered.
  });

  it('runScrumux reports the shell\'s OWN code when the sibling CLI is not there', () => {
    const root = scratch();
    const ctx = nctx(root);
    const r = runScrumux(ctx, ['graph', 'gov', 'bearing']);
    // THE CLAIM IS "the interpreter's own", AND THE NUMBER IS NOT PORTABLE.
    // `runScrumux` spawns with `process.execPath` now (bash retired), so what
    // it owes the caller is node's own verdict on a script that is not there
    // — not the `status === null` fallback the function substitutes when the
    // spawn itself fails. Ask node the same question and compare, rather
    // than hard-coding a number.
    const nodesOwn = spawnSync(process.execPath, [join(NO_SCRIPTS, 'scrumux')], { encoding: 'utf8' }).status;
    expect(nodesOwn).not.toBeNull();
    expect(r.rc).toBe(nodesOwn);
    expect(r.rc).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toBe('');
  });
});

