/**
 * Root resolution.
 *
 * TWO ROOTS, AND CONFLATING THEM BREAKS VERIFICATION SILENTLY:
 *
 *   ROOT       where the RECORDS live. Follows GOV_ROOT.
 *   WORK_ROOT  the tree the CODE is in, where a verification command runs.
 *
 * If GOV_ROOT pointed a dispatched session's records at one checkout while
 * WORK_ROOT stayed unset, verification would follow ROOT too and run
 * against a tree without the code the session had just written. A check
 * that needs that code goes red on the wrong tree and acceptance refuses
 * the red receipt; one that happens to pass writes a GREEN receipt about
 * code nobody tested. Neither is recoverable by re-running -- so ROOT and
 * WORK_ROOT are resolved independently below, never derived from one
 * shared variable.
 *
 * GOV_ROOT IS SUPPORTED IN PRODUCTION, not just in tests.
 */
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

export interface Roots {
  /** Where the records live. GOV_ROOT wins. */
  root: string;
  /** `<root>/governance`. */
  gov: string;
  /** The tree the code is in; where a verification command runs. */
  workRoot: string;
}

function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const t = out.trim();
    return t.length > 0 ? t : null;
  } catch {
    // Not a git repo, or no git on PATH. Absence is normal here -- the
    // harness governs non-git trees too -- so this is not an error path.
    return null;
  }
}

/**
 * @param cwd        the CALLER's working directory (not the script's).
 * @param scriptsDir where the CLI itself lives, for the two-up fallback.
 * @param env        process env, injectable so tests need no mutation.
 */
export function resolveRoots(
  cwd: string,
  scriptsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Roots {
  // ROOT: GOV_ROOT > caller's git toplevel > two levels up from the CLI.
  let root: string;
  const govRoot = env['GOV_ROOT'];
  if (govRoot !== undefined && govRoot !== '') {
    root = govRoot;
  } else {
    root = gitToplevel(cwd) ?? resolve(scriptsDir, '..', '..');
  }

  // WORK_ROOT: explicit > caller's git toplevel > ROOT. With GOV_ROOT unset
  // these are the same path and nothing changes, which is every CLI-only use.
  let workRoot: string;
  const explicitWork = env['WORK_ROOT'];
  if (explicitWork !== undefined && explicitWork !== '') {
    workRoot = explicitWork;
  } else {
    workRoot = gitToplevel(cwd) ?? root;
  }

  return { root, gov: resolve(root, 'governance'), workRoot };
}

/** Directory of the running CLI, for the two-up fallback. */
export function selfDir(importMetaUrl: string): string {
  return dirname(new URL(importMetaUrl).pathname);
}
