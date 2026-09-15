/**
 * The 2026-09-13 improvement cycle (super-repo ISSUES.MD), CLI half:
 *
 *   SX-011  task lint's scope scan stops reading URLs, routes and hosts as files
 *   SX-003  hollow greens: the READER note names the patterns, orders can state
 *           what must make the check fail, verify keeps its output for review
 *   SX-012  an addition to a ratified sprint awaits its own ratification (D-S017)
 *   SX-013  an accepted task's receipt is frozen; later runs are drift (D-S018)
 *
 * Every case drives the real noun modules against a scratch `governance/`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as task } from '../../src/nouns/task.js';
import { MODULE as sprint } from '../../src/nouns/sprint.js';
import { MODULE as session } from '../../src/nouns/session.js';
import { unlistedScopePaths, isFileShaped } from '../../src/nouns/task/scope-paths.js';
import { readerQuestion } from '../../src/nouns/task/reader.js';
import { pendingAdditions } from '../../src/nouns/sprint-additions.js';
import { frozenReceipt, redDrift, POST_ACCEPTANCE_KEEP } from '../../src/nouns/task/receipt-freeze.js';

const TODAY = todayStamp();
const NO_SCRIPTS = mkdtempSync(join(tmpdir(), 'scrumux-cycle-noscripts-'));

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scrumux-cycle-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}
const ctxFor = (root: string): DispatchContext => ({
  roots: { root, gov: join(root, 'governance'), workRoot: root },
  today: TODAY, io: captureIo(), scriptsDir: NO_SCRIPTS, env: { ...process.env }, cwd: root,
});
function drive(mod: NounModule, root: string, verb: string, args: string[]): { io: CapturedIo; rc: number } {
  const io = captureIo();
  const cli = new Cli(`x ${verb}`, args, false, io);
  let rc = 0;
  try { mod.run(cli, { ...ctxFor(root), io }, verb, args); } catch (e) {
    if (e instanceof ExitSignal) rc = e.code; else throw e;
  }
  return { io, rc };
}
const plant = (root: string, name: string, doc: unknown): void =>
  writeFileSync(join(root, 'governance', name), JSON.stringify(doc, null, 2) + '\n');
const entry = (root: string, name: string, id: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(root, 'governance', name), 'utf8')) as { entries: Record<string, unknown>[] })
    .entries.find((e) => e['id'] === id)!;

const order = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scope: 'change src/a.ts', out_of_scope: ['x'], verification_command: 'true',
  context: { files: [{ path: 'src/a.ts', why: 'the site' }], refs: [], commands: ['c'], interfaces: [], data_shapes: [] },
  ...over,
});
const seedTask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'T-0001', title: 't', acceptance_check: 'c', status: 'proposed', created_at: '2026-08-01', ...over,
});
const green = (command = 'true'): Record<string, unknown> =>
  ({ date: '2026-08-20', at_epoch: 1755648000, command, rc: 0, checks_run: 1, checks_failed: 0 });

// ---------------------------------------------------------------- SX-011
describe('SX-011: the scope scan does not read URLs, routes or hosts as files', () => {
  const ROVER = 'Add a health probe that calls /healthz and /api/vault over //127.0.0.1, and calls '
    + 'GATEWAY_URL/v1/entitlement for budget; index sources at Sources/_index, and fetch '
    + 'http://agent-builder:8010/openapi.json and agent-builder:8010/openapi.json.';

  it('names none of the Rover SP-0002 false positives', () => {
    expect(unlistedScopePaths(ROVER, ['src/health.ts'], scratch())).toEqual([]);
  });

  it('still catches a real unlisted file, a new file with an extension, and an existing directory', () => {
    const root = scratch();
    mkdirSync(join(root, 'agents', 'tests'), { recursive: true });
    const found = unlistedScopePaths(`${ROVER} Also edit src/other.ts, create app/src/vault.ts, and fix agents/tests.`, ['src/health.ts'], root);
    expect(found).toEqual(['src/other.ts', 'app/src/vault.ts', 'agents/tests']);
  });

  it('keeps absolute file paths and dotfiles-with-extension, and drops a sentence-ending period', () => {
    const root = scratch();
    expect(isFileShaped('/srv/apps/example-sdk/docs/sop/conventions.md', root)).toBe(true);
    expect(isFileShaped('/api/vault', root)).toBe(false);
    expect(unlistedScopePaths('See docs/notes.md.', [], root)).toEqual(['docs/notes.md']);
    expect(unlistedScopePaths('See src/a.ts.', ['src/a.ts'], root)).toEqual([]);
  });

  it('task lint prints no TELL for the Rover order', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ task_order: order({ scope: ROVER }) })] });
    const { io } = drive(task, root, 'lint', ['T-0001', '--hotfix']);
    expect(io.stdout).not.toContain('the scope text names path(s)');
  });
});

// ---------------------------------------------------------------- SX-003
describe('SX-003: hollow greens are named, a failure case can be declared, the output is kept', () => {
  it('the READER note names the three patterns and says when no failure case is declared', () => {
    const q = readerQuestion('sh check.sh', '');
    expect(q).toMatch(/SKIPS when its dependency is down/);
    expect(q).toMatch(/assertion that cannot fail/);
    expect(q).toMatch(/real shared data/);
    expect(q).toMatch(/declares no failure case/);
    expect(readerQuestion('sh check.sh', 'the vault is down')).toMatch(/must FAIL when: the vault is down/);
  });

  it('task order records --fails-when, lint echoes it, and brief prints it', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    const o = drive(task, root, 'order', ['T-0001', '--scope', 'change src/a.ts', '--verify', 'true',
      '--file', 'src/a.ts | the site', '--out', 'x', '--fails-when', 'the probe gets a 404']);
    expect(o.rc).toBe(0);
    const row = entry(root, 'tasks.json', 'T-0001');
    expect((row['task_order'] as Record<string, unknown>)['fails_when']).toBe('the probe gets a 404');
    const lint = drive(task, root, 'lint', ['T-0001', '--hotfix']);
    expect(lint.io.stdout).toContain('must FAIL when: the probe gets a 404');
    const brief = drive(task, root, 'brief', ['T-0001', '--allow-unsprinted']);
    expect(brief.io.stdout).toContain('MUST FAIL WHEN: the probe gets a 404');
  });

  it('an order without --fails-when carries no key (older orders read the same)', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask()] });
    drive(task, root, 'order', ['T-0001', '--scope', 's', '--verify', 'true', '--file', 'src/a.ts | w']);
    expect('fails_when' in (entry(root, 'tasks.json', 'T-0001')['task_order'] as object)).toBe(false);
  });

  it('task verify writes the output tail to a self-ignoring evidence sidecar', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_progress', task_order: order({ verification_command: 'echo "2 passed, 3 skipped"' }) })] });
    const { rc } = drive(task, root, 'verify', ['T-0001']);
    expect(rc).toBe(0);
    const ev = readFileSync(join(root, 'governance', '.evidence', 'T-0001.verify.txt'), 'utf8');
    expect(ev).toContain('# command: echo "2 passed, 3 skipped"');
    expect(ev).toContain('# rc: 0');
    expect(ev).toContain('2 passed, 3 skipped');
    expect(readFileSync(join(root, 'governance', '.evidence', '.gitignore'), 'utf8')).toBe('*\n');
  });
});

// ---------------------------------------------------------------- SX-012
describe('SX-012 / D-S017: adding to a ratified sprint opens ratification for the addition', () => {
  const ratifiedSprint = (): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [
      seedTask({ id: 'T-0007', story: 'S-0001', task_order: order() }),
      seedTask({ id: 'T-0008', story: 'S-0001', task_order: order() }),
    ] });
    plant(root, 'design.json', { entries: [{ id: 'S-0001', kind: 'story', narrative: 'n' }] });
    plant(root, 'sprints.json', { entries: [{
      id: 'SP-0003', epic: 'E-0001', status: 'ratified', tasks: ['T-0007'], parallel: 1, created_at: '2026-09-13',
      ratified: { by: 'claude-opus-5', date: '2026-09-13', authority: 'app' },
    }] });
    return root;
  };

  it('allows the add, records it as awaiting ratification, and leaves the original ratification alone', () => {
    const root = ratifiedSprint();
    const { io, rc } = drive(sprint, root, 'add', ['SP-0003', 'T-0008']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('awaiting ratification');
    const sp = entry(root, 'sprints.json', 'SP-0003');
    expect(sp['tasks']).toEqual(['T-0007', 'T-0008']);
    expect(sp['ratified']).toEqual({ by: 'claude-opus-5', date: '2026-09-13', authority: 'app' });
    expect(pendingAdditions(sp as never)).toEqual(['T-0008']);
  });

  it('the added task fails its brief sprint gate; the ratified task still briefs OK', () => {
    const root = ratifiedSprint();
    drive(sprint, root, 'add', ['SP-0003', 'T-0008']);
    const added = drive(task, root, 'brief', ['T-0008']);
    expect(added.rc).toBe(1);
    expect(added.io.stdout).toMatch(/added to SP-0003 after SP-0003 was ratified/);
    const kept = drive(task, root, 'brief', ['T-0007']);
    expect(kept.io.stdout).toContain('T-0007 is in ratified sprint SP-0003 — OK');
    expect(kept.io.stdout).not.toMatch(/after SP-0003 was ratified/);
  });

  it('sprint ratify ratifies the addition only, and the brief then passes', () => {
    const root = ratifiedSprint();
    drive(sprint, root, 'add', ['SP-0003', 'T-0008']);
    const r = drive(sprint, root, 'ratify', ['SP-0003', '--by', 'User', '--authority', 'direct']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toContain('addition(s) ratified: T-0008');
    const sp = entry(root, 'sprints.json', 'SP-0003');
    expect(sp['ratified']).toEqual({ by: 'claude-opus-5', date: '2026-09-13', authority: 'app' });
    expect(pendingAdditions(sp as never)).toEqual([]);
    expect(drive(task, root, 'brief', ['T-0008']).io.stdout).toContain('T-0008 is in ratified sprint SP-0003 — OK');
  });

  it('a past addition with no additions record (older journals) is not pending, and a proposed sprint records none', () => {
    const root = ratifiedSprint();
    const sp = entry(root, 'sprints.json', 'SP-0003');
    expect(pendingAdditions({ ...sp, tasks: ['T-0007', 'T-0008'] } as never)).toEqual([]);
    plant(root, 'sprints.json', { entries: [{ id: 'SP-0004', epic: 'E-0001', status: 'proposed', tasks: [], created_at: '2026-09-13' }] });
    drive(sprint, root, 'add', ['SP-0004', 'T-0008']);
    expect('additions' in entry(root, 'sprints.json', 'SP-0004')).toBe(false);
  });
});

// ---------------------------------------------------------------- SX-013
describe('SX-013 / D-S018: an accepted receipt is frozen; later runs are post-acceptance checks', () => {
  const accepted = (): string => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({
      status: 'in_review', updated_at: '2026-08-20', task_order: order({ verification_command: 'test -f ok' }), receipt: green('test -f ok'),
    })] });
    writeFileSync(join(root, 'ok'), '');
    expect(drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    return root;
  };

  it('a red verify after acceptance leaves receipt and acceptance.receipt unchanged and records drift', () => {
    const root = accepted();
    const before = entry(root, 'tasks.json', 'T-0001');
    rmSync(join(root, 'ok'));
    const v = drive(task, root, 'verify', ['T-0001']);
    expect(v.rc).toBe(1);
    expect(v.io.stdout).toMatch(/ACCEPTED, so its acceptance receipt is frozen/);
    expect(v.io.stdout).toMatch(/DRIFT/);
    const after = entry(root, 'tasks.json', 'T-0001');
    expect(after['receipt']).toEqual(before['receipt']);
    expect(after['acceptance']).toEqual(before['acceptance']);
    expect(frozenReceipt(after as never)).toEqual(before['receipt']);
    expect(redDrift(after as never)?.['rc']).toBe(1);
    expect(existsSync(join(root, 'governance', '.evidence', 'T-0001.post-acceptance.txt'))).toBe(true);
  });

  it('session check WARNs about the drift and does not fail "receipt green"', () => {
    const root = accepted();
    rmSync(join(root, 'ok'));
    drive(task, root, 'verify', ['T-0001']);
    const s = drive(session, root, 'check', []);
    expect(s.io.stdout).toContain('post-acceptance drift');
    expect(s.io.stdout).not.toMatch(/FAIL receipt green/);
  });

  it('keeps only the newest post-acceptance checks, and a later green run clears the drift', () => {
    const root = accepted();
    rmSync(join(root, 'ok'));
    for (let i = 0; i < POST_ACCEPTANCE_KEEP + 2; i++) drive(task, root, 'verify', ['T-0001']);
    writeFileSync(join(root, 'ok'), '');
    drive(task, root, 'verify', ['T-0001']);
    const row = entry(root, 'tasks.json', 'T-0001');
    expect((row['post_acceptance_checks'] as unknown[]).length).toBe(POST_ACCEPTANCE_KEEP);
    expect(redDrift(row as never)).toBeNull();
  });

  it('an older accepted row (no acceptance.receipt) freezes its live receipt', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({
      status: 'accepted', task_order: order({ verification_command: 'false' }), receipt: green('false'),
      acceptance: { accepted: true, by: 'User', date: '2026-08-20', authority: 'direct' },
    })] });
    drive(task, root, 'verify', ['T-0001']);
    const row = entry(root, 'tasks.json', 'T-0001');
    expect(row['receipt']).toEqual(green('false'));
    expect(redDrift(row as never)).not.toBeNull();
  });
});

// ---------------------------------------------------------------- SX-006
describe('SX-006: a block records what it waits on, and only while blocked', () => {
  it('task status blocked --reason records the reason; moving on removes it', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_progress', task_order: order() })] });
    const b = drive(task, root, 'status', ['T-0001', 'blocked', '--reason', 'awaiting operator deploy of this branch']);
    expect(b.rc).toBe(0);
    expect(entry(root, 'tasks.json', 'T-0001')['blocked']).toEqual({ reason: 'awaiting operator deploy of this branch', date: TODAY });
    expect(drive(task, root, 'status', ['T-0001', 'in_review']).rc).toBe(0);
    expect('blocked' in entry(root, 'tasks.json', 'T-0001')).toBe(false);
  });

  it('blocked without a reason still works, and --by stays superseded-only', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [seedTask({ status: 'in_progress' })] });
    expect(drive(task, root, 'status', ['T-0001', 'blocked']).rc).toBe(0);
    expect('blocked' in entry(root, 'tasks.json', 'T-0001')).toBe(false);
    expect(drive(task, root, 'status', ['T-0001', 'blocked', '--by', 'T-0002']).rc).toBe(2);
  });
});
