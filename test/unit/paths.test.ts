import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveRoots, selfDir } from '../../src/journal/paths.js';

/**
 * TWO ROOTS, AND CONFLATING THEM IS A MEASURED FAILURE (lib.sh:50-67).
 *
 * Until 2026-08-27 one variable answered both. Pointing a dispatched
 * session's GOV_ROOT at the main checkout moved its VERIFICATION onto main
 * too, so `task verify` ran the order's command against a tree without the
 * code the session had just written -- a red receipt acceptance refuses, or a
 * GREEN receipt about code nobody tested. Neither is recoverable by re-running.
 *
 * These are the tests that would have caught it.
 */
function gitRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'paths-')));
  writeFileSync(join(d, 'f'), 'x\n');
  execFileSync('git', ['init', '-q', '.'], { cwd: d });
  return d;
}

describe('root resolution', () => {
  it('GOV_ROOT wins for the RECORDS and does not move the CODE', () => {
    const work = gitRepo();
    const gov = realpathSync(mkdtempSync(join(tmpdir(), 'gov-')));
    const r = resolveRoots(work, '/nowhere/scripts', { GOV_ROOT: gov });
    expect(r.root).toBe(gov);
    expect(r.gov).toBe(join(gov, 'governance'));
    // The whole point: WORK_ROOT stays where the caller is.
    expect(r.workRoot).toBe(work);
    rmSync(work, { recursive: true }); rmSync(gov, { recursive: true });
  });

  it('with GOV_ROOT unset the two roots are the same path', () => {
    const work = gitRepo();
    const r = resolveRoots(work, '/nowhere/scripts', {});
    expect(r.root).toBe(work);
    expect(r.workRoot).toBe(work);
    rmSync(work, { recursive: true });
  });

  it('an explicit WORK_ROOT overrides the caller\'s git toplevel', () => {
    const work = gitRepo();
    const r = resolveRoots(work, '/nowhere/scripts', { WORK_ROOT: '/explicit/tree' });
    expect(r.workRoot).toBe('/explicit/tree');
    rmSync(work, { recursive: true });
  });

  it('an EMPTY GOV_ROOT is unset, not a root of ""', () => {
    const work = gitRepo();
    const r = resolveRoots(work, '/nowhere/scripts', { GOV_ROOT: '', WORK_ROOT: '' });
    expect(r.root).toBe(work);
    expect(r.workRoot).toBe(work);
    rmSync(work, { recursive: true });
  });

  it('falls back two levels up from the CLI outside a git repo', () => {
    // The harness governs non-git trees too, so "not a git repo" is a normal
    // state and not an error path.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'bare-')));
    const r = resolveRoots(bare, '/opt/pkg/.claude/scripts', {});
    expect(r.root).toBe(resolve('/opt/pkg/.claude/scripts', '..', '..'));
    expect(r.workRoot).toBe(r.root);
    rmSync(bare, { recursive: true });
  });

  it('resolves from the CALLER\'s directory, not the process cwd', () => {
    const outer = gitRepo();
    const inner = join(outer, 'sub/deeper');
    mkdirSync(inner, { recursive: true });
    expect(resolveRoots(inner, '/nowhere', {}).root).toBe(outer);
    rmSync(outer, { recursive: true });
  });
});

describe('selfDir', () => {
  it('answers the directory of a file:// module url', () => {
    expect(selfDir('file:///a/b/c.js')).toBe('/a/b');
  });
});
