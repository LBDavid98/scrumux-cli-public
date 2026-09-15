/**
 * The write engine, in isolation.
 *
 * THIS MODULE GETS REAL TESTS, NOT LIGHT ONES. Journal corruption is the
 * harness's worst historical failure class and every guard below was bought
 * with a measured incident: 237164 bytes to zero at rc 0 (I-0058), 80
 * decisions to 6 with no backup to restore from (2026-08-27), two callers
 * handed T-0128 five times out of five (I-0079). A test that only proves the
 * happy path proves none of that.
 *
 * The bash-parity half -- byte fidelity, the seal file's hand-printed format,
 * and the cross-implementation lock -- is in
 * test/differential/journal-engine.test.ts, because it needs the bash CLI.
 * This file covers what a byte comparison cannot reach: the refusal WORDING,
 * the guards' ORDER, and the count-regression guard that has no bash test to
 * port from at all (journal-engine.md open question 2 -- "a coverage gap the
 * port should not inherit silently").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { jqFormat, parsePreservingNumbers, RawNumber, type JsonValue } from '../../src/journal/jqformat.js';
import { JournalRefusal, refusing } from '../../src/journal/refusal.js';
import {
  DEFAULT_LOCK_TRIES,
  journalLock,
  journalUnlock,
  lockPathOf,
  staleLockMessage,
  withJournalLock,
} from '../../src/journal/lock.js';
import { formatId, nextId } from '../../src/journal/ids.js';
import { appendWithId, ensureFile, writeJson, type WriteOptions } from '../../src/journal/write.js';
import { SEALED_JOURNALS, brokenSeals, sealJournals, sealOf } from '../../src/journal/seals.js';
import { admissionState, admissionTsv, authorityGuard, parallelGuard } from '../../src/journal/guards.js';
import { refExists, refExistsAny, refJournal, refResolve, requireTaskRef } from '../../src/journal/refs.js';
import { cacheGet, cacheKey, cachePut, CACHE_DIR_NAME } from '../../src/journal/cache.js';
import { runWithTimeout } from '../../src/journal/timeout.js';
import { attested, beat, emitted, type Emitter } from '../../src/journal/beat.js';

const TODAY = '2026-09-01';

let box: string;
let gov: string;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'scrumux-journal-'));
  gov = join(box, 'governance');
  mkdirSync(gov, { recursive: true });
});

afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

function opts(over: Partial<WriteOptions> = {}): WriteOptions {
  return { gov, today: TODAY, env: {}, err: () => {}, ...over };
}

/** A journal in `jq .` bytes, which is what every real journal is. */
function seed(name: string, doc: JsonValue): string {
  const p = join(gov, name);
  writeFileSync(p, jqFormat(doc));
  return p;
}

function entries(n: number): JsonValue {
  return { entries: Array.from({ length: n }, (_, i) => ({ id: formatId('T', i + 1) })) };
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe('journalLock', () => {
  it('takes the lock as a DIRECTORY named <journal>.lock', () => {
    const p = seed('tasks.json', entries(1));
    journalLock(p, {});
    expect(statSync(lockPathOf(p)).isDirectory()).toBe(true);
    journalUnlock(p);
    expect(existsSync(lockPathOf(p))).toBe(false);
  });

  it('refuses a stale lock after JOURNAL_LOCK_TRIES attempts, naming the directory', () => {
    const p = seed('tasks.json', entries(1));
    mkdirSync(lockPathOf(p));
    const t0 = Date.now();
    expect(() => journalLock(p, { JOURNAL_LOCK_TRIES: '2' })).toThrow(JournalRefusal);
    // TWO tries means ONE sleep between them: the contract is the number of
    // attempts, not the wall clock (journal-engine.md open question 5), but a
    // spin that never slept would be a busy loop and this catches that.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    try {
      journalLock(p, { JOURNAL_LOCK_TRIES: '2' });
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('tasks.json.lock');
      expect(m).toContain("rmdir '");
      expect(m).toContain('another scrumux process is writing');
    }
  });

  it('is NOT re-entrant -- taking it twice burns the try budget', () => {
    const p = seed('tasks.json', entries(1));
    journalLock(p, {});
    expect(() => journalLock(p, { JOURNAL_LOCK_TRIES: '1' })).toThrow(/timed out waiting for the journal lock/);
    journalUnlock(p);
  });

  it('unlock never fails, even on a lock it does not hold', () => {
    expect(() => journalUnlock(join(gov, 'never-locked.json'))).not.toThrow();
  });

  it('releases the lock when the body throws', () => {
    const p = seed('tasks.json', entries(1));
    expect(() => withJournalLock(p, {}, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPathOf(p))).toBe(false);
  });

  it('refuses immediately when the parent directory is gone', () => {
    expect(() => journalLock(join(box, 'nope', 'tasks.json'), {})).toThrow(/parent directory does not exist/);
  });

  it('a non-numeric JOURNAL_LOCK_TRIES fails on the first contended attempt', () => {
    const p = seed('tasks.json', entries(1));
    mkdirSync(lockPathOf(p));
    const t0 = Date.now();
    expect(() => journalLock(p, { JOURNAL_LOCK_TRIES: 'lots' })).toThrow(JournalRefusal);
    expect(Date.now() - t0).toBeLessThan(90);
  });

  it('defaults to 100 tries and names the path in the refusal text', () => {
    expect(DEFAULT_LOCK_TRIES).toBe(100);
    expect(staleLockMessage('/g/tasks.json')).toContain('/g/tasks.json.lock');
  });
});

// ---------------------------------------------------------------------------
// nextId
// ---------------------------------------------------------------------------

describe('nextId', () => {
  it('is max+1 over the stream, zero-padded to four', () => {
    expect(nextId([], 'T')).toBe('T-0001');
    expect(nextId(['T-0001', 'T-0007', 'T-0003'], 'T')).toBe('T-0008');
    expect(nextId([null, 'T-0002', null], 'T')).toBe('T-0003');
  });

  it('is MAX+1, not COUNT+1 -- a gap never re-issues a used id', () => {
    expect(nextId(['T-0001', 'T-0099'], 'T')).toBe('T-0100');
  });

  it('keeps counting past four digits rather than truncating', () => {
    expect(nextId(['T-9999'], 'T')).toBe('T-10000');
  });

  it('strips a LITERAL prefix and nothing else', () => {
    // `ltrimstr` passes a value that does not start with the prefix straight
    // through -- which is where a foreign id lands, and why the caller owns
    // the stream selection rather than this function.
    expect(() => nextId(['X-0003'], 'T')).toThrow(/whose suffix is not a number/);
  });

  it('accepts a numerically-typed id, as ltrimstr|tonumber does', () => {
    expect(nextId([new RawNumber('12')], 'T')).toBe('T-0013');
  });

  // APPROVED-DIVERGENCE: D-0085 (OQ-7).
  it('REFUSES a malformed id instead of silently allocating a duplicate', () => {
    // bash: `tonumber` errors, the pipe empties, `read -r n || n=1` defaults,
    // and the allocator hands out T-0001 at rc 0 -- an id that already exists.
    let msg = '';
    try {
      nextId(['T-0001', 'T-000A'], 'T', 'tasks.json');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('T-000A');
    expect(msg).toContain('D-0085/OQ-7');
    expect(msg).toContain('scrumux repair journal tasks.json');
  });
});

// ---------------------------------------------------------------------------
// The five guards
// ---------------------------------------------------------------------------

describe('writeJson guards', () => {
  it('(a) refuses when the transform throws, leaving the journal untouched', () => {
    const p = seed('tasks.json', entries(2));
    const before = read(p);
    expect(() => writeJson(p, () => { throw new TypeError('bad filter'); }, opts())).toThrow(
      `jq write failed for ${p}`,
    );
    expect(read(p)).toBe(before);
  });

  it('(a) refuses when the journal itself does not parse', () => {
    const p = join(gov, 'tasks.json');
    writeFileSync(p, '{ broken');
    expect(() => writeJson(p, (d) => d, opts())).toThrow(`jq write failed for ${p}`);
  });

  // T-0110/I-0058: measured 237164 bytes -> 0, rc 0, success line printed.
  it('(b) refuses empty output rather than truncating to zero bytes', () => {
    const p = seed('tasks.json', entries(3));
    const before = read(p);
    let msg = '';
    try {
      writeJson(p, () => undefined, opts());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('the jq filter produced NO output');
    expect(msg).toContain('truncate the journal to zero bytes');
    expect(read(p)).toBe(before);
    expect(statSync(p).size).toBeGreaterThan(0);
  });

  // T-0157/I-0035.
  it('(c) refuses output that is not an object with an entries array', () => {
    const p = seed('tasks.json', entries(1));
    const before = read(p);
    for (const bad of [
      () => ({ other: [1] }) as JsonValue,
      () => [1, 2] as JsonValue,
      () => 'a string' as JsonValue,
      () => ({ entries: 'not an array' }) as JsonValue,
    ]) {
      let msg = '';
      try {
        writeJson(p, bad, opts());
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('is not an object with an entries array');
      expect(msg).toContain('T-0157');
    }
    // THE GUARD FIRES BEFORE THE mv -- journal-shape-tests.sh:57 asserts
    // exactly this, because a refusal that has already replaced the file is
    // not a refusal.
    expect(read(p)).toBe(before);
  });

  // The 2026-08-27 decisions.json 80 -> 6 incident. No bash suite exercises
  // this guard at all (journal-engine.md open question 2); these are the
  // tests written fresh rather than ported.
  it('(d) refuses an entry-count regression, naming both counts', () => {
    const p = seed('decisions.json', entries(80));
    const before = read(p);
    let msg = '';
    try {
      writeJson(p, () => entries(6), opts());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('this would DROP 74 of 80 entries, leaving 6');
    expect(msg).toContain('ALLOW_ENTRY_REMOVAL=1');
    expect(read(p)).toBe(before);
  });

  it('(d) lets a declared removal through under ALLOW_ENTRY_REMOVAL=1', () => {
    const p = seed('decisions.json', entries(80));
    const res = writeJson(p, () => entries(6), opts({ env: { ALLOW_ENTRY_REMOVAL: '1' } }));
    expect(res.entriesBefore).toBe(80);
    expect(res.entriesAfter).toBe(6);
    expect(parsePreservingNumbers(read(p))).toEqual(entries(6));
  });

  it('(d) only "1" opts in -- a truthy-looking value still refuses', () => {
    const p = seed('decisions.json', entries(5));
    for (const v of ['0', 'yes', 'true', '']) {
      expect(() => writeJson(p, () => entries(4), opts({ env: { ALLOW_ENTRY_REMOVAL: v } }))).toThrow(
        /would DROP/,
      );
    }
  });

  it('(d) an equal or growing count needs no declaration', () => {
    const p = seed('tasks.json', entries(3));
    expect(() => writeJson(p, () => entries(3), opts())).not.toThrow();
    expect(() => writeJson(p, () => entries(4), opts())).not.toThrow();
  });

  it('(d) counts a missing .entries as zero, so a first write is an increase', () => {
    const p = join(gov, 'tasks.json');
    writeFileSync(p, jqFormat({}));
    const res = writeJson(p, () => entries(1), opts());
    expect(res.entriesBefore).toBe(0);
    expect(res.entriesAfter).toBe(1);
  });

  it('writes `jq .` bytes -- insertion order kept, number literals preserved', () => {
    const p = seed('tasks.json', { entries: [] });
    const doc = parsePreservingNumbers('{"entries":[{"z":1,"a":1.50,"n":1e3}]}');
    writeJson(p, () => doc, opts());
    // `1.50` survives verbatim; `1e3` is canonicalised the way jq canonicalises
    // it. Both are the formatter's contract, asserted here from the WRITE path
    // so a writer that reached for JSON.stringify could not pass.
    expect(read(p)).toBe('{\n  "entries": [\n    {\n      "z": 1,\n      "a": 1.50,\n      "n": 1E+3\n    }\n  ]\n}\n');
  });
});

// ---------------------------------------------------------------------------
// Guard (e) -- the backups
// ---------------------------------------------------------------------------

describe('the .backups generation copy', () => {
  function backupsOf(name: string): string[] {
    const dir = join(gov, '.backups');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.startsWith(`${name}.`));
  }

  it('keeps the version being REPLACED, not the one just written', () => {
    const p = seed('tasks.json', entries(1));
    const before = read(p);
    writeJson(p, () => entries(2), opts());
    const kept = backupsOf('tasks.json');
    expect(kept).toHaveLength(1);
    expect(read(join(gov, '.backups', kept[0]!))).toBe(before);
  });

  it('writes a self-ignoring .gitignore into the directory', () => {
    // Left untracked these dirty the checkout, and `deliver` refuses a dirty
    // tree -- so backups written during a dispatched session helped block
    // that session's own acceptance (observed on T-0006).
    const p = seed('tasks.json', entries(1));
    writeJson(p, () => entries(2), opts());
    expect(read(join(gov, '.backups', '.gitignore'))).toBe('*\n');
  });

  it('rotates to ten generations by default, and keeps the RIGHT ten', () => {
    // FIFTEEN WRITES INSIDE ONE SECOND is the shape that broke this once. The
    // generation copy carries the source's mtime, and rounding those times to
    // the millisecond made the ordering non-monotonic on APFS -- measured
    // 654999000, 655999000, 654999000 across three consecutive writes, so the
    // prune deleted generation 4 and kept generation 3. Asserting the COUNT
    // alone passed all the way through that. This asserts identity.
    const p = seed('tasks.json', entries(1));
    for (let i = 2; i <= 16; i++) writeJson(p, () => entries(i), opts());
    const kept = backupsOf('tasks.json')
      .map((n) => (parsePreservingNumbers(read(join(gov, '.backups', n))) as { entries: unknown[] }).entries.length)
      .sort((a, b) => a - b);
    expect(kept).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('honours JOURNAL_BACKUPS', () => {
    const p = seed('tasks.json', entries(1));
    for (let i = 2; i <= 10; i++) writeJson(p, () => entries(i), opts({ env: { JOURNAL_BACKUPS: '3' } }));
    expect(backupsOf('tasks.json')).toHaveLength(3);
  });

  it('keeps the NEWEST generations -- restoring is not always take-the-newest, so there must be room to look', () => {
    const p = seed('tasks.json', entries(1));
    for (let i = 2; i <= 6; i++) writeJson(p, () => entries(i), opts({ env: { JOURNAL_BACKUPS: '2' } }));
    const kept = backupsOf('tasks.json')
      .map((n) => (parsePreservingNumbers(read(join(gov, '.backups', n))) as { entries: unknown[] }).entries.length)
      .sort((a, b) => a - b);
    expect(kept).toEqual([4, 5]);
  });

  it('prunes only its OWN journal -- the glob is by name', () => {
    const t = seed('tasks.json', entries(1));
    const d = seed('decisions.json', entries(1));
    for (let i = 2; i <= 5; i++) writeJson(t, () => entries(i), opts({ env: { JOURNAL_BACKUPS: '1' } }));
    writeJson(d, () => entries(2), opts({ env: { JOURNAL_BACKUPS: '1' } }));
    expect(backupsOf('tasks.json')).toHaveLength(1);
    expect(backupsOf('decisions.json')).toHaveLength(1);
  });

  it('never refuses the write it is protecting (P-09)', () => {
    // No governance directory at all: the backup is skipped, the write lands.
    const loose = join(box, 'loose');
    mkdirSync(loose);
    const p = join(loose, 'tasks.json');
    writeFileSync(p, jqFormat(entries(1)));
    const res = writeJson(p, () => entries(2), opts({ gov: join(box, 'no-such-gov') }));
    expect(res.backup).toBeNull();
    expect(res.entriesAfter).toBe(2);
  });

  it('does not collide fifteen writes in one process onto one generation', () => {
    // PORT NOTE (journal-engine.md open question 7): bash's uniqueness source
    // is `$$`, which is fresh per invocation there and constant here.
    const p = seed('tasks.json', entries(1));
    for (let i = 2; i <= 6; i++) {
      writeJson(p, () => entries(i), opts({ now: () => new Date(2026, 8, 1, 12, 0, 0) }));
    }
    expect(backupsOf('tasks.json')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// appendWithId
// ---------------------------------------------------------------------------

describe('appendWithId', () => {
  const idStream = (doc: JsonValue): JsonValue[] =>
    ((doc as { entries: { id: JsonValue }[] }).entries ?? []).map((r) => r.id);

  it('allocates inside the lock and hands the id to the transform', () => {
    const p = seed('tasks.json', { entries: [{ id: 'T-0001' }] });
    const res = appendWithId(
      p,
      idStream,
      'T',
      (doc, id) => ({ entries: [...(doc as { entries: JsonValue[] }).entries, { id, title: 'two' }] }),
      opts(),
    );
    expect(res.id).toBe('T-0002');
    expect(res.entriesAfter).toBe(2);
    expect(existsSync(lockPathOf(p))).toBe(false);
  });

  it('releases the lock when the allocator refuses', () => {
    const p = seed('tasks.json', { entries: [{ id: 'T-00XX' }] });
    expect(() => appendWithId(p, idStream, 'T', (d) => d, opts())).toThrow(JournalRefusal);
    expect(existsSync(lockPathOf(p))).toBe(false);
  });

  it('releases the lock when a guard refuses', () => {
    const p = seed('tasks.json', { entries: [{ id: 'T-0001' }] });
    expect(() => appendWithId(p, idStream, 'T', () => undefined, opts())).toThrow(/produced NO output/);
    expect(existsSync(lockPathOf(p))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The seal, from the write path
// ---------------------------------------------------------------------------

describe('resealOne', () => {
  function seals(): JsonValue {
    return parsePreservingNumbers(read(join(gov, 'seals.json')));
  }

  it('updates only the file just written, leaving every other seal alone', () => {
    const t = seed('tasks.json', entries(1));
    const d = seed('decisions.json', entries(1));
    sealJournals(gov, TODAY);
    const decHash = (seals() as { journals: Record<string, string> }).journals['decisions.json'];

    // A hand edit to a DIFFERENT journal, of the kind the seal exists to
    // catch. One unrelated write must not launder it -- measured: a tampered
    // tasks.json was reported, then one `scrumux decide` erased the report.
    writeFileSync(d, jqFormat(entries(2)));
    writeJson(t, () => entries(5), opts());

    expect((seals() as { journals: Record<string, string> }).journals['decisions.json']).toBe(decHash);
    expect(brokenSeals(gov)).toEqual(['decisions.json']);
  });

  it('reseals the file it wrote, so the seal stays clean across a write', () => {
    const t = seed('tasks.json', entries(1));
    sealJournals(gov, TODAY);
    writeJson(t, () => entries(4), opts());
    expect(brokenSeals(gov)).toEqual([]);
    expect((seals() as { journals: Record<string, string> }).journals['tasks.json']).toBe(sealOf(t));
  });

  it('PRUNES a key no longer in the roster', () => {
    // A seal written by an older harness for a DERIVED file can never match
    // again -- the file is rebuilt on every deploy -- so the repo fails its
    // own validation permanently with no way to clear it.
    const t = seed('tasks.json', entries(1));
    writeFileSync(
      join(gov, 'seals.json'),
      jqFormat({ sealed_at: '2026-01-01', journals: { 'tasks.json': 'stale', 'governance-graph.json': 'stale' } }),
    );
    writeJson(t, () => entries(2), opts());
    const j = (seals() as { journals: Record<string, string> }).journals;
    expect(Object.keys(j)).toEqual(['tasks.json']);
  });

  it('is a no-op for a file outside SEALED_JOURNALS', () => {
    const p = seed('code-graph.json', entries(1));
    sealJournals(gov, TODAY);
    const before = read(join(gov, 'seals.json'));
    writeJson(p, () => entries(2), opts());
    expect(read(join(gov, 'seals.json'))).toBe(before);
  });

  it('is a no-op before the repo has ever been sealed', () => {
    const p = seed('tasks.json', entries(1));
    const res = writeJson(p, () => entries(2), opts());
    expect(res.resealWarning).toBeNull();
    expect(existsSync(join(gov, 'seals.json'))).toBe(false);
  });

  // APPROVED-DIVERGENCE: D-0085 (OQ-18).
  it('reports its own write failure as a warning AND on stderr', () => {
    const p = seed('tasks.json', entries(1));
    writeFileSync(join(gov, 'seals.json'), '{ not json');
    const errs: string[] = [];
    const res = writeJson(p, () => entries(2), opts({ err: (s) => void errs.push(s) }));
    expect(res.resealWarning).toContain('could not update the seal for tasks.json');
    expect(res.resealWarning).toContain('scrumux repair journal tasks.json');
    expect(errs.join('')).toContain('could not update the seal for tasks.json');
    // The WRITE still succeeded -- exit code unchanged is the ruling.
    expect(res.entriesAfter).toBe(2);
  });

  it('takes the seals lock, and takes it AFTER the journal lock', () => {
    const p = seed('tasks.json', entries(1));
    sealJournals(gov, TODAY);
    const seenOrder: string[] = [];
    // Hold the SEALS lock from outside; the write must get as far as the mv
    // and then fail to reseal, which proves the order is journal-then-seals
    // (had it wanted the seals lock first, nothing would have been written).
    mkdirSync(lockPathOf(join(gov, 'seals.json')));
    try {
      expect(() => writeJson(p, () => { seenOrder.push('body'); return entries(2); },
        opts({ env: { JOURNAL_LOCK_TRIES: '2' } }))).toThrow(/seals.json.lock/);
    } finally {
      journalUnlock(join(gov, 'seals.json'));
    }
    expect(seenOrder).toEqual(['body']);
    expect(read(p)).toBe(jqFormat(entries(2)));
    // and the JOURNAL lock is released even on that path
    expect(existsSync(lockPathOf(p))).toBe(false);
  });

  it('names the eight sealed journals and nothing derived', () => {
    expect([...SEALED_JOURNALS]).toEqual([
      'design.json', 'tasks.json', 'sprints.json', 'decisions.json',
      'issues.json', 'exceptions.json', 'log.json', 'repo-health.json',
    ]);
    expect(SEALED_JOURNALS).not.toContain('code-graph.json');
    expect(SEALED_JOURNALS).not.toContain('governance-graph.json');
    expect(SEALED_JOURNALS).not.toContain('seals.json');
  });
});

// ---------------------------------------------------------------------------
// ensureFile
// ---------------------------------------------------------------------------

describe('ensureFile', () => {
  it('seeds the printf template, NOT jq bytes (P-49)', () => {
    const p = join(gov, 'exceptions.json');
    ensureFile(p, '{"entries": []}');
    expect(read(p)).toBe('{"entries": []}\n');
    expect(read(p)).not.toBe(jqFormat({ entries: [] }));
  });

  it('creates the directory, and never overwrites an existing file', () => {
    const p = join(box, 'deep', 'a', 'tasks.json');
    ensureFile(p, '{"entries": []}');
    writeFileSync(p, 'MINE');
    ensureFile(p, '{"entries": []}');
    expect(read(p)).toBe('MINE');
  });

  it('is the one place a filesystem failure is fatal', () => {
    const clash = join(box, 'clash');
    writeFileSync(clash, 'i am a file');
    expect(() => ensureFile(join(clash, 'tasks.json'), '{}')).toThrow(/cannot create/);
  });
});

// ---------------------------------------------------------------------------
// The guards that are not journal I/O
// ---------------------------------------------------------------------------

describe('authorityGuard', () => {
  it('accepts the three recorded forms', () => {
    writeFileSync(join(gov, 'decisions.json'), jqFormat({ entries: [{ id: 'D-0044' }] }));
    for (const a of ['direct', 'app', 'app:sess-9', 'standing:D-0044']) {
      expect(() => authorityGuard(gov, a, 'accept')).not.toThrow();
    }
  });

  it('requires one -- an act with no recorded authority is indistinguishable from an agent acting alone', () => {
    let msg = '';
    try {
      authorityGuard(gov, '', 'accept');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      'accept: --authority is required — direct (a person said so in this session), app:<session> ' +
        '(taken through scrumux-app), or standing:D-XXXX (a ratified delegation). An act with no ' +
        'recorded authority is indistinguishable from an agent acting on its own say-so.',
    );
  });

  it('refuses a standing delegation that does not resolve', () => {
    writeFileSync(join(gov, 'decisions.json'), jqFormat({ entries: [{ id: 'D-0044' }] }));
    expect(() => authorityGuard(gov, 'standing:D-9999', 'ratify')).toThrow(
      /ratify: --authority standing:D-9999 does not resolve in governance\/decisions.json/,
    );
  });

  it('refuses a malformed value, quoting it back', () => {
    expect(() => authorityGuard(gov, 'app:', 'accept')).toThrow(
      "accept: --authority must be direct, app:<session>, or standing:D-XXXX, got 'app:'",
    );
    expect(() => authorityGuard(gov, 'standing:D-00001', 'accept')).toThrow(/got 'standing:D-00001'/);
    expect(() => authorityGuard(gov, 'User', 'accept')).toThrow(/got 'User'/);
  });
});

describe('parallelGuard', () => {
  it('accepts absence and any positive whole number', () => {
    for (const v of [undefined, '', '1', '4', '00', '007']) {
      expect(() => parallelGuard(v, 'sprint new')).not.toThrow();
    }
  });

  it('refuses non-numbers and zero, with two different reasons', () => {
    expect(() => parallelGuard('two', 'sprint new')).toThrow(/must be a whole number 1 or more, got 'two'/);
    expect(() => parallelGuard('-1', 'sprint new')).toThrow(/got '-1'/);
    expect(() => parallelGuard('0', 'sprint new')).toThrow(/a sprint that admits nothing is an abandoned sprint/);
  });
});

describe('admissionState', () => {
  function seedAdmission(): void {
    writeFileSync(
      join(gov, 'tasks.json'),
      jqFormat({
        entries: [
          { id: 'T-0001', status: 'in_progress' },
          { id: 'T-0002', status: 'in_progress' },
          { id: 'T-0003', status: 'proposed' },
          { id: 'T-0009', status: 'in_progress' },
        ],
      }),
    );
    writeFileSync(
      join(gov, 'sprints.json'),
      jqFormat({
        entries: [
          { id: 'SP-0001', status: 'ratified', parallel: new RawNumber('3'), tasks: ['T-0001', 'T-0002', 'T-0003'] },
          { id: 'SP-0003', status: 'ratified', tasks: ['T-0009'] },
        ],
      }),
    );
  }

  it('reports the home sprint, its cap, and same-sprint busy work', () => {
    seedAdmission();
    const s = admissionState(gov, 'T-0003');
    expect(s.home).toBe('SP-0001');
    expect(s.cap).toBe(3);
    expect(s.same).toEqual(['T-0001', 'T-0002']);
    expect(s.elsewhere).toEqual(['T-0009 is in SP-0003']);
    expect(s.elsewhereIds).toEqual(['T-0009']);
    expect(admissionTsv(s)).toBe('SP-0001\t3\tT-0001, T-0002\t2\tT-0009 is in SP-0003\tT-0009');
  });

  it('caps an unsprinted task at 1 and counts every busy task as elsewhere (D-0006, unchanged)', () => {
    seedAdmission();
    const s = admissionState(gov, 'T-0100');
    expect(s.home).toBe('');
    expect(s.cap).toBe(1);
    expect(s.same).toEqual([]);
    expect(s.elsewhereIds).toEqual(['T-0001', 'T-0002', 'T-0009']);
  });

  it('defaults an undeclared cap to 1', () => {
    seedAdmission();
    expect(admissionState(gov, 'T-0009').cap).toBe(1);
  });

  it('treats a PROPOSED sprint as no home at all', () => {
    writeFileSync(join(gov, 'tasks.json'), jqFormat({ entries: [{ id: 'T-0001', status: 'in_progress' }] }));
    writeFileSync(
      join(gov, 'sprints.json'),
      jqFormat({ entries: [{ id: 'SP-0001', status: 'proposed', parallel: new RawNumber('9'), tasks: ['T-0001', 'T-0002'] }] }),
    );
    const s = admissionState(gov, 'T-0002');
    expect(s.home).toBe('');
    expect(s.cap).toBe(1);
  });

  it('works with no sprints.json at all', () => {
    writeFileSync(join(gov, 'tasks.json'), jqFormat({ entries: [] }));
    expect(admissionState(gov, 'T-0001')).toEqual({ home: '', cap: 1, same: [], elsewhere: [], elsewhereIds: [] });
  });

  it('refuses rather than computing an admission decision from no data', () => {
    expect(() => admissionState(gov, 'T-0001')).toThrow(/cannot read .*tasks.json/);
    writeFileSync(join(gov, 'tasks.json'), jqFormat({ entries: [] }));
    writeFileSync(join(gov, 'sprints.json'), '{ broken');
    expect(() => admissionState(gov, 'T-0001')).toThrow(/cannot read .*sprints.json/);
  });
});

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

describe('refs', () => {
  beforeEach(() => {
    writeFileSync(
      join(gov, 'decisions.json'),
      jqFormat({
        entries: [
          { id: 'D-0044', title: 'mtime is not a tamper signal' },
          { id: 'D-0090', title: 'the replacement', supersedes: 'D-0044' },
        ],
      }),
    );
    writeFileSync(join(gov, 'issues.json'), jqFormat({ entries: [{ id: 'I-0079', summary: 'duplicate ids' }] }));
    writeFileSync(join(gov, 'tasks.json'), jqFormat({ entries: [{ id: 'T-0128', title: 'the lock' }] }));
    writeFileSync(
      join(gov, 'design.json'),
      jqFormat({
        entries: [
          { id: 'E-0001', kind: 'epic', name: 'an epic' },
          { id: 'F-0001', kind: 'feature', name: 'a feature' },
          { id: 'S-0001', kind: 'story', narrative: 'a story' },
          { id: 'SF-0001', kind: 'surface', name: 'a surface' },
          { id: 'C-0001', kind: 'control' },
        ],
      }),
    );
  });

  it('maps every prefix to one journal, and nothing else', () => {
    expect(refJournal(gov, 'D-0001')).toBe(join(gov, 'decisions.json'));
    expect(refJournal(gov, 'I-0001')).toBe(join(gov, 'issues.json'));
    expect(refJournal(gov, 'T-0001')).toBe(join(gov, 'tasks.json'));
    for (const id of ['E-1', 'F-1', 'S-1', 'SF-1', 'C-1']) {
      expect(refJournal(gov, id)).toBe(join(gov, 'design.json'));
    }
    // L- joined on 2026-09-14 (SX-037): an order may cite a work-log entry.
    expect(refJournal(gov, 'L-0001')).toBe(join(gov, 'log.json'));
    expect(refJournal(gov, 'SP-0001')).toBeNull();
  });

  it('resolves each kind from its own field', () => {
    expect(refResolve(gov, 'I-0079')).toBe('duplicate ids');
    expect(refResolve(gov, 'T-0128')).toBe('the lock');
    expect(refResolve(gov, 'E-0001')).toBe('an epic');
    expect(refResolve(gov, 'F-0001')).toBe('a feature');
    expect(refResolve(gov, 'S-0001')).toBe('a story');
    expect(refResolve(gov, 'SF-0001')).toBe('a surface');
    // `(.name // .id)` -- a control with no name renders as its id.
    expect(refResolve(gov, 'C-0001')).toBe('C-0001');
  });

  it('marks a superseded decision so dead law does not read as current law', () => {
    expect(refResolve(gov, 'D-0044')).toBe(
      'mtime is not a tamper signal [SUPERSEDED by D-0090 — read that instead]',
    );
    expect(refResolve(gov, 'D-0090')).toBe('the replacement');
  });

  it('answers UNRESOLVED for a missing id, a missing journal, and a corrupt one', () => {
    expect(refResolve(gov, 'T-9999')).toBe('UNRESOLVED');
    expect(refResolve(join(box, 'nowhere'), 'T-0001')).toBe('UNRESOLVED');
    writeFileSync(join(gov, 'tasks.json'), '{ broken');
    expect(refResolve(gov, 'T-0128')).toBe('UNRESOLVED');
    expect(refResolve(gov, 'L-0001')).toBe('UNRESOLVED');
    expect(refResolve(gov, 'SP-0001')).toBeNull();
  });

  it('refExistsAny is false for an unknown prefix and for a missing journal', () => {
    expect(refExistsAny(gov, 'T-0128')).toBe(true);
    expect(refExistsAny(gov, 'T-9999')).toBe(false);
    expect(refExistsAny(gov, 'L-0001')).toBe(false);
    expect(refExists(join(gov, 'absent.json'), 'T-0128')).toBe(false);
  });

  it('requireTaskRef names the command that creates the task', () => {
    expect(() => requireTaskRef(gov, 'T-0128')).not.toThrow();
    expect(() => requireTaskRef(gov, 'T-9999')).toThrow(
      'task T-9999 not found in governance/tasks.json — create it first: scrumux task new --title ... --check ...',
    );
  });
});

// ---------------------------------------------------------------------------
// The derived-value cache
// ---------------------------------------------------------------------------

describe('the derived-value cache', () => {
  it('a warm read returns exactly what was put', () => {
    const p = seed('issues.json', entries(2));
    const k = cacheKey('openissues', p);
    expect(cacheGet(gov, k)).toBeNull();
    cachePut(gov, k, '7');
    expect(cacheGet(gov, k)).toBe('7');
    expect(existsSync(join(gov, CACHE_DIR_NAME))).toBe(true);
  });

  it('ANY journal change invalidates -- including one scrumux never saw', () => {
    // This is why the key is hashed LIVE and not read out of seals.json: the
    // seal only moves on a scrumux write, so a hand edit would go on serving
    // a stale answer for ever.
    const p = seed('issues.json', entries(2));
    const before = cacheKey('openissues', p);
    cachePut(gov, before, '2');
    writeFileSync(p, jqFormat(entries(3)));
    const after = cacheKey('openissues', p);
    expect(after).not.toBe(before);
    expect(cacheGet(gov, after)).toBeNull();
  });

  it('distinguishes absent from empty, and depends on every named journal', () => {
    const a = join(gov, 'issues.json');
    const b = join(gov, 'log.json');
    const kAbsent = cacheKey('x', a, b);
    writeFileSync(a, '');
    expect(cacheKey('x', a, b)).not.toBe(kAbsent);
    writeFileSync(b, '{}');
    expect(cacheKey('x', a, b)).not.toBe(kAbsent);
    expect(cacheKey('x', a)).not.toBe(cacheKey('y', a));
  });

  it('is disposable -- a removed directory, an empty entry and a corrupt one all miss', () => {
    const p = seed('issues.json', entries(1));
    const k = cacheKey('openissues', p);
    cachePut(gov, k, 'v');
    rmSync(join(gov, CACHE_DIR_NAME), { recursive: true, force: true });
    expect(cacheGet(gov, k)).toBeNull();
    mkdirSync(join(gov, CACHE_DIR_NAME));
    writeFileSync(join(gov, CACHE_DIR_NAME, k), '');
    expect(cacheGet(gov, k)).toBeNull();
    expect(cacheGet(gov, 'deadbeef')).toBeNull();
  });

  it('never fails anything -- an unwritable cache directory is a no-op', () => {
    const p = seed('issues.json', entries(1));
    const k = cacheKey('openissues', p);
    writeFileSync(join(gov, CACHE_DIR_NAME), 'a file where the directory goes');
    expect(() => cachePut(gov, k, 'v')).not.toThrow();
    expect(cacheGet(gov, k)).toBeNull();
  });

  it('is outside the governance/*.json sweep and not in SEALED_JOURNALS', () => {
    expect(CACHE_DIR_NAME.startsWith('.')).toBe(true);
    expect(SEALED_JOURNALS.some((n) => n.includes('cache'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run_with_timeout
// ---------------------------------------------------------------------------

describe('runWithTimeout', () => {
  it('passes the command\'s own exit code through', () => {
    expect(runWithTimeout(5, 'exit 0', { capture: true }).code).toBe(0);
    expect(runWithTimeout(5, 'exit 3', { capture: true }).code).toBe(3);
  });

  it('reports 142 on timeout -- the code the health runner counts as TIMEOUT', () => {
    const r = runWithTimeout(1, 'sleep 5', { capture: true });
    expect(r.code).toBe(142);
    expect(r.timedOut).toBe(true);
  });

  it('does not arm a timer at all for 0 seconds, as perl\'s alarm 0 does not', () => {
    const r = runWithTimeout(0, 'exit 4', { capture: true });
    expect(r.code).toBe(4);
    expect(r.timedOut).toBe(false);
  });

  it('captures and can combine the streams, as the callers\' 2>&1 does', () => {
    const plain = runWithTimeout(5, 'echo out; echo err >&2', { capture: true });
    expect(plain.stdout).toBe('out\n');
    expect(plain.stderr).toBe('err\n');
    const both = runWithTimeout(5, 'echo out; echo err >&2', { capture: true, combine: true });
    expect(both.stdout).toBe('out\nerr\n');
    expect(both.stderr).toBe('');
  });

  it('runs where it is told, with the environment it is given', () => {
    expect(runWithTimeout(5, 'pwd -P', { capture: true, cwd: gov }).stdout.trim()).toBe(realpathSync(gov));
    expect(runWithTimeout(5, 'printf %s "$MARK"', { capture: true, env: { MARK: 'set' } }).stdout).toBe('set');
  });
});

// ---------------------------------------------------------------------------
// The refusal seam and the writer's exit
// ---------------------------------------------------------------------------

describe('refusing', () => {
  it('turns a JournalRefusal into the CLI refusal, verbatim', () => {
    const said: string[] = [];
    const cli = { die: (m: string): never => { said.push(m); throw new Error('exited'); } };
    expect(() => refusing(cli, () => { throw new JournalRefusal('the message'); })).toThrow('exited');
    expect(said).toEqual(['the message']);
  });

  it('lets a real defect through rather than dressing it as a refusal', () => {
    const cli = { die: (): never => { throw new Error('should not be reached'); } };
    expect(() => refusing(cli, () => { throw new TypeError('undefined is not a function'); })).toThrow(TypeError);
  });
});

describe('the writer exit helpers', () => {
  function fake(): { lines: string[]; data: Record<string, JsonValue>; cli: Emitter } {
    const lines: string[] = [];
    const data: Record<string, JsonValue> = {};
    const cli: Emitter = {
      say: (l) => void lines.push(l),
      data: (o) => void Object.assign(data, o),
      emit: (s = ''): never => { lines.push(`EMIT(${s})`); throw new Error('emitted'); },
    };
    return { lines, data, cli };
  }

  it('emitted carries the id on stdout AND as .data.id', () => {
    const { lines, data, cli } = fake();
    expect(() => emitted(cli, 'T-0042')).toThrow('emitted');
    expect(data).toEqual({ id: 'T-0042' });
    expect(lines).toEqual(['T-0042', 'EMIT()']);
  });

  it('beat states where the work is and, optionally, the next move', () => {
    const { lines, cli } = fake();
    beat(cli, 'T-0042 is in_progress.');
    beat(cli, 'T-0042 is in_review.', 'scrumux task verify T-0042');
    expect(lines).toEqual([
      '  T-0042 is in_progress.',
      '  T-0042 is in_review.',
      '  next: scrumux task verify T-0042',
    ]);
  });

  it('attested says the claim is a claim, both sentences', () => {
    const { lines, cli } = fake();
    attested(cli, 'The receipt', 'scrumux task verify T-0042');
    expect(lines[0]).toContain('recorded as ATTESTED — your claim about your own work');
    expect(lines[1]).toBe('  You may initiate verification; you may not be the thing that verifies it.');
    expect(lines[2]).toBe('  next: scrumux task verify T-0042');
  });
});
