/**
 * Improvement cycle 2 (D-S038), the task/session/issue/log half:
 *
 *   SX-024  receipt fresh compares content; an accepted task's change is drift
 *   SX-028  post-acceptance task verify prints an accepted task's next step
 *   SX-029  timeouts stop the whole process group; accept's re-run is bounded
 *   SX-034  receipt_history keeps the pre-acceptance runs
 *   SX-036  task new --issue records the link; accept TELLs; the close WARNs (D-S041)
 *   SX-041  acceptance records check_fingerprint (D-S045)
 *
 * Every case drives the real noun modules against a scratch `governance/`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, nounContext, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as task } from '../../src/nouns/task.js';
import { MODULE as session } from '../../src/nouns/session.js';
import { runWithTimeout } from '../../src/journal/timeout.js';
import { rerunVerification } from '../../src/nouns/task/accept-extras.js';
import { RECEIPT_HISTORY_KEEP } from '../../src/nouns/task/receipt-freeze.js';
import { checkFingerprint, hashPath, coveredPaths } from '../../src/nouns/task/fingerprint.js';
import { commandPathWords, commandWorkDirs } from '../../src/nouns/task/command-paths.js';
import { checkJournal } from '../../src/schema/check.js';

const TODAY = todayStamp();
const CHECKOUT = resolve(import.meta.dirname, '../..');
const NO_SCRIPTS = mkdtempSync(join(tmpdir(), 'cycle2-task-noscripts-'));

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cycle2-task-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/a.ts'), 'export const a = 1;\n');
  return d;
}
const ctxFor = (root: string): DispatchContext => ({
  roots: { root, gov: join(root, 'governance'), workRoot: root },
  today: TODAY, io: captureIo(), scriptsDir: NO_SCRIPTS, env: { ...process.env, SCRUMUX_TASK: '' }, cwd: root,
});
function drive(mod: NounModule, root: string, verb: string, args: string[], json = false): { io: CapturedIo; rc: number } {
  const io = captureIo();
  const cli = new Cli(`x ${verb}`, args, json, io);
  let rc = 0;
  try { mod.run(cli, { ...ctxFor(root), io }, verb, args); } catch (e) {
    if (e instanceof ExitSignal) rc = e.code; else throw e;
  }
  return { io, rc };
}
const plant = (root: string, name: string, doc: unknown): void =>
  writeFileSync(join(root, 'governance', name), JSON.stringify(doc, null, 2) + '\n');
const entry = (root: string, id: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(root, 'governance/tasks.json'), 'utf8')) as { entries: Record<string, unknown>[] })
    .entries.find((e) => e['id'] === id)!;
const order = (verify: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scope: 'change src/a.ts', out_of_scope: ['x'], verification_command: verify,
  context: { files: [{ path: 'src/a.ts', why: 'the site' }], refs: [], commands: ['c'], interfaces: [], data_shapes: [] },
  ...over,
});
const seed = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T-0001', title: 't', acceptance_check: 'c', status: 'in_progress', created_at: '2026-09-01', task_order: order('true'), ...over,
});
const past = (p: string): void => { const t = new Date(Date.now() + 120_000); utimesSync(p, t, t); };

// ---------------------------------------------------------------- SX-024
describe('SX-024: receipt fresh compares content; an accepted change is drift', () => {
  it('a touched file with the same content passes; a changed one fails the in_review task', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seed()] });
    expect(drive(task, root, 'verify', ['T-0001']).rc).toBe(0);
    const hashes = (entry(root, 'T-0001')['receipt'] as Record<string, unknown>)['file_hashes'] as Record<string, string>;
    expect(Object.keys(hashes)).toEqual(['src/a.ts']);
    drive(task, root, 'status', ['T-0001', 'in_review']);
    past(join(root, 'src/a.ts')); // a checkout or a merge: mtime moved, bytes did not
    let s = drive(session, root, 'check', []).io.stdout;
    expect(s).toMatch(/ok +receipt fresh/);
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    s = drive(session, root, 'check', []).io.stdout;
    expect(s).toMatch(/FAIL receipt fresh .*T-0001:src\/a\.ts/);
  });

  it('a covered file created after the receipt counts as changed', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seed({ task_order: order('true', { context: { files: [{ path: 'src/a.ts', why: 'w' }], expected_artifacts: ['src/new.ts'] } }) })] });
    drive(task, root, 'verify', ['T-0001']);
    drive(task, root, 'status', ['T-0001', 'in_review']);
    writeFileSync(join(root, 'src/new.ts'), 'x');
    expect(drive(session, root, 'check', []).io.stdout).toMatch(/FAIL receipt fresh .*T-0001:src\/new\.ts/);
  });

  it("another task's legitimate change to an accepted task's file is a WARN, never the close's FAIL", () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seed()] });
    drive(task, root, 'verify', ['T-0001']);
    drive(task, root, 'status', ['T-0001', 'in_review']);
    expect(drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3;\n');
    const s = drive(session, root, 'check', []);
    expect(s.io.stdout).toMatch(/WARN post-acceptance drift .*T-0001:src\/a\.ts/);
    expect(s.io.stdout).not.toMatch(/FAIL receipt fresh/);
  });

  it('a receipt with no hashes (written before them) keeps the mtime test', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seed({ status: 'in_review', updated_at: TODAY,
      receipt: { date: '2026-09-01', at_epoch: 1000, command: 'true', rc: 0, checks_run: 1, checks_failed: 0 } })] });
    expect(drive(session, root, 'check', []).io.stdout).toMatch(/FAIL receipt fresh .*T-0001:src\/a\.ts/);
    expect(coveredPaths(entry(root, 'T-0001'))).toEqual(['src/a.ts']);
  });
});

// --------------------------------------------------------- SX-028, SX-034
describe('SX-028 / SX-034: the verdict after acceptance, and the run history before it', () => {
  it('keeps every pre-acceptance run, newest last, bounded', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seed({ task_order: order('test -f ok') })] });
    expect(drive(task, root, 'verify', ['T-0001']).rc).toBe(1);
    writeFileSync(join(root, 'ok'), '');
    expect(drive(task, root, 'verify', ['T-0001']).rc).toBe(0);
    let row = entry(root, 'T-0001');
    const hist = row['receipt_history'] as Record<string, unknown>[];
    expect(hist.map((h) => h['rc'])).toEqual([1, 0]);
    expect(Object.keys(hist[0]!)).toEqual(['date', 'at_epoch', 'command', 'rc', 'checks_run', 'checks_failed']);
    for (let i = 0; i < RECEIPT_HISTORY_KEEP + 3; i++) drive(task, root, 'verify', ['T-0001']);
    row = entry(root, 'T-0001');
    expect((row['receipt_history'] as unknown[]).length).toBe(RECEIPT_HISTORY_KEEP);
    expect(checkJournal(join(root, 'governance/tasks.json'), 'task.schema.json', CHECKOUT)).toEqual([]);
  });

  it('an accepted task gets an accepted task\'s verdict, green or red, and its history is not extended', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seed({ task_order: order('test -f ok') })] });
    writeFileSync(join(root, 'ok'), '');
    drive(task, root, 'verify', ['T-0001']);
    drive(task, root, 'status', ['T-0001', 'in_review']);
    drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    const green = drive(task, root, 'verify', ['T-0001']).io.stdout;
    expect(green).toContain('VERDICT: all checks pass — recorded as a post-acceptance check on accepted T-0001');
    expect(green).not.toContain('in_review');
    unlinkSync(join(root, 'ok'));
    const red = drive(task, root, 'verify', ['T-0001']).io.stdout;
    expect(red).toContain('recorded as post-acceptance DRIFT (D-S018)');
    expect(red).not.toContain('The task stays in_progress');
    expect((entry(root, 'T-0001')['receipt_history'] as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------- SX-029
describe('SX-029: a timeout stops every process the check started', () => {
  it('a backgrounded child dies with the timed-out command', async () => {
    const root = scratch();
    const marker = join(root, 'marker');
    const r = runWithTimeout(0.5, `(sleep 1.5; touch ${marker}) & sleep 10`, { capture: true, combine: true });
    expect([r.code, r.timedOut, r.signal]).toEqual([142, true, 'SIGALRM']);
    await new Promise((res) => setTimeout(res, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps the exit contract: own code, 127 for no command, 128+N for a signal, no timeout at 0', () => {
    expect(runWithTimeout(5, 'exit 3', { capture: true }).code).toBe(3);
    expect(runWithTimeout(5, 'no_such_command_cycle2', { capture: true }).code).toBe(127);
    expect(runWithTimeout(5, 'kill -TERM $$', { capture: true })).toMatchObject({ code: 143, timedOut: false, signal: 'SIGTERM' });
    expect(runWithTimeout(0, 'echo ok', { capture: true }).stdout).toBe('ok\n');
  });

  it("accept's re-run is bounded and says so in words", () => {
    const root = scratch();
    const io = captureIo();
    const cli = new Cli('task accept', [], false, io);
    let rc = 0;
    try { rerunVerification(cli, nounContext(ctxFor(root)), 'T-0001', 'echo started; sleep 10', 0.5); } catch (e) {
      if (e instanceof ExitSignal) rc = e.code; else throw e;
    }
    expect(rc).toBe(2);
    expect(io.stderr).toMatch(/re-run was STOPPED after \d+ s — it passed the 0\.5 s ceiling task verify gives/);
    expect(io.stderr).toContain('every process it started');
    expect(io.stderr).toContain('Nothing was accepted');
  });
});

// ---------------------------------------------------------- SX-036, SX-041
describe('SX-036 / D-S041 and SX-041 / D-S045: the issue link and the check fingerprint', () => {
  const withIssue = (status: string): string => {
    const root = scratch();
    plant(root, 'issues.json', { entries: [{ id: 'I-0016', type: 'defect', source: 'claude', summary: 's', resolution_pointer: 'f', status, created_at: '2026-09-01', validation: { verdict: 'reproduced', by: 'v', date: '2026-09-01', evidence: 'e' } }] });
    plant(root, 'tasks.json', { entries: [] });
    expect(drive(task, root, 'new', ['--title', 'The thing works', '--check', 'it does', '--issue', 'I-0016']).rc).toBe(0);
    return root;
  };

  it('task new --issue records it; accept TELLs the link and writes nothing to the issue; the close WARNs', () => {
    const root = withIssue('open');
    expect(entry(root, 'T-0001')['issue']).toBe('I-0016');
    const tasks = JSON.parse(readFileSync(join(root, 'governance/tasks.json'), 'utf8')) as { entries: Record<string, unknown>[] };
    tasks.entries[0] = { ...tasks.entries[0], status: 'in_review', task_order: order('true') };
    plant(root, 'tasks.json', tasks);
    drive(task, root, 'verify', ['T-0001']);
    const before = readFileSync(join(root, 'governance/issues.json'), 'utf8');
    const a = drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']);
    expect(a.rc).toBe(0);
    expect(a.io.stdout).toContain('T-0001 fixes I-0016 — resolve it with scrumux issue update I-0016 --status resolved');
    expect(readFileSync(join(root, 'governance/issues.json'), 'utf8')).toBe(before);
    expect(drive(session, root, 'check', []).io.stdout).toMatch(/WARN fixed issue open .*T-0001->I-0016/);
    expect(checkJournal(join(root, 'governance/tasks.json'), 'task.schema.json', CHECKOUT)).toEqual([]);
  });

  it('a resolved issue gets no TELL and no WARN', () => {
    const root = withIssue('resolved');
    const tasks = JSON.parse(readFileSync(join(root, 'governance/tasks.json'), 'utf8')) as { entries: Record<string, unknown>[] };
    tasks.entries[0] = { ...tasks.entries[0], status: 'in_review', task_order: order('true') };
    plant(root, 'tasks.json', tasks);
    drive(task, root, 'verify', ['T-0001']);
    const a = drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct'], true);
    expect((JSON.parse(a.io.stdout) as { data: Record<string, unknown> }).data['issue_status']).toBe('resolved');
    expect(a.io.stdout).not.toContain('fixes issue');
    expect(drive(session, root, 'check', []).io.stdout).not.toContain('fixed issue open');
  });

  it('acceptance fingerprints the script and test paths the command names, under its working directory', () => {
    const root = scratch();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'agents/tests/drafter'), { recursive: true });
    writeFileSync(join(root, 'scripts/check.sh'), 'exit 0\n');
    writeFileSync(join(root, 'agents/tests/test_fast.py'), 'def test(): pass\n');
    writeFileSync(join(root, 'agents/tests/drafter/test_a.py'), 'a\n');
    const cmd = 'bash scripts/check.sh && cd agents && true tests/test_fast.py tests/drafter ../../outside.sh';
    plant(root, 'tasks.json', { entries: [seed({ status: 'in_review', task_order: order(cmd) })] });
    drive(task, root, 'verify', ['T-0001']);
    expect(drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    const fp = (entry(root, 'T-0001')['acceptance'] as Record<string, unknown>)['check_fingerprint'] as { algo: string; files: Record<string, string> };
    expect(fp.algo).toBe('sha256');
    expect(Object.keys(fp.files).sort()).toEqual(['agents/tests/drafter', 'agents/tests/test_fast.py', 'scripts/check.sh']);
    expect(fp.files['agents/tests/drafter']).toBe(hashPath(join(root, 'agents/tests/drafter')));
    expect(checkJournal(join(root, 'governance/tasks.json'), 'task.schema.json', CHECKOUT)).toEqual([]);
  });

  it('the command readers and the directory hash', () => {
    expect(commandWorkDirs('uv run --directory agents pytest -q tests/x.py && cd app/ && npm test -- --cwd=web')).toEqual(['agents', 'app', 'web']);
    expect(commandPathWords("bash scripts/a.sh --config=conf/x.yaml -k 'tests/y' $HOME/z https://h/x.py pytest")).toEqual(['scripts/a.sh', 'conf/x.yaml', 'tests/y']);
    const root = scratch();
    const before = hashPath(join(root, 'src'));
    writeFileSync(join(root, 'src/b.ts'), 'b');
    expect(hashPath(join(root, 'src'))).not.toBe(before);
    expect(hashPath(join(root, 'nope'))).toBeNull();
    expect(checkFingerprint(root, 'true').files).toEqual({});
  });
});
