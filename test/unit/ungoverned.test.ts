/**
 * The self-governance guard (RULINGS.md R-001), at the anchor
 * `test/unit/dispatch.test.ts:26` cites.
 *
 * THAT CITATION WAS DANGLING. dispatch.test.ts says, of the reason every case
 * in it aims ROOT at a scratch directory: "The guard has its own file and its
 * own tests (`test/unit/ungoverned.test.ts`); these are about the dispatcher."
 * The first half was true and the second was not — there was no such file, and
 * `refusalMessage` was reached by nothing in the TypeScript suite at all.
 * Written in Harden E, alongside the same repair to R-003's citation, because
 * a pointer at an anchor that does not exist is worse than no pointer: it
 * reads as coverage.
 *
 * WHY THE GAP MATTERED MORE THAN ITS SIZE. This is the guard that makes THIS
 * REPO safe to work in. `scrumux-cli` carries the marker, so every session
 * here meets it, and R-001 is explicit that the CLI "enforces this rather than
 * asking for it, because nothing an agent reads can be relied on to hold".
 * `tests/ungoverned-repo-tests.sh` (87 assertions) drives the real CLI end to
 * end; this file is the unit tier.
 *
 * EVERY REFUSAL CLAUSE WAS COMPARED AGAINST BASH RATHER THAN RETYPED, until
 * bash was retired (2026-09-03): the text lived in
 * `.deploy-claude/scripts/scrumux` as one long `die` string, and this file
 * extracted the port's message and asserted the clauses against the SHELL
 * SOURCE, so a wording drift on either side went red here. With one
 * implementation left, the clause list itself — what R-001 requires — is
 * what the test still pins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  UNGOVERNED_ALLOWED_NOUNS,
  findMarker,
  isAllowed,
  refusalMessage,
} from '../../src/cli/ungoverned.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');

let D = '';
beforeAll(() => { D = mkdtempSync(join(tmpdir(), 'scrumux-ungov-')); });
afterAll(() => { if (D !== '') rmSync(D, { recursive: true, force: true }); });

describe('findMarker — the walk up, which is not optional', () => {
  it('finds a marker two directories above the cwd, because that is the same repo', () => {
    const root = join(D, 'repo-a');
    const deep = join(root, 'src', 'nested');
    mkdirSync(deep, { recursive: true });
    const marker = join(root, '.scrumux-ungoverned');
    writeFileSync(marker, 'builds the harness\n');
    expect(findMarker(deep)).toBe(marker);
    expect(findMarker(root)).toBe(marker);
  });

  it('returns null when no ancestor carries one, walking all the way to `/`', () => {
    // An infinite loop in a guard that runs before every verb is not a defect
    // anyone debugs twice, so the terminating walk is exercised rather than
    // assumed. The real filesystem root has no marker, so this goes the
    // distance and comes back empty.
    const root = join(D, 'repo-b', 'a', 'b');
    mkdirSync(root, { recursive: true });
    expect(findMarker(root)).toBe(null);
  });

  it('handles a RELATIVE root, whose walk terminates at `.` rather than `/`', () => {
    // `dirname('.')` is `.`, so the same loop ends by a different route. The
    // dispatcher is handed `process.cwd()` today; the second terminator is in
    // the code because a relative root is what a caller passing `'.'` gets,
    // and an unproven terminator in a hot guard is a hang waiting for a
    // caller. Vitest runs with the checkout as cwd, and the checkout carries
    // the marker — so the relative form resolves at the first step and the
    // path comes back RELATIVE, which is the observable half.
    expect(findMarker('.')).toBe(join('.', '.scrumux-ungoverned'));
  });

  it('THIS checkout carries one — the ruling is enforced, not described', () => {
    // R-001: "The marker is COMMITTED, not local: one that a clone does not
    // receive protects a single working copy and lets the next clone govern
    // itself." So it is asserted against the real tree, not a fixture.
    expect(findMarker(CHECKOUT)).toBe(join(CHECKOUT, '.scrumux-ungoverned'));
  });
});

describe('isAllowed — DEFAULT-DENY, and the list is the allow list', () => {
  it('permits exactly the delivery and read-only nouns', () => {
    // The parity check this had against the SHELL SOURCE retired with bash
    // (2026-09-03) — `UNGOVERNED_ALLOWED_NOUNS` is the sole declaration now.
    for (const n of UNGOVERNED_ALLOWED_NOUNS.split(' ')) {
      expect(isAllowed(n, 'check'), n).toBe(true);
    }
  });

  it('REFUSES every record-writing noun, including ones added later', () => {
    // Default-deny is the contract, not the current list: a noun absent from
    // the allow list is blocked without anyone remembering to block it. The
    // last entry is deliberately not a real noun — a guard that answered only
    // about nouns it knows would be a deny list wearing an allow list's name.
    for (const n of ['task', 'sprint', 'decide', 'issue', 'epic', 'story', 'log',
      'secret', 'memory', 'repair', 'rank', 'feature', 'health', 'exception',
      'session', 'views', 'a-noun-invented-in-a-later-phase']) {
      expect(isAllowed(n, 'new'), n).toBe(false);
    }
  });

  it('always answers help and version, whatever the noun', () => {
    for (const n of ['help', '-h', '--help', 'version', '--version']) {
      expect(isAllowed(n, ''), n).toBe(true);
    }
    // `<noun> help` prints usage and writes nothing. A refusal that also hid
    // the manual would teach the reader less than the manual does.
    for (const v of ['help', '-h', '--help']) {
      expect(isAllowed('task', v), `task ${v}`).toBe(true);
    }
    // …and only those three verbs. `task new` is still refused above.
    expect(isAllowed('task', 'helper')).toBe(false);
  });
});

describe('refusalMessage — every clause R-001 requires', () => {
  it('carries the six clauses R-001 says are load-bearing', () => {
    // The cross-check this had against bash's shell source retired with bash
    // (2026-09-03); the clause list itself is what R-001 requires and is
    // unaffected by which side prints it.
    const marker = join(D, 'm1');
    writeFileSync(marker, 'builds the harness\n');
    const msg = refusalMessage('task new', marker);
    for (const clause of [
      "writes records or runs the governed workflow — refused.",
      'Why: this repo BUILDS scrumux, so it must exist OUTSIDE the harness.',
      'the next session reads them as settled law.',
      'Rulings for this repo go directly in RULINGS.md at the repo root.',
      'This refusal is working as intended. It is not a wall to route around.',
    ]) {
      expect(msg, `the port dropped: ${clause}`).toContain(clause);
    }
    // The COMMAND and the MARKER PATH are the two runtime values.
    expect(msg).toContain("'task new'");
    expect(msg).toContain(`The marker: ${marker}`);
    // …and the list of what still works is the same string `isAllowed` reads.
    expect(msg).toContain(`Still available: ${UNGOVERNED_ALLOWED_NOUNS}, plus help and version.`);
  });

  it('quotes the marker\'s FIRST LINE and only the first', () => {
    // bash reads it with `sed -n '1p'`.
    const marker = join(D, 'm2');
    writeFileSync(marker, 'this repo builds scrumux\nand a second line nobody prints\n');
    const msg = refusalMessage('decide new', marker);
    expect(msg).toContain(`The marker: ${marker} — "this repo builds scrumux"`);
    expect(msg).not.toContain('nobody prints');
  });

  it('OMITS the quoted clause entirely when there is no first line', () => {
    // `${_ug_why:+ — "$_ug_why"}` drops the whole expansion on an empty value,
    // so an empty marker must not print an empty pair of quotes. Three ways to
    // get there: an empty file, a file that is only a newline, and a path that
    // cannot be read at all (bash's `sed … 2>/dev/null` prints nothing).
    const empty = join(D, 'm3');
    writeFileSync(empty, '');
    const onlyNewline = join(D, 'm4');
    writeFileSync(onlyNewline, '\n');
    const gone = join(D, 'does-not-exist');
    for (const m of [empty, onlyNewline, gone]) {
      const msg = refusalMessage('task new', m);
      expect(msg, m).toContain(`The marker: ${m}\n`);
      expect(msg, m).not.toContain('""');
      expect(msg, m).not.toContain('— "');
    }
  });

  it('the marker THIS repo carries produces a message naming this repo\'s reason', () => {
    // End to end on the real file, because a fixture cannot show that the
    // committed marker actually has a first line to quote.
    const marker = findMarker(CHECKOUT)!;
    const why = readFileSync(marker, 'utf8').split('\n')[0] ?? '';
    expect(why, 'the committed marker lost its one-line reason').not.toBe('');
    expect(refusalMessage('sprint new', marker)).toContain(`— "${why}"`);
  });
});
