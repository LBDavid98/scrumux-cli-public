import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJournal, journalUnreadable } from '../../src/journal/read.js';
import { RawNumber } from '../../src/journal/jqformat.js';

/**
 * The tri-state read, at its edges. ABSENT IS NOT UNREADABLE, and collapsing
 * the two has shipped four times (I-0078, I-0083, T-0156, I-0102) — each time
 * because a bare read handed the caller an EMPTY string, which then rendered
 * as "(no open tasks)" or a session brief whose counts were silently wrong.
 */
describe('readJournal', () => {
  const d = mkdtempSync(join(tmpdir(), 'read-'));
  // A hook, not an `it`. Cleanup dressed as a test inflates the count with an
  // assertion that cannot fail -- and a suite's tally is what the parity
  // runner reads to decide a run happened at all.
  afterAll(() => { rmSync(d, { recursive: true, force: true }); });

  it('a path that is a DIRECTORY is unreadable, not absent and not ok', () => {
    // The readFileSync failure arm, which is separate from the parse arm: a
    // repo whose governance/tasks.json is somehow a directory has a problem,
    // and "absent" would be a lie about it.
    const p = join(d, 'as-a-dir.json');
    mkdirSync(p, { recursive: true });
    const r = readJournal(p);
    expect(r.kind).toBe('unreadable');
    if (r.kind === 'unreadable') expect(r.error.length).toBeGreaterThan(0);
  });

  it('an unreadable-by-permission file is unreadable', () => {
    const p = join(d, 'no-read.json');
    writeFileSync(p, '{"entries":[]}\n');
    chmodSync(p, 0o000);
    const r = readJournal(p);
    // Running as root would read it anyway; assert only that it is never
    // silently "absent", which is the collapse that matters.
    expect(r.kind === 'unreadable' || r.kind === 'ok').toBe(true);
    chmodSync(p, 0o644);
  });

  it('absence yields the DEFAULT at kind "absent", never an error', () => {
    // A fresh repo is in this state. ensure_file repairs absence at the WRITE
    // path, not the read path.
    const r = readJournal(join(d, 'not-there.json'));
    expect(r.kind).toBe('absent');
    if (r.kind === 'absent') expect(r.value).toEqual({ entries: [] });
  });

  it('honours a caller-supplied default', () => {
    const r = readJournal(join(d, 'nope.json'), '{"journals":{}}');
    expect(r.kind).toBe('absent');
    if (r.kind === 'absent') expect(r.value).toEqual({ journals: {} });
  });

  it('a readable journal keeps its raw bytes and its number literals', () => {
    const p = join(d, 'ok.json');
    writeFileSync(p, '{"entries": [], "n": 1.10}\n');
    const r = readJournal(p);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.raw).toBe('{"entries": [], "n": 1.10}\n');
      // jq preserves an unmodified literal; JSON.parse would give 1.1.
      const v = r.value as Record<string, RawNumber | undefined>;
      expect(v.n).toBeInstanceOf(RawNumber);
      expect(v.n!.text).toBe('1.10');
    }
  });

  it('the refusal names the file AND the two repairs', () => {
    // Article 5: one wording, so every caller says the same thing and names
    // the same fix. backlog-tests and error-shape-tests grep for exactly this.
    const m = journalUnreadable('/anywhere/governance/tasks.json');
    expect(m).toContain('governance/tasks.json is not valid JSON');
    expect(m).toContain('restore it from git');
    expect(m).toContain('scrumux repair journal tasks.json');
  });
});
