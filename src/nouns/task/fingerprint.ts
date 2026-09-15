/**
 * Content hashes for receipts and acceptance.
 *
 *   `receipt.file_hashes` (SX-024): sha256 of every covered file that exists
 *     when `task verify` writes the receipt, so `session check` "receipt
 *     fresh" compares CONTENT. mtime moves on a worktree checkout, a merge or
 *     a break-and-restore with no change at all (seven Rover filings).
 *   `acceptance.check_fingerprint` (D-S045, SX-041): sha256 of the files the
 *     verification command references, taken at acceptance, so scrumux-app
 *     can show "the check itself changed since acceptance".
 *
 * A DIRECTORY IS HASHED DETERMINISTICALLY: its regular files in sorted
 * relative-path order, each contributing `path NUL sha256 LF`, skipping
 * dependency and VCS directories (`SKIP_DIRS`) and symlinks. A directory with
 * more than `MAX_DIR_FILES` files is not hashed at all — an unbounded walk at
 * acceptance is a cost, and a missing entry reads as "unknown".
 *
 * Dependencies: node:crypto, node:fs, node:path, command-paths.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { commandPathWords, commandWorkDirs } from './command-paths.js';

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.scratch', '.pytest_cache', 'dist', 'build']);
export const MAX_DIR_FILES = 2000;

/** The recorded shape of `acceptance.check_fingerprint`. */
export interface CheckFingerprint { algo: 'sha256'; files: Record<string, string> }

/** sha256 hex of a regular file's bytes, or null when it is not one or cannot be read. */
export function sha256File(abs: string): string | null {
  try {
    if (!lstatSync(abs).isFile()) return null;
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * sha256 hex of a file, or of a directory as described in the header; null
 * when the path is neither, cannot be read, or the directory is too large.
 *
 * Dependencies: sha256File.
 */
export function hashPath(abs: string): string | null {
  let st;
  try { st = lstatSync(abs); } catch { return null; }
  if (st.isFile()) return sha256File(abs);
  if (!st.isDirectory()) return null;
  const files: string[] = [];
  const walk = (dir: string, rel: string): boolean => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return true; }
    for (const name of names) {
      const p = join(dir, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      let s;
      try { s = lstatSync(p); } catch { continue; }
      if (s.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (!walk(p, r)) return false;
      } else if (s.isFile()) {
        files.push(r);
        if (files.length > MAX_DIR_FILES) return false;
      }
    }
    return true;
  };
  if (!walk(abs, '')) return null;
  const h = createHash('sha256');
  for (const r of files) h.update(`${r}\0${sha256File(join(abs, r)) ?? ''}\n`);
  return h.digest('hex');
}

/**
 * `{path: sha256}` for each of `paths` (repo-relative) that is a regular file
 * under `workRoot`. Paths that do not exist are left out.
 *
 * Dependencies: sha256File.
 */
export function fileHashes(workRoot: string, paths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    if (p === '' || p in out) continue;
    const h = sha256File(join(workRoot, p));
    if (h !== null) out[p] = h;
  }
  return out;
}

/**
 * The paths a task's receipt covers: `task_order.context.files[].path` and
 * `task_order.context.expected_artifacts`, in that order, each once — the
 * list `session check` "receipt fresh" judges.
 *
 * Dependencies: none.
 */
export function coveredPaths(row: { [k: string]: unknown }): string[] {
  const order = row['task_order'];
  const ctx = order !== null && typeof order === 'object' ? (order as Record<string, unknown>)['context'] : null;
  const c = ctx !== null && typeof ctx === 'object' ? (ctx as Record<string, unknown>) : {};
  const files = Array.isArray(c['files']) ? c['files'] : [];
  const arts = Array.isArray(c['expected_artifacts']) ? c['expected_artifacts'] : [];
  const out: string[] = [];
  const add = (v: unknown): void => {
    const s = typeof v === 'string' ? v : '';
    for (const p of s.split(/\s+/)) if (p !== '' && !out.includes(p)) out.push(p);
  };
  for (const f of files) add(f !== null && typeof f === 'object' ? (f as Record<string, unknown>)['path'] : '');
  for (const a of arts) add(a);
  return out;
}

/** A path relative to `root` when it lies inside it (and is not the root itself), else null. */
function inside(root: string, abs: string): string | null {
  const rel = relative(resolve(root), resolve(abs));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

/**
 * The fingerprint of a verification command: every path-shaped word it
 * names (a `/` or an extension: `scripts/check.sh`, `tests/drafter`,
 * `test_x.py`), tried as written and under each directory the command works
 * in, that exists inside `workRoot` — files and directories alike, keyed by
 * repo-relative path. A bare word (`pytest tests`) is not read as a path.
 *
 * Dependencies: commandPathWords, commandWorkDirs, hashPath.
 */
export function checkFingerprint(workRoot: string, command: string): CheckFingerprint {
  const files: Record<string, string> = {};
  const bases = ['', ...commandWorkDirs(command)];
  // The directories the command works IN are bases, not check files: hashing
  // a whole package would flag every code change as a change to the check.
  for (const w of commandPathWords(command)) {
    for (const base of bases) {
      const abs = isAbsolute(w) ? w : resolve(workRoot, normalize(join(base, w)));
      const rel = inside(workRoot, abs);
      if (rel === null || rel in files) continue;
      const h = hashPath(abs);
      if (h !== null) files[rel] = h;
      if (isAbsolute(w)) break;
    }
  }
  return { algo: 'sha256', files };
}
