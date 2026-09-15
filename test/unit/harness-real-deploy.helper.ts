/**
 * A real `harness deploy` / `harness verify` driven in-process over THIS
 * checkout's payload, for the SX-008 and D-S020 suites. Not a test file (no
 * `.test.`), so vitest does not collect it.
 *
 * Depends on: the built bundle at `.deploy-claude/dist/scrumux.mjs` (the two
 * post-install checks re-invoke it), `src/nouns/harness.ts`.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cli } from '../../src/cli/envelope.js';
import { captureIo, ExitSignal } from '../../src/cli/exit.js';
import { MODULE } from '../../src/nouns/harness.js';

export const CHECKOUT = resolve(__dirname, '../..');
export const SRC_CLAUDE = join(CHECKOUT, '.deploy-claude');

export interface Row { name: string; ok: boolean; tier: string; detail: string }
export interface Item { path: string; status: string; detail: string }
export interface Env { summary: string; exit: number; ok: boolean; checks: Row[]; items: Item[] }

/** A fresh git repo in the OS temp dir, realpath'd (macOS /private/var). */
export function tempRepo(tag: string): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), `sx-${tag}-`)));
  execFileSync('git', ['init', '-q', '-b', 'main', t]);
  return t;
}

/** Commit everything in `t` under a fixed identity. */
export function commitAll(t: string, msg: string): void {
  execFileSync('git', ['-C', t, 'add', '-A']);
  execFileSync('git', ['-C', t, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg]);
}

/** A temp Claude Code config naming `root` trusted or not; returns its path. */
export function claudeConfig(dir: string, root: string, trusted: boolean | null): string {
  const p = join(dir, 'claude.json');
  const projects = trusted === null ? {} : { [root]: { hasTrustDialogAccepted: trusted, secretish: 'never printed' } };
  writeFileSync(p, JSON.stringify({ userID: 'do-not-print', projects }));
  return p;
}

/** Run `harness <verb> <target> --json` with an isolated env; returns the envelope and exit code. */
export function harness(verb: 'deploy' | 'verify', target: string, env: NodeJS.ProcessEnv = {}): { env: Env; rc: number; raw: string } {
  const io = captureIo();
  const cli = new Cli(`harness ${verb}`, [target], true, io);
  const ctx = {
    roots: { root: target, gov: join(target, 'governance'), workRoot: target },
    today: '2026-09-13',
    io,
    scriptsDir: join(SRC_CLAUDE, 'scripts'),
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', SCRUMUX_SELF: join(SRC_CLAUDE, 'dist/scrumux.mjs'), ...env },
    cwd: target,
  };
  let rc = -1;
  try {
    MODULE.run(cli, ctx, verb, [target]);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    rc = e.code;
  }
  return { env: JSON.parse(io.stdout) as Env, rc, raw: io.stdout + io.stderr };
}

export function rowOf(env: Env, name: string): Row {
  const r = env.checks.find((c) => c.name === name);
  if (r === undefined) throw new Error(`no row ${name}; got ${env.checks.map((c) => c.name).join(',')}`);
  return r;
}
