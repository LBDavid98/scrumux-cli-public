/**
 * SX-020 / D-S039 — a decision (or an exception resolution) without a
 * resolvable authority is recorded PROPOSED, never refused; a person
 * ratifies, rejects or acknowledges it. Legacy records read as ratified with
 * authority "unknown".
 *
 * Every case drives the real noun modules against a scratch `governance/`,
 * and every record written is checked against the shipped schema.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as decide } from '../../src/nouns/decide.js';
import { MODULE as exception } from '../../src/nouns/exception.js';
import { MODULE as task } from '../../src/nouns/task.js';
import { MODULE as records } from '../../src/nouns/records.js';
import { MODULE as status } from '../../src/nouns/status.js';
import { renderDecisions } from '../../src/nouns/views-render.js';
import { refResolve } from '../../src/journal/refs.js';
import { standingOf, isAuthorityVariance } from '../../src/journal/standing.js';
import { checkJournal } from '../../src/schema/check.js';
import { parseActFlags } from '../../src/nouns/lib/standing-acts.js';

const TODAY = todayStamp();
const CHECKOUT = resolve(import.meta.dirname, '../..');
const NO_SCRIPTS = mkdtempSync(join(tmpdir(), 'cycle2-decide-noscripts-'));

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cycle2-decide-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}
const ctxFor = (root: string): DispatchContext => ({
  roots: { root, gov: join(root, 'governance'), workRoot: root },
  today: TODAY, io: captureIo(), scriptsDir: NO_SCRIPTS, env: { ...process.env }, cwd: root,
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
const rows = (root: string, name: string): Record<string, unknown>[] =>
  (JSON.parse(readFileSync(join(root, 'governance', name), 'utf8')) as { entries: Record<string, unknown>[] }).entries;
const row = (root: string, name: string, id: string): Record<string, unknown> => rows(root, name).find((e) => e['id'] === id)!;
const schemaClean = (root: string, journal: string, schema: string): string[] =>
  checkJournal(join(root, 'governance', journal), schema, CHECKOUT);

const NEW = ['--title', 'smoke.sh pins -p rover', '--decision', 'The rule', '--rationale', 'Weighed'];
const legacy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'D-0001', date: '2026-09-01', title: 'old', decision: 'x', rationale: 'y', ratified_by: 'claude-opus-5 (Rover operator, D-0008)', refs: {}, supersedes: null, ...over,
});

describe('decide new never refuses for authority (D-S039)', () => {
  it('without --authority: proposed, authority none, recorded_by, no ratified_by; stdout is only the id', () => {
    const root = scratch();
    const r = drive(decide, root, 'new', [...NEW, '--by', 'claude-sonnet (T-0011)']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toBe('D-0001\n');
    expect(r.io.stderr).toMatch(/D-0001 is recorded PROPOSED/);
    expect(r.io.stderr).toContain('scrumux decide ratify D-0001');
    const d = row(root, 'decisions.json', 'D-0001');
    expect(d['status']).toBe('proposed');
    expect(d['authority']).toBe('none');
    expect(d['recorded_by']).toBe('claude-sonnet (T-0011)');
    expect('ratified_by' in d).toBe(false);
    expect(schemaClean(root, 'decisions.json', 'decision.schema.json')).toEqual([]);
  });

  it('an authority that does not resolve is kept as authority_claimed, still proposed, exit 0', () => {
    const root = scratch();
    const r = drive(decide, root, 'new', [...NEW, '--by', 'agent', '--authority', 'standing:D-0099'], true);
    expect(r.rc).toBe(0);
    const env = JSON.parse(r.io.stdout) as { data: Record<string, unknown> };
    expect(env.data).toEqual({ status: 'proposed', authority: 'none', id: 'D-0001' });
    expect(row(root, 'decisions.json', 'D-0001')['authority_claimed']).toBe('standing:D-0099');
  });

  it('with a resolvable authority: ratified with it', () => {
    const root = scratch();
    expect(drive(decide, root, 'new', [...NEW, '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    const d = row(root, 'decisions.json', 'D-0001');
    expect([d['status'], d['authority'], d['ratified_by'], d['recorded_by']]).toEqual(['ratified', 'direct', 'User', 'User']);
  });

  it('a proposed decision retires nothing it supersedes, until it is ratified', () => {
    const root = scratch();
    plant(root, 'decisions.json', { entries: [legacy({ ratified_by: 'User' })] });
    drive(decide, root, 'new', [...NEW, '--by', 'agent', '--supersedes', 'D-0001']);
    expect('superseded_by' in row(root, 'decisions.json', 'D-0001')).toBe(false);
    const gov = join(root, 'governance');
    expect(refResolve(gov, 'D-0001')).toBe('old');
    expect(refResolve(gov, 'D-0002')).toContain('[PROPOSED — not binding]');
    const doc = JSON.parse(readFileSync(join(gov, 'decisions.json'), 'utf8'));
    expect(renderDecisions(doc)).not.toContain('Superseded (archive');
    expect(renderDecisions(doc)).toContain('PROPOSED — recorded by agent with no authority');

    expect(drive(decide, root, 'ratify', ['D-0002', '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    expect(row(root, 'decisions.json', 'D-0001')['superseded_by']).toBe('D-0002');
    expect(refResolve(gov, 'D-0001')).toContain('SUPERSEDED by D-0002');
  });
});

describe('decide ratify | reject | acknowledge', () => {
  it('ratify needs an authority that resolves, and records who and when', () => {
    const root = scratch();
    plant(root, 'decisions.json', { entries: [legacy()] });
    expect(drive(decide, root, 'ratify', ['D-0001', '--by', 'User']).rc).toBe(2);
    expect(drive(decide, root, 'ratify', ['D-0001', '--by', 'User', '--authority', 'standing:D-0001']).rc).toBe(2);
    const r = drive(decide, root, 'ratify', ['D-0001', '--by', 'User', '--authority', 'app:s-1'], true);
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.io.stdout) as { data: unknown }).data).toEqual({ id: 'D-0001', status: 'ratified', authority: 'app:s-1', by: 'User' });
    const d = row(root, 'decisions.json', 'D-0001');
    expect(d['prior_ratified_by']).toBe('claude-opus-5 (Rover operator, D-0008)');
    expect([d['ratified_by'], d['ratified_at']]).toEqual(['User', TODAY]);
    expect(schemaClean(root, 'decisions.json', 'decision.schema.json')).toEqual([]);
    // Already ratified with an authority: changed only by a successor.
    const again = drive(decide, root, 'ratify', ['D-0001', '--by', 'User', '--authority', 'direct']);
    expect(again.rc).toBe(2);
    expect(again.io.stderr).toContain('--supersedes');
  });

  it('reject needs a reason; a rejected decision is archived and cannot be ratified', () => {
    const root = scratch();
    plant(root, 'decisions.json', { entries: [legacy({ ratified_by: 'User' }), legacy({ id: 'D-0002', supersedes: 'D-0001' })] });
    // A legacy successor had stamped its predecessor.
    const docs = rows(root, 'decisions.json');
    docs[0]!['superseded_by'] = 'D-0002';
    plant(root, 'decisions.json', { entries: docs });
    expect(drive(decide, root, 'reject', ['D-0002', '--by', 'User']).rc).toBe(2);
    expect(drive(decide, root, 'reject', ['D-0002', '--by', 'User', '--reason', 'the operator never decided this']).rc).toBe(0);
    expect(row(root, 'decisions.json', 'D-0002')['status']).toBe('rejected');
    expect('superseded_by' in row(root, 'decisions.json', 'D-0001')).toBe(false);
    const md = renderDecisions(JSON.parse(readFileSync(join(root, 'governance/decisions.json'), 'utf8')));
    expect(md).toContain('# Rejected (NOT law');
    expect(md).toContain('REJECTED by User: the operator never decided this');
    expect(drive(decide, root, 'ratify', ['D-0002', '--by', 'User', '--authority', 'direct']).io.stderr).toContain('was rejected');
    expect(schemaClean(root, 'decisions.json', 'decision.schema.json')).toEqual([]);
  });

  it('acknowledge keeps the standing, records who saw it, and is taken once', () => {
    const root = scratch();
    plant(root, 'decisions.json', { entries: [legacy()] });
    expect(isAuthorityVariance(standingOf(row(root, 'decisions.json', 'D-0001') as never))).toBe(true);
    expect(drive(decide, root, 'acknowledge', ['D-0001', '--by', 'User', '--note', 'content is accurate']).rc).toBe(0);
    const d = row(root, 'decisions.json', 'D-0001');
    expect([d['acknowledged_by'], d['acknowledged_at'], d['acknowledgement_note'], d['status']]).toEqual(['User', TODAY, 'content is accurate', undefined]);
    expect(isAuthorityVariance(standingOf(d as never))).toBe(false);
    expect(drive(decide, root, 'acknowledge', ['D-0001', '--by', 'User']).io.stderr).toContain('already acknowledged');
    drive(decide, root, 'new', [...NEW, '--by', 'User', '--authority', 'direct']);
    expect(drive(decide, root, 'acknowledge', ['D-0002', '--by', 'User']).io.stderr).toContain('no variance');
  });

  it('refuses a missing id, an unknown flag and a missing --by, naming the usage', () => {
    const root = scratch();
    plant(root, 'decisions.json', { entries: [legacy()] });
    expect(drive(decide, root, 'ratify', []).io.stderr).toContain('usage: scrumux decide ratify');
    expect(drive(decide, root, 'reject', ['D-0009', '--by', 'U', '--reason', 'r']).io.stderr).toContain('not found');
    expect(parseActFlags('decide', 'acknowledge', ['D-0001', '--reason', 'x'])).toMatch(/unknown flag --reason/);
    expect(parseActFlags('decide', 'acknowledge', ['D-0001', '--note'])).toMatch(/needs a value/);
    expect(parseActFlags('decide', 'acknowledge', ['D-0001'])).toMatch(/--by is required/);
  });
});

describe('readers: legacy is ratified/unknown; a proposed decision delegates nothing', () => {
  it('standingOf reads a legacy row as ratified with authority unknown', () => {
    expect(standingOf(legacy() as never)).toEqual({ status: 'ratified', authority: 'unknown', legacy: true, acknowledgedBy: '' });
  });

  it('task accept refuses standing:D-XXXX that names a proposed decision, and takes a legacy one', () => {
    const root = scratch();
    plant(root, 'decisions.json', { entries: [legacy({ ratified_by: 'User' })] });
    drive(decide, root, 'new', [...NEW, '--by', 'agent']);
    plant(root, 'tasks.json', { entries: [{ id: 'T-0001', title: 't', acceptance_check: 'c', status: 'in_review', created_at: '2026-09-01',
      task_order: { scope: 's', verification_command: 'true', context: { files: [] } },
      receipt: { date: '2026-09-01', at_epoch: 1, command: 'true', rc: 0, checks_run: 1, checks_failed: 0 } }] });
    const bad = drive(task, root, 'accept', ['T-0001', '--by', 'agent', '--authority', 'standing:D-0002']);
    expect(bad.rc).toBe(2);
    expect(bad.io.stderr).toContain('names a proposed decision');
    expect(drive(task, root, 'accept', ['T-0001', '--by', 'User', '--authority', 'standing:D-0001']).rc).toBe(0);
  });

  it('status session lists proposed decisions awaiting User, and marks them in recent decisions', () => {
    const root = scratch();
    drive(decide, root, 'new', [...NEW, '--by', 'agent']);
    const out = drive(status, root, 'session', []).io.stdout;
    expect(out).toContain('awaiting User: proposed-decisions[D-0001]');
    expect(out).toContain('D-0001 smoke.sh pins -p rover [PROPOSED — not ratified]');
  });

  it('records check does not call a proposed decision "missing ratified_by"', () => {
    const root = scratch();
    drive(decide, root, 'new', [...NEW, '--by', 'agent']);
    const io = captureIo();
    try { records.run(new Cli('check', [], true, io), { ...ctxFor(root), io }, 'check', []); } catch (e) { if (!(e instanceof ExitSignal)) throw e; }
    expect(io.stdout).not.toContain('missing decision, rationale');
  });
});

describe('exception resolve records proposed unless authorised; a person acts on it', () => {
  const X = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'X-0001', lens: 'Scope', severity: 'red', ref: 'T-0001', finding: 'f', disposition: 'accept_and_track',
    status: 'open', source: 'claude', created_at: '2026-09-01', ...over,
  });

  it('resolve without authority is proposed and still listed; ratify settles it', () => {
    const root = scratch();
    plant(root, 'exceptions.json', { entries: [X()] });
    const r = drive(exception, root, 'resolve', ['X-0001', '--status', 'tracked', '--by', 'agent', '--authority', 'nope']);
    expect(r.rc).toBe(0);
    expect(r.io.stderr).toContain('recorded PROPOSED');
    const x = row(root, 'exceptions.json', 'X-0001');
    expect([x['status'], x['resolution_status'], x['authority'], x['recorded_by'], x['authority_claimed']])
      .toEqual(['tracked', 'proposed', 'none', 'agent', 'nope']);
    expect(schemaClean(root, 'exceptions.json', 'exception.schema.json')).toEqual([]);
    expect(drive(exception, root, 'list', []).io.stdout).toContain('[resolution PROPOSED: tracked by agent — needs a person]');
    expect(drive(exception, root, 'ratify', ['X-0001', '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    expect(row(root, 'exceptions.json', 'X-0001')['resolution_status']).toBe('ratified');
    expect(drive(exception, root, 'list', []).io.stdout).toContain('(no open exceptions)');
  });

  it('reject reopens the finding; a re-resolve with authority clears the rejection', () => {
    const root = scratch();
    plant(root, 'exceptions.json', { entries: [X({ status: 'withdrawn', resolved_by: 'agent', resolution: null })] });
    expect(drive(exception, root, 'reject', ['X-0001', '--by', 'User', '--reason', 'not withdrawn']).rc).toBe(0);
    let x = row(root, 'exceptions.json', 'X-0001');
    expect([x['status'], x['resolution_status'], x['rejected_by']]).toEqual(['open', 'rejected', 'User']);
    expect(drive(exception, root, 'acknowledge', ['X-0001', '--by', 'User']).rc).toBe(2);
    expect(drive(exception, root, 'resolve', ['X-0001', '--status', 'corrected', '--by', 'User', '--authority', 'direct']).rc).toBe(0);
    x = row(root, 'exceptions.json', 'X-0001');
    expect([x['resolution_status'], x['ratified_by'], 'rejected_by' in x]).toEqual(['ratified', 'User', false]);
    expect(schemaClean(root, 'exceptions.json', 'exception.schema.json')).toEqual([]);
  });

  it('acts on an open finding refuse, and acknowledge keeps a legacy resolution', () => {
    const root = scratch();
    plant(root, 'exceptions.json', { entries: [X(), X({ id: 'X-0002', status: 'tracked', resolved_by: 'User', resolution: null })] });
    expect(drive(exception, root, 'ratify', ['X-0001', '--by', 'U', '--authority', 'direct']).io.stderr).toContain('is open');
    expect(drive(exception, root, 'acknowledge', ['X-0002', '--by', 'User']).rc).toBe(0);
    expect(row(root, 'exceptions.json', 'X-0002')['acknowledged_by']).toBe('User');
    expect(drive(exception, root, 'ratify', ['X-0009', '--by', 'U', '--authority', 'direct']).io.stderr).toContain('no X-0009');
  });
});
