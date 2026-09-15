/**
 * R-021 (D-S030, SX-018): the pointer to CLAUDE.pre-harness.md is present
 * exactly once after every deploy while that file exists.
 * R-022 (D-S031): the rebuilt code index is listed for commit only when it
 * differs from the committed index apart from the build stamp; the index
 * format, and so stale detection, is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cli } from '../../src/cli/envelope.js';
import { captureIo, ExitSignal } from '../../src/cli/exit.js';
import { MODULE } from '../../src/nouns/harness.js';
import { CLAUDE_POINTER, constitutionAct, desiredConstitution } from '../../src/nouns/harness/constitution.js';
import { committedText, indexNeedsCommit, withoutBuildStamp } from '../../src/nouns/harness/index-commit.js';
import { isStaleGraph, loadIndex } from '../../src/nouns/graph/code-index.js';
import { reusableIndex } from '../../src/nouns/harness/index-commit.js';
import { statSync } from 'node:fs';

const CHECKOUT = resolve(__dirname, '../..');
const SRC_CLAUDE = join(CHECKOUT, '.deploy-claude');
const git = (t: string, ...a: string[]): string => execFileSync('git', ['-C', t, ...a], { encoding: 'utf8' });
const commit = (t: string, m: string): void => { git(t, 'add', '-A'); git(t, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', m); };

type Env = { exit: number; commit_paths: string[]; items: { path: string; status: string }[] };
function deploy(t: string): Env {
  const io = captureIo();
  const ctx = {
    roots: { root: t, gov: join(t, 'governance'), workRoot: t }, today: '2026-09-13', io,
    scriptsDir: join(SRC_CLAUDE, 'scripts'), env: { ...process.env, SCRUMUX_SELF: join(SRC_CLAUDE, 'dist/scrumux.mjs') }, cwd: t,
  };
  try { MODULE.run(new Cli('harness deploy', [t], true, io), ctx, 'deploy', [t]); } catch (e) { if (!(e instanceof ExitSignal)) throw e; }
  return JSON.parse(io.stdout) as Env;
}
const pointers = (t: string): number => readFileSync(join(t, 'CLAUDE.md'), 'utf8').split('## This repo had its own CLAUDE.md').length - 1;
const status = (env: Env, p: string): string | undefined => env.items.find((i) => i.path === p)?.status;

describe('constitutionAct / desiredConstitution', () => {
  const payload = Buffer.from('# governed by the **harness**\n');
  it('adds the pointer once only while the preserved file exists', () => {
    expect(desiredConstitution(payload, false)).toEqual(payload);
    expect(desiredConstitution(payload, true).toString()).toBe(`${payload.toString()}${CLAUDE_POINTER}`);
  });
  it('classifies install, unchanged, update (pointer lost or doubled) and preserve', () => {
    expect(constitutionAct(null, payload, true)).toBe('install');
    expect(constitutionAct(desiredConstitution(payload, true), payload, true)).toBe('unchanged');
    expect(constitutionAct(payload, payload, true)).toBe('update');
    expect(constitutionAct(Buffer.concat([desiredConstitution(payload, true), Buffer.from(CLAUDE_POINTER)]), payload, true)).toBe('update');
    expect(constitutionAct(Buffer.from('# theirs\n'), payload, false)).toBe('preserve');
  });
});

describe('harness deploy keeps the pointer to CLAUDE.pre-harness.md (R-021)', () => {
  it('first, second and third deploy: pointer present exactly once each time', () => {
    const t = mkdtempSync(join(tmpdir(), 'r021-'));
    try {
      git(t, 'init', '-q');
      writeFileSync(join(t, 'CLAUDE.md'), '# this repo had its own rules\n');
      commit(t, 'init');
      const first = deploy(t);
      expect(status(first, 'CLAUDE.md')).toBe('CREATED');
      expect(readFileSync(join(t, 'CLAUDE.pre-harness.md'), 'utf8')).toBe('# this repo had its own rules\n');
      expect(pointers(t)).toBe(1);
      commit(t, 'deploy 1');
      const second = deploy(t);
      expect(status(second, 'CLAUDE.md')).toBe('UNCHANGED');
      expect(second.commit_paths).not.toContain('CLAUDE.md');
      expect(pointers(t)).toBe(1);
      const third = deploy(t);
      expect(status(third, 'CLAUDE.md')).toBe('UNCHANGED');
      expect(pointers(t)).toBe(1);
      // A repo a pre-R-021 deploy left without the pointer is repaired, once.
      writeFileSync(join(t, 'CLAUDE.md'), readFileSync(join(SRC_CLAUDE, 'CLAUDE.md.payload')));
      const repaired = deploy(t);
      expect(status(repaired, 'CLAUDE.md')).toBe('UPDATED');
      expect(pointers(t)).toBe(1);
      expect(readFileSync(join(t, 'CLAUDE.pre-harness.md'), 'utf8')).toBe('# this repo had its own rules\n');
    } finally { rmSync(t, { recursive: true, force: true }); }
  }, 120_000);
});

describe('the code index in commit_paths (R-022)', () => {
  const idx = (over: Record<string, unknown> = {}, prov: Record<string, unknown> = {}): string => JSON.stringify({
    files: ['a.ts'], symbols: [{ name: 'a' }], ...over,
    provenance: { built_at: '2026-09-13T00:00:00Z', built_at_epoch: 1789300000.5, commit: 'abc', dirty: false, ...prov },
  }, null, 2);

  it('unchanged apart from the build stamp is not listed; changed content is; nothing committed is', () => {
    expect(indexNeedsCommit(idx(), idx({}, { built_at: '2026-09-14T00:00:00Z', built_at_epoch: 1789400000.25 }))).toBe(false);
    expect(indexNeedsCommit(idx(), idx({ symbols: [{ name: 'a' }, { name: 'b' }] }))).toBe(true);
    // D-S033: a commit-only or dirty-only difference is build metadata, not content.
    expect(indexNeedsCommit(idx(), idx({}, { commit: 'def' }))).toBe(false);
    expect(indexNeedsCommit(idx(), idx({}, { dirty: true }))).toBe(false);
    expect(indexNeedsCommit(idx(), idx({ files: ['a.ts', 'b.ts'] }, { commit: 'def', dirty: true }))).toBe(true);
    expect(indexNeedsCommit(null, idx())).toBe(true);
    expect(indexNeedsCommit(idx(), null)).toBe(false);
    expect(indexNeedsCommit('{broken', idx())).toBe(true);
    expect(withoutBuildStamp(idx())).not.toContain('built_at');
    expect(withoutBuildStamp(idx())).not.toContain('"commit"');
    expect(withoutBuildStamp(idx())).not.toContain('"dirty"');
  });

  it('through a real deploy: listed when the indexed source changed; the format keeps built_at_epoch; stale detection unchanged', () => {
    const t = mkdtempSync(join(tmpdir(), 'r022-'));
    try {
      git(t, 'init', '-q');
      writeFileSync(join(t, 'a.ts'), 'export const a = 1;\n');
      commit(t, 'init');
      expect(deploy(t).commit_paths).toContain('governance/code-graph.json');
      commit(t, 'deploy');
      // Same committed index, rebuilt with only its stamp moved: not a change.
      const committed = committedText(t, 'governance/code-graph.json')!;
      const doc = JSON.parse(committed) as { provenance: Record<string, unknown> };
      doc.provenance['built_at_epoch'] = Number(doc.provenance['built_at_epoch']) + 5;
      expect(indexNeedsCommit(committed, JSON.stringify(doc))).toBe(false);

      writeFileSync(join(t, 'b.ts'), 'export function b(): number { return 2; }\n');
      const after = deploy(t);
      expect(after.commit_paths).toContain('governance/code-graph.json');
      const built = loadIndex(join(t, 'governance/code-graph.json'));
      const epochOnDisk = (JSON.parse(readFileSync(join(t, 'governance/code-graph.json'), 'utf8')) as { provenance: { built_at_epoch: unknown } }).provenance.built_at_epoch;
      expect(typeof epochOnDisk).toBe('number');
      expect(isStaleGraph(built, t)[0]).toBe(false);
      const future = Number(epochOnDisk) + 60;
      utimesSync(join(t, 'b.ts'), future, future);
      expect(isStaleGraph(built, t)[0]).toBe(true);
    } finally { rmSync(t, { recursive: true, force: true }); }
  }, 120_000);
});

describe('deploy reuses a fresh committed index (D-S034)', () => {
  it('missing → built and listed; fresh committed → no write, not listed; stale → rebuilt and listed', () => {
    const t = mkdtempSync(join(tmpdir(), 'ds034-'));
    try {
      git(t, 'init', '-q');
      writeFileSync(join(t, 'a.ts'), 'export const a = 1;\n');
      commit(t, 'init');
      expect(reusableIndex(t)).toEqual({ reuse: false, reason: 'no index on disk' });
      // missing
      const first = deploy(t);
      expect(first.commit_paths).toContain('governance/code-graph.json');
      commit(t, 'deploy');
      // fresh and committed
      const p = join(t, 'governance/code-graph.json');
      const bytes = readFileSync(p, 'utf8');
      const mtime = statSync(p).mtimeMs;
      expect(reusableIndex(t).reuse).toBe(true);
      const second = deploy(t);
      expect(second.commit_paths).not.toContain('governance/code-graph.json');
      expect(readFileSync(p, 'utf8')).toBe(bytes);
      expect(statSync(p).mtimeMs).toBe(mtime);
      expect(git(t, 'status', '--porcelain')).toBe('');
      // stale: a source file newer than the build stamp
      const epoch = Number((JSON.parse(bytes) as { provenance: { built_at_epoch: number } }).provenance.built_at_epoch);
      utimesSync(join(t, 'a.ts'), epoch + 60, epoch + 60);
      expect(reusableIndex(t).reason).toContain('stale');
      const third = deploy(t);
      expect(third.commit_paths).toContain('governance/code-graph.json');
      expect(readFileSync(p, 'utf8')).not.toBe(bytes);
      // a modified copy on disk is not the committed index, so it is rebuilt
      commit(t, 'index');
      writeFileSync(p, `${readFileSync(p, 'utf8')} `);
      expect(reusableIndex(t)).toEqual({ reuse: false, reason: 'the index on disk differs from the committed one' });
    } finally { rmSync(t, { recursive: true, force: true }); }
  }, 120_000);
});

