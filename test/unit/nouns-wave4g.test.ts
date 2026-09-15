/**
 * Unit cover for Wave 4G: the `task` noun, and the write-through `Cli`.
 *
 * THE DIFFERENTIAL IS THE GATE, not this file (`test/fixtures/
 * tier2-wave4g.mjs`). What lives here is exactly what a byte comparison
 * cannot reach:
 *
 *   1. THE RULED DIVERGENCES. A fixture must go RED where a ruling makes the
 *      two sides differ, so those shapes are asserted per side here instead:
 *      the D-0085/OQ-7 malformed-id refusal through `task new` (bash hands
 *      out a duplicate at rc 0), and the TIMEOUT evidence line (bash's shell
 *      prints a pid-bearing job-control diagnostic the port does not fake).
 *   2. THE WRITE-THROUGH RULING (2026-09-01). Every fixture's happy path was
 *      byte-identical before AND after the change -- that is the point of it
 *      -- so only a speak-then-refuse shape can pin it, and that shape ends
 *      at exit 2 where the envelope never flushes a buffer.
 *   3. CLI-7. The differential runs both sides with WORK_ROOT == ROOT, so a
 *      re-run that used the wrong tree would still compare green. Asserted
 *      here with the two trees genuinely different.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as task } from '../../src/nouns/task.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');

const TODAY = todayStamp();
const J = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scrumux-w4g-unit-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}

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

function drive(mod: NounModule, ctx: DispatchContext, verb: string, args: string[], json = false): { io: CapturedIo; rc: number } {
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

const seededTask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T-0001', title: 'Task 1', status: 'proposed', acceptance_check: 'check 1', created_at: '2026-08-01', ...over,
});

// ---------------------------------------------------------------------------
describe('the write-through Cli (ruling of 2026-09-01)', () => {
  it('a line said before a refusal has already reached stdout, as bash printed it', () => {
    const io = captureIo();
    const cli = new Cli('probe', [], false, io);
    cli.say('added .env to .gitignore');
    let rc = -1;
    try { cli.die('refusing after speaking'); } catch (e) { rc = (e as ExitSignal).code; }
    expect(rc).toBe(2);
    // The measured `secret set` shape: the operator must not lose the fact
    // that their .gitignore was just changed.
    expect(io.stdout).toBe('added .env to .gitignore\n');
    expect(io.stderr).toContain('refusing after speaking');
  });

  it('a result row printed before a refusal has also reached stdout (cli.sh:87-93)', () => {
    const io = captureIo();
    const cli = new Cli('probe', [], false, io);
    cli.pass('gate', 'held');
    try { cli.die('then refused'); } catch { /* the exit */ }
    expect(io.stdout).toContain('  ok   gate');
  });

  it('under --json the same shape keeps stdout to exactly one object', () => {
    const io = captureIo();
    const cli = new Cli('probe', [], true, io);
    cli.say('prose that must not leak');
    cli.pass('gate', 'held');
    try { cli.die('refused'); } catch { /* the exit */ }
    expect(io.stdout).not.toContain('prose that must not leak');
    const env = JSON.parse(io.stdout) as { exit: number; checks: unknown[] };
    expect(env.exit).toBe(2);
    expect(env.checks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('task new over a malformed id (APPROVED-DIVERGENCE D-0085/OQ-7)', () => {
  it('refuses through the noun where bash would allocate a duplicate at rc 0', () => {
    // The fixture for this shape was retired from the differential when the
    // noun was ported: the ruling MAKES the sides differ (bash's `tonumber`
    // dies mid-stream, `read -r n || n=1` defaults, and T-0001 is handed out
    // again over a journal that already holds it), so the mismatch is
    // asserted here, per side, instead of compared.
    const root = scratch();
    const before = J({ entries: [seededTask(), seededTask({ id: 'T-000A', title: 'Task 1, again' })] });
    writeFileSync(join(root, 'governance/tasks.json'), before);
    const { io, rc } = drive(task, ctxFor(root), 'new', ['--title', 'a new one', '--check', 'it exists']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('D-0085/OQ-7');
    expect(io.stderr).toContain('T-000A');
    // nothing was written -- the refusal left the journal exactly as planted.
    expect(readFileSync(join(root, 'governance/tasks.json'), 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('task verify — the TIMEOUT arm (T-0078, D-0085/OQ-15)', () => {
  it('classifies a timed-out LINT check as FAIL, ahead of the lint carve-out', () => {
    // Fixture-unpinnable: bash's shell prints a job-control diagnostic into
    // the captured evidence (`<lib.sh>: line NNN: <pid> Alarm clock: 14 …`)
    // whose pid varies run to run, and the port does not fake it -- Wave 4G
    // divergence register, item 2. The CLASSIFICATION is what must hold: a
    // linter that burned its whole timeout produced no findings, so calling
    // it TELL would assert it ran (Article 4).
    const root = scratch();
    writeFileSync(join(root, 'governance/tasks.json'), J({
      entries: [seededTask({ task_order: { scope: 's', out_of_scope: [], verification_command: "printf 'ok\\n'", context: { files: [{ path: 'x', why: 'w' }], refs: [], commands: [], interfaces: [], data_shapes: [] } } })],
    }));
    writeFileSync(join(root, 'governance/repo-health.json'), J({
      entries: [{ name: 'slow-lint', command: 'sleep 3', timeout_seconds: 1, type: 'lint' }],
    }));
    const { io, rc } = drive(task, ctxFor(root), 'verify', ['T-0001'], true);
    expect(rc).toBe(1);
    const env = JSON.parse(io.stdout.slice(io.stdout.indexOf('{'))) as {
      checks: { name: string; tier: string; detail: string }[];
      data: { receipt: { checks_run: number; checks_failed: number } };
    };
    const row = env.checks.find((c) => c.name === 'repo-health/slow-lint');
    expect(row?.tier).toBe('fail');
    expect(row?.detail).toBe('TIMED OUT (T-0078)');
    expect(env.data.receipt.checks_run).toBe(2);
    expect(env.data.receipt.checks_failed).toBe(1);
  }, 20000);
});

// ---------------------------------------------------------------------------
describe('task accept re-runs from WORK_ROOT, never ROOT (CLI-7)', () => {
  it('proves the delivered tree, with the records elsewhere', () => {
    // The differential cannot see this: it runs both sides with
    // WORK_ROOT == ROOT. Here the verification command passes ONLY in the
    // worktree, so an accept that re-ran from the records root would refuse.
    const records = scratch();
    const worktree = mkdtempSync(join(tmpdir(), 'scrumux-w4g-work-'));
    writeFileSync(join(worktree, 'delivered.marker'), 'present\n');
    const vc = 'test -f delivered.marker';
    writeFileSync(join(records, 'governance/tasks.json'), J({
      entries: [seededTask({
        status: 'in_review',
        task_order: { scope: 's', out_of_scope: [], verification_command: vc, context: { files: [{ path: 'x', why: 'w' }], refs: [], commands: [], interfaces: [], data_shapes: [] } },
        receipt: { date: '2026-08-20', at_epoch: 1755648000, command: vc, rc: 0, checks_run: 1, checks_failed: 0 },
      })],
    }));
    const ctx = ctxFor(records, { roots: { root: records, gov: join(records, 'governance'), workRoot: worktree } });
    const { io, rc } = drive(task, ctx, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(0);
    expect(io.stderr).toContain("re-running T-0001's verification before accepting");
    expect(io.stderr).toContain('re-run passed (exit 0)');
    const after = JSON.parse(readFileSync(join(records, 'governance/tasks.json'), 'utf8')) as {
      entries: { acceptance: { accepted: boolean; reverified: boolean } }[];
    };
    expect(after.entries[0]!.acceptance).toMatchObject({ accepted: true, reverified: true });
  });

  it('refuses when the WORKTREE fails the command, whatever the records root holds', () => {
    const records = scratch();
    writeFileSync(join(records, 'delivered.marker'), 'only in the records root\n');
    const worktree = mkdtempSync(join(tmpdir(), 'scrumux-w4g-work-'));
    const vc = 'test -f delivered.marker';
    writeFileSync(join(records, 'governance/tasks.json'), J({
      entries: [seededTask({
        status: 'in_review',
        task_order: { scope: 's', out_of_scope: [], verification_command: vc, context: { files: [{ path: 'x', why: 'w' }], refs: [], commands: [], interfaces: [], data_shapes: [] } },
        receipt: { date: '2026-08-20', at_epoch: 1755648000, command: vc, rc: 0, checks_run: 1, checks_failed: 0 },
      })],
    }));
    const ctx = ctxFor(records, { roots: { root: records, gov: join(records, 'governance'), workRoot: worktree } });
    const { io, rc } = drive(task, ctx, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('FAILED when re-run just now (exit 1)');
  });
});

// ---------------------------------------------------------------------------
describe('a rejected task stays acceptable (the // false hazard, twice ruled)', () => {
  it('accepted:false does not trip the write-once gate', () => {
    // cmd-task.md open question 2: `.acceptance.accepted == true`, never
    // `// true` -- a rejected task carries accepted:false and must remain
    // acceptable after rework.
    const root = scratch();
    const vc = 'true';
    writeFileSync(join(root, 'governance/tasks.json'), J({
      entries: [seededTask({
        status: 'in_progress',
        acceptance: { accepted: false, by: 'User', date: '2026-08-21', reason: 'sent back once' },
        task_order: { scope: 's', out_of_scope: [], verification_command: vc, context: { files: [{ path: 'x', why: 'w' }], refs: [], commands: [], interfaces: [], data_shapes: [] } },
        receipt: { date: '2026-08-22', at_epoch: 1755648000, command: vc, rc: 0, checks_run: 1, checks_failed: 0 },
      })],
    }));
    const { rc } = drive(task, ctxFor(root), 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(rc).toBe(0);
  });
});
