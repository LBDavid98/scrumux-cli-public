/**
 * The four shell file tests, asked the questions `sh` would ask.
 *
 * WHY THIS FILE EXISTS AT ALL, given that every noun uses these and the whole
 * suite therefore runs them thousands of times. Incidental traffic proves the
 * TRUE arms and nothing else: the callers ask `isFile(journal)` about journals
 * they just wrote, so the interesting half — the `catch` — is reached by
 * accident or not at all. `src/util/fs-predicates.ts` says in as many words
 * that "THE `try`/`catch` IS THE WHOLE POINT, and it is not defensive
 * padding", and until now nothing in the repo held it to that. It sat at 77%
 * lines and 75% functions, entirely on the strength of being called a lot.
 *
 * THE SPEC IS `sh`, NOT NODE, so every case below is stated as the shell test
 * it ports:
 *
 *   `[ -f p ]` is FALSE for a path that does not exist, for a path whose
 *   PARENT is not a directory, for a DANGLING SYMLINK, and for a path the
 *   process may not stat. `statSync` THROWS for every one of those, so a
 *   missing catch would turn four shell falsehoods into four crashes — in a
 *   predicate the payload roster walks whole trees with.
 *
 * AND THE ONE DISTINCTION THAT IS LOAD-BEARING. `isExecutable` (`accessSync`,
 * the EFFECTIVE permission) and `isExecutableFile` (the MODE BIT) are
 * deliberately two functions, and the file's own comment says they "must not
 * be collapsed": `harness verify`'s hooks-executable check asks what the
 * install WROTE, which must not change with who is asking, while `task brief`
 * asks what this process can actually run. The pair is asserted disagreeing
 * below, on a directory — the cheapest input on which they legitimately
 * differ — because a collapse would otherwise pass every other test here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isDir, isExecutable, isExecutableFile, isFile } from '../../src/util/fs-predicates.js';

let D = '';

// Named so the assertions below read as the shell tests they port.
let plainFile = '';
let dir = '';
let missing = '';
let underAFile = '';
let dangling = '';
let linkToFile = '';
let linkToDir = '';
let mode0644 = '';
let mode0755 = '';
let groupOnlyExec = '';

beforeAll(() => {
  D = mkdtempSync(join(tmpdir(), 'scrumux-fspred-'));
  plainFile = join(D, 'plain');
  writeFileSync(plainFile, 'x');
  dir = join(D, 'adir');
  mkdirSync(dir);
  missing = join(D, 'nope');
  // A path whose PARENT is a regular file. `sh` says false; `statSync` throws
  // ENOTDIR, which is a different error from ENOENT and reaches the same catch.
  underAFile = join(plainFile, 'child');
  dangling = join(D, 'dangling');
  symlinkSync(join(D, 'does-not-exist'), dangling);
  linkToFile = join(D, 'link-to-file');
  symlinkSync(plainFile, linkToFile);
  linkToDir = join(D, 'link-to-dir');
  symlinkSync(dir, linkToDir);
  mode0644 = join(D, 'm0644');
  writeFileSync(mode0644, 'x');
  chmodSync(mode0644, 0o644);
  mode0755 = join(D, 'm0755');
  writeFileSync(mode0755, 'x');
  chmodSync(mode0755, 0o755);
  // 0o010 — the GROUP execute bit and nothing else. `[ -x ]` for root reduces
  // to "any of the three bits", which is what `isExecutableFile` implements
  // and what bash's own hooks-executable check meant.
  groupOnlyExec = join(D, 'm0610');
  writeFileSync(groupOnlyExec, 'x');
  chmodSync(groupOnlyExec, 0o610);
});

afterAll(() => {
  if (D !== '') rmSync(D, { recursive: true, force: true });
});

describe('isFile — `[ -f p ]`', () => {
  it('is true for a regular file and false for a directory', () => {
    expect(isFile(plainFile)).toBe(true);
    expect(isFile(dir)).toBe(false);
  });

  it('FOLLOWS SYMLINKS, because `[ -f ]` does (statSync, never lstatSync)', () => {
    expect(isFile(linkToFile)).toBe(true);
    expect(isFile(linkToDir)).toBe(false);
  });

  it('answers FALSE rather than throwing on every path `statSync` refuses', () => {
    // The four the header names. Each reaches the catch by a different errno,
    // and a predicate that threw on any of them would abort a roster walk.
    expect(isFile(missing), 'ENOENT').toBe(false);
    expect(isFile(underAFile), 'ENOTDIR — the parent is a regular file').toBe(false);
    expect(isFile(dangling), 'a dangling symlink').toBe(false);
    expect(isFile('')).toBe(false);
  });
});

describe('isDir — `[ -d p ]`', () => {
  it('is true for a directory and false for a regular file', () => {
    expect(isDir(dir)).toBe(true);
    expect(isDir(plainFile)).toBe(false);
  });

  it('follows a symlink to a directory', () => {
    expect(isDir(linkToDir)).toBe(true);
    expect(isDir(linkToFile)).toBe(false);
  });

  it('answers FALSE rather than throwing', () => {
    expect(isDir(missing)).toBe(false);
    expect(isDir(underAFile)).toBe(false);
    expect(isDir(dangling)).toBe(false);
  });
});

describe('isExecutable — `[ -x p ]`, the EFFECTIVE permission', () => {
  it('is true for a 0755 file and false for a 0644 one', () => {
    expect(isExecutable(mode0755)).toBe(true);
    expect(isExecutable(mode0644)).toBe(false);
  });

  it('answers FALSE rather than throwing when the path cannot be reached', () => {
    // `accessSync` throws ENOENT here, and the shell's `-x` is simply false.
    expect(isExecutable(missing)).toBe(false);
    expect(isExecutable(underAFile)).toBe(false);
    expect(isExecutable(dangling)).toBe(false);
  });
});

describe('isExecutableFile — `[ -f p ] && [ -x p ]` BY MODE BIT', () => {
  it('is true for a 0755 file and false for a 0644 one', () => {
    expect(isExecutableFile(mode0755)).toBe(true);
    expect(isExecutableFile(mode0644)).toBe(false);
  });

  it('reads ANY of the three execute bits, not the owner\'s', () => {
    // 0o610: the owner cannot execute it, the group can. `[ -x ]` for root
    // reduces to "any bit", which is the question `harness verify` is asking
    // about a hook it installed — not "can I, right now".
    expect(isExecutableFile(groupOnlyExec)).toBe(true);
  });

  it('is FALSE for a directory, which is the whole `-f` half of the test', () => {
    // A directory carries every execute bit and is not an executable file. A
    // version that dropped `st.isFile() &&` would report the hooks DIRECTORY
    // as an installed hook.
    expect(isExecutableFile(dir)).toBe(false);
  });

  it('answers FALSE rather than throwing', () => {
    expect(isExecutableFile(missing)).toBe(false);
    expect(isExecutableFile(underAFile)).toBe(false);
    expect(isExecutableFile(dangling)).toBe(false);
  });
});

describe('the two executable predicates are NOT the same question', () => {
  it('disagree on a directory, which is why they may never be collapsed', () => {
    // `accessSync(dir, X_OK)` succeeds — a directory's execute bit means
    // "traversable" and the process has it — while `isExecutableFile` says no
    // because it is not a file. Collapsing the pair would either report the
    // hooks directory as an installed hook, or make `harness verify`'s answer
    // depend on the mount and the sandbox rather than on what it wrote.
    expect(isExecutable(dir)).toBe(true);
    expect(isExecutableFile(dir)).toBe(false);
  });

  it('agree on the two file cases, so the difference is narrow and stated', () => {
    for (const p of [mode0755, mode0644]) {
      expect(isExecutable(p)).toBe(isExecutableFile(p));
    }
  });
});
