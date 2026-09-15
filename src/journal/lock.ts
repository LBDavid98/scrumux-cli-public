/**
 * The journal lock (T-0128/I-0079).
 *
 * WITHOUT THIS LOCK, TWO CONCURRENT scrumux PROCESSES CAN BOTH SUCCEED WHILE
 * LOSING A RECORD: each reads the journal, each writes its own version back,
 * and the journal ends up one entry longer instead of two -- with both
 * callers told their record was created. The seal cannot catch it:
 * `resealOne` hashes whatever is on disk, so the winner certifies the
 * truncated file and the lost record is invisible.
 *
 * AN O_EXCL `mkdir` LOCK, DELIBERATELY NOT `flock(1)`. flock is a util-linux
 * program and does not exist on darwin, the declared platform, and a
 * file-lock library would add a native dependency to a code path every wall
 * and every write goes through. `mkdir` is atomic on every POSIX filesystem
 * and needs no helper binary: `mkdirSync` is `mkdir(2)` with `O_EXCL`
 * semantics -- exactly one caller's `mkdir` of a given path can succeed, and
 * every other caller sees EEXIST rather than success -- so two processes
 * exclude each other with no coordination beyond the filesystem.
 *
 * NOT RE-ENTRANT, BY DESIGN. Taking it twice for the same file without
 * unlocking deadlocks until the try budget runs out, which is why `writeJson`
 * and `appendWithId` each take the lock themselves and call one shared
 * UNLOCKED body rather than nesting. A re-entrant lock would hide that
 * mistake instead of surfacing it as a hang.
 *
 * SYNCHRONOUS THROUGHOUT. There is no `await` between acquire and release --
 * an interleaving point inside the critical section would reopen exactly the
 * race the lock closes, in a single process, where no filesystem lock can see
 * it. The spin uses `Atomics.wait` on a private buffer, which is a real
 * blocking sleep rather than a busy loop, so the process genuinely stalls
 * instead of burning CPU polling.
 */
import { mkdirSync, rmdirSync } from 'node:fs';
import { JournalRefusal } from './refusal.js';

/** Default number of lock-acquire attempts (env: `JOURNAL_LOCK_TRIES`). */
export const DEFAULT_LOCK_TRIES = 100;

/** Sleep between lock-acquire attempts, in milliseconds. */
export const LOCK_SLEEP_MS = 100;

/** The lock DIRECTORY for a journal: `<path>.lock`. A directory, not a file, because `mkdir` is what gives the atomicity above. */
export function lockPathOf(path: string): string {
  return `${path}.lock`;
}

/**
 * How many attempts this process gets.
 *
 * A NON-NUMERIC `JOURNAL_LOCK_TRIES` FAILS ON THE FIRST CONTENDED ATTEMPT --
 * this returns 0 tries rather than silently falling back to the default.
 * Restoring 100 tries on a garbage value would hide a typo'd override for
 * the entire life of a session, which is worse than the loud failure of a
 * lock that never contends succeeding on its first (and only) attempt.
 */
function triesFrom(env: NodeJS.ProcessEnv): number {
  const raw = env['JOURNAL_LOCK_TRIES'];
  if (raw === undefined || raw === '') return DEFAULT_LOCK_TRIES;
  if (!/^-?[0-9]+$/.test(raw.trim())) return 0;
  return Number(raw.trim());
}

/** A real blocking sleep. `Atomics.wait` is permitted on Node's main thread. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The stale-lock refusal.
 *
 * IT NAMES THE DIRECTORY AND THE COMMAND THAT CLEARS IT. A crashed writer
 * must not wedge the repo silently; `tests/journal-lock-tests.sh` asserts
 * the literal lock path appears in the message, because that is the only way
 * out (Article 5). A refusal that only said "timed out" and stopped there
 * would leave the operator to go find the lock directory themselves.
 */
export function staleLockMessage(path: string): string {
  const lock = lockPathOf(path);
  return (
    `timed out waiting for the journal lock ${lock} — another scrumux process is writing ${path}, ` +
    `or a previous one died holding it. If no scrumux is running, clear it: rmdir '${lock}'`
  );
}

/**
 * Block until this journal is ours, or refuse naming the stale lock.
 *
 * THE CONTRACT IS THE NUMBER OF TRIES, NOT THE WALL CLOCK. `journal-lock-
 * tests.sh` pins `JOURNAL_LOCK_TRIES=2`, not a duration, because the actual
 * wait time is not part of the contract -- only how many acquire attempts
 * this process makes before giving up and naming the stale lock. A test that
 * pinned a duration instead would be timing-sensitive on a slow machine.
 *
 * EVERY FAILED `mkdir` GETS THE SAME TREATMENT EXCEPT ONE. Contention retries
 * up to `tries` times and then refuses with `staleLockMessage`; the one
 * exception is handled separately just below, before the retry loop counts
 * it as an ordinary contended attempt.
 */
export function journalLock(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const lock = lockPathOf(path);
  const tries = triesFrom(env);
  let n = 0;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // APPROVED-DIVERGENCE: R-008. ENOENT means the journal's own directory
      // is gone -- the caller is pointed at a path that cannot hold a lock,
      // and spinning 100 times over it would turn a wrong path into a
      // ten-second hang ending in "timed out waiting for the journal lock",
      // which tells the operator to look for another process when the fault
      // is in the path they passed. Everything else is treated as contention.
      // Ruled by User 2026-09-01 (RULINGS.md R-008).
      if (code === 'ENOENT') {
        throw new JournalRefusal(
          `cannot take the journal lock ${lock} — its parent directory does not exist`,
        );
      }
      n += 1;
      if (!(n < tries)) throw new JournalRefusal(staleLockMessage(path));
      sleepSync(LOCK_SLEEP_MS);
    }
  }
}

/**
 * Release. NEVER THROWS -- already gone, never taken, or not ours are all
 * treated as success, so a failed unlock can never turn a completed write
 * into a reported failure.
 */
export function journalUnlock(path: string): void {
  try {
    rmdirSync(lockPathOf(path));
  } catch {
    // Already gone, never taken, or not ours. All three are non-events.
  }
}

/** Take the lock, run, release -- release even when the body throws. */
export function withJournalLock<T>(path: string, env: NodeJS.ProcessEnv, fn: () => T): T {
  journalLock(path, env);
  try {
    return fn();
  } finally {
    journalUnlock(path);
  }
}
