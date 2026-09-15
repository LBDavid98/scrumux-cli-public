/**
 * The guarded journal write.
 *
 * THE ONE JSON WRITER. A hand-rolled write-then-rename is the banned pattern
 * (T-0077/I-0026): a gate must never report success after a failed write, and
 * every journal mutation in the CLI goes through here so the guards below are
 * unskippable rather than remembered.
 *
 * FIVE STACKED GUARDS, in this order:
 *
 *   a. the transform must not fail
 *   b. its output must not be empty        (T-0110/I-0058)
 *   c. its output must be {entries:[...]}  (T-0157/I-0035)
 *   d. it must not DROP entries
 *   e. keep the version being replaced
 *
 * Then the atomic rename, then `resealOne` on the file just written.
 *
 * WHY d EXISTS AND WHY c IS NOT ENOUGH: a filter that keeps six of eighty
 * entries discards the journal just as surely as one that keeps none, and
 * every guard above d passes it -- six entries is a valid array in a valid
 * object. A filter that binds over an empty jq stream can silently drop
 * every entry it doesn't match while still reporting success, and there is
 * no backup unless guard e provides one -- governance journals are
 * gitignored, so nothing else recovers them.
 *
 * ONE PARSE. The document is parsed once and held in memory; shape and entry
 * counts are derived from that parse rather than re-reading the file. The
 * serialized bytes are `jq .`-shaped (see jqformat.ts), and the seal is
 * taken over the bytes actually written, by hashing the file after the
 * rename.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDir } from '../util/fs-predicates.js';
import { jqFormat, parsePreservingNumbers, type JsonValue } from './jqformat.js';
import { nextId } from './ids.js';
import { journalLock, journalUnlock } from './lock.js';
import { JournalRefusal } from './refusal.js';
import { resealOne } from './seals.js';

/** Default number of backup generations kept per journal (env: `JOURNAL_BACKUPS`). */
export const DEFAULT_JOURNAL_BACKUPS = 10;

/** Backup directory name, local to the governance directory, gitignored, self-ignoring. */
export const BACKUP_DIR_NAME = '.backups';

/**
 * A journal transform: takes the current document, returns the next one.
 *
 * RETURNING `undefined` MEANS "no output" (jq's `empty`) -- guard (b) below
 * catches that shape and refuses to truncate the journal to zero bytes.
 */
export type Transform = (doc: JsonValue) => JsonValue | undefined;

export interface WriteOptions {
  /** Governance directory root; where `.backups/` and `seals.json` live. */
  gov: string;
  /** Today's date, captured once per invocation. */
  today: string;
  /** Reads `ALLOW_ENTRY_REMOVAL`, `JOURNAL_BACKUPS`, `JOURNAL_LOCK_TRIES`. */
  env?: NodeJS.ProcessEnv;
  /** The backup stamp's clock. Injectable so a test need not sleep. */
  now?: () => Date;
  /** Where the reseal warning goes; defaults to stderr. */
  err?: (s: string) => void;
}

export interface WriteResult {
  path: string;
  /** The exact bytes on disk after the write. */
  bytes: string;
  entriesBefore: number;
  entriesAfter: number;
  /** The generation kept, or `null` when no copy was taken. */
  backup: string | null;
  /**
   * The reseal failure, or `null`.
   *
   * A failed reseal does not fail the write: the journal write already
   * succeeded, so this surfaces as a warn row in the envelope with the exit
   * code unchanged (D-0085/OQ-18). The warning is also written to stderr.
   */
  resealWarning: string | null;
}

/** Locks the journal, runs the guarded write body, unlocks. */
export function writeJson(path: string, transform: Transform, opts: WriteOptions): WriteResult {
  const env = opts.env ?? process.env;
  journalLock(path, env);
  try {
    return writeJsonBody(path, transform, opts);
  } finally {
    journalUnlock(path);
  }
}

export interface AppendResult extends WriteResult {
  /** bash's `NEW_ID`. */
  id: string;
}

/**
 * Locks the journal, allocates the next id, runs the guarded write body,
 * unlocks.
 *
 * THE ID IS ALLOCATED INSIDE THE LOCK AND HANDED TO THE TRANSFORM. `nextId`
 * is max+1 over the journal, so allocating it before entering the critical
 * section would give two concurrent writers the same id even though each
 * write is individually locked (I-0079). The id arrives as a function
 * argument, so the transform has no way to substitute its own.
 *
 * @param idStream the ids to consider, selected from the CURRENT document by
 *                 the caller. The caller owns the selection; this function
 *                 narrows nothing.
 */
export function appendWithId(
  path: string,
  idStream: (doc: JsonValue) => JsonValue[],
  prefix: string,
  transform: (doc: JsonValue, id: string) => JsonValue | undefined,
  opts: WriteOptions,
): AppendResult {
  const env = opts.env ?? process.env;
  journalLock(path, env);
  try {
    const doc = readForWrite(path);
    const id = nextId(idStream(doc), prefix, basename(path));
    const res = writeJsonBody(path, (d) => transform(d, id), opts, doc);
    return { ...res, id };
  } finally {
    journalUnlock(path);
  }
}

/**
 * Reads and parses the journal before the transform runs.
 *
 * A MISSING OR UNPARSEABLE FILE IS THE SAME REFUSAL: both mean there is
 * nothing to write into. This is deliberately stricter than `readJournal`,
 * which treats an absent file as distinct from an unreadable one -- that
 * distinction matters only to a reader.
 */
function readForWrite(path: string): JsonValue {
  try {
    return parsePreservingNumbers(readFileSync(path, 'utf8'));
  } catch {
    throw new JournalRefusal(`jq write failed for ${path}`);
  }
}

/**
 * The write itself, with NO locking. PRIVATE: callers must already hold the
 * lock. Kept separate from `writeJson` because the lock is not re-entrant --
 * `appendWithId` shares this body rather than nesting a second lock acquire.
 */
function writeJsonBody(
  path: string,
  transform: Transform,
  opts: WriteOptions,
  preread?: JsonValue,
): WriteResult {
  const env = opts.env ?? process.env;
  const before = preread ?? readForWrite(path);

  // --- guard (a): the transform must not fail --------------------------
  let out: JsonValue | undefined;
  try {
    out = transform(before);
  } catch (e) {
    if (e instanceof JournalRefusal) throw e;
    throw new JournalRefusal(`jq write failed for ${path}`);
  }

  // --- guard (b): non-empty output (T-0110/I-0058) ---------------------
  // A transform that produces NO output must not be allowed to truncate the
  // journal to zero bytes. This is not an exotic shape: a select/filter over
  // a journal with no match produces no output, and without this guard that
  // would silently empty the file while the caller reports success.
  const bytes = out === undefined ? '' : jqFormat(out);
  if (bytes.length === 0) {
    throw new JournalRefusal(
      `refusing to write ${path}: the jq filter produced NO output, which would truncate the journal ` +
        `to zero bytes — check the filter (a streaming '.entries[] | select(...)' matching nothing does this)`,
    );
  }

  // --- guard (c): {entries:[...]} (T-0157/I-0035) ----------------------
  // Every governance journal is {entries:[...]}. A filter that produces a
  // valid object with no entries array has silently discarded the journal.
  const entriesAfter = entriesArrayOf(out as JsonValue);
  if (entriesAfter === null) {
    throw new JournalRefusal(
      `refusing to write ${path}: the jq filter produced output that is not an object with an entries ` +
        `array — check the filter (T-0157: every governance journal is {entries:[...]})`,
    );
  }

  // --- guard (d): no entry-count regression ----------------------------
  // A FILTER THAT KEEPS SIX OF EIGHTY DISCARDS THE JOURNAL just as surely as
  // one that keeps none. Governance journals are append-mostly; nothing in
  // the CLI deletes an entry except `repair journal`, and a person doing that
  // on purpose can say so.
  const nBefore = jqLength(fieldOf(before, 'entries'));
  const nAfter = entriesAfter.length;
  if (nAfter < nBefore && env['ALLOW_ENTRY_REMOVAL'] !== '1') {
    const lost = nBefore - nAfter;
    throw new JournalRefusal(
      `refusing to write ${path}: this would DROP ${lost} of ${nBefore} entries, leaving ${nAfter}. ` +
        `Governance journals are append-mostly and nothing in the CLI removes an entry by design. ` +
        `If the filter is meant to select rather than delete, it is probably a map/select shape that ` +
        `discards non-matching rows -- note that in jq, '(empty) as $x | body' produces nothing, so a ` +
        `stream binding that finds no match drops the whole row. If the removal IS intended, re-run ` +
        `with ALLOW_ENTRY_REMOVAL=1 and say why in the repair's --why.`,
    );
  }

  // --- guard (e): keep the version we are about to replace -------------
  const backup = takeBackup(path, opts);

  // --- the atomic swap -------------------------------------------------
  // Written to a sibling temp and renamed, so a reader never sees a partial
  // journal and a crash mid-write leaves the previous version intact.
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    throw new JournalRefusal(`cannot move temp file onto ${path}`);
  }

  // --- reseal THIS file, and only this file ----------------------------
  // The write path is the only place that reliably knows a write happened,
  // so sealing belongs here rather than in each caller. Deliberately NOT
  // `sealJournals` -- see the note on `resealOne`.
  const resealWarning = resealOne(opts.gov, path, opts.today, env);
  if (resealWarning !== null) {
    const err = opts.err ?? ((s: string) => void process.stderr.write(s));
    err(resealWarning + '\n');
  }

  return { path, bytes, entriesBefore: nBefore, entriesAfter: nAfter, backup, resealWarning };
}

/**
 * KEEP THE VERSION WE ARE ABOUT TO REPLACE.
 *
 * The entry-count guard (d) catches a filter that drops entries; it does not
 * catch one that rewrites content while keeping the count the same. This
 * guard does, at the cost of a file copy on a path that already writes a
 * file. Governance journals are gitignored, so this backup is the only
 * recovery path a bad write leaves behind.
 *
 * TEN GENERATIONS, AND THAT NUMBER IS LOAD-BEARING. Restoring is NOT always
 * "take the newest": some verbs write the same journal twice in a row (e.g.
 * `repair journal` rewrites the target, then appends its own log entry), so
 * when the damaged journal is the one being appended to, the newest backup
 * was taken AFTER the damage -- the good version can be a few generations
 * back, and ten exist so there is room to look.
 *
 * EVERY STEP IS BEST-EFFORT (P-09). A full disk must not turn a governance
 * write into a refusal -- the backup protects the write, it does not gate it.
 */
function takeBackup(path: string, opts: WriteOptions): string | null {
  const gov = opts.gov;
  if (!isDir(gov)) return null;
  const dir = join(gov, BACKUP_DIR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  // SELF-IGNORING. These are a local safety net, not a record -- and left
  // untracked they dirty the checkout: `deliver` refuses a dirty tree, so
  // stray backups can block a session's own acceptance (T-0006). The
  // directory carries its own ignore rule so this holds in every repo with
  // no deploy step and no per-repo .gitignore edit.
  try {
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  } catch {
    // best effort
  }

  const base = basename(path);
  const dest = backupName(dir, base, (opts.now ?? (() => new Date()))());
  try {
    // The copy carries the ORIGINAL's mode and times, which is what makes
    // the newest-first pruning below order generations by when each journal
    // version was written rather than by when it was copied.
    //
    // THE TIMES ARE CARRIED SUB-MILLISECOND, AND THAT IS NOT PEDANTRY.
    // `utimesSync` with plain `Date` objects (as `statSync` normally hands
    // back) rounds to the millisecond, and on APFS that rounding is not
    // monotonic: several writes inside one millisecond can produce backup
    // mtimes that go up, then down, then up again -- corrupting the
    // newest-first order `pruneBackups` relies on and deleting the wrong
    // generation. Passing `mtimeNs / 1e9` keeps sub-millisecond precision
    // (not full nanosecond -- a double's mantissa can't hold a ~61-bit
    // nanosecond epoch -- but far finer than millisecond rounding) and
    // avoids the problem.
    copyFileSync(path, dest);
    const st = statSync(path, { bigint: true });
    chmodSync(dest, Number(st.mode & 0o7777n));
    utimesSync(dest, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9);
  } catch {
    return null;
  }

  pruneBackups(dir, base, opts.env ?? process.env);
  return dest;
}

/**
 * Backup filename: `<base>.<timestamp>.<pid>`, plus a de-collision suffix.
 *
 * THE PID ALONE IS NOT ENOUGH TO STAY UNIQUE. This CLI can run as a
 * long-lived process, and multiple writes to the same journal within one
 * process share a PID: fifteen writes to one journal inside one second
 * would all land on the same name and leave ONE generation where the
 * recovery depth guard (e) expects fifteen. The `-2`, `-3` ... suffix
 * appears only on a collision.
 */
function backupName(dir: string, base: string, now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp =
    `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const head = join(dir, `${base}.${stamp}.${process.pid}`);
  if (!existsSync(head)) return head;
  for (let n = 2; ; n++) {
    const cand = `${head}-${n}`;
    if (!existsSync(cand)) return cand;
  }
}

/**
 * Keep the newest `JOURNAL_BACKUPS` per journal: `ls -t` newest-first, delete
 * from N+1. Failures are ignored on purpose.
 *
 * `ls -t` GLOBS BY NAME (`"$_bk/$_bkbase."*`), not by lock ownership, so the
 * prefix match is on `<journal>.` and the ordering is by mtime. The tie-break
 * is by name descending, which for this name scheme is also newest-first.
 */
function pruneBackups(dir: string, base: string, env: NodeJS.ProcessEnv): void {
  const raw = env['JOURNAL_BACKUPS'];
  const keep = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_JOURNAL_BACKUPS;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(`${base}.`));
  } catch {
    return;
  }
  const rows: { name: string; mtime: bigint; stamp: string; seq: number }[] = [];
  for (const n of names) {
    try {
      const m = /\.([0-9]{8}-[0-9]{6})\.[0-9]+(?:-([0-9]+))?$/.exec(n);
      rows.push({
        name: n,
        mtime: statSync(join(dir, n), { bigint: true }).mtimeNs,
        stamp: m?.[1] ?? '',
        // The de-collision suffix is a CREATION COUNTER, so it is compared as
        // a number: a plain lexicographic tie-break puts `-10` before `-2`,
        // and ten generations is exactly the default depth.
        seq: m?.[2] === undefined ? 1 : Number(m[2]),
      });
    } catch {
      // vanished under us; nothing to prune
    }
  }
  rows.sort((a, b) => {
    if (a.mtime !== b.mtime) return a.mtime > b.mtime ? -1 : 1;
    if (a.stamp !== b.stamp) return a.stamp > b.stamp ? -1 : 1;
    if (a.seq !== b.seq) return b.seq - a.seq;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });
  for (const row of rows.slice(keep)) {
    try {
      rmSync(join(dir, row.name), { force: true });
    } catch {
      // best effort, per P-09
    }
  }
}

/** `.entries` when it is an array, else `null` -- guard (c) in one place. */
function entriesArrayOf(v: JsonValue): JsonValue[] | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = (v as { [k: string]: JsonValue })['entries'];
  return Array.isArray(e) ? e : null;
}

function fieldOf(v: JsonValue, key: string): JsonValue {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = (v as { [k: string]: JsonValue })[key];
  return x === undefined ? null : x;
}

/**
 * jq's `length` semantics, used to compute the before-count.
 *
 * A journal whose `.entries` is missing yields `null | length` = 0 rather
 * than an error, so a first write into a `{}` file counts as an increase,
 * not a regression.
 */
function jqLength(v: JsonValue): number {
  if (v === null || v === undefined) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return Array.from(v).length;
  if (typeof v === 'object') return Object.keys(v as { [k: string]: JsonValue }).length;
  return 0;
}

/**
 * Seeds a journal file with a template if it doesn't already exist.
 *
 * THE ONE PLACE IN THIS MODULE WHERE A FILESYSTEM FAILURE IS FATAL (P-49).
 * Everything the backup path does is best-effort; this dies, because a caller
 * that could not seed the journal it is about to write has nothing to write
 * into.
 *
 * THE SEEDED BYTES ARE NOT `jq .` BYTES. This writes the literal template
 * text plus a newline, not the jqFormat-serialized form, and the file stays
 * that way until its first real write -- so a freshly seeded, never-written
 * journal is not byte-identical to one this CLI has since written to.
 */
export function ensureFile(path: string, template: string): void {
  // `[ -f "$1" ]` -- a FILE. A directory in the way falls through to the
  // write, which fails, which dies naming the path.
  try {
    if (statSync(path).isFile()) return;
  } catch {
    // absent; seed it
  }
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    throw new JournalRefusal(`cannot create ${dir}`);
  }
  try {
    writeFileSync(path, template + '\n');
  } catch {
    throw new JournalRefusal(`cannot create ${path}`);
  }
}
