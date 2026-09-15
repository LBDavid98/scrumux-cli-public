/**
 * Will Claude Code honour this repo's `.claude/settings.json` at all? (SX-008,
 * D-S019, 2026-09-13)
 *
 * THE SILENT FAILURE THIS REPORTS. Claude Code ignores a project's
 * `permissions.allow` in a workspace that has not been trusted, and resolves
 * trust for a git worktree on the MAIN repo root. The warning goes to stderr,
 * which a headless dispatched session never shows anyone. Rover's first
 * dispatched session could not run `.claude/scripts/scrumux` and spent ~40
 * turns probing, because nothing checked `projects["/srv/apps/example-app"]
 * .hasTrustDialogAccepted` in `~/.claude.json`.
 *
 * PASSIVE BY RULING (D-S016, global "fail passively"). `harness deploy` and
 * `harness verify` print a WARN or a NOTE and never change the exit code.
 * "unknown" (no config file, unreadable, unparseable) is its own harmless
 * answer, distinct from "not trusted". Nothing but the one boolean is read
 * out of the config; no other content is ever printed.
 *
 * Depends on: node:fs, node:path, git (for the main root of a worktree).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type TrustState = 'trusted' | 'untrusted' | 'unknown';

export interface TrustReport {
  readonly state: TrustState;
  /** The project key Claude Code resolves trust on (the main repo root). */
  readonly root: string;
  /** A sentence for the operator, naming the fix when there is one. */
  readonly detail: string;
}

/**
 * Where Claude Code keeps its per-project state: `$HOME/.claude.json`.
 * `SCRUMUX_CLAUDE_CONFIG` overrides it (tests, and an operator with a
 * non-default install). Null when the environment names neither -- the answer
 * is then "unknown", never a guess at some other home directory.
 *
 * Depends on: nothing. Pure.
 */
export function claudeConfigPath(env: NodeJS.ProcessEnv): string | null {
  const o = env['SCRUMUX_CLAUDE_CONFIG'];
  if (o !== undefined && o !== '') return o;
  const home = env['HOME'];
  return home !== undefined && home !== '' ? join(home, '.claude.json') : null;
}

/**
 * The directory Claude Code resolves trust on: the main checkout when `target`
 * is a linked worktree, else `target` itself; realpath'd so a symlinked path
 * matches the key Claude Code wrote.
 *
 * Depends on: git (`rev-parse --git-common-dir`), `realpathSync`.
 */
export function trustRoot(target: string): string {
  let root = target;
  const r = spawnSync('git', ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const common = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
  if (common.endsWith('/.git')) root = dirname(common);
  try { return realpathSync(root); } catch { return root; }
}

/**
 * Is `target` trusted by Claude Code? Reads one boolean from the config.
 *
 * Depends on: `claudeConfigPath`, `trustRoot`, `readFileSync`.
 */
export function trustOf(target: string, env: NodeJS.ProcessEnv): TrustReport {
  const root = trustRoot(target);
  const cfg = claudeConfigPath(env);
  const fix = `open the repo once interactively with \`claude\` in ${root} and accept the trust dialog, `
    + 'or have the operator trust it in scrumux-app (Trust this repo)';
  let doc: unknown;
  try {
    if (cfg === null) throw new Error('no HOME');
    doc = JSON.parse(readFileSync(cfg, 'utf8'));
  } catch {
    return { state: 'unknown', root, detail: `trust not checked: no readable Claude Code config at ${cfg ?? '$HOME/.claude.json (HOME is not set)'} — unknown, not a failure. A dispatched session needs ${root} trusted or it silently ignores this repo's allow-list; if it is not, ${fix}` };
  }
  const projects = (doc as { projects?: unknown } | null)?.projects;
  const entry = projects !== null && typeof projects === 'object'
    ? (projects as Record<string, unknown>)[root]
    : undefined;
  const accepted = entry !== null && typeof entry === 'object'
    && (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true;
  if (accepted) {
    return { state: 'trusted', root, detail: `${root} is trusted by Claude Code, so sessions there (and in its worktrees) load this repo's permissions.allow` };
  }
  return { state: 'untrusted', root, detail: `${root} is NOT trusted by Claude Code (${cfg} has no hasTrustDialogAccepted for it), so every session there — dispatched worktrees included — silently IGNORES this repo's permissions.allow and a headless session can run nothing. Fix: ${fix}` };
}
