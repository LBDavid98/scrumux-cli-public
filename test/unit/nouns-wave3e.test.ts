/**
 * Unit cover for Wave 3E -- the seven simple write nouns and the two helpers
 * they stand on.
 *
 * THE DIFFERENTIAL IS THE GATE, not this file. `test/fixtures/tier2-wave3e.mjs`
 * proves these modules and bash agree byte for byte, in both modes, including
 * the journal bytes and the seal state. What is here is the two things a
 * fixture cannot reach:
 *
 *   1. THE PATH DERIVATION, which needs a repo whose path goes through a
 *      symlink. The differential materialises every case under `realpathSync`
 *      -- deliberately, so the two sides are symmetric -- so the one divergence
 *      this wave repaired is invisible to it by construction.
 *   2. THE jq EDGES, where the shape that would break is a hand-damaged
 *      journal (`.entries` a string, the document an array) and building a
 *      fixture for each would be a fixture per line of a four-line function.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { RawNumber, jqFormat, parsePreservingNumbers } from '../../src/journal/jqformat.js';
import {
  defaultScriptsDir, logicalDirOf, nounContext, todayStamp,
  type DispatchContext, type NounContext,
} from '../../src/nouns/lib/context.js';
import { appendEntry, mapEntries, shellWords, warnReseal } from '../../src/nouns/lib/writers.js';
import { decideEntry, parseDecideFlags, MODULE as decide } from '../../src/nouns/decide.js';
import { nextFeatures, parseEpicUpdateFlags, MODULE as epic } from '../../src/nouns/epic.js';
import { parseFeatureFlags } from '../../src/nouns/feature.js';
import { parseStoryFlags } from '../../src/nouns/story.js';
import { logEntry, parseLogFlags, MODULE as log } from '../../src/nouns/log.js';
import { healthEntry, parseHealthFlags, MODULE as health } from '../../src/nouns/health.js';
import {
  MEMORY_HEADER, blockLineCount, runMemoryAdd, stripTrailingNewlines, MODULE as memory,
} from '../../src/nouns/memory.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'scrumux-w3e-'));
}

function nctx(root: string, env: NodeJS.ProcessEnv = {}): NounContext {
  return nounContext({
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: '2026-09-01',
    io: captureIo(),
    scriptsDir: SCRIPTS,
    env,
    cwd: root,
  });
}

function dctx(root: string, io: CapturedIo, env: NodeJS.ProcessEnv = {}): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: '2026-09-01',
    io,
    scriptsDir: SCRIPTS,
    env,
    cwd: root,
  };
}

interface Driven { io: CapturedIo; rc: number }

function drive(
  mod: { run(cli: Cli, ctx: DispatchContext, verb: string, args: readonly string[]): never },
  root: string,
  verb: string,
  args: string[],
  json = false,
  env: NodeJS.ProcessEnv = {},
): Driven {
  const io = captureIo();
  const cli = new Cli(verb, args, json, io);
  let rc = 0;
  try {
    mod.run(cli, dctx(root, io, env), verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

const seedGov = (root: string, files: Record<string, string>): void => {
  mkdirSync(join(root, 'governance'), { recursive: true });
  for (const [n, text] of Object.entries(files)) writeFileSync(join(root, 'governance', n), text);
};

const read = (root: string, name: string): string => readFileSync(join(root, 'governance', name), 'utf8');

// -------------------------------------------------------- the path repair --

describe('$SCRIPTS is derived LOGICALLY, the way bash derives it', () => {
  it('does not realpath -- an intermediate symlinked directory survives', () => {
    // THE MEASURED DIVERGENCE. Node's ESM loader realpaths the module it
    // loads, so `import.meta.url` is the physical path; on macOS `/var` is a
    // symlink to `/private/var`, and a harness deployed under `mktemp -d`
    // therefore printed `/private/var/.../.venv` where bash printed
    // `/var/.../.venv` in the SAME refusal (records check, no python3).
    const real = scratch();
    const box = scratch();
    const link = join(box, 'link');
    symlinkSync(real, link);
    mkdirSync(join(real, '.claude/dist'), { recursive: true });
    writeFileSync(join(real, '.claude/dist/scrumux.mjs'), '');

    expect(logicalDirOf(join(link, '.claude/dist/scrumux.mjs')))
      .toBe(join(link, '.claude/dist'));
    expect(defaultScriptsDir(['node', join(link, '.claude/dist/scrumux.mjs')]))
      .toBe(join(link, '.claude/scripts'));

    rmSync(real, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
  });

  it('DOES follow a symlink whose final component is the link, as `while [ -L ]` does', () => {
    // The `scrumux` on PATH case: one file symlinked into a bin directory
    // that holds no harness. bash reads the link and starts again; so does
    // this, and the answer is the real harness rather than the bin dir.
    const d = scratch();
    mkdirSync(join(d, '.claude/dist'), { recursive: true });
    writeFileSync(join(d, '.claude/dist/scrumux.mjs'), '');
    mkdirSync(join(d, 'bin'), { recursive: true });
    symlinkSync(join(d, '.claude/dist/scrumux.mjs'), join(d, 'bin/scrumux'));

    expect(logicalDirOf(join(d, 'bin/scrumux'))).toBe(join(d, '.claude/dist'));
    rmSync(d, { recursive: true, force: true });
  });

  it('resolves a RELATIVE link against the link\'s own directory, not the cwd', () => {
    const d = scratch();
    mkdirSync(join(d, 'a'), { recursive: true });
    mkdirSync(join(d, 'b'), { recursive: true });
    writeFileSync(join(d, 'b/real.mjs'), '');
    symlinkSync('../b/real.mjs', join(d, 'a/link.mjs'));
    expect(logicalDirOf(join(d, 'a/link.mjs'), '/')).toBe(join(d, 'b'));
    rmSync(d, { recursive: true, force: true });
  });

  it('collapses dot-dot LEXICALLY, which is what `cd -L` does', () => {
    // The shim execs `node "$(cd "$(dirname "$0")" && pwd)/../dist/<file>"`,
    // so a `..` component in the entry path is ordinary rather than exotic.
    expect(logicalDirOf('/x/.claude/scripts/../dist/scrumux.mjs')).toBe('/x/.claude/dist');
  });

  it('answers for a path that does not exist -- `[ -L ]` on one is false', () => {
    expect(logicalDirOf('/nowhere/at/all/scrumux.mjs')).toBe('/nowhere/at/all');
  });

  it('falls back to the module\'s own location when there is no entry path', () => {
    expect(defaultScriptsDir(['node']).endsWith('/scripts')).toBe(true);
  });
});

// ------------------------------------------------------------- jq edges ----

describe('the jq expressions the write filters are built out of', () => {
  it('accepts a null document, because `null | .entries = v` builds an object', () => {
    expect(appendEntry(null, { id: 'D-0001' })).toEqual({ entries: [{ id: 'D-0001' }] });
  });

  it('REFUSES a document that is not an object -- guard (a), not a fresh journal', () => {
    // `[] | .entries` is an error in jq, and the engine turns any throw out of
    // a filter into "jq write failed for <path>". A port that answered `{}`
    // here would write a NEW journal over a corrupt one.
    expect(() => appendEntry([1, 2] as never, {})).toThrow();
    expect(() => appendEntry('text' as never, {})).toThrow();
    // A RawNumber IS a `typeof object`; jq calls it a number and refuses.
    expect(() => appendEntry(new RawNumber('1'), {})).toThrow();
  });

  it('appends without moving the entries key, and adds it last when it is new', () => {
    const doc = parsePreservingNumbers('{"schema":"x","entries":[{"id":"A"}]}');
    expect(Object.keys(appendEntry(doc, { id: 'B' }) as object)).toEqual(['schema', 'entries']);
    expect(Object.keys(appendEntry({ schema: 'x' }, { id: 'B' }) as object)).toEqual(['schema', 'entries']);
  });

  it('does NOT mutate the document it was handed', () => {
    // `_write_json_body` measures the BEFORE count after the filter has run,
    // so an in-place push would make the entry-count guard compare a number
    // with itself and the whole of guard (d) would be off.
    const doc = { entries: [{ id: 'A' }] };
    appendEntry(doc, { id: 'B' });
    mapEntries(doc, () => ({ id: 'Z' }));
    expect(doc).toEqual({ entries: [{ id: 'A' }] });
  });

  it('`|=` over an absent entries array is a failure, unlike `+=`', () => {
    expect(() => mapEntries({ schema: 'x' }, (r) => r)).toThrow();
    expect(appendEntry({ schema: 'x' }, { id: 'B' })).toEqual({ schema: 'x', entries: [{ id: 'B' }] });
  });

  it('field-splits an unquoted command substitution and drops the empties', () => {
    expect(shellWords(['F-0001', '', 'F-0002 F-0003', ' \t '])).toEqual(['F-0001', 'F-0002', 'F-0003']);
  });

  it('carries a failed reseal into the envelope only under --json (D-0085)', () => {
    const human = new Cli('log new', [], false, captureIo());
    warnReseal(human, 'cannot reseal');
    expect(human.build('').checks).toEqual([]);
    const json = new Cli('log new', [], true, captureIo());
    warnReseal(json, 'cannot reseal');
    expect(json.build('').checks).toHaveLength(1);
    expect(json.build('').exit).toBe(0);
  });
});

// -------------------------------------------------------- record shapes ----

describe('the record each filter builds', () => {
  it('decide: key order, an empty refs object, and an explicit null supersedes', () => {
    const f = parseDecideFlags(
      ['--title', 'T', '--decision', 'D', '--rationale', 'R', '--by', 'User'],
      (m) => { throw new Error(m); },
    );
    // No authority resolved: PROPOSED, with no ratified_by (D-S039).
    const e = decideEntry(f, 'D-0001', '2026-09-01');
    expect(Object.keys(e as object)).toEqual([
      'id', 'date', 'title', 'decision', 'rationale', 'status', 'authority', 'recorded_by', 'refs', 'supersedes',
    ]);
    // Ratified: ratified_by keeps its place, the standing follows it.
    expect(Object.keys(decideEntry({ ...f, authority: 'direct' }, 'D-0001', '2026-09-01', true) as object)).toEqual([
      'id', 'date', 'title', 'decision', 'rationale', 'ratified_by', 'status', 'authority', 'recorded_by', 'refs', 'supersedes',
    ]);
    // jq renders an empty object inline; every other object in the journal is
    // multi-line, so this is a real byte the post-state compares.
    expect(jqFormat(e)).toContain('"refs": {}');
    expect(jqFormat(e)).toContain('"supersedes": null');
  });

  it('decide: scope lands between the standing fields and refs, and refs is built in flag order', () => {
    const f = parseDecideFlags(
      ['--title', 'T', '--decision', 'D', '--rationale', 'R', '--by', 'X',
        '--push-hold', 'abc', '--issue', 'I-1', '--task', 'T-1', '--scope', 'repo'],
      (m) => { throw new Error(m); },
    );
    const e = decideEntry(f, 'D-0002', '2026-09-01', true) as { [k: string]: unknown };
    expect(Object.keys(e)).toEqual([
      'id', 'date', 'title', 'decision', 'rationale', 'ratified_by', 'status', 'authority', 'recorded_by', 'scope', 'refs', 'supersedes',
    ]);
    // The ORDER of the refs keys is the filter's, not the command line's.
    expect(Object.keys(e['refs'] as object)).toEqual(['task', 'issue', 'push_hold']);
  });

  it('log: task is an explicit null when absent, and the tail keys are omitted', () => {
    const f = parseLogFlags(['--title', 'T', '--did', 'D'], (m) => { throw new Error(m); }, {});
    const e = logEntry(f, 'L-0001', '2026-09-01');
    expect(Object.keys(e as object)).toEqual(['id', 'date', 'task', 'actor', 'title', 'what_was_done']);
    expect(jqFormat(e)).toContain('"task": null');
  });

  it('log: the actor default is GOV_ACTOR, then the literal `claude`', () => {
    const p = (env: NodeJS.ProcessEnv, args: string[] = []): string =>
      parseLogFlags(args, (m) => { throw new Error(m); }, env).actor;
    expect(p({})).toBe('claude');
    expect(p({ GOV_ACTOR: '' })).toBe('claude');
    expect(p({ GOV_ACTOR: 'issue-validator' })).toBe('issue-validator');
    expect(p({ GOV_ACTOR: 'issue-validator' }, ['--actor', 'bob'])).toBe('bob');
  });

  it('health: `tonumber` canonicalises a decNumber literal and nothing more', () => {
    // "0120" is written 120; a value too large for a double keeps every digit,
    // which a parse-to-number-and-print would not.
    expect(jqFormat(healthEntry({ name: 'n', command: 'c', type: '', timeout: '0120' })))
      .toContain('"timeout_seconds": 120');
    expect(jqFormat(healthEntry({ name: 'n', command: 'c', type: '', timeout: '0' })))
      .toContain('"timeout_seconds": 0');
    expect(jqFormat(healthEntry({ name: 'n', command: 'c', type: '', timeout: '99999999999999999999' })))
      .toContain('"timeout_seconds": 99999999999999999999');
    expect(Object.keys(healthEntry({ name: 'n', command: 'c', type: '', timeout: '' }) as object))
      .toEqual(['name', 'command']);
  });

  it('epic: the array minus removes EVERY occurrence, as jq does', () => {
    expect(nextFeatures(['F-1', 'F-2', 'F-1'], [], ['F-1'])).toEqual(['F-2']);
    expect(nextFeatures(['F-1'], ['F-2', 'F-2'], [])).toEqual(['F-1', 'F-2', 'F-2']);
    // Adds land before the removal, so adding and removing the same id in one
    // invocation removes it -- including the copy that was already there.
    expect(nextFeatures(['F-1'], ['F-1'], ['F-1'])).toEqual([]);
  });
});

// ------------------------------------------------------- the flag loops ----

describe('the flag loops', () => {
  it('refuse an unknown flag with the noun\'s own wording -- health names no noun', () => {
    const grab = (fn: () => unknown): string => {
      try { fn(); } catch (e) { return (e as Error).message; }
      return '';
    };
    expect(grab(() => parseDecideFlags(['--nope', 'x'], (m) => { throw new Error(m); })))
      .toBe('decide: unknown flag --nope — see: scrumux help decide');
    expect(grab(() => parseFeatureFlags(['--nope', 'x'], (m) => { throw new Error(m); })))
      .toBe('feature: unknown flag --nope — see: scrumux help feature');
    expect(grab(() => parseStoryFlags(['--nope'], (m) => { throw new Error(m); })))
      .toBe('story: unknown flag --nope — see: scrumux help story');
    expect(grab(() => parseEpicUpdateFlags(['--nope'], (m) => { throw new Error(m); })))
      .toBe('epic update: unknown flag --nope — see: scrumux help epic');
    // NOT "scrumux help health". The wording is contract, not a typo.
    expect(grab(() => parseHealthFlags(['--nope'], (m) => { throw new Error(m); })))
      .toBe('health: unknown flag --nope — see: scrumux help');
  });

  it('accumulate a repeated flag with NO de-duplication', () => {
    const f = parseFeatureFlags(
      ['--name', 'N', '--desc', 'D', '--dep', 'F-1', '--dep', 'F-1'],
      (m) => { throw new Error(m); },
    );
    expect(f.deps).toEqual(['F-1', 'F-1']);
  });

  it('refuse a flag with no value -- a STATED divergence from bash (cmd-task.md OQ-1)', () => {
    // bash writes `${2?}`, so a truncated line is disposed of by the SHELL at
    // exit 1 with a path and a line number in the text. Unruled across every
    // noun that uses the idiom; this refuses at 2 with the noun's wording.
    let msg = '';
    try {
      parseDecideFlags(['--title'], (m) => { throw new Error(m); });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe('decide: --title needs a value — see: scrumux help decide');
  });
});

// ------------------------------------------------------------- the verbs ---

describe('the verbs, end to end, in a scratch repo', () => {
  it('decide new writes the entry, seals the repo, and prints the bare id', () => {
    const d = scratch();
    seedGov(d, { 'decisions.json': '{"entries": []}\n' });
    const r = drive(decide, d, 'new',
      ['--title', 'T', '--decision', 'D', '--rationale', 'R', '--by', 'User']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toBe('D-0001\n');
    const doc = JSON.parse(read(d, 'decisions.json')) as { entries: { id: string }[] };
    expect(doc.entries.map((e) => e.id)).toEqual(['D-0001']);
    // seal_bootstrap ran AFTER the write, so the baseline it took covers an
    // entry that already existed -- which is the fact it records.
    const seals = JSON.parse(read(d, 'seals.json')) as Record<string, unknown>;
    expect(seals['bootstrapped_over_existing_content']).toBe('2026-09-01');
    rmSync(d, { recursive: true, force: true });
  });

  it('epic update refuses a second copy of a feature and writes nothing', () => {
    const d = scratch();
    seedGov(d, {
      'design.json': jqFormat({
        entries: [
          { kind: 'feature', id: 'F-0001', name: 'f', description: 'd' },
          { kind: 'epic', id: 'E-0001', name: 'e', description: 'd', features: ['F-0001'] },
        ],
      }),
    });
    const before = read(d, 'design.json');
    const r = drive(epic, d, 'update', ['E-0001', '--add-feature', 'F-0001']);
    expect(r.rc).toBe(2);
    expect(r.io.stderr).toContain("an epic's features are a set");
    expect(read(d, 'design.json')).toBe(before);
    rmSync(d, { recursive: true, force: true });
  });

  it('log new --task refuses an unresolvable task before it writes anything', () => {
    const d = scratch();
    seedGov(d, { 'tasks.json': '{"entries": []}\n' });
    const r = drive(log, d, 'new', ['--title', 'T', '--did', 'D', '--task', 'T-0099']);
    expect(r.rc).toBe(2);
    expect(r.io.stderr).toContain('task T-0099 not found in governance/tasks.json');
    // ensure_file never ran: the refusal is upstream of it.
    expect(() => read(d, 'log.json')).toThrow();
    rmSync(d, { recursive: true, force: true });
  });

  /**
   * A CHECK IS KEYED BY ITS NAME, so `add` on a name already registered
   * REPLACES it. This case used to pin the opposite -- it asserted the second
   * row appending beside the first -- and that behaviour is the defect, not
   * the contract. `add` was the only verb on this noun, so a typo in
   * `--command` was UNREACHABLE from the CLI: correcting it left the wrong row
   * in place under the same name, permanently red, and every `task verify` and
   * `session check` on the repo failed thereafter over a command no verb could
   * reach. Measured end to end on the 2026-09-02 E2E operator run (I-0004), on
   * a repo whose own code was green throughout.
   */
  it('health add REPLACES a name already registered, in its own slot, and says old -> new', () => {
    const d = scratch();
    seedGov(d, {
      'repo-health.json': jqFormat({ entries: [
        { name: 'lint', command: 'eslint .' },
        { name: 'build', command: 'old' },
        { name: 'test', command: 'vitest run' },
      ] }),
    });
    const r = drive(health, d, 'add', ['--name', 'build', '--command', 'new']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toBe("health check 'build' re-registered: old -> new\n");
    const doc = JSON.parse(read(d, 'repo-health.json')) as { entries: { name: string; command: string }[] };
    // IN PLACE, not moved to the end. `run_health_checks` reports in file
    // order, so an operator's list would silently reorder itself on a
    // correction if the replacement appended.
    expect(doc.entries.map((e) => e.name)).toEqual(['lint', 'build', 'test']);
    expect(doc.entries.map((e) => e.command)).toEqual(['eslint .', 'new', 'vitest run']);
    rmSync(d, { recursive: true, force: true });
  });

  it('health add still APPENDS a name that is not there, and says registered', () => {
    const d = scratch();
    seedGov(d, { 'repo-health.json': jqFormat({ entries: [{ name: 'build', command: 'make' }] }) });
    const r = drive(health, d, 'add', ['--name', 'test', '--command', 'vitest run']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toBe("health check 'test' registered\n");
    const doc = JSON.parse(read(d, 'repo-health.json')) as { entries: { name: string }[] };
    expect(doc.entries.map((e) => e.name)).toEqual(['build', 'test']);
    rmSync(d, { recursive: true, force: true });
  });

  /**
   * THE ENTRY COUNT NEVER MOVES, and the duplicates a pre-replace repo already
   * carries are NAMED rather than collapsed. `write_json` refuses any filter
   * leaving fewer entries than it found -- the same guard that catches a
   * destructive `repair` jq -- so a version of this that swept the strays was
   * refused outright. That guard is right: a write verb quietly setting
   * ALLOW_ENTRY_REMOVAL would make "nothing on this noun deletes a row" false.
   */
  it('replaces only the FIRST of two rows sharing a name, and names the sanctioned way to drop the rest', () => {
    const d = scratch();
    seedGov(d, {
      'repo-health.json': jqFormat({ entries: [
        { name: 'build', command: 'first' },
        { name: 'build', command: 'second' },
      ] }),
    });
    const r = drive(health, d, 'add', ['--name', 'build', '--command', 'new']);
    expect(r.rc).toBe(0);
    expect(r.io.stdout).toContain('this name is on 2 entries; the first was replaced and the rest are untouched');
    expect(r.io.stdout).toContain('ALLOW_ENTRY_REMOVAL=1 scrumux repair journal repo-health.json');
    expect(r.io.stdout).toContain("health check 'build' re-registered: first -> new\n");
    const doc = JSON.parse(read(d, 'repo-health.json')) as { entries: { command: string }[] };
    expect(doc.entries.map((e) => e.command)).toEqual(['new', 'second']);
    rmSync(d, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------- memory -----

describe('memory add', () => {
  it('strips EVERY trailing newline and puts exactly one back', () => {
    expect(stripTrailingNewlines('a\n\n\n')).toBe('a');
    expect(stripTrailingNewlines('a\n\nb')).toBe('a\n\nb');
    expect(blockLineCount('one')).toBe(1);
    expect(blockLineCount('one\ntwo')).toBe(2);
  });

  it('CREATES the file with its header (D-0089) and says which of the two happened', () => {
    const d = scratch();
    mkdirSync(join(d, 'governance'), { recursive: true });
    const io = captureIo();
    const cli = new Cli('memory add', [], false, io);
    let rc = 0;
    try {
      runMemoryAdd(cli, nctx(d), ['--by', 'issue-validator'], () => 'one\ntwo\n\n');
    } catch (e) { rc = (e as ExitSignal).code; }
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      "created validator-memory.md and appended 2 line(s) under '## Run 2026-09-01 — issue-validator'\n",
    );
    expect(readFileSync(join(d, 'governance/validator-memory.md'), 'utf8'))
      .toBe(`${MEMORY_HEADER}\n## Run 2026-09-01 — issue-validator\n\none\ntwo\n`);
    rmSync(d, { recursive: true, force: true });
  });

  it('REFUSES a file that exists and is empty -- absent and empty are different facts', () => {
    const d = scratch();
    seedGov(d, { 'validator-memory.md': '' });
    const io = captureIo();
    const cli = new Cli('memory add', [], false, io);
    let rc = 0;
    try {
      runMemoryAdd(cli, nctx(d), ['--by', 'User'], () => 'a block\n');
    } catch (e) { rc = (e as ExitSignal).code; }
    expect(rc).toBe(2);
    expect(io.stderr).toContain('has lost its header');
    expect(readFileSync(join(d, 'governance/validator-memory.md'), 'utf8')).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('writes nothing a seal covers, so it never creates seals.json', () => {
    const d = scratch();
    mkdirSync(join(d, 'governance'), { recursive: true });
    try {
      runMemoryAdd(new Cli('memory add', [], false, captureIo()), nctx(d), ['--by', 'V'], () => 'x\n');
    } catch { /* ExitSignal */ }
    expect(() => read(d, 'seals.json')).toThrow();
    rmSync(d, { recursive: true, force: true });
  });

  it('refuses an unknown verb by name', () => {
    const d = scratch();
    const r = drive(memory, d, 'frobnicate', []);
    expect(r.rc).toBe(2);
    expect(r.io.stderr).toContain("unknown verb 'frobnicate' for noun memory");
    rmSync(d, { recursive: true, force: true });
  });

  it('has today\'s stamp available for the heading, in the LOCAL zone', () => {
    // The heading is `## Run $TODAY — $BY`, and $TODAY is `date +%F`: local,
    // not UTC, which is a different day for several hours out of every 24.
    expect(todayStamp(new Date(2026, 8, 1, 23, 30))).toBe('2026-09-01');
  });
});
