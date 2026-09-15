/**
 * Two `session check` readings kept out of session.ts:
 *
 *   `receiptFreshness` — check 3, "receipt fresh" (SX-024). Content hashes
 *     where the receipt has them (`receipt.file_hashes`), the mtime test for
 *     an older receipt; a changed file on an ACCEPTED task is post-acceptance
 *     drift (D-S018), reported apart from the stale files that fail the close.
 *   `acceptedWithOpenIssue` — D-S041: accepted tasks created with
 *     `task new --issue` whose issue is still open.
 *
 * Dependencies: jqlike (field, interp), receipt-freeze (isAccepted,
 * frozenReceipt), fingerprint (coveredPaths, sha256File), node:fs.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '../journal/jqformat.js';
import { isFile } from '../util/fs-predicates.js';
import { field, interp } from './lib/jqlike.js';
import { coveredPaths, sha256File } from './task/fingerprint.js';
import { frozenReceipt, isAccepted } from './task/receipt-freeze.js';

type Row = { [k: string]: JsonValue };

export interface Freshness {
  /** ` T-0001:path` per open task whose receipt no longer covers the code — a FAIL. */
  stale: string;
  /** ` T-0001` per receipt with no `at_epoch` — cannot be judged, a WARN. */
  unstamped: string;
  /** ` T-0001:path` per ACCEPTED task whose covered file changed — drift, a WARN. */
  drift: string;
}

const asRow = (v: JsonValue | undefined | null): Row | null =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;

/** Whole seconds of a path's mtime, or 0. */
function mtime(path: string): number {
  try { return Math.floor(statSync(path).mtimeMs / 1000); } catch { return 0; }
}

/**
 * The first covered file of one task that changed since `receipt`, or ''.
 * With `file_hashes`: a differing hash, or a file that exists now and was not
 * hashed. Without: a file whose mtime is newer than `at_epoch`.
 *
 * Dependencies: coveredPaths, sha256File, isFile.
 */
export function firstChanged(row: Row, receipt: Row, workRoot: string): string {
  const hashes = asRow(receipt['file_hashes']);
  const at = Number(interp(receipt['at_epoch'] ?? null));
  for (const f of coveredPaths(row)) {
    const p = join(workRoot, f);
    if (!isFile(p)) continue;
    if (hashes !== null) {
      const want = hashes[f];
      if (typeof want !== 'string' || sha256File(p) !== want) return f;
      continue;
    }
    if (!Number.isFinite(at)) continue; // a bad stamp cannot be judged
    if (mtime(p) > at) return f;
  }
  return '';
}

/**
 * Check 3 over the claimed tasks.
 *
 * Dependencies: firstChanged, frozenReceipt, isAccepted.
 */
export function receiptFreshness(tasks: readonly JsonValue[], claimed: readonly string[], workRoot: string): Freshness {
  const out: Freshness = { stale: '', unstamped: '', drift: '' };
  for (const t of claimed) {
    const row = asRow(tasks.find((e) => field(e, 'id') === t));
    if (row === null) continue;
    const settled = isAccepted(row);
    const receipt = settled ? frozenReceipt(row) : asRow(row['receipt']);
    const at = receipt === null ? null : receipt['at_epoch'];
    if (receipt === null || at === undefined || at === null || at === false) {
      out.unstamped += ` ${t}`;
      continue;
    }
    const changed = firstChanged(row, receipt, workRoot);
    if (changed === '') continue;
    if (settled) out.drift += ` ${t}:${changed}`;
    else out.stale += ` ${t}:${changed}`;
  }
  return out;
}

/**
 * Accepted tasks that record `issue` (D-S041) whose issue is still `open` or
 * `accepted`. A task with no `issue` field, or an issue that cannot be found,
 * says nothing: unknown is not a finding.
 *
 * Dependencies: isAccepted, field, interp.
 */
export function acceptedWithOpenIssue(tasks: readonly JsonValue[], issues: readonly JsonValue[]): { task: string; issue: string }[] {
  const out: { task: string; issue: string }[] = [];
  for (const e of tasks) {
    const row = asRow(e);
    if (row === null || !isAccepted(row) || typeof row['issue'] !== 'string') continue;
    const iss = issues.find((i) => field(i, 'id') === row['issue']);
    const st = iss === undefined ? '' : interp(field(iss, 'status'));
    if (st === 'open' || st === 'accepted') out.push({ task: interp(row['id'] ?? null), issue: row['issue'] });
  }
  return out;
}
