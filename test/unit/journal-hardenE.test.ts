/**
 * The journal engine's FAILURE paths -- the ones a differential run can never
 * reach.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM test/differential/journal-engine.test.ts
 * AND FROM test/unit/journal-engine.test.ts. The differential harness proves
 * that bash and TypeScript agree byte-for-byte on stdout, stderr, exit code,
 * `.argv` and post-state -- but it can only compare the two implementations on
 * inputs it can CONSTRUCT, and every case below is one it cannot: a temp file
 * that cannot be written, a `.backups` directory that refuses a copy, a cache
 * entry that is a directory, a shell that cannot start at all, a journal row
 * that is `null`. Those are the branches that only run when the filesystem or
 * the process is already having a bad day, which is precisely when a
 * governance journal must not be lost. `journal-engine.test.ts` covers the
 * refusal WORDING and the guards' ORDER on the happy machine; this one covers
 * what happens when the machine is not happy.
 *
 * THE ORGANISING PRINCIPLE IS P-09: the backup protects the write, it does not
 * gate it. Nearly every assertion here is some form of "this went wrong and the
 * journal was still written correctly, or was still left exactly as it was".
 * A guard that turns a full disk into a lost journal, or a best-effort copy
 * into a refusal, is the failure mode these pin shut.
 *
 * Two things are pinned here that are KNOWN GAPS rather than desired
 * behaviour, and both say so at the site: `runWithTimeout`'s signal table is a
 * SUBSET of the signals a shell can report, and `jqLength` answers 0 for a
 * `.entries` that jq's own `length` would error on. They are pinned so the gap
 * cannot widen unnoticed and so closing it is a deliberate, visible edit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  canonNumber,
  jqDouble,
  jqFormat,
  parsePreservingNumbers,
  RawNumber,
  type JsonValue,
} from '../../src/journal/jqformat.js';
import { JournalRefusal } from '../../src/journal/refusal.js';
import { formatId, nextId } from '../../src/journal/ids.js';
import { appendWithId, ensureFile, writeJson, BACKUP_DIR_NAME, type WriteOptions } from '../../src/journal/write.js';
import {
  govJsonFiles,
  resealOne,
  sealBootstrap,
  sealJournals,
  sealOf,
  SEAL_FILE_NAME,
} from '../../src/journal/seals.js';
import { admissionState, admissionTsv, authorityGuard } from '../../src/journal/guards.js';
import { refResolve } from '../../src/journal/refs.js';
import { cacheGet, cacheKey, cachePut, CACHE_DIR_NAME } from '../../src/journal/cache.js';
import { runWithTimeout } from '../../src/journal/timeout.js';

const TODAY = '2026-09-01';

let box: string;
let gov: string;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'scrumux-hardenE-'));
  gov = join(box, 'governance');
  mkdirSync(gov, { recursive: true });
});

afterEach(() => {
  // A test may have left a read-only directory behind on purpose; make the
  // tree removable again before tearing it down.
  for (const d of [join(gov, BACKUP_DIR_NAME), gov, box]) {
    try {
      chmodSync(d, 0o755);
    } catch {
      // never existed, or already writable
    }
  }
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

/** A path that exists as a symlink and resolves to nothing. */
function dangling(at: string): string {
  symlinkSync(join(box, 'no-such-directory', 'target'), at);
  return at;
}

function backupsOf(name: string): string[] {
  const dir = join(gov, BACKUP_DIR_NAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith(`${name}.`));
}

/** Nothing may be left behind under any name containing `.tmp.`. */
function debris(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes('.tmp.'));
}

// ---------------------------------------------------------------------------
// write.ts -- the write that cannot complete
// ---------------------------------------------------------------------------

describe('writeJson when the filesystem refuses', () => {
  it('(a) lets the TRANSFORM\'s own refusal through verbatim, not dressed as a jq failure', () => {
    // The transform is where a caller's own precondition lives ("T-0009 is
    // already accepted"). Wrapping that in "jq write failed for <path>" would
    // replace a sentence the operator can act on with one naming a filter they
    // never wrote -- and it is one `instanceof` check that keeps them apart.
    const p = seed('tasks.json', entries(2));
    const before = read(p);
    expect(() =>
      writeJson(p, () => {
        throw new JournalRefusal('T-0009 is already accepted — nothing to do');
      }, opts()),
    ).toThrow('T-0009 is already accepted — nothing to do');
    expect(read(p)).toBe(before);
  });

  it('refuses when the temp file cannot be written, and the generation copy is ALREADY taken', () => {
    // The atomic swap writes `<journal>.tmp.<pid>` beside the journal and
    // renames it on. A dangling symlink at that name fails the write the way a
    // full disk or a vanished directory would -- AFTER every guard has passed,
    // which is the only window in which a half-written journal is possible.
    const p = seed('tasks.json', entries(3));
    const before = read(p);
    dangling(`${p}.tmp.${process.pid}`);
    expect(() => writeJson(p, () => entries(9), opts())).toThrow(`cannot move temp file onto ${p}`);
    // NOT A PARTIAL JOURNAL. The rename is what makes the new bytes visible,
    // so a failure before it leaves the previous version whole.
    expect(read(p)).toBe(before);
    // Guard (e) runs BEFORE the swap, so even the write that never landed has
    // left a copy of what was there. Ordering the copy after the rename would
    // have kept nothing on exactly the run that went wrong.
    const kept = backupsOf('tasks.json');
    expect(kept).toHaveLength(1);
    expect(read(join(gov, BACKUP_DIR_NAME, kept[0]!))).toBe(before);
  });

  it('(e) skips the generation copy when .backups cannot be created, and still writes (P-09)', () => {
    const p = seed('tasks.json', entries(1));
    // A FILE where the directory goes: `mkdir -p` cannot resolve it.
    writeFileSync(join(gov, BACKUP_DIR_NAME), 'not a directory');
    const res = writeJson(p, () => entries(2), opts());
    expect(res.backup).toBeNull();
    expect(res.entriesAfter).toBe(2);
    expect(read(p)).toBe(jqFormat(entries(2)));
  });

  it('(e) a .gitignore that cannot be written does not cost the backup', () => {
    const p = seed('tasks.json', entries(1));
    mkdirSync(join(gov, BACKUP_DIR_NAME));
    dangling(join(gov, BACKUP_DIR_NAME, '.gitignore'));
    const res = writeJson(p, () => entries(2), opts());
    // The copy is the point; the ignore rule is a convenience on top of it.
    expect(res.backup).not.toBeNull();
    expect(read(res.backup!)).toBe(jqFormat(entries(1)));
    expect(existsSync(join(gov, BACKUP_DIR_NAME, '.gitignore'))).toBe(false);
  });

  it('(e) skips the copy when the destination cannot be written, and still writes (P-09)', () => {
    const p = seed('tasks.json', entries(1));
    const dir = join(gov, BACKUP_DIR_NAME);
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    const res = writeJson(p, () => entries(2), opts());
    expect(res.backup).toBeNull();
    // THE WRITE IS WHAT MATTERS. A backup step that could refuse the write it
    // exists to protect would have turned the 2026-08-27 incident into a
    // repo that cannot record anything at all.
    expect(res.entriesAfter).toBe(2);
    expect(read(p)).toBe(jqFormat(entries(2)));
    expect(backupsOf('tasks.json')).toEqual([]);
  });
});

describe('the .backups prune ordering', () => {
  /**
   * `ls -t` NEWEST-FIRST WITH THREE TIE-BREAKS, and every one of them is
   * load-bearing on APFS, where five writes inside one millisecond share an
   * mtime. The order is mtime desc, then stamp desc, then the de-collision
   * counter desc (NUMERICALLY: `-10` is newer than `-2`), then name desc.
   * Getting any tier wrong deletes a generation out of the middle, which is
   * exactly the failure that made generation 3 outlive generation 4.
   */
  it('breaks an mtime tie by stamp, then by the de-collision counter, then by name', () => {
    const p = seed('tasks.json', entries(1));
    const dir = join(gov, BACKUP_DIR_NAME);
    mkdirSync(dir);
    // One instant, far in the past, shared by all four planted generations, so
    // the mtime tier cannot separate them and each later tier has to.
    const t0 = 1577836800; // 2020-01-01T00:00:00Z
    const plant = (name: string): string => {
      const f = join(dir, name);
      writeFileSync(f, name);
      utimesSync(f, t0, t0);
      return name;
    };
    const seq2 = plant('tasks.json.20260901-120000.100-2');
    const highName = plant('tasks.json.20260901-120000.999');
    const lowName = plant('tasks.json.20260901-120000.100');
    const oldStamp = plant('tasks.json.20260901-110000.100');

    const fresh = `tasks.json.20260902-130000.${process.pid}`;
    writeJson(p, () => entries(2), opts({
      env: { JOURNAL_BACKUPS: '3' },
      now: () => new Date(2026, 8, 2, 13, 0, 0),
    }));

    const kept = backupsOf('tasks.json').sort();
    // The copy just taken carries the journal's own mtime, which is now, so it
    // wins the FIRST tier outright. Then seq 2 beats seq 1; then among equal
    // seq, `999` beats `100` on the name.
    expect(kept).toEqual([seq2, highName, fresh].sort());
    expect(kept).not.toContain(lowName);
    expect(kept).not.toContain(oldStamp);
  });

  it('skips an entry it cannot stat, and still prunes one whose name it cannot parse', () => {
    const p = seed('tasks.json', entries(1));
    const dir = join(gov, BACKUP_DIR_NAME);
    mkdirSync(dir);
    // The glob is `<journal>.`* by NAME, so anything sharing the prefix is in
    // scope -- including a name this scheme never wrote.
    const odd = join(dir, 'tasks.json.hand-copied-by-someone');
    writeFileSync(odd, 'x');
    utimesSync(odd, 1577836800, 1577836800);
    // A broken symlink is listed by readdir and cannot be stat'd. It must not
    // take the prune down with it -- the prune runs INSIDE a successful write.
    const ghost = join(dir, 'tasks.json.20200101-000000.7');
    dangling(ghost);

    const res = writeJson(p, () => entries(2), opts({
      env: { JOURNAL_BACKUPS: '1' },
      now: () => new Date(2026, 8, 2, 13, 0, 0),
    }));

    expect(res.entriesAfter).toBe(2);
    // The unparseable name sorts as stamp "" -- oldest -- and is pruned.
    expect(existsSync(odd)).toBe(false);
    // The unstattable one never entered the ordering at all, so it survives a
    // prune it was never a candidate for. Silently dropping it would be a
    // delete decided by an exception.
    expect(existsSync(join(dir, 'tasks.json.20200101-000000.7'))).toBe(false);
    expect(readdirSync(dir)).toContain('tasks.json.20200101-000000.7');
    expect(backupsOf('tasks.json')).toContain(`tasks.json.20260902-130000.${process.pid}`);
  });

  it('survives a generation it cannot delete (P-09), leaving the write green', () => {
    const p = seed('tasks.json', entries(1));
    const dir = join(gov, BACKUP_DIR_NAME);
    mkdirSync(dir);
    // A DIRECTORY where a generation should be: it stats, it sorts oldest, it
    // is selected for pruning, and `rm` refuses it.
    const stuck = join(dir, 'tasks.json.20200101-000000.5');
    mkdirSync(stuck);
    utimesSync(stuck, 1577836800, 1577836800);

    const res = writeJson(p, () => entries(2), opts({ env: { JOURNAL_BACKUPS: '1' } }));

    expect(res.entriesAfter).toBe(2);
    expect(res.backup).not.toBeNull();
    expect(existsSync(stuck)).toBe(true);
  });
});

describe('the entry-count guard over a degenerate .entries', () => {
  it('measures a non-array .entries with jq\'s `length`, so the guard still fires', () => {
    // `_wj_before=$(jq '.entries | length' "$f")` runs against the file AS IT
    // IS, and jq's `length` is defined for strings and objects too. A port
    // that answered 0 for anything but an array would silently disarm guard
    // (d) on exactly the corrupted journal that needs it most.
    const p = join(gov, 'decisions.json');

    writeFileSync(p, jqFormat({ entries: 'abcde' }));
    expect(() => writeJson(p, () => entries(2), opts())).toThrow(
      'this would DROP 3 of 5 entries, leaving 2',
    );

    writeFileSync(p, jqFormat({ entries: { a: 'x', b: 'y', c: 'z' } }));
    expect(() => writeJson(p, () => entries(1), opts())).toThrow(
      'this would DROP 2 of 3 entries, leaving 1',
    );
  });

  it('KNOWN GAP: `.entries` as a boolean counts 0 where jq\'s `length` would error', () => {
    // jq: `true | length` is an error, so bash's before-count command
    // substitution comes back empty. Here it is 0, which makes any write an
    // increase. Pinned rather than "fixed" -- byte parity is the contract and
    // no live journal is in this shape -- so that closing the gap has to be a
    // visible edit against a red test.
    const p = join(gov, 'decisions.json');
    writeFileSync(p, jqFormat({ entries: true }));
    const res = writeJson(p, () => entries(0), opts());
    expect(res.entriesBefore).toBe(0);
    expect(res.entriesAfter).toBe(0);
  });
});

describe('the write path with no options supplied', () => {
  it('reads the environment and writes the reseal warning to the real stderr', () => {
    // bash prints this line unconditionally, so the default sink is not an
    // implementation detail: with no `err` the operator must still be told the
    // seal did not move, or the NEXT records check accuses them of tampering.
    const p = seed('tasks.json', entries(1));
    sealJournals(gov, TODAY);
    writeFileSync(join(gov, SEAL_FILE_NAME), '{ not json');

    const said: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let res;
    try {
      // No `env`, no `err`, no `now` -- every default taken.
      res = writeJson(p, () => entries(2), { gov, today: TODAY });
    } finally {
      process.stderr.write = real;
    }
    expect(said.join('')).toContain('could not update the seal for tasks.json');
    expect(said.join('')).toContain('scrumux repair journal tasks.json');
    expect(res.resealWarning).not.toBeNull();
    expect(res.entriesAfter).toBe(2);
  });

  it('appendWithId takes the same defaults and still allocates inside the lock', () => {
    const p = seed('tasks.json', { entries: [{ id: 'T-0001' }, { id: 'T-0007' }] });
    const res = appendWithId(
      p,
      (doc) => ((doc as { entries: { id: JsonValue }[] }).entries ?? []).map((r) => r.id),
      'T',
      (doc, id) => ({ entries: [...(doc as { entries: JsonValue[] }).entries, { id }] }),
      { gov, today: TODAY },
    );
    // MAX+1, not COUNT+1, and re-derived from the document the lock is held
    // over -- not from anything computed before it was taken.
    expect(res.id).toBe('T-0008');
    expect(res.entriesAfter).toBe(3);
  });
});

describe('ensureFile', () => {
  it('dies naming the path when a DIRECTORY is in the way', () => {
    // `[ -f "$1" ]` is a FILE test, so a directory falls through to the write
    // -- which fails, which dies. This is the one place in the module where a
    // filesystem failure is fatal (P-49): a caller that could not seed the
    // journal has nothing to write into.
    const p = join(gov, 'exceptions.json');
    mkdirSync(p);
    expect(() => ensureFile(p, '{"entries": []}')).toThrow(`cannot create ${p}`);
    expect(existsSync(join(p, 'exceptions.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// seals.ts
// ---------------------------------------------------------------------------

describe('govJsonFiles', () => {
  it('answers nothing for a governance directory that is not there', () => {
    // Every sweep that walks the glob calls this first. A throw here would
    // turn "this repo has no governance yet" into a crash.
    expect(govJsonFiles(join(box, 'no-governance-here'))).toEqual([]);
  });

  it('is the shell glob: files only, no dot names, and nothing that will not stat', () => {
    writeFileSync(join(gov, 'tasks.json'), '{}');
    writeFileSync(join(gov, 'notes.txt'), 'x');
    // `*` does not match a leading dot, which is what keeps `.cache/` and
    // `.backups/` out of every sweep by construction.
    writeFileSync(join(gov, '.scratch.json'), '{}');
    mkdirSync(join(gov, 'a-directory.json'));
    dangling(join(gov, 'ghost.json'));
    expect(govJsonFiles(gov)).toEqual(['tasks.json']);
  });
});

describe('sealJournals', () => {
  it('is a no-op when the governance directory does not exist', () => {
    const missing = join(box, 'no-governance-here');
    expect(() => sealJournals(missing, TODAY)).not.toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});

describe('sealBootstrap deciding whether it laundered anything', () => {
  it('ignores a journal that does not parse rather than calling it content', () => {
    // A corrupt file is not evidence that entries existed. Treating it as
    // content would stamp the laundering flag on every repo with one bad file,
    // and the flag is the record of a real event.
    writeFileSync(join(gov, 'tasks.json'), '{"entries":[]}\n');
    writeFileSync(join(gov, 'notes.json'), '{ not json');
    sealBootstrap(gov, TODAY);
    expect(read(join(gov, SEAL_FILE_NAME))).not.toContain('bootstrapped_over_existing_content');
  });

  it('counts a non-array .entries with jq\'s `length`, and a DERIVED file trips the flag', () => {
    // journal-engine.md open question 8, reproduced rather than "fixed": the
    // laundering check enumerates the whole `governance/*.json` glob, NOT
    // SEALED_JOURNALS, so content in a derived index records the baseline as
    // taken over existing content even though that file is never sealed.
    writeFileSync(join(gov, 'code-graph.json'), jqFormat({ entries: { 'src/a.ts': 1, 'src/b.ts': 2 } }));
    sealBootstrap(gov, TODAY);
    const text = read(join(gov, SEAL_FILE_NAME));
    expect(text).toContain(`"bootstrapped_over_existing_content": "${TODAY}"`);
    // ... and it is still not in the seal map, because a derived file is
    // rebuilt on every deploy and its hash can never match again (P-22).
    expect(text).not.toContain('code-graph.json');
  });

  it('counts a STRING .entries by its characters, and a boolean as nothing', () => {
    writeFileSync(join(gov, 'code-graph.json'), jqFormat({ entries: 'abc' }));
    sealBootstrap(gov, TODAY);
    expect(read(join(gov, SEAL_FILE_NAME))).toContain('bootstrapped_over_existing_content');

    rmSync(join(gov, SEAL_FILE_NAME));
    writeFileSync(join(gov, 'code-graph.json'), jqFormat({ entries: true }));
    sealBootstrap(gov, TODAY);
    expect(read(join(gov, SEAL_FILE_NAME))).not.toContain('bootstrapped_over_existing_content');
  });
});

describe('resealOne', () => {
  it('a journal that cannot be hashed is nothing to reseal, not a failure', () => {
    // `_h=$(seal_of "$_f") || return 0`. The write path calls this AFTER the
    // rename, so the only way to be here with no file is that something else
    // removed it -- and reporting that as a seal failure would tell the
    // operator to re-run a write that already succeeded.
    seed('tasks.json', entries(1));
    sealJournals(gov, TODAY);
    const before = read(join(gov, SEAL_FILE_NAME));
    rmSync(join(gov, 'tasks.json'));
    expect(resealOne(gov, join(gov, 'tasks.json'), TODAY, {})).toBeNull();
    expect(read(join(gov, SEAL_FILE_NAME))).toBe(before);
  });

  it('warns, leaves the file alone and cleans up when seals.json is not an object', () => {
    // `.sealed_at = $d` against an array is a jq error -- the `_rs_failed=1`
    // branch. The seal file is NOT repaired here on purpose: a write path is
    // not the surface that decides what a malformed seal file should become.
    const p = seed('tasks.json', entries(1));
    writeFileSync(join(gov, SEAL_FILE_NAME), jqFormat([1, 2]));
    const w = resealOne(gov, p, TODAY, {});
    expect(w).toContain('could not update the seal for tasks.json');
    expect(w).toContain('scrumux repair journal tasks.json');
    expect(read(join(gov, SEAL_FILE_NAME))).toBe(jqFormat([1, 2]));
    expect(debris(gov)).toEqual([]);
  });

  it('creates .journals when the seal file has none, and moves sealed_at', () => {
    const p = seed('tasks.json', entries(1));
    writeFileSync(join(gov, SEAL_FILE_NAME), jqFormat({ sealed_at: '2026-01-01' }));
    expect(resealOne(gov, p, TODAY, {})).toBeNull();
    expect(parsePreservingNumbers(read(join(gov, SEAL_FILE_NAME)))).toEqual({
      sealed_at: TODAY,
      journals: { 'tasks.json': sealOf(p) },
    });
  });
});

// ---------------------------------------------------------------------------
// cache.ts -- "never fails anything" is the whole contract
// ---------------------------------------------------------------------------

describe('the derived-value cache under a hostile directory', () => {
  it('a DIRECTORY in an entry\'s slot is a miss, not a crash', () => {
    const k = cacheKey('openissues', seed('issues.json', entries(1)));
    mkdirSync(join(gov, CACHE_DIR_NAME, k), { recursive: true });
    expect(cacheGet(gov, k)).toBeNull();
  });

  it('a temp path that cannot be written OR removed still stores nothing and throws nothing', () => {
    const k = cacheKey('openissues', seed('issues.json', entries(1)));
    const tmp = join(gov, CACHE_DIR_NAME, `${k}.tmp.${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    // The write fails (EISDIR) and then the cleanup fails too (`rm` refuses a
    // directory). Both are swallowed: a leaked temp file is not an error,
    // because a counter that stops counting to protect a cache is the trade
    // this module exists to refuse.
    expect(() => cachePut(gov, k, 'v')).not.toThrow();
    expect(cacheGet(gov, k)).toBeNull();
    expect(existsSync(tmp)).toBe(true);
  });

  it('a temp path that fails leaving nothing behind is equally silent', () => {
    const k = cacheKey('openlog', seed('log.json', entries(1)));
    mkdirSync(join(gov, CACHE_DIR_NAME), { recursive: true });
    const tmp = dangling(join(gov, CACHE_DIR_NAME, `${k}.tmp.${process.pid}`));
    expect(() => cachePut(gov, k, 'v')).not.toThrow();
    expect(cacheGet(gov, k)).toBeNull();
    expect(existsSync(tmp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// timeout.ts -- the exit-code contract, which is the whole observable surface
// ---------------------------------------------------------------------------

describe('runWithTimeout exit codes', () => {
  it('passes the code through with the streams INHERITED when nothing is captured', () => {
    // bash's callers redirect at the call site; not capturing is the default
    // and must not change the code the health runner reads.
    const r = runWithTimeout(5, 'exit 7');
    expect(r.code).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('reports 128 + the signal for a command killed by something OTHER than the timer', () => {
    // A shell reports 128+n; the health runner counts 142 as TIMEOUT and
    // everything else as a failure, so conflating the two would file a killed
    // check as a slow one.
    const term = runWithTimeout(5, 'kill -s TERM $$; sleep 5', { capture: true });
    expect(term.code).toBe(143);
    expect(term.timedOut).toBe(false);

    const int = runWithTimeout(5, 'kill -s INT $$; sleep 5', { capture: true });
    expect(int.code).toBe(130);
    expect(int.timedOut).toBe(false);
  });

  it('KNOWN GAP: a signal outside the table reports 128, losing the number', () => {
    // SIGNUM is a SUBSET -- SIGXCPU, SIGXFSZ, SIGPROF and friends are absent,
    // so `?? 0` renders them all as a bare 128, which is also what a command
    // that simply exited 128 reports. A health check run under an rlimit is
    // the reachable case. Pinned so the gap cannot widen unnoticed; extending
    // the table is a deliberate edit that turns this test red.
    const r = runWithTimeout(5, 'kill -s XCPU $$; sleep 5', { capture: true });
    expect(r.code).toBe(128);
    expect(r.timedOut).toBe(false);
  });

  it('reports 127 when the shell could not be started at all', () => {
    // `exec @ARGV or exit 127`. A working directory that does not exist is the
    // ordinary way to reach this: a registered health check whose `cwd` was
    // deleted must report "could not run", never "ran and passed".
    const r = runWithTimeout(5, 'exit 0', { capture: true, cwd: join(box, 'no-such-directory') });
    expect(r.code).toBe(127);
    expect(r.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// guards.ts
// ---------------------------------------------------------------------------

describe('authorityGuard', () => {
  it('treats an ABSENT --authority exactly as an empty one', () => {
    // The flag arrives as `string | undefined` from the parser, so "not
    // passed" and "passed empty" must land on the same refusal -- otherwise
    // omitting the flag entirely is the way around the guard.
    expect(() => authorityGuard(gov, undefined, 'accept')).toThrow(
      /accept: --authority is required — direct/,
    );
  });
});

describe('admissionState over a malformed journal', () => {
  it('reads a top-level ARRAY and a non-array .entries as no tasks at all', () => {
    writeFileSync(join(gov, 'tasks.json'), '[1,2]\n');
    expect(admissionState(gov, 'T-0001')).toEqual({
      home: '', cap: 1, same: [], elsewhere: [], elsewhereIds: [],
    });
    writeFileSync(join(gov, 'tasks.json'), jqFormat({ entries: { a: 'x' } }));
    expect(admissionState(gov, 'T-0001').elsewhereIds).toEqual([]);
  });

  it('survives rows that are not objects, and phrases a busy task that has no id', () => {
    writeFileSync(
      join(gov, 'tasks.json'),
      jqFormat({
        entries: [
          null,
          'a string where a row should be',
          [],
          // `status` is not a string: not busy, because `.status == "..."` is
          // false for a number in jq too.
          { id: 'T-0001', status: 5 },
          // Busy, and no id at all -- the shape a hand-edited journal reaches.
          { status: 'in_progress' },
        ],
      }),
    );
    writeFileSync(
      join(gov, 'sprints.json'),
      jqFormat({
        entries: [
          null,
          // `tasks` is a string, not an array: it lists nothing.
          { id: 'SP-0001', status: 'ratified', tasks: 'T-0001' },
        ],
      }),
    );
    const s = admissionState(gov, 'T-0002');
    expect(s.home).toBe('');
    expect(s.cap).toBe(1);
    expect(s.same).toEqual([]);
    expect(s.elsewhere).toEqual([' is in no ratified sprint']);
    expect(s.elsewhereIds).toEqual(['']);
    // The four callers word-split this line, so the exact field layout is the
    // contract even when the data is nonsense.
    expect(admissionTsv(s)).toBe('\t1\t\t0\t is in no ratified sprint\t');
  });

  it('a ratified sprint with no id is NO home, and a non-numeric cap is not a cap', () => {
    writeFileSync(join(gov, 'tasks.json'), jqFormat({ entries: [{ id: 'T-0007', status: 'proposed' }] }));
    writeFileSync(
      join(gov, 'sprints.json'),
      jqFormat({
        entries: [
          // Ratified and lists the task, but has no id to BE a home.
          { status: 'ratified', tasks: ['T-0007'] },
        ],
      }),
    );
    expect(admissionState(gov, 'T-0007').home).toBe('');
    expect(admissionState(gov, 'T-0007').cap).toBe(1);

    writeFileSync(
      join(gov, 'sprints.json'),
      jqFormat({ entries: [{ id: 'SP-0002', status: 'ratified', parallel: 'lots', tasks: ['T-0007'] }] }),
    );
    const s = admissionState(gov, 'T-0007');
    expect(s.home).toBe('SP-0002');
    // FAIL SMALL. A cap that cannot be read is 1, never unlimited: the guard
    // is the thing that keeps a person able to say what is in flight.
    expect(s.cap).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ids.ts
// ---------------------------------------------------------------------------

describe('nextId over values ltrimstr never produced', () => {
  it('refuses a non-scalar id instead of skipping it', () => {
    // Skipping it would silently lower the max and re-issue a live id -- the
    // I-0079 outcome by a different route. D-0085/OQ-7 rules that the
    // allocator refuses.
    for (const bad of [true, [] as JsonValue, {} as JsonValue]) {
      expect(() => nextId([bad], 'T', 'tasks.json')).toThrow(/whose suffix is not a number/);
    }
    expect(() => nextId([true], 'T', 'tasks.json')).toThrow(/scrumux repair journal tasks\.json/);
  });

  it('accepts a plain numeric id, as `ltrimstr | tonumber` does', () => {
    expect(nextId([12, 'T-0003'], 'T')).toBe('T-0013');
  });

  it('refuses a numeric id that is not finite rather than formatting an infinity', () => {
    // `%04d` of an infinity is not an id. Without the finiteness check the max
    // becomes Infinity and the allocator hands back `T-Infinity`.
    expect(() => nextId([new RawNumber('1e999')], 'T', 'tasks.json')).toThrow(
      /whose suffix is not a number/,
    );
  });
});

// ---------------------------------------------------------------------------
// refs.ts
// ---------------------------------------------------------------------------

describe('refResolve over rows a hand edit can produce', () => {
  it('renders a non-string title the way `jq -r` renders a boolean', () => {
    writeFileSync(join(gov, 'decisions.json'), jqFormat({ entries: [{ id: 'D-0001', title: true }] }));
    expect(refResolve(gov, 'D-0001')).toBe('true');
  });

  it('a supersession row with no id of its own produces NO marker', () => {
    // The marker names the replacement so a reader can go there. Emitting
    // "[SUPERSEDED by  — read that instead]" would retire a ruling and point
    // at nothing, which is worse than not marking it.
    writeFileSync(
      join(gov, 'decisions.json'),
      jqFormat({
        entries: [
          { id: 'D-0001', title: 'the ruling' },
          { id: null, supersedes: 'D-0001' },
        ],
      }),
    );
    expect(refResolve(gov, 'D-0001')).toBe('the ruling');
  });

  it('`//` swallows a FALSE name, and a null row resolves nothing', () => {
    writeFileSync(
      join(gov, 'design.json'),
      jqFormat({ entries: [null, { id: 'C-0002', kind: 'control', name: false }] }),
    );
    // `(.name // .id)` -- jq's alternative operator takes the right side for
    // null AND for false, which is why lib.sh's own style note forbids it on a
    // boolean field.
    expect(refResolve(gov, 'C-0002')).toBe('C-0002');
    expect(refResolve(gov, 'C-9999')).toBe('UNRESOLVED');
  });

  it('a top-level ARRAY journal resolves nothing rather than throwing', () => {
    writeFileSync(join(gov, 'tasks.json'), '[{"id":"T-0001"}]\n');
    expect(refResolve(gov, 'T-0001')).toBe('UNRESOLVED');
  });
});

// ---------------------------------------------------------------------------
// jqformat.ts -- the number renderers, against jq 1.7.1's measured output
// ---------------------------------------------------------------------------

describe('jqDouble renders a COMPUTED number as jvp_dtoa_fmt does', () => {
  it('matches jq for the shapes around every branch of the format rule', () => {
    // Each expectation below was taken from `jq -n <expr>` on jq-1.7.1:
    // `nan`, `infinite`, `-(infinite)`, `0.0*-1`, `3/2`, `1/2`, `1/8`,
    // `100000/1000`, `123456789/1`, `1e-4+0`, `0.00001+0`, `1e15+0`,
    // `1e16+0`, `1e30+0`.
    expect(jqDouble(NaN)).toBe('null');
    expect(jqDouble(Infinity)).toBe('1.7976931348623157e+308');
    expect(jqDouble(-Infinity)).toBe('-1.7976931348623157e+308');
    expect(jqDouble(0)).toBe('0');
    expect(jqDouble(-0)).toBe('-0');
    expect(jqDouble(1.5)).toBe('1.5');
    expect(jqDouble(0.5)).toBe('0.5');
    expect(jqDouble(0.125)).toBe('0.125');
    expect(jqDouble(100)).toBe('100');
    expect(jqDouble(123456789)).toBe('123456789');
    expect(jqDouble(1e-4)).toBe('0.0001');
    // decpt <= -4 crosses into exponential, and the exponent is zero-padded to
    // two digits -- `1e-05`, never `1e-5`.
    expect(jqDouble(1e-5)).toBe('1e-05');
    expect(jqDouble(1e15)).toBe('1000000000000000');
    expect(jqDouble(1e16)).toBe('1e+16');
    expect(jqDouble(1e30)).toBe('1e+30');
  });
});

describe('canonNumber renders a PRESERVED literal as decNumber does', () => {
  it('keeps the digits it was given, and only goes scientific when the rule says to', () => {
    // Taken from `echo '{"a":...}' | jq .` on jq-1.7.1, which re-emits a
    // literal it did not modify: `1.50`, `9E+9`, `1e3`, `1e-7`, `-0.0`.
    expect(canonNumber('1.50')).toBe('1.50');
    expect(canonNumber('-0.0')).toBe('-0.0');
    expect(canonNumber('9E+9')).toBe('9E+9');
    expect(canonNumber('1e3')).toBe('1E+3');
    expect(canonNumber('1e-7')).toBe('1E-7');
    // Not a number at all: handed back untouched rather than mangled, because
    // the parser is what refuses malformed input, not the renderer.
    expect(canonNumber('not-a-number')).toBe('not-a-number');
  });

  it('is what jqFormat emits, so a rewrite of an untouched journal is byte-identical', () => {
    const src = '{\n  "entries": [\n    {\n      "a": 1.50,\n      "b": 9E+9\n    }\n  ]\n}\n';
    expect(jqFormat(parsePreservingNumbers(src))).toBe(src);
  });
});

describe('RawNumber', () => {
  it('is a NUMBER to JSON.stringify, so a literal never leaks as an object', () => {
    // The literal survives inside the harness; anything crossing into
    // `JSON.stringify` -- the --json envelope among them -- gets the value.
    expect(JSON.stringify({ rank: new RawNumber('1.50') })).toBe('{"rank":1.5}');
    // ... and a NUMBER to arithmetic, which is what lets a rank sort against a
    // plain one without either side knowing which it holds.
    expect(Number(new RawNumber('12'))).toBe(12);
  });
});
