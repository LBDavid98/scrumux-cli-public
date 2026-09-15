import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, CLI_CONTRACT } from '../../src/cli/dispatch.js';
import { captureIo, ExitSignal, type CapturedIo } from '../../src/cli/exit.js';

/**
 * Every dispatcher path, at the function rather than through a subprocess.
 *
 * WHY THAT MATTERS AND IS NOT DUPLICATION of `npm run diff`. The differential
 * proves the two implementations agree; it cannot prove the TS side reaches a
 * branch, because a branch neither implementation reaches agrees perfectly.
 * These assert the branch is entered and what it says -- and every refusal
 * text below is product surface under Article 5, so it is asserted, not
 * assumed.
 */
/**
 * EVERY CASE RUNS WITH ROOT AIMED AT A SCRATCH DIRECTORY, and that is not
 * incidental. This checkout is the harness SOURCE repo, the one repo in the
 * world carrying `.scrumux-ungoverned`, so a dispatch that resolved ROOT the
 * ordinary way would meet the self-governance refusal before reaching any of
 * the branches below — `task`, `secret` and an unknown noun are all blocked
 * there. The guard has its own file and its own tests
 * (`test/unit/ungoverned.test.ts`); these are about the dispatcher.
 */
let SCRATCH = '';
beforeAll(() => { SCRATCH = mkdtempSync(join(tmpdir(), 'scrumux-dispatch-')); });
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function run(argv: string[]): { code: number; io: CapturedIo } {
  const io = captureIo();
  try {
    dispatch(argv, io, { cwd: SCRATCH, env: { ...process.env, GOV_ROOT: SCRATCH } });
  } catch (e) {
    if (e instanceof ExitSignal) return { code: e.code, io };
    throw e;
  }
  throw new Error('dispatch returned without exiting — every path must end in io.exit');
}

describe('version', () => {
  for (const argv of [['version'], ['--version']]) {
    it(`\`${argv.join(' ')}\` prints the bare contract string at exit 0`, () => {
      const { code, io } = run(argv);
      expect(code).toBe(0);
      expect(io.stdout).toBe(CLI_CONTRACT + '\n');
      expect(io.stderr).toBe('');
    });
  }

  it('emits the standard envelope under --json, with the string as a FIELD', () => {
    // PK-1, ruled 2026-09-01: `version --json` printed a bare line where the
    // CLI's own help text promised exactly one object. It changed on BOTH
    // sides at once -- a port that tightened this alone would be certifying
    // its own divergence. `.data.contract` and not `.data.lines`, because a
    // caller pinning a version wants a field rather than a line to parse.
    const { code, io } = run(['version', '--json']);
    expect(code).toBe(0);
    const env = JSON.parse(io.stdout);
    expect(env.schema).toBe('scrumux.cli/1');
    expect(env.command).toBe('version');
    expect(env.ok).toBe(true);
    expect(env.exit).toBe(0);
    expect(env.data.contract).toBe(CLI_CONTRACT);
    expect(io.stderr).toBe('');
  });
});

/**
 * THE SELF-GOVERNANCE GUARD, WIRED — R-001's other half.
 *
 * `test/unit/ungoverned.test.ts` (Harden E) asserts what the guard SAYS;
 * nothing asserted that the dispatcher asks it. The two are different claims
 * and R-001 names the second explicitly: "POSITION IS PART OF THE CONTRACT. It
 * runs after the noun is resolved and BEFORE the help case, the noun registry
 * and the implementation flip, so that every verb passes through it exactly
 * once and a verb that later moves to TypeScript cannot slip past a guard
 * placed after the flip." `tests/ungoverned-repo-tests.sh` asserts that
 * ordering on the bash side and had no counterpart here.
 *
 * Every OTHER case in this file aims ROOT at a marker-free scratch directory
 * precisely so this guard does not fire — which is correct for those cases and
 * is exactly why the guard's own wiring needed a describe of its own.
 */
describe('the ungoverned guard, from the dispatcher', () => {
  let MARKED = '';
  beforeAll(() => {
    MARKED = mkdtempSync(join(tmpdir(), 'scrumux-marked-'));
    writeFileSync(join(MARKED, '.scrumux-ungoverned'), 'builds the harness\n');
  });
  afterAll(() => { rmSync(MARKED, { recursive: true, force: true }); });

  const inMarked = (argv: string[]): { code: number; io: CapturedIo } => {
    const io = captureIo();
    try {
      dispatch(argv, io, { cwd: MARKED, env: { ...process.env, GOV_ROOT: MARKED } });
    } catch (e) {
      if (e instanceof ExitSignal) return { code: e.code, io };
      throw e;
    }
    throw new Error('dispatch returned without exiting');
  };

  it('refuses a record-writing verb at exit 2, quoting the marker', () => {
    const { code, io } = inMarked(['task', 'new', '--title', 'X']);
    expect(code).toBe(2);
    expect(io.stderr).toContain('this repo is ungoverned by scrumux');
    expect(io.stderr).toContain(`The marker: ${join(MARKED, '.scrumux-ungoverned')} — "builds the harness"`);
    expect(io.stderr).toContain('It is not a wall to route around.');
  });

  it('names the COMMAND, and names the noun alone when there is no verb', () => {
    expect(inMarked(['task', 'new']).io.stderr).toContain("'task new'");
    expect(inMarked(['task']).io.stderr).toContain("'task'");
  });

  it('fires BEFORE the noun registry, which is what makes the position load-bearing', () => {
    // The refusal envelope reports an EMPTY argv and the command as the
    // noun/verb pair, because the guard runs above `redactArgv` and above
    // `loadNoun`. A guard placed after the flip would let a verb that moved to
    // TypeScript past it, and the envelope is where that would first show.
    const { code, io } = inMarked(['decide', 'new', '--title', 'X', '--json']);
    expect(code).toBe(2);
    const env = JSON.parse(io.stdout);
    expect(env.command).toBe('decide new');
    expect(env.argv).toEqual([]);
    expect(env.error.message).toContain('this repo is ungoverned by scrumux');
  });

  it('lets the delivery and read-only surface through, and help and version', () => {
    // The refusal is not a lockout: R-001 keeps the harness buildable,
    // deployable and inspectable from its own source tree. `status session` is
    // additionally on the SessionStart hook, so refusing it would turn every
    // session in this repo into a hook failure.
    for (const argv of [['status', 'session'], ['records', 'check'], ['backlog', 'tasks']]) {
      expect(inMarked(argv).io.stderr, argv.join(' '))
        .not.toContain('this repo is ungoverned by scrumux');
    }
    expect(inMarked(['help']).code).toBe(0);
    expect(inMarked(['version']).code).toBe(0);
    // …and `<noun> help` still prints the manual, because a refusal that hid
    // it would teach the reader less than the manual does.
    expect(inMarked(['task', 'help']).code).toBe(0);
  });

  it('does NOT fire where there is no marker — no marker, no refusal', () => {
    // The control. Without it every assertion above is satisfied by a guard
    // that refuses unconditionally, and SCRATCH is one directory away.
    expect(run(['task', 'new', '--title', 'X']).io.stderr)
      .not.toContain('this repo is ungoverned');
  });
});

describe('help', () => {
  for (const argv of [[], ['help'], ['-h'], ['--help']]) {
    it(`\`scrumux ${argv.join(' ')}\` prints the noun table at exit 0`, () => {
      const { code, io } = run(argv);
      expect(code).toBe(0);
      expect(io.stdout).toContain('nouns:');
    });
  }

  it('`help <noun>` prints that noun\'s block', () => {
    const { code, io } = run(['help', 'task']);
    expect(code).toBe(0);
    expect(io.stdout.startsWith('scrumux task —')).toBe(true);
  });

  it('`<noun> help` lands on the same text', () => {
    expect(run(['task', 'help']).io.stdout).toBe(run(['help', 'task']).io.stdout);
    expect(run(['task', '--help']).io.stdout).toBe(run(['help', 'task']).io.stdout);
    expect(run(['task', '-h']).io.stdout).toBe(run(['help', 'task']).io.stdout);
  });

  it('`help <unknown>` refuses with command "help" and an EMPTY argv', () => {
    // cli_init runs before argv capture in bash, so the envelope reports the
    // refusal as belonging to `help` with nothing in argv. A port that filled
    // argv in would be "more correct" and differential-red.
    const { code, io } = run(['help', 'nosuchnoun', '--json']);
    expect(code).toBe(2);
    const env = JSON.parse(io.stdout);
    expect(env.command).toBe('help');
    expect(env.argv).toEqual([]);
    expect(env.error.kind).toBe('usage');
    expect(env.error.message).toBe("unknown noun 'nosuchnoun' — run: scrumux help");
    expect(io.stderr).toBe("scrumux help: error: unknown noun 'nosuchnoun' — run: scrumux help\n");
  });
});

describe('the unknown noun', () => {
  it('puts the noun table on STDERR and then the one refusal line', () => {
    // It was the ONE refusal in the CLI that produced no object in either
    // mode (PK-1), because it fired before a noun context existed to name.
    // Ruled 2026-09-01: the noun the caller typed IS the context, so it goes
    // through the same refusal writer as everything else -- which is also
    // what puts the wording in one place instead of two. The table comes
    // first because it answers "then what IS there", exactly as the
    // noun-with-no-verb path has always ordered it.
    for (const argv of [['nosuchnoun', 'list'], ['nosuchnoun', 'list', '--json']]) {
      const { code, io } = run(argv);
      expect(code).toBe(2);
      expect(io.stderr).toContain('nouns:');
      expect(io.stderr.trimEnd().endsWith("scrumux nosuchnoun: error: unknown noun 'nosuchnoun' — run: scrumux help")).toBe(true);
    }
  });

  it('emits the standard refusal envelope under --json', () => {
    const { code, io } = run(['nosuchnoun', 'list', '--json']);
    expect(code).toBe(2);
    const env = JSON.parse(io.stdout);
    expect(env.command).toBe('nosuchnoun');
    // argv is EMPTY: bash calls cli_init before it captures argv, and the
    // refusal predates the capture on both sides.
    expect(env.argv).toEqual([]);
    expect(env.ok).toBe(false);
    expect(env.exit).toBe(2);
    expect(env.error.kind).toBe('usage');
    expect(env.error.message).toBe("unknown noun 'nosuchnoun' — run: scrumux help");
  });

  it('emits NOTHING on stdout in human mode', () => {
    const { io } = run(['nosuchnoun', 'list']);
    expect(io.stdout).toBe('');
  });
});

describe('a noun with no verb', () => {
  it('puts the usage on STDERR and the envelope on STDOUT', () => {
    const { code, io } = run(['task', '--json']);
    expect(code).toBe(2);
    expect(io.stderr.startsWith('scrumux task —')).toBe(true);
    const env = JSON.parse(io.stdout);
    expect(env.command).toBe('task');
    expect(env.argv).toEqual([]);
    expect(env.error.message).toContain('There are no default verbs');
  });

  it('says why there is no default, not just that there is none', () => {
    // Article 5: a refusal that states a fact without naming the next action
    // is a defect. This one names the usage above it and the reason.
    const { io } = run(['secret']);
    expect(io.stderr).toContain('the usage above lists them');
    expect(io.stderr).toContain('a command that guesses is a command that is sometimes wrong');
  });
});

describe('a verb with no TypeScript side yet', () => {
  it('no longer exists — every roster noun reaches its module', () => {
    // The scaffold refusal ("has no TypeScript implementation in this
    // build") fired for a roster noun with no registry entry, and Wave 4
    // seated the last two (harness, task) — so the shape is unreachable from
    // argv. The seam stays in dispatch.ts as the defensive net for a future
    // noun; what this pins now is that `task` gets its MODULE's refusal
    // (here: no governance/tasks.json), never the scaffold's.
    const { code, io } = run(['task', 'lint', 'T-1']);
    expect(code).toBe(2);
    expect(io.stderr).not.toContain('has no TypeScript implementation');
    expect(io.stderr).toContain('no governance/tasks.json');
  });

  it('does NOT say that about a noun the registry does own', () => {
    // The complement, and the one that would rot silently: a registered noun
    // must reach its module rather than the scaffold's refusal.
    const { io } = run(['backlog', 'tasks']);
    expect(io.stdout).not.toContain('has no TypeScript implementation');
    expect(io.stdout).toContain('=== BACKLOG (');
  });

  it('carries the real argv into the envelope', () => {
    const { io } = run(['task', 'lint', 'T-1', '--json']);
    expect(JSON.parse(io.stdout).argv).toEqual(['T-1']);
  });
});

/**
 * THE SECRET VALUE NEVER REACHES THE ENVELOPE (User's ruling, Harden C, on
 * the PK-1 precedent — the correct behaviour wins on both sides at once).
 *
 * These run through `dispatch` rather than through the noun module, because
 * the redaction IS a dispatcher act: `redactArgv` sits at the one line that
 * hands a list to `new Cli`, exactly where bash's `cli_argv_capture` sits
 * above `cli_init`. Driving `secret.MODULE` directly (as
 * `test/unit/nouns-wave3f.test.ts` does) constructs its own `Cli` and would
 * pass whatever it was handed — which is why the assertion belongs here.
 *
 * Every case greps the WHOLE of stdout and stderr for the literal value. That
 * is broader than checking `.argv`, deliberately: the field is where the leak
 * was, and the contract is that the value appears nowhere at all.
 */
describe('secret set: the value is redacted out of the envelope', () => {
  const VALUE = 'sup3r-s3cret-value-do-not-echo';

  it('records the NAME and <redacted> under --json, and prints the value nowhere', () => {
    const { code, io } = run(['secret', 'set', 'DISPATCH_TOKEN', VALUE, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout).argv).toEqual(['DISPATCH_TOKEN', '<redacted>']);
    expect(io.stdout).not.toContain(VALUE);
    expect(io.stderr).not.toContain(VALUE);
  });

  it('prints the value nowhere in human mode either', () => {
    const { code, io } = run(['secret', 'set', 'DISPATCH_TOKEN', VALUE]);
    expect(code).toBe(0);
    expect(io.stdout).not.toContain(VALUE);
    expect(io.stderr).not.toContain(VALUE);
    // …and the NOTE that fires only on the argv path is still there, because
    // the value IS in the operator's shell history whatever this envelope says.
    expect(io.stdout).toContain('you passed the value as an argument');
  });

  it('redacts on the REFUSAL path, which is where the leak would have survived', () => {
    // A refusal envelope carries the same argv list, so redacting only the
    // success path leaves the credential reachable by mistyping the NAME.
    const { code, io } = run(['secret', 'set', '1BAD', VALUE, '--json']);
    expect(code).toBe(2);
    const env = JSON.parse(io.stdout);
    expect(env.argv).toEqual(['1BAD', '<redacted>']);
    expect(env.error.message).toContain('not a usable environment variable name');
    expect(io.stdout).not.toContain(VALUE);
    expect(io.stderr).not.toContain(VALUE);
  });

  it('preserves the entry COUNT, which is the PK-2 property restated', () => {
    // `.argv` is the record of what was run: a list that dropped an element
    // misstates the act as surely as one that leaks it.
    const { io } = run(['secret', 'set', 'DISPATCH_TOKEN', VALUE, `${VALUE}-second`, '--json']);
    expect(JSON.parse(io.stdout).argv).toEqual(['DISPATCH_TOKEN', '<redacted>', '<redacted>']);
    expect(io.stdout).not.toContain(VALUE);
  });

  it('leaves the argv of every OTHER secret verb alone', () => {
    // The redaction is narrow by construction: `list` takes nothing and
    // `remove` takes a NAME, so neither has a value to hide, and a blanket
    // rule over the noun would erase the record of what was removed.
    const { io } = run(['secret', 'remove', 'DISPATCH_TOKEN', '--json']);
    expect(JSON.parse(io.stdout).argv).toEqual(['DISPATCH_TOKEN']);
  });
});

/**
 * R-010 — THE SAME LEAK, ONE LAYER OUT: the REFUSAL TEXT.
 *
 * `redactArgv` closed `.argv` and nothing else, and a value beginning with a
 * dash never reaches it: `parsePositional` sees a flag, refuses, and the old
 * wording put the operand back on stderr and into the envelope's `summary` and
 * `error.message`. `scrumux secret set TOKEN -sup3r-s3cret` printed the
 * credential straight back, on the one noun whose stated contract is that
 * nothing prints a value back. Found by Harden C's audit, ruled by extension
 * of User's Harden C secret ruling, fixed on BOTH sides at once — the same
 * PK-1 mechanism, so the two stay byte-comparable and
 * `test/fixtures/tier2-hardenE.mjs` is what holds them there.
 *
 * THESE ARE GREP-EVERYTHING ASSERTIONS. Not "the message names the position"
 * — that would go green on a message that named the position AND echoed the
 * operand. The literal value must appear in NO byte of stdout or stderr, in
 * both modes, in every argv position a value can occupy. A leak has to have
 * somewhere to appear, and this says there is nowhere.
 */
describe('R-010: `secret set` never echoes the operand, so a dash-value cannot leak', () => {
  const VALUE = '-sup3r-s3cret-value-do-not-echo';

  /** Every place a leading-dash operand can land, and what the ordinal must say. */
  const POSITIONS: { argv: string[]; ordinal: number; what: string }[] = [
    { argv: ['TOKEN', VALUE], ordinal: 2, what: 'the VALUE slot — the reported case' },
    { argv: [VALUE], ordinal: 1, what: 'the NAME slot — indistinguishable from a value typed early' },
    { argv: ['TOKEN', 'first', VALUE], ordinal: 3, what: 'a later value, which is the one bash stores' },
    { argv: ['TOKEN', VALUE, 'second'], ordinal: 2, what: 'refused at the FIRST dash, not the last' },
  ];

  for (const { argv, ordinal, what } of POSITIONS) {
    for (const json of [false, true]) {
      it(`${what} [${json ? 'json' : 'human'}]`, () => {
        const { code, io } = run(['secret', 'set', ...argv, ...(json ? ['--json'] : [])]);
        expect(code).toBe(2);
        // THE WHOLE OF BOTH STREAMS. Not a field, not a line.
        expect(io.stdout, 'the value reached stdout').not.toContain(VALUE);
        expect(io.stderr, 'the value reached stderr').not.toContain(VALUE);
        // …and the refusal is still USEFUL, which is the other half of the
        // fix: withholding the operand is only acceptable because the ordinal
        // tells the operator which argument to go and look at.
        const text = json ? (JSON.parse(io.stdout).error.message as string) : io.stderr;
        expect(text).toContain(`secret set: unknown flag in argument ${ordinal}`);
        expect(text).toContain('not echoed — on this noun an argument may be the secret itself');
        // The usage tail is the pre-existing wording, unchanged: the refusal
        // still says what the shapes are.
        expect(text).toContain('usage: scrumux secret set NAME [VALUE] | scrumux secret list | scrumux secret remove NAME');
      });
    }
  }

  it('the whole envelope is clean, field by field, not just the two streams', () => {
    const { io } = run(['secret', 'set', 'TOKEN', VALUE, '--json']);
    const env = JSON.parse(io.stdout);
    // `.argv` was already redacted by redactArgv; `summary` and
    // `error.message` are the two fields the old wording leaked through, and
    // they are asserted BY NAME so a future envelope field that carried the
    // message would still have to face the whole-stdout assertion above.
    expect(env.argv).toEqual(['TOKEN', '<redacted>']);
    expect(JSON.stringify(env)).not.toContain(VALUE);
    expect(env.summary).toContain('unknown flag in argument 2');
    expect(env.error.kind).toBe('usage');
  });

  it('`secret remove` still names the flag, because its operand is a NAME', () => {
    // The redaction is narrow ON PURPOSE. `remove` has no value in its argv to
    // leak, and its wording is matched byte-for-byte against `cmd-secret.sh`
    // by the refusal-parity corpus; redacting it would buy nothing and cost a
    // matched pair. A change that broadened R-010 to the whole noun turns this
    // red, which is the point.
    const { code, io } = run(['secret', 'remove', '-x', '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(io.stdout).error.message)
      .toContain('secret remove: unknown flag -x — usage: scrumux secret set NAME [VALUE]');
  });

  it('a value that does NOT begin with a dash is unaffected — the write still happens', () => {
    // The fix touches one arm. A regression that routed every `secret set`
    // through it would refuse the documented argv form outright, and nothing
    // else in this file would notice.
    const { code, io } = run(['secret', 'set', 'R010_TOKEN', 'plain-value', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout).data).toMatchObject({ name: 'R010_TOKEN', action: 'stored' });
  });
});
