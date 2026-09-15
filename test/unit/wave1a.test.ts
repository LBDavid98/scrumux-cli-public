import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../../src/cli/dispatch.js';
import { captureIo, ExitSignal, type CapturedIo } from '../../src/cli/exit.js';
import {
  UNGOVERNED_ALLOWED_NOUNS, findMarker, isAllowed, refusalMessage,
} from '../../src/cli/ungoverned.js';
import { Report, ReportRefusal } from '../../src/cli/capture.js';
import { hasModule, loadNoun, portedNouns } from '../../src/nouns/registry.js';
import { NOUNS } from '../../src/cli/usage.js';
import { clength, cslice, interp, joinJq, sortBy, truthy } from '../../src/nouns/lib/jqlike.js';
import type { JsonValue } from '../../src/journal/jqformat.js';

/**
 * Wave 1A — the pieces the differential harness cannot reach on its own.
 *
 * `npm run diff` is the primary gate and it proves the two implementations
 * agree. It cannot prove three things, and each is asserted here instead:
 *
 *  - that a branch was ENTERED. Two sides that both skip a branch agree
 *    perfectly about nothing.
 *  - what a helper does at its EDGES. The differential only ever sees the
 *    inputs a fixture happens to contain, and the jq text rules below are
 *    wrong in ways that need a codepoint past U+FFFF or a null in a join to
 *    show up at all.
 *  - that the registry's SEAM is complete. A module missing a third of it is
 *    a compile error only if something asks for the missing third.
 */

let SCRATCH = '';
beforeAll(() => { SCRATCH = mkdtempSync(join(tmpdir(), 'scrumux-w1a-')); });
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function run(argv: string[], root: string): { code: number; io: CapturedIo } {
  const io = captureIo();
  try {
    dispatch(argv, io, { cwd: root, env: { ...process.env, GOV_ROOT: root } });
  } catch (e) {
    if (e instanceof ExitSignal) return { code: e.code, io };
    throw e;
  }
  throw new Error('dispatch returned without exiting');
}

// --------------------------------------------------------------------------
describe('the ungoverned guard', () => {
  it('finds a marker several directories above the scan root', () => {
    const top = mkdtempSync(join(tmpdir(), 'scrumux-ug-'));
    writeFileSync(join(top, '.scrumux-ungoverned'), 'because this repo builds it\n');
    const deep = join(top, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    // Walking UP is not optional: the marker is at the repo root and a session
    // two directories down is in the same repo.
    expect(findMarker(deep)).toBe(join(top, '.scrumux-ungoverned'));
    rmSync(top, { recursive: true, force: true });
  });

  it('terminates rather than looping when there is no marker anywhere', () => {
    // `dirname(x) === x` is what ends the walk, at `/` for an absolute path
    // and at `.` for a relative one. A guard that spun here would hang every
    // invocation in a non-repo directory, which is most of them.
    expect(findMarker(SCRATCH)).toBe(null);
    expect(findMarker('/')).toBe(null);
  });

  it('is DEFAULT-DENY: the allow list is a list of what passes, not what fails', () => {
    // Port the property, not the sixteen names. A noun added to the CLI later
    // must be blocked without anyone remembering to add it here, so the test
    // is written against a noun that does not exist rather than against the
    // roster of the day.
    expect(isAllowed('a-noun-invented-in-a-later-phase', 'run')).toBe(false);
    for (const n of UNGOVERNED_ALLOWED_NOUNS.split(' ')) {
      expect(isAllowed(n, 'anything')).toBe(true);
    }
    // Every noun on the live roster is either allowed by name or blocked;
    // nothing is allowed by accident of spelling.
    const allowed = new Set(UNGOVERNED_ALLOWED_NOUNS.split(' '));
    for (const n of NOUNS) expect(isAllowed(n, 'run')).toBe(allowed.has(n));
  });

  it('lets the manual through, as a noun and as a verb', () => {
    for (const n of ['help', '-h', '--help', 'version', '--version']) {
      expect(isAllowed(n, '')).toBe(true);
    }
    // A refusal that also hides the manual teaches the reader less than the
    // manual does, so `<blocked noun> help` is allowed.
    for (const v of ['help', '-h', '--help']) expect(isAllowed('task', v)).toBe(true);
    expect(isAllowed('task', 'new')).toBe(false);
  });

  it('carries every load-bearing clause of the refusal', () => {
    const marker = join(SCRATCH, '.scrumux-ungoverned');
    writeFileSync(marker, 'the per-repo reason, on line one\nand a second line nobody quotes\n');
    const m = refusalMessage('task new', marker);
    expect(m).toContain("'task new' writes records or runs the governed workflow — refused.");
    expect(m).toContain(`The marker: ${marker} — "the per-repo reason, on line one"`);
    expect(m).not.toContain('and a second line nobody quotes');
    expect(m).toContain('this repo BUILDS scrumux');
    expect(m).toContain('Rulings for this repo go directly in RULINGS.md');
    expect(m).toContain(`Still available: ${UNGOVERNED_ALLOWED_NOUNS}, plus help and version.`);
    expect(m).toContain('It is not a wall to route around.');
    rmSync(marker, { force: true });
  });

  it('omits the quoted clause entirely for an empty marker', () => {
    const marker = join(SCRATCH, '.scrumux-ungoverned');
    writeFileSync(marker, '');
    // bash's `sed -n 1p` yields nothing and `${_ug_why:+ …}` drops the whole
    // clause rather than printing an empty pair of quotes.
    expect(refusalMessage('task new', marker)).toContain(`The marker: ${marker}\n  Why:`);
    rmSync(marker, { force: true });
  });

  it('refuses a blocked verb through the dispatcher, at exit 2 with the object', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrumux-ugr-'));
    writeFileSync(join(root, '.scrumux-ungoverned'), 'a reason\n');
    const { code, io } = run(['task', 'new', '--json'], root);
    expect(code).toBe(2);
    const env = JSON.parse(io.stdout);
    expect(env.command).toBe('task new');
    expect(env.error.kind).toBe('refused');
    expect(env.exit).toBe(2);
    expect(io.stderr).toContain('is not a wall to route around');
    rmSync(root, { recursive: true, force: true });
  });

  it('sits ABOVE the registry, so a ported noun is refused too when blocked', () => {
    // Position is the contract. `secret` is ported nowhere yet, but the point
    // generalises: the guard must not be reachable only for nouns that fall
    // through to the "no TypeScript implementation" branch.
    const root = mkdtempSync(join(tmpdir(), 'scrumux-ugp-'));
    writeFileSync(join(root, '.scrumux-ungoverned'), 'a reason\n');
    // `status` and `backlog` are ALLOWED and ported: they must still run.
    expect(run(['backlog', 'tasks'], root).code).toBe(0);
    expect(run(['status', 'session'], root).code).toBe(0);
    // `views render` is blocked and must refuse with the guard's words, not
    // with a module's.
    const { code, io } = run(['views', 'render'], root);
    expect(code).toBe(2);
    expect(io.stderr).toContain('is not a wall to route around');
    rmSync(root, { recursive: true, force: true });
  });
});

// --------------------------------------------------------------------------
describe('the noun registry', () => {
  it('answers all three parts of the seam for every registered noun', () => {
    // cli-shape-tests.sh asserts `<noun>_verbs`, `<noun>_usage` and
    // `<noun>_run` exist for every noun on the bash roster. This is the same
    // assertion on this side, and it is what stops a module landing with two
    // thirds of the seam.
    for (const n of portedNouns()) {
      const m = loadNoun(n);
      expect(m, n).not.toBe(null);
      expect(typeof m!.verbs()).toBe('string');
      expect(m!.verbs().length).toBeGreaterThan(0);
      expect(m!.usage().startsWith(`scrumux ${n} —`), n).toBe(true);
      expect(typeof m!.run).toBe('function');
    }
  });

  it('lists every verb it publishes as a TAB-separated line', () => {
    // The verbs table is the machine-readable half of the surface. Its shape
    // is `verb<TAB>gloss`, one per line, exactly as the bash heredoc emits.
    for (const n of portedNouns()) {
      for (const line of loadNoun(n)!.verbs().trimEnd().split('\n')) {
        expect(line.split('\t').length, `${n}: ${line}`).toBe(2);
      }
    }
  });

  it('registers only nouns the bash roster also knows', () => {
    for (const n of portedNouns()) expect(NOUNS).toContain(n);
  });

  it('says no rather than throwing for a name with no module', () => {
    // Wave 4 seated the last two roster nouns (harness, task), so the
    // no-module answer is now only reachable for a name off the roster.
    // The contract is unchanged -- null, never a throw -- and it stays the
    // dispatcher's defensive net for any future noun.
    expect(hasModule('not-a-noun')).toBe(false);
    expect(loadNoun('not-a-noun')).toBe(null);
    expect(hasModule('task')).toBe(true);
    expect(hasModule('backlog')).toBe(true);
  });
});

// --------------------------------------------------------------------------
describe('the report sink', () => {
  it('drops blank lines from .data.lines and keeps them for a human', () => {
    // `data_lines` is split-and-drop-empties over the captured bytes: a
    // `say ""` separator is a rendering device and never reaches the object.
    const io = captureIo();
    const json = new Report(true, io);
    json.lines(['a', '', 'b']);
    expect(json.dataLines()).toEqual(['a', 'b']);
    expect(io.stdout).toBe('');

    const human = new Report(false, io);
    human.lines(['a', '', 'b']);
    expect(io.stdout).toBe('a\n\nb\n');
    expect(human.dataLines()).toEqual([]);
  });

  it('splits a multi-line value into several lines, as printf does', () => {
    const r = new Report(true, captureIo());
    r.line('SP-0001:\n  T-0001 one');
    expect(r.dataLines()).toEqual(['SP-0001:', '  T-0001 one']);
  });

  it('carries the refusal detail without deciding what to do with it', () => {
    const e = new ReportRefusal('governance/tasks.json is not valid JSON');
    expect(e.detail).toBe('governance/tasks.json is not valid JSON');
    expect(e).toBeInstanceOf(Error);
  });
});

// --------------------------------------------------------------------------
describe('the jq text rules', () => {
  it('interpolates a non-string as its JSON form, so a null prints "null"', () => {
    expect(interp('x')).toBe('x');
    expect(interp(null)).toBe('null');
    expect(interp(3)).toBe('3');
    expect(interp(true)).toBe('true');
    expect(interp(['a'])).toBe('["a"]');
  });

  it('counts and slices CODEPOINTS, not UTF-16 units', () => {
    // The 150-character description cut and the 100-character summary cut both
    // land on real text. `String.prototype.slice` would cut an emoji in half
    // and emit half a surrogate pair, which is not the bytes jq produces.
    const s = 'x'.repeat(9) + '🙂' + 'tail';
    expect(clength(s)).toBe(14);
    expect(cslice(s, 0, 10)).toBe('x'.repeat(9) + '🙂');
    expect(cslice(s, 0, 10)).not.toBe(s.slice(0, 10));
  });

  it('joins a null element as the EMPTY string, never as the word null', () => {
    // An id list with a hole in it joins to "A " in jq. `Array.join` would put
    // the word `null` into a session brief.
    expect(joinJq(['A', null, 'B'], ' ')).toBe('A  B');
    expect(joinJq([], ', ')).toBe('');
    expect(joinJq([1, 'a'], '; ')).toBe('1; a');
  });

  it('sorts STABLY, so equal keys keep their journal order', () => {
    const xs = [{ id: 'c', r: 1 }, { id: 'a', r: 1 }, { id: 'b', r: 0 }];
    expect(sortBy(xs, (x) => x.r).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders null before numbers before strings, as jq does', () => {
    const xs: { k: JsonValue }[] = [{ k: 'a' }, { k: 2 }, { k: null }, { k: 1 }];
    expect(sortBy(xs, (x) => x.k).map((x) => x.k)).toEqual([null, 1, 2, 'a']);
  });

  it('treats false as untruthy, which is what `//` swallows', () => {
    expect(truthy(false)).toBe(false);
    expect(truthy(null)).toBe(false);
    expect(truthy(0)).toBe(true);
    expect(truthy('')).toBe(true);
  });
});

// --------------------------------------------------------------------------
describe('status and backlog, at their argv edges', () => {
  it('status refuses a surplus argument BEFORE it recognises the verb', () => {
    // `status bogus extra` names the verb it was given, not the unknown verb:
    // the argv check is first in bash and the ordering is observable.
    const { code, io } = run(['status', 'bogus', 'extra'], SCRATCH);
    expect(code).toBe(2);
    expect(io.stderr).toContain('status bogus takes no arguments');
  });

  it('status names every verb it has when the verb is unknown', () => {
    const { code, io } = run(['status', 'bogus'], SCRATCH);
    expect(code).toBe(2);
    expect(io.stderr).toContain('verbs: session, planning, sprint, sweep');
  });

  it('backlog refuses an unknown verb OUTSIDE the capture, so --json still answers', () => {
    const { code, io } = run(['backlog', 'bogus', '--json'], SCRATCH);
    expect(code).toBe(2);
    expect(JSON.parse(io.stdout).error.message).toContain('verbs: tasks, features');
  });

  it('backlog swallows a bad FLAG under --json, because the flag loop is inside the capture', () => {
    // P-53 at its sharpest: `--json` is the LOSSIER mode here. Reproduced from
    // bash, not chosen — a port that emitted the refusal object would be
    // changing an observable contract with no ruling.
    const { code, io } = run(['backlog', 'tasks', '--nope', '--json'], SCRATCH);
    expect(code).toBe(2);
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('');
    // Human mode is not lossy. The flag loop runs BEFORE the header line, so
    // there is nothing on stdout to lose here — the header appears only once
    // the argv is understood, which is why the corrupt-journal case below is
    // the one where the split between the two streams is visible.
    const h = run(['backlog', 'tasks', '--nope'], SCRATCH);
    expect(h.code).toBe(2);
    expect(h.io.stdout).toBe('');
    expect(h.io.stderr).toContain('backlog: unknown flag --nope');
  });

  it('backlog prints the header and THEN refuses on an unreadable journal', () => {
    // The other half of the split: by the time a journal is read the header is
    // already out, so human mode shows it and then the error on stderr, and
    // `--json` shows neither because both went into the capture.
    const root = mkdtempSync(join(tmpdir(), 'scrumux-w1a-bad-'));
    mkdirSync(join(root, 'governance'), { recursive: true });
    writeFileSync(join(root, 'governance/tasks.json'), 'NOT JSON AT ALL\n');
    const h = run(['backlog', 'tasks'], root);
    expect(h.code).toBe(2);
    expect(h.io.stdout).toContain('=== BACKLOG (');
    expect(h.io.stderr).toContain('governance/tasks.json is not valid JSON');
    const j = run(['backlog', 'tasks', '--json'], root);
    expect(j.code).toBe(2);
    expect(j.io.stdout).toBe('');
    expect(j.io.stderr).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  it('status session exits 0 over an unreadable journal, and says so in the brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'scrumux-w1a-gov-'));
    mkdirSync(join(root, 'governance'), { recursive: true });
    writeFileSync(join(root, 'governance/tasks.json'), 'NOT JSON AT ALL\n');
    const { code, io } = run(['status', 'session'], root);
    // The contract the SessionStart hook depends on: a failure to brief would
    // be a failure to start work, so the refusal is PRINTED, never exited.
    expect(code).toBe(0);
    expect(io.stdout).toContain('scrumux status: error: governance/tasks.json is not valid JSON');
    // Once per FILE, though two loaders open it.
    expect(io.stdout.split('governance/tasks.json is not valid JSON').length - 1).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
