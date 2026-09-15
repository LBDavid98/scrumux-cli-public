/**
 * Improvement cycle 2 (D-S038), the reading and guidance half:
 *
 *   SX-025  issue list / issue find, and a TELL on a near-duplicate issue new
 *   SX-037  log show, --ref L-XXXX, and the brief inlining the entries an order cites
 *   SX-027  lint does not TELL on package-relative spellings of listed paths
 *   SX-030/SX-031/SX-032/SX-038, D-S040  the brief's runnable MUST FAIL WHEN
 *           forms and working notes; the READER's two new hollow greens
 *
 * Every case drives the real noun modules against a scratch `governance/`.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as issue } from '../../src/nouns/issue.js';
import { MODULE as log } from '../../src/nouns/log.js';
import { MODULE as task } from '../../src/nouns/task.js';
import { unlistedScopePaths, namesListed } from '../../src/nouns/task/scope-paths.js';
import { readerQuestion } from '../../src/nouns/task/reader.js';
import { citedLogIds, renderLogEntry } from '../../src/nouns/log-show.js';
import { nearDuplicates } from '../../src/nouns/issue-read.js';

const TODAY = todayStamp();
const NO_SCRIPTS = mkdtempSync(join(tmpdir(), 'cycle2-reads-noscripts-'));

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cycle2-reads-'));
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

const ISSUES = [
  { id: 'I-0005', type: 'harness', source: 'claude', summary: 'session check receipt fresh FAILs on a fresh worktree checkout: mtime moved, content identical', resolution_pointer: 'compare content hashes', status: 'open', created_at: '2026-09-01', refs: { files: ['src/nouns/session.ts'], task: 'T-0003' } },
  { id: 'I-0009', type: 'defect', source: 'claude', summary: 'vault cleanup leaves folders', resolution_pointer: 'diff the store', status: 'resolved', created_at: '2026-09-02', refs: { files: [] } },
];

// ---------------------------------------------------------------- SX-025
describe('SX-025: find an existing issue before filing one', () => {
  it('issue list shows open issues by default, and filters by status, type and task', () => {
    const root = scratch();
    plant(root, 'issues.json', { entries: ISSUES });
    const open = drive(issue, root, 'list', []);
    expect(open.rc).toBe(0);
    expect(open.io.stdout).toContain('I-0005  open  harness  session check receipt fresh');
    expect(open.io.stdout).toContain('[task T-0003] [files src/nouns/session.ts]');
    expect(open.io.stdout).not.toContain('I-0009');
    expect(drive(issue, root, 'list', ['--status', 'all', '--type', 'defect']).io.stdout).toContain('I-0009');
    expect(drive(issue, root, 'list', ['--task', 'T-0099']).io.stdout).toContain('(no open issues match)');
    const j = JSON.parse(drive(issue, root, 'list', ['--status', 'all'], true).io.stdout) as { data: { issues: Record<string, unknown>[] } };
    expect(j.data.issues.map((i) => i['id'])).toEqual(['I-0005', 'I-0009']);
    expect(Object.keys(j.data.issues[0]!)).toEqual(['id', 'type', 'status', 'severity', 'summary', 'resolution_pointer', 'task', 'files', 'created_at']);
    expect(j.data.issues[1]!['severity']).toBeNull();
  });

  it('issue find searches id, summary, fix, task and files across statuses', () => {
    const root = scratch();
    plant(root, 'issues.json', { entries: ISSUES });
    expect(drive(issue, root, 'find', ['RECEIPT', 'fresh']).io.stdout).toContain('I-0005');
    expect(drive(issue, root, 'find', ['diff the store']).io.stdout).toContain('I-0009');
    expect(drive(issue, root, 'find', ['session.ts', '--status', 'resolved']).io.stdout).toContain('(no resolved issues match)');
    expect(drive(issue, root, 'find', []).rc).toBe(2);
    expect(drive(issue, root, 'list', ['oops']).io.stderr).toContain('scrumux issue find');
    expect(drive(issue, root, 'list', ['--status', 'closed']).rc).toBe(2);
    expect(drive(issue, root, 'list', ['--bogus']).rc).toBe(2);
    expect(drive(issue, root, 'list', ['--type']).rc).toBe(2);
    expect(drive(issue, scratch(), 'list', []).rc).toBe(0);
  });

  it('issue new TELLs a near-duplicate on stderr, never refuses, and stdout stays the id', () => {
    const root = scratch();
    plant(root, 'issues.json', { entries: ISSUES });
    const r = drive(issue, root, 'new', ['--type', 'harness', '--source', 'claude', '--summary', 'receipt fresh FAILs after a worktree checkout although content is identical', '--fix', 'hash']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toBe('I-0010\n');
    expect(r.io.stderr).toContain('TELL: open issue(s) that look like this one: I-0005');
    const j = drive(issue, root, 'new', ['--type', 'defect', '--source', 'claude', '--summary', 'unrelated wording here', '--fix', 'f', '--file', 'src/nouns/session.ts'], true);
    expect((JSON.parse(j.io.stdout) as { checks: { name: string }[] }).checks.map((c) => c.name)).toContain('possible duplicate');
    expect(drive(issue, root, 'new', ['--type', 'defect', '--source', 'claude', '--summary', 'completely different', '--fix', 'f']).io.stderr).toBe('');
    expect(nearDuplicates(join(root, 'governance'), 'vault cleanup leaves folders', [])).toEqual([]); // I-0009 is resolved
  });
});

// ---------------------------------------------------------------- SX-037
describe('SX-037: log entries are readable, citable and carried into the brief', () => {
  const LOG = { entries: [
    { id: 'L-0004', date: '2026-09-13', task: 'T-0003', actor: 'claude', title: 'Phylactery export procedure', what_was_done: 'PUT the agent, POST export, poll the job', verification: 'rc=0', pending: ['re-export on change'] },
    { id: 'L-0005', date: '2026-09-13', task: 'T-0003', actor: 'claude', title: 'second', what_was_done: 'x'.repeat(900) },
  ] };

  it('log show by id, by task, and names ids that do not exist', () => {
    const root = scratch();
    plant(root, 'log.json', LOG);
    const one = drive(log, root, 'show', ['L-0004', 'L-0099']);
    expect(one.rc).toBe(0);
    expect(one.io.stdout).toContain('L-0004  2026-09-13  T-0003  claude: Phylactery export procedure');
    expect(one.io.stdout).toContain('    did: PUT the agent, POST export, poll the job');
    expect(one.io.stdout).toContain('    pending: re-export on change');
    expect(one.io.stdout).toContain('not in governance/log.json: L-0099');
    const j = JSON.parse(drive(log, root, 'show', ['--task', 'T-0003'], true).io.stdout) as { data: { entries: unknown[]; missing: string[] } };
    expect(j.data.entries.length).toBe(2);
    expect(drive(log, root, 'show', ['--task', 'T-0099']).io.stdout).toContain('(no log entries for T-0099)');
    expect(drive(log, root, 'show', []).rc).toBe(2);
    expect(drive(log, root, 'show', ['T-0003']).rc).toBe(2);
    expect(drive(log, root, 'show', ['--task']).rc).toBe(2);
    expect(renderLogEntry(LOG.entries[1]!, 600)[1]!.length).toBeLessThan(620);
    expect(citedLogIds(['read: L-0004, L-0004', 'and L-0017'])).toEqual(['L-0004', 'L-0017']);
  });

  it('task order takes --ref L-XXXX, and the brief inlines every cited entry from the whole log', () => {
    const root = scratch();
    plant(root, 'log.json', LOG);
    plant(root, 'tasks.json', { entries: [{ id: 'T-0010', title: 't', acceptance_check: 'c', status: 'ready', created_at: '2026-09-01' }] });
    expect(drive(task, root, 'order', ['T-0010', '--scope', 'export the drafter as L-0004 describes', '--verify', 'true',
      '--file', 'governance/log.json | read: L-0005', '--out', 'x', '--ref', 'L-0004', '--ref', 'L-0077']).rc).toBe(0);
    const b = drive(task, root, 'brief', ['T-0010', '--allow-unsprinted']).io.stdout;
    expect(b).toContain('--- Log entries this order cites ---');
    expect(b).toContain('  L-0004  2026-09-13  T-0003  claude: Phylactery export procedure');
    expect(b).toContain('  L-0077: UNRESOLVED — no such entry in governance/log.json');
    expect(b).toContain('  L-0004: Phylactery export procedure'); // the refs block resolves L- too
  });
});

// ---------------------------------------------------------------- SX-027
describe('SX-027: lint reads package-relative spellings of listed paths', () => {
  it('the validator reproduction prints no TELL; a real unlisted file still does', () => {
    const listed = ['app/src/runs.ts', 'agents/tests/test_fast.py'];
    const scope = 'Update src/runs.ts to fix the run counter and add tests/test_fast.py under uv run --directory agents to cover it.';
    expect(unlistedScopePaths(scope, listed, scratch(), ['agents'])).toEqual([]);
    expect(unlistedScopePaths(`${scope} Also src/other.ts.`, listed, scratch(), ['agents'])).toEqual(['src/other.ts']);
  });

  it('a bare file name counts only when it ends exactly one listed path', () => {
    expect(namesListed('runs.ts', ['app/src/runs.ts'])).toBe(true);
    expect(namesListed('index.ts', ['a/index.ts', 'b/index.ts'])).toBe(false);
    expect(namesListed('src/index.ts', ['a/src/index.ts', 'b/src/index.ts'])).toBe(true);
    expect(namesListed('tests/x.py', ['agents/tests/x.py'], ['agents'])).toBe(true);
    expect(namesListed('ns.ts', ['app/src/runs.ts'])).toBe(false);
  });

  it('task lint uses the verify command\'s directory and says to list a read path rather than delete it', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [{ id: 'T-0001', title: 't', acceptance_check: 'c', status: 'ready', created_at: '2026-09-01',
      task_order: { scope: 'fix tests/test_fast.py and docs/new.md', out_of_scope: ['x'], verification_command: 'uv run --directory agents pytest tests/test_fast.py',
        context: { files: [{ path: 'agents/tests/test_fast.py', why: 'w' }], refs: [], commands: ['c'], interfaces: [], data_shapes: [] } } }] });
    const out = drive(task, root, 'lint', ['T-0001', '--hotfix']).io.stdout;
    expect(out).toContain('does not list: docs/new.md —');
    expect(out).not.toContain('tests/test_fast.py —');
    expect(out).toContain("read: <what to look for>");
    expect(out).toContain('Do not delete a path from the prose');
  });
});

// ------------------------------------------------- SX-030/31/32/38, D-S040
describe('the brief and the READER carry the cycle-2 guidance', () => {
  it('the READER names the two new hollow greens', () => {
    const q = readerQuestion('sh check.sh', '');
    expect(q).toMatch(/\(4\) a "nothing remains" check that enumerates the ids it expects instead of diffing/);
    expect(q).toMatch(/\(5\) an assertion over an empty input/);
  });

  it('the brief gives MUST FAIL WHEN runnable forms and the working notes', () => {
    const root = scratch();
    plant(root, 'tasks.json', { entries: [{ id: 'T-0001', title: 't', acceptance_check: 'c', status: 'ready', created_at: '2026-09-01',
      task_order: { scope: 's', out_of_scope: ['x'], verification_command: 'true', fails_when: 'the gateway key is bad',
        context: { files: [{ path: 'src/a.ts', why: 'w' }], refs: [], commands: [], interfaces: [], data_shapes: [] } } }] });
    const b = drive(task, root, 'brief', ['T-0001', '--allow-unsprinted']).io.stdout;
    expect(b).toContain('MUST FAIL WHEN: the gateway key is bad');
    expect(b).toContain('Never `VAR=value cmd`, `env …`, `export …` or `bash -c …`');
    expect(b).toContain('`bash scripts/<name>`');
    expect(b).toContain('--- Working here ---');
    expect(b).toContain('call the CLI as .claude/scripts/scrumux');
    expect(b).toContain('Throwaway files go in .scratch/');
    expect(b).toContain('`bash -c "echo hi"` to see what is gated IS probing');
    expect(b).toContain('snapshot taken BEFORE the run');
    expect(b).toContain('every background process you started has ended');
    expect(b).not.toContain('--- Log entries this order cites ---');
  });
});
