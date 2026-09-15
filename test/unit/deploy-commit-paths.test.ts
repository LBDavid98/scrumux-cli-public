/**
 * R-020 (D-S029, SX-017): `harness deploy --json` lists, in `commit_paths`,
 * exactly the paths it created, changed or removed that belong in the repo's
 * history — journals included, and the code index because worktree sessions
 * read it from git; rendered views and the event log never — so a caller that
 * commits the deploy stages that list and is left with a clean checkout.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cli } from '../../src/cli/envelope.js';
import { captureIo, ExitSignal } from '../../src/cli/exit.js';
import { MODULE } from '../../src/nouns/harness.js';
import { commitPaths, type HarnessRun } from '../../src/nouns/harness/state.js';

const CHECKOUT = resolve(__dirname, '../..');
const SRC_CLAUDE = join(CHECKOUT, '.deploy-claude');
const git = (t: string, ...a: string[]): string => execFileSync('git', ['-C', t, ...a], { encoding: 'utf8' });

/** Run `harness deploy --json <t>` in process; the parsed envelope. */
function deployJson(t: string): { exit: number; commit_paths?: string[]; items: { path: string; status: string }[] } {
  const io = captureIo();
  const ctx = {
    roots: { root: t, gov: join(t, 'governance'), workRoot: t },
    today: '2026-09-13', io, scriptsDir: join(SRC_CLAUDE, 'scripts'),
    env: { ...process.env, SCRUMUX_SELF: join(SRC_CLAUDE, 'dist/scrumux.mjs') }, cwd: t,
  };
  const cli = new Cli('harness deploy', [t], true, io);
  try { MODULE.run(cli, ctx, 'deploy', [t]); } catch (e) { if (!(e instanceof ExitSignal)) throw e; }
  return JSON.parse(io.stdout) as ReturnType<typeof deployJson>;
}

describe('commitPaths', () => {
  it('lists written statuses and extra writes, sorted and unique; never UNCHANGED or KEPT', () => {
    const h = {
      items: [
        { path: 'b', status: 'CREATED', detail: '' }, { path: 'a', status: 'UPDATED', detail: '' },
        { path: 'c', status: 'UNCHANGED', detail: '' }, { path: 'd', status: 'KEPT', detail: '' },
        { path: 'e', status: 'REMOVED', detail: '' }, { path: 'f', status: 'SEEDED', detail: '' },
        { path: 'b', status: 'UPDATED', detail: '' },
      ],
      wrote: ['CLAUDE.pre-harness.md'],
    } as unknown as HarnessRun;
    expect(commitPaths(h)).toEqual(['CLAUDE.pre-harness.md', 'a', 'b', 'e', 'f']);
  });
});

describe('harness deploy --json commit_paths, for real', () => {
  it('a first deploy committed by exactly its list leaves a clean checkout; a redeploy lists no payload', () => {
    const t = mkdtempSync(join(tmpdir(), 'r020-'));
    try {
      git(t, 'init', '-q');
      writeFileSync(join(t, 'CLAUDE.md'), '# this repo had one\n');
      git(t, 'add', '.');
      git(t, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

      const env = deployJson(t);
      expect(env.exit).toBe(0);
      const paths = env.commit_paths!;
      for (const p of ['governance/tasks.json', 'governance/repo-health.json', '.claude/DEPLOYED', '.claude/scripts/scrumux',
        '.claude/settings.json', '.gitignore', 'CLAUDE.md', 'CLAUDE.pre-harness.md']) expect(paths, p).toContain(p);
      // The code index is derived but committed: a worktree session has no grammars to rebuild it.
      expect(paths).toContain('governance/code-graph.json');
      expect(paths.some((p) => p.endsWith('governance-graph.json') || p.endsWith('events.jsonl'))).toBe(false);

      git(t, 'add', '-A', '--', ...paths);
      git(t, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'harness deploy');
      expect(git(t, 'status', '--porcelain')).toBe('');

      // A redeploy that changes no payload lists no payload, and the kept
      // constitution is UNCHANGED (R-021). The index is listed only when it
      // differs from the committed one apart from its build stamp (R-022).
      const second = deployJson(t).commit_paths!;
      expect(second.filter((p) => p !== 'governance/code-graph.json')).toEqual([]);

      // A prune is a change to commit too.
      writeFileSync(join(t, '.claude/scripts/zz-retired'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(t, '.claude/scripts/zz-retired'), 0o755);
      const doc = JSON.parse(readFileSync(join(t, '.claude/DEPLOYED'), 'utf8'));
      doc.files['.claude/scripts/zz-retired'] = '0'.repeat(64);
      writeFileSync(join(t, '.claude/DEPLOYED'), JSON.stringify(doc, null, 2) + '\n');
      git(t, 'add', '-A');
      git(t, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old manifest');
      const again = deployJson(t).commit_paths!;
      expect(again).toEqual(expect.arrayContaining(['.claude/scripts/zz-retired', '.claude/DEPLOYED']));
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 120_000);
});
