/**
 * WHEN A REBUILT CODE INDEX IS A CHANGE TO COMMIT (R-022, D-S031).
 *
 * Deploy rebuilds `governance/code-graph.json` every run, and the index
 * carries its build stamp (`provenance.built_at`, `provenance.built_at_epoch`),
 * so its bytes differ on every run even when nothing indexed changed. R-020
 * listed it in `commit_paths` whenever the bytes changed, which made every
 * redeploy commit touch the index.
 *
 * The FORMAT DOES NOT CHANGE: `isStaleGraph` (src/nouns/graph/code-index.ts)
 * compares source mtimes against `built_at_epoch`, so removing the stamp would
 * break stale detection across the fleet. Instead the index is listed only
 * when it differs from the COMMITTED version apart from the build stamp
 * (`BUILD_STAMP_FIELDS`). An
 * index with no committed version (a first deploy, or a target that is not a
 * git checkout) is always listed. The file on disk is never touched here.
 *
 * D-S034 goes one step earlier: a committed index that is not stale is not
 * rebuilt at all (`reusableIndex`), so deploy writes nothing and lists nothing.
 *
 * Depends on: node:child_process (git show), node:fs, `loadIndex`/`isStaleGraph`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStaleGraph, loadIndex } from '../graph/code-index.js';

/** Where deploy keeps the index, repo-relative. */
export const INDEX_REL = 'governance/code-graph.json';

/**
 * The provenance fields that change on every build and are ignored (R-022).
 * `commit` and `dirty` joined the stamp with D-S033: committing an index moves
 * HEAD past the commit it names, so the next build always records a new one,
 * and neither field judges staleness (`isStaleGraph` reads `built_at_epoch`;
 * `commit` only feeds the informational commits-behind count).
 */
export const BUILD_STAMP_FIELDS = ['built_at', 'built_at_epoch', 'commit', 'dirty'] as const;

/**
 * The index text with the build stamp removed, as a canonical string; null
 * when it is not a JSON object (an unreadable index is always a change).
 * Depends on: nothing.
 */
export function withoutBuildStamp(text: string): string | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const prov = o['provenance'];
  if (prov !== null && typeof prov === 'object' && !Array.isArray(prov)) {
    const stamp = new Set<string>(BUILD_STAMP_FIELDS);
    o['provenance'] = Object.fromEntries(Object.entries(prov as Record<string, unknown>).filter(([k]) => !stamp.has(k)));
  }
  return JSON.stringify(o);
}

/**
 * True when the current index must be committed: there is one on disk, and
 * either nothing is committed or it differs apart from the build stamp.
 * Depends on: `withoutBuildStamp`.
 */
export function indexNeedsCommit(committed: string | null, current: string | null): boolean {
  if (current === null) return false;
  if (committed === null) return true;
  const a = withoutBuildStamp(committed);
  const b = withoutBuildStamp(current);
  return a === null || b === null || a !== b;
}

/** `git show HEAD:<rel>` in `target`, or null when git has no such committed file. Depends on: git. */
export function committedText(target: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', target, 'show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
}

/**
 * WHETHER DEPLOY MAY REUSE THE INDEX IT FINDS (R-022, D-S034).
 *
 * Reuse only the COMMITTED index — the file on disk byte-equal to
 * `HEAD:governance/code-graph.json` — and only when `isStaleGraph`, the rule
 * every query already applies, says it is fresh. Anything else (no index,
 * none committed, a modified copy on disk, unreadable, stale) is rebuilt and
 * listed as before. Returns the reason either way, for the deploy line.
 * Depends on: `committedText`, `loadIndex`, `isStaleGraph`.
 */
export function reusableIndex(target: string): { reuse: boolean; reason: string } {
  let onDisk: string;
  try { onDisk = readFileSync(join(target, INDEX_REL), 'utf8'); } catch { return { reuse: false, reason: 'no index on disk' }; }
  const committed = committedText(target, INDEX_REL);
  if (committed === null) return { reuse: false, reason: 'no committed index' };
  if (committed !== onDisk) return { reuse: false, reason: 'the index on disk differs from the committed one' };
  let stale: boolean;
  let why: string;
  try { [stale, why] = isStaleGraph(loadIndex(join(target, INDEX_REL)), target); } catch (e) {
    return { reuse: false, reason: `the committed index is unreadable: ${(e as Error).message}` };
  }
  return stale ? { reuse: false, reason: `the committed index is stale: ${why}` } : { reuse: true, reason: why };
}

