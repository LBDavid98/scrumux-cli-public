/**
 * The derived-value cache (T-0139/D-0044).
 *
 * KEYED ON THE CONTENT OF THE JOURNALS A READER CONSUMED, HASHED LIVE, AND
 * DELIBERATELY NOT READ OUT OF `seals.json`. The seal map only moves on a
 * scrumux write, so a journal edited outside scrumux would keep serving a
 * stale cached answer for ever; hashing the file itself means ANY change
 * invalidates, including one scrumux never saw. That is the whole reason the
 * mechanism exists in this shape, and `tests/journal-cache-tests.sh` is the
 * case that pins it.
 *
 * ENTIRELY DISPOSABLE (P-11). A missing, unreadable or malformed entry falls
 * through to a full computation; `cachePut` never fails anything. Removing
 * the directory changes nothing but timing.
 *
 * SIDE EFFECTS NEVER GO BEHIND IT. A counter that ticks on every read has to
 * tick on a hit too -- trading a side effect for speed is how a counter
 * silently stops counting.
 *
 * `governance/.cache/`: a dot directory, gitignored, outside the
 * `governance/*.json` glob every sweep walks, and NOT in `SEALED_JOURNALS` --
 * sealing a derived file breaks on every rebuild, which is why the two graph
 * indexes are excluded too.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealOf } from './seals.js';

export const CACHE_DIR_NAME = '.cache';

/**
 * `cache_key <label> <journal-path>...` -- a stable key for a derived value.
 *
 * The accumulator is `label` then `:<sha256>` per file, or `:absent` for one
 * that is not there, and the whole string is hashed. An absent file is a
 * DISTINCT key from an empty one, which is what makes "the journal appeared"
 * an invalidating event.
 */
export function cacheKey(label: string, ...paths: string[]): string {
  let acc = label;
  for (const p of paths) {
    let hashed: string | null = null;
    try {
      if (statSync(p).isFile()) hashed = sealOf(p);
    } catch {
      hashed = null;
    }
    acc += hashed === null ? ':absent' : `:${hashed}`;
  }
  return createHash('sha256').update(acc).digest('hex');
}

/**
 * The cached value, or `null` for absent, EMPTY, or unreadable.
 *
 * A zero-byte entry is treated as a miss, never an answer, because a
 * truncated write must not become a cached empty result.
 *
 * The bytes come back exactly as stored, with no trailing-newline
 * stripping -- a caller that wants stripped output strips it itself.
 */
export function cacheGet(gov: string, key: string): string | null {
  const f = join(gov, CACHE_DIR_NAME, key);
  try {
    if (!statSync(f).isFile()) return null;
    const text = readFileSync(f, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Store a value. NEVER FATAL: an unwritable cache directory is a no-op. */
export function cachePut(gov: string, key: string, value: string): void {
  const dir = join(gov, CACHE_DIR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const tmp = join(dir, `${key}.tmp.${process.pid}`);
  try {
    writeFileSync(tmp, value);
    renameSync(tmp, join(dir, key));
  } catch {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // the cache is disposable; a leaked temp file is not an error
    }
  }
}
