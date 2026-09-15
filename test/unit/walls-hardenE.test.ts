import { describe, it, expect, afterAll, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  captureWallIo, wallExitCode, readHookInput, runAsEntry,
  type WallIo, type CapturedWallIo,
} from '../../src/walls/lib/hook.js';
import { loadConf, splitRule, reasonFor, emitWarnings, refuses } from '../../src/walls/lib/conf.js';
import { translateEre, ereOrThrow, ereMatches } from '../../src/walls/lib/ere.js';
import { jqCompact } from '../../src/walls/lib/jsonl.js';
import { cmdWords } from '../../src/walls/lib/cmd-words.js';
import { scanCommand } from '../../src/walls/block-upstream-edit.js';
import { isTemp, rmTargetsTemp, main as destructive } from '../../src/walls/block-destructive.js';
import { readOperands, main as secret } from '../../src/walls/block-secret-reads.js';
import { main as upstream } from '../../src/walls/block-upstream-edit.js';
import { main as directLlm } from '../../src/walls/block-direct-llm.js';

/**
 * THE PATHS THE FOUR WALL SUITES REACH ONLY BY ACCIDENT, OR NOT AT ALL.
 *
 * `walls-main.test.ts` asserts the sentence each wall says. `walls-hooks.test.ts`
 * asserts the predicates. `walls-main-branches.test.ts` picks up the conf arms.
 * `ere.test.ts` property-tests the translator against every grep on the machine.
 * Between them they leave a specific and uncomfortable residue, which is what
 * this file is:
 *
 *  - EVERY REDIRECT AND HEREDOC CASE IN `scanCommand` THAT DOES NOT HIT ON ITS
 *    FIRST TOKEN. The suites test `> .claude/scripts/scrumux` and a heredoc
 *    whose first body line is already the attack, so the two `continue` arms —
 *    "this redirect target is fine, carry on" and "this heredoc line is fine,
 *    read the next one" — had never executed. A wall that returned instead of
 *    continuing there would still pass every existing test while going blind to
 *    everything after the first benign line of a heredoc, which is precisely the
 *    I-0121 route.
 *
 *  - THE EMPTY PROGRAM WORD. Three walls write `cmdWords(cmd)[0] ?? ''` into the
 *    event stream, and nothing exercised the `?? ''`. `URL=https://api.openai.com`
 *    is a whole command with NO command word — every token is an assignment — and
 *    it is the shape that reaches that default. bash writes `"refused":""` there;
 *    so must this.
 *
 *  - `processWallIo`, which no unit test can call without owning fd 0, and which
 *    is the seam every wall's production path actually runs through.
 *
 *  - The ERE translator's escape and failure arms: a backslash INSIDE a bracket
 *    expression, a trailing backslash at either level, an unbalanced `)`.
 *
 *  - The three "the bookkeeping failed and the command still runs" arms:
 *    an unreadable `project-walls.conf`, a `governance/` that does not exist yet,
 *    and an `attestations.jsonl` that cannot be appended to.
 *
 * BYTE-PARITY IS ASSERTED HERE, NOT ASSUMED. Every wall-level case below goes
 * through `run()`, which drives the SAME payload through
 * `.deploy-claude/hooks/<wall>.sh` in a scratch root of its own and requires the
 * two verdicts to match. The bash hooks are still the production owner; a new
 * test that pins TypeScript behaviour bash does not have is a new divergence
 * wearing a green tick.
 */

// --------------------------------------------------------------- fixtures --
const REPO = resolve(import.meta.dirname, '../..');
const AWK_ORACLE = join(REPO, 'test/oracle/cmd-words.awk.sh');

const scratch: string[] = [];
interface RootOpts { deployed?: boolean; conf?: string; governance?: boolean; attestBlocked?: boolean }

function mkRoot(opts: RootOpts = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'wallhardenE-'));
  scratch.push(d);
  mkdirSync(join(d, '.claude'), { recursive: true });
  if (opts.governance !== false) mkdirSync(join(d, 'governance'), { recursive: true });
  // A DIRECTORY where the append expects a file: the only portable way to make
  // appendFileSync fail without touching permissions as a non-root user.
  if (opts.attestBlocked === true) mkdirSync(join(d, 'governance/attestations.jsonl'), { recursive: true });
  if (opts.deployed === true) writeFileSync(join(d, '.claude/DEPLOYED'), '{"source_remote":"git@example:harness.git"}\n');
  if (opts.conf !== undefined) writeFileSync(join(d, '.claude/project-walls.conf'), opts.conf);
  return d;
}
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

const MAIN: Readonly<Record<string, (io: WallIo) => never>> = {
  'block-destructive': destructive,
  'block-secret-reads': secret,
  'block-upstream-edit': upstream,
  'block-direct-llm': directLlm,
};

/** Run one wall in-process. */
function run(wall: string, payload: unknown, opts: RootOpts = {}): { code: number; io: CapturedWallIo; gov: string } {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const gov = mkRoot(opts);
  const io = captureWallIo(raw);
  const prev = process.env['GOV_ROOT'];
  process.env['GOV_ROOT'] = gov;
  let code: number;
  try {
    code = wallExitCode(() => MAIN[wall]!(io));
  } finally {
    if (prev === undefined) delete process.env['GOV_ROOT']; else process.env['GOV_ROOT'] = prev;
  }
  return { code, io, gov };
}

const cmd = (c: string): object => ({ tool_input: { command: c } });
const events = (gov: string): Array<Record<string, unknown>> =>
  readFileSync(join(gov, '.scrumux/events.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// =============================================================== lib/hook ==
describe('processWallIo — the seam the PRODUCTION path runs through', () => {
  const PAYLOAD = '{"tool_input":{"command":"rm -rf /Users/x/data"}}';

  it('reads the whole payload from fd 0, and its exit throws rather than returning', async () => {
    // Unit-testable only by owning fd 0, which a test runner does not hand out:
    // a real `readFileSync(0)` here either blocks on the runner's stdin or reads
    // somebody else's bytes. So node:fs is replaced for one dynamic import, and
    // the assertion is that this function wires the three pieces of `WallIo`
    // together correctly — not that node can read a file descriptor.
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: (p: unknown, enc: unknown): unknown => (p === 0
          ? PAYLOAD
          : (actual.readFileSync as (a: unknown, b: unknown) => unknown)(p, enc)),
      };
    });
    try {
      const mod = await import('../../src/walls/lib/hook.js');
      const io = mod.processWallIo();
      expect(io.input).toBe(PAYLOAD);
      // exit THROWS in production exactly as it does under capture, so nothing
      // after a refusal ever runs. A production seam that returned would let a
      // wall keep evaluating past its own verdict.
      expect(() => io.exit(2)).toThrow(mod.WallExit);
      const seen: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write');
      spy.mockImplementation((chunk) => { seen.push(String(chunk)); return true; });
      try { io.err('BLOCKED by w: because\n'); } finally { spy.mockRestore(); }
      expect(seen).toEqual(['BLOCKED by w: because\n']);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('NO STDIN AT ALL IS AN EMPTY PAYLOAD, never a refusal', async () => {
    // bash's `jq -r '.tool_input.command // empty'` yields empty on anything it
    // cannot read and every wall then exits 0. A wall that refused here would
    // block tool calls this harness has never blocked. The catch is deliberately
    // silent, so the only observable is the empty input it leaves behind.
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: (p: unknown, enc: unknown): unknown => {
          if (p === 0) throw new Error('EAGAIN: no stdin');
          return (actual.readFileSync as (a: unknown, b: unknown) => unknown)(p, enc);
        },
      };
    });
    try {
      const mod = await import('../../src/walls/lib/hook.js');
      expect(mod.processWallIo().input).toBe('');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('readHookInput — GOV_ROOT moves the DATA root and nothing else', () => {
  it('falls back to two levels up from the hook when GOV_ROOT is unset', () => {
    // The fallback is what runs in a real deployment: the hook lives in
    // `<repo>/.claude/dist/`, so two up is the repo. Every other test in the
    // wall suites sets GOV_ROOT, so the shipped resolution had never run.
    const io = captureWallIo('{}');
    expect(readHookInput('/repo/.claude/dist', io, {}).root).toBe('/repo/.claude/dist/../..');
  });

  it('an EMPTY GOV_ROOT is not a root — it falls back too', () => {
    // `GOV_ROOT= scrumux ...` exports the variable as the empty string, and
    // treating that as a root points every wall's conf lookup, event stream and
    // DEPLOYED probe at `/.claude/...`. bash's `${GOV_ROOT:-...}` treats unset
    // and empty alike; so does this.
    const io = captureWallIo('{}');
    expect(readHookInput('/repo/.claude/dist', io, { GOV_ROOT: '' }).root)
      .toBe('/repo/.claude/dist/../..');
    expect(readHookInput('/repo/.claude/dist', io, { GOV_ROOT: '/elsewhere' }).root)
      .toBe('/elsewhere');
  });
});

describe('runAsEntry — the catch-all refuses whatever was thrown', () => {
  it('names a NON-Error throw, and writes it to process.stderr by default', () => {
    // Two gaps in one: the default stderr sink (every existing case injects
    // one) and the `String(e)` arm. A `throw 'boom'` from a dependency reaches
    // the same catch as a TypeError, and exit 2 means BLOCK — a wall that
    // crashed open would be the silent no-op the jq guard exists to prevent.
    const seen: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write');
    spy.mockImplementation((chunk) => { seen.push(String(chunk)); return true; });
    let exited = -1;
    try {
      runAsEntry('block-x', pathToFileURL('/a.mjs').href,
        (): never => { throw 'a dependency threw a bare string'; },
        ['node', '/a.mjs'], (c) => { exited = c; });
    } finally {
      spy.mockRestore();
    }
    expect(exited).toBe(2);
    expect(seen.join('')).toContain('BLOCKED by block-x');
    expect(seen.join('')).toContain('a dependency threw a bare string');
    expect(seen.join('')).toContain('fail-closed, CLI-1');
  });
});

// =============================================================== lib/conf ==
describe('project-walls.conf — the arms that keep the built-ins running', () => {
  it('an UNREADABLE conf is named, and does not silently disable the repo', () => {
    // present-but-unreadable is a different state from absent, and the wrong
    // answer here is the quiet one: no rules, no complaint, and a repo that
    // believes its refuse lines are live.
    const d = mkRoot();
    mkdirSync(join(d, '.claude/project-walls.conf'), { recursive: true });   // a DIRECTORY
    const c = loadConf(d);
    expect(c.present).toBe(true);
    expect(c.rules).toEqual([]);
    expect(c.warnings.some((w) => w.includes('cannot be read'))).toBe(true);
    expect(c.warnings.some((w) => w.includes("none of this repo's own rules apply"))).toBe(true);
  });

  it('a line with NO PIPE AT ALL is not a rule — bash\'s `grep -F \'|\'` filter', () => {
    expect(splitRule('refuse', 'refuse terraform destroy')).toBeNull();
    expect(splitRule('allow', 'allow rm -rf ./archive')).toBeNull();
    // ...and the verb still has to be the verb.
    expect(splitRule('allow', 'refuse zz | reason')).toBeNull();
  });

  it('a verb with NO PATTERN before the pipe is skipped, and skipped UNNAMED', () => {
    // Distinct from the reasonless rule beside it, which IS named: bash's
    // pattern extraction yields empty here and the rule simply never joins the
    // set, so naming it would be a message bash never prints.
    const c = loadConf(mkRoot({ conf: 'refuse    | a reason with no pattern\nrefuse zz | real\n' }));
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0]!.pattern).toBe('zz');
    expect(c.warnings).toEqual([]);
    expect(refuses(c, 'anything at all').refused).toBe(false);
  });

  it('reasonFor walks PAST a rule it cannot evaluate to the one that matched', () => {
    // The skipped rule holds a null regex. Reading it as "no reason" would
    // attribute the refusal to the wrong line and send the reader to a rule
    // that never fired.
    const c = loadConf(mkRoot({
      conf: 'refuse ( | a pattern that cannot compile\nrefuse id_rsa | this repo has no ssh keys in it\n',
    }));
    expect(reasonFor(c, 'refuse', 'cat ~/.ssh/id_rsa')).toBe('this repo has no ssh keys in it');
  });

  it('...and returns the empty string when nothing matched at all', () => {
    // The fail-closed refusal has no matching rule by construction, and the
    // caller supplies its own sentence there. This must not throw or invent one.
    const c = loadConf(mkRoot({ conf: 'refuse id_rsa | this repo has no ssh keys in it\n' }));
    expect(reasonFor(c, 'refuse', 'echo hello')).toBe('');
    expect(reasonFor(c, 'allow', 'cat ~/.ssh/id_rsa')).toBe('');
  });

  it('emitWarnings writes to process.stderr when no sink is injected', () => {
    // The default sink is what the CLI-side callers get. A default that wrote
    // nowhere would make every named skip invisible outside the wall hot path.
    const c = loadConf(mkRoot({ conf: 'refuse ( | a pattern that cannot compile\n' }));
    const seen: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write');
    spy.mockImplementation((chunk) => { seen.push(String(chunk)); return true; });
    try { emitWarnings(c); } finally { spy.mockRestore(); }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ignoring an invalid refuse pattern');
    expect(seen[0]!.endsWith('\n')).toBe(true);
  });
});

// ================================================================ lib/ere ==
/** rc from every grep on this machine; 2 means "will not compile". */
function grepRcs(pattern: string, subject: string): number[] {
  return ['/usr/bin/grep', 'grep']
    .filter((g, i, a) => a.indexOf(g) === i)
    .filter((g) => (g.startsWith('/') ? existsSync(g) : true))
    .map((g) => spawnSync(g, ['-Eqi', '--', pattern], { input: subject, encoding: 'utf8' }).status ?? -1);
}

describe('the ERE translator\'s escape and failure arms', () => {
  it('a backslash INSIDE a bracket expression escapes the next character', () => {
    // JS reads `[` `]` `\` `^` and `-` as structure inside a class; POSIX reads
    // most of them as literals. Passing the pair through unchanged is what keeps
    // `[\.]` a one-character class rather than a syntax error, and it is the arm
    // that had never run.
    expect(ereMatches('[\\.]', 'a.b')).toBe(true);
    expect(ereMatches('[\\.]', 'xyz')).toBe(false);
    // Both greps on this machine agree on these two, so agreement is required
    // rather than pinned.
    expect(new Set(grepRcs('[\\.]', 'a.b')), 'greps disagree; the assertion above is no longer an oracle').toEqual(new Set([0]));
    expect(new Set(grepRcs('[\\.]', 'xyz'))).toEqual(new Set([1]));
  });

  it('a trailing backslash is INVALID at either level, exactly as grep says', () => {
    // Top level and inside a bracket are separate code paths and both used to
    // be untested. grep exits 2 on both, so `walls_field` skips the rule; the
    // translator must refuse it too rather than compiling something else.
    for (const p of ['abc\\', '[a\\']) {
      const t = translateEre(p);
      expect(t.ok, p).toBe(false);
      if (!t.ok) expect(t.kind, p).toBe('invalid');
      expect(new Set(grepRcs(p, 'abc')), `grep no longer rejects ${p}`).toEqual(new Set([2]));
    }
  });

  it('an unbalanced `)` is INVALID, not "untranslatable"', () => {
    // The two get different answers by ruling: an invalid pattern has a bash
    // counterpart (grep exits 2, the rule is skipped on both verbs), while an
    // untranslatable one has none and FAILS CLOSED on a refuse line. Classing a
    // typo as untranslatable would refuse every command in the repo.
    const t = translateEre('a{2,1})');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.kind).toBe('invalid');
    expect(new Set(grepRcs('a{2,1})', 'aa'))).toEqual(new Set([2]));
    // The refuse line therefore does NOT fail closed on it: it is skipped and
    // named, and the other rules still apply.
    const c = loadConf(mkRoot({ conf: 'refuse a{2,1}) | a typo\nrefuse id_rsa | no ssh keys here\n' }));
    expect(refuses(c, 'echo hello')).toEqual({ refused: false, failedClosed: false });
    expect(refuses(c, 'cat id_rsa')).toEqual({ refused: true, failedClosed: false });
  });

  it('ereOrThrow STOPS rather than silently disabling a wall predicate', () => {
    // A pattern compiled into this build is ours, not a repo's input. The
    // skip-and-name path is for a person's typo; a build defect that disabled
    // `SHELL_READS` or `ATT_RM` by returning a no-op regex is the silent
    // fail-open this throw exists to prevent.
    expect(() => ereOrThrow('[abc')).toThrow(/will not translate/);
    expect(() => ereOrThrow('[abc')).toThrow(/\[abc/);
    expect(ereOrThrow('^[[:space:]]+$', 'i').test('  \t ')).toBe(true);
  });
});

// ============================================================== lib/jsonl ==
describe('jq -c renders the scalars the wall rows actually carry', () => {
  it('a boolean is a bare true/false, never a quoted string', () => {
    // `records check` jq-parses these rows. `"true"` and `true` are different
    // values to every consumer downstream.
    expect(jqCompact(true)).toBe('true');
    expect(jqCompact(false)).toBe('false');
    expect(jqCompact({ ok: true, failedClosed: false })).toBe('{"ok":true,"failedClosed":false}');
  });

  it('a non-integer number keeps its decimal form', () => {
    expect(jqCompact(1.5)).toBe('1.5');
    expect(jqCompact([1, 1.5, -2.25, 0])).toBe('[1,1.5,-2.25,0]');
  });
});

// ========================================================== lib/cmd-words ==
/** The frozen awk oracle — the definition of correct for this tokenizer. */
function awkWords(input: string): string[] {
  return execFileSync('sh', [AWK_ORACLE], { input, encoding: 'utf8' })
    .split('\n').filter((l) => l !== '');
}
function bothTokenize(input: string, want: string[]): void {
  expect(cmdWords(input), input).toEqual(want);
  expect(awkWords(input), `${JSON.stringify(input)}: the awk oracle disagrees`).toEqual(want);
}

describe('cmdWords — the separator shapes three walls decide from', () => {
  it('an empty command yields NO words, not one empty pass', () => {
    // awk produces zero records for empty input. A single empty record here
    // would push '' into the word list and every `words[0]` downstream would
    // stop being the program word.
    bothTokenize('', []);
  });

  it('a separator inside SINGLE quotes is data, not structure', () => {
    // The I-0001 class, on the quote style the suites never used: a `;` or a
    // `|` inside a quoted argument must not restart command position, or a
    // governance record's own prose yields a bogus `rm` and trips a wall on
    // text that runs nothing.
    bothTokenize("echo 'a; rm -rf /'", ['echo']);
    bothTokenize("git commit -m 'rm -rf / and cat .env'", ['git']);
  });

  it('...but a bare separator DOES restart it', () => {
    // The other half, and the one that keeps the walls honest: over-report,
    // never under-report.
    bothTokenize('echo a; rm -rf /x', ['echo', 'rm']);
    bothTokenize('cat x | grep y', ['cat', 'grep']);
    bothTokenize('false || rm -rf /x', ['false', 'rm']);
  });

  it('a newline ends a command, and a trailing one adds no empty record', () => {
    bothTokenize('cat a\nrm b\n', ['cat', 'rm']);
  });
});

// ==================================================== block-upstream-edit ==
describe('scanCommand — the arms that must CONTINUE rather than answer', () => {
  const hits = (c: string): string | null => scanCommand(c)?.path ?? null;

  it('a redirect with the path ATTACHED to the operator still blocks', () => {
    // `> path` and `>path` are the same redirect to a shell and two different
    // tokens to a scanner. Only the spaced form had ever been tested, so the
    // whole attached-operator arm was dead code as far as any suite knew.
    expect(hits('echo x >.claude/dist/y.mjs')).toBe('.claude/dist/y.mjs');
    expect(hits('echo x >>.claude/scripts/scrumux')).toBe('.claude/scripts/scrumux');
    expect(hits('cp /tmp/a >.claude/schemas/task.schema.json')).toBe('.claude/schemas/task.schema.json');
  });

  it('a redirect at an ORDINARY path is fine, and the segment after it is judged fresh', () => {
    // Both continue-arms in one shape. If either returned instead of carrying
    // on, `echo hi > notes.txt` would block; if the separator did not restore
    // command position, the `rm` behind it would be read as an argument and the
    // real write would walk through.
    expect(hits('echo hi > notes.txt')).toBeNull();
    expect(hits('echo hi >notes.txt')).toBeNull();
    expect(hits('echo hi > notes.txt; rm .claude/dist/a.mjs')).toBe('.claude/dist/a.mjs');
    expect(hits('echo hi >notes.txt; rm .claude/dist/a.mjs')).toBe('.claude/dist/a.mjs');
  });

  it('A HEREDOC BODY IS READ TO THE END, not just its first line (I-0121)', () => {
    // The suites' heredoc case puts the attack on the first body line, so the
    // "this line is clean, read the next one" arm had never executed. A wall
    // that stopped at the first clean line is blind to every heredoc with a
    // greeting in it, which is every real one.
    const clean = 'python3 <<\'EOF\'\nprint("hello")\ndata = 1\nEOF';
    expect(hits(clean)).toBeNull();
    const buried = 'python3 <<\'EOF\'\nprint("hello")\nimport os\nopen(\'.claude/dist/x.mjs\',\'w\').write(\'boom\')\nEOF';
    // The token arrives with its shell punctuation stripped, which is what lets
    // a relative path inside quotes inside a call still read as machinery.
    expect(hits(buried)).toBe('open.claude/dist/x.mjs,w.writeboom');
  });

  it('leading whitespace is not a token', () => {
    expect(hits('   rm .claude/dist/a.mjs')).toBe('.claude/dist/a.mjs');
    expect(hits('\trm .claude/dist/a.mjs')).toBe('.claude/dist/a.mjs');
  });

  it('a separator glued to an ordinary token restores command position', () => {
    // `cat x; rm <machinery>` — the `;` arrives welded to `x`, so the token is
    // neither a separator nor empty. Missing it leaves `rm` reading as an
    // argument of `cat` and the write is allowed.
    expect(hits('cat x; rm .claude/dist/a.mjs')).toBe('.claude/dist/a.mjs');
    expect(hits('cat x| rm .claude/dist/a.mjs')).toBe('.claude/dist/a.mjs');
  });

  it('...and so does one glued to a token that is ONLY punctuation', () => {
    // `";` strips to nothing at all, which is its own branch: the token is
    // empty AND carries a separator. Dropping the separator with the token is
    // how a mangled quote turns a mutator back into an argument.
    expect(hits('echo "; rm .claude/scripts/scrumux')).toBe('.claude/scripts/scrumux');
    expect(hits('echo ") ; rm .claude/scripts/scrumux')).toBe('.claude/scripts/scrumux');
  });
});

describe('block-upstream-edit end to end', () => {
  it('an ORDINARY Bash command inside a deployment is allowed', () => {
    // The wall's fall-through. Every existing end-to-end case either blocks or
    // exits early on an empty command, so the "scanned the whole command, found
    // nothing, allow" path had never been reached — and it is the path taken by
    // essentially every command a deployed repo ever runs.
    expect(run('block-upstream-edit', cmd('ls -la src'), { deployed: true }).code).toBe(0);
    expect(run('block-upstream-edit', cmd('npm run build && git status'), { deployed: true }).code).toBe(0);
  });

  it('the redirect and heredoc routes block in a deployment, and agree with bash', () => {
    for (const c of [
      'echo x >.claude/dist/y.mjs',
      'echo hi > notes.txt; rm .claude/dist/a.mjs',
      'echo "; rm .claude/scripts/scrumux',
      'python3 <<\'EOF\'\nprint("hello")\nopen(\'.claude/dist/x.mjs\',\'w\').write(\'boom\')\nEOF',
    ]) {
      const { code, io } = run('block-upstream-edit', cmd(c), { deployed: true });
      expect(code, c).toBe(2);
      expect(io.stderr, c).toContain('D-0078 boundary 1');
    }
  });

  it('...and the benign forms of the same shapes are allowed, on both sides', () => {
    for (const c of [
      'echo hi > notes.txt',
      'cat <<EOF > /tmp/out\njust some text\nEOF',
      'grep -n scrumux .claude/dist/scrumux.mjs',
    ]) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(0);
    }
  });

  /**
   * WAS A PINNED GAP; CLOSED ON BOTH SIDES BY R-013.
   *
   * This assertion used to require exit 0 for the glued forms and carried the
   * reasoning for it: `2>path` and `&>path` are redirects that NEITHER
   * implementation saw, because the token is not one of the bare operators and
   * does not begin with `>`, so it fell through to the ordinary operand test
   * with a benign command word in front of it. It was filed as found-not-fixed
   * on the standing rule that an evasion working against bash too is a finding
   * about the WALL, and that widening one side alone is a silent divergence
   * this repo does not take unilaterally.
   *
   * R-013 is that ruling arriving: both sides closed together, `redirGluedTarget`
   * / `redir_glued_target` written once each and mirrored. The assertion keeps
   * its shape — it is still deliberately about the PAIR, so closing or
   * REOPENING it in only one implementation turns this red — and only the
   * expected code moved.
   */
  it('R-013: an fd-prefixed or &-prefixed redirect glued to its path is REFUSED, on both sides', () => {
    for (const c of [
      'echo x 2>.claude/schemas/task.schema.json',
      'echo x &>.claude/dist/y.mjs',
      'echo x 2>>.claude/schemas/task.schema.json',
      'echo x 1>.claude/scripts/scrumux',
    ]) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(2);
    }
    // The spaced forms were always caught, and still are.
    for (const c of ['echo x 2> .claude/schemas/task.schema.json', 'echo x &> .claude/dist/y.mjs']) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(2);
    }
    // `2>&1` is a DUP, not a file: it must not become a refusal, and it is the
    // shape most likely to be broken by a careless widening of the same regex.
    expect(run('block-upstream-edit', cmd('cat .claude/scripts/scrumux 2>&1'), { deployed: true }).code)
      .toBe(0);
    // Rows from the targeted probe, kept because each is a distinct spelling
    // the regex has to get right: an exec-wrapper and a VAR= prefix in front,
    // a two-digit fd, both append forms, a later segment, and a glued target
    // that is quoted.
    for (const c of [
      'sudo tee x 2>.claude/dist/y.mjs',
      'env FOO=1 echo x 2>.claude/dist/y.mjs',
      'echo x 12>.claude/dist/y.mjs',
      'echo x &>>.claude/dist/y.mjs',
      'true; echo x 2>.claude/schemas/s.json',
      'echo x 2>".claude/dist/y.mjs"',
    ]) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(2);
    }
    // A redirect to an UNPROTECTED path is still nobody's business.
    expect(run('block-upstream-edit', cmd('cat .claude/scripts/scrumux 2>/dev/null'), { deployed: true }).code)
      .toBe(0);
  });

  /**
   * THE ONE THING THE TARGETED PROBE FOUND THAT WAS NOT WHAT I EXPECTED, and
   * it is recorded rather than quietly accepted.
   *
   * `echo "x 2>.claude/dist/y.mjs"` writes nothing — the redirect is inside a
   * quoted string — and it now REFUSES. That is not a regression this change
   * introduced: the scanner has never been quote-aware, deliberately (every
   * token is scanned, which is what keeps the I-0121 heredoc route caught),
   * and the SPACED form in quotes refused before this change and still does.
   * Measured both ways at the previous HEAD.
   *
   * So what R-013 actually did here was remove an INCONSISTENCY — `> path` in
   * quoted prose blocked while `2>path` in quoted prose did not — rather than
   * add strictness. Pinned so the two spellings cannot drift apart again.
   */
  it('R-013: quoted prose is judged the same way in the glued and spaced forms', () => {
    for (const c of ['echo "x 2>.claude/dist/y.mjs"', 'echo "x > .claude/dist/y.mjs"']) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(2);
    }
  });

  /**
   * R-013's second half: a protected DIRECTORY named as an operand.
   *
   * `Expand-Archive -DestinationPath .claude/scripts` and `mv evil
   * .claude/dist` write into the machinery without ever naming a protected
   * FILE, and every pattern in `is_protected` required a `/` with something
   * after it. Dialect-independent and always true; found by the PowerShell
   * adversarial round.
   *
   * THE FALSE-POSITIVE EDGE IS THE HALF WORTH TESTING. The fix is a SEGMENT
   * boundary, not a string prefix, so a longer name that merely starts with a
   * protected directory's name stays allowed — a repo may legitimately own
   * `.claude/scriptsomething`, and a `startsWith` test would have refused it.
   */
  it('R-013: a protected DIRECTORY named as an operand is refused, at a segment boundary', () => {
    for (const c of ['mv evil .claude/scripts', 'cp evil .claude/dist/', 'mv x .claude/schemas']) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(2);
    }
    for (const c of ['mv evil .claude/scriptsomething', 'cp x .claude/disty', 'mv x agents/library']) {
      expect(run('block-upstream-edit', cmd(c), { deployed: true }).code, c).toBe(0);
    }
  });
});

// ===================================================== block-secret-reads ==
describe('block-secret-reads — the arms after the pattern test says no', () => {
  it('the Read arm ALLOWS an ordinary source file', () => {
    // The read arm's fall-through: not exempt, not conf-refused, not a secret.
    // It is the answer for almost every Read this harness ever sees, and no
    // test had taken it.
    const { code, io, gov } = run('block-secret-reads', { tool_input: { file_path: '/repo/src/app.ts' } });
    expect(code).toBe(0);
    expect(io.stderr).toBe('');
    expect(existsSync(join(gov, '.scrumux/events.jsonl'))).toBe(false);
  });

  it('an empty leading segment does not swallow the read behind it', () => {
    // `readOperands` asks cmdWords what runs each segment, and a
    // whitespace-only segment has no program word at all. Reading that as
    // anything but "no word" would have to decide what to do with it, and the
    // segment carrying the actual secret is the NEXT one.
    expect(readOperands(' ; cat /app/.env')).toContain('/app/.env');
    const { code, io } = run('block-secret-reads', cmd(' ; cat /app/.env'));
    expect(code).toBe(2);
    expect(io.stderr).toContain('scrumux secret NAME');
  });

  it('a conf refusal on a command with NO program word records an EMPTY subject', () => {
    // `ZZ=/app/secrets.json` is a whole command in which every token is an
    // assignment, so there is no program word to record. bash writes
    // `"refused":""` and so must this: manufacturing a subject out of the
    // command line is exactly the CLI-5 leak the safe-subject rule prevents.
    const { code, io, gov } = run('block-secret-reads', cmd('ZZ=/app/secrets.json --token=sk-live-xyz'),
      { conf: 'refuse secrets\\.json | this repo keeps its secrets out of agent hands\n' });
    expect(code).toBe(2);
    expect(io.stderr).toBe('BLOCKED by project-walls.conf: this repo keeps its secrets out of agent hands\n');
    const row = events(gov)[0]!;
    expect(row['wall']).toBe('project-walls.conf');
    expect(row['refused']).toBe('');
    expect(readFileSync(join(gov, '.scrumux/events.jsonl'), 'utf8')).not.toContain('sk-live-xyz');
  });
});

// ======================================================= block-direct-llm ==
describe('block-direct-llm — the conf refusal and the wordless command', () => {
  it('a conf refuse line that MATCHES quotes the repo\'s own reason', () => {
    // The failedClosed arm beside it is covered in walls-main-branches; this is
    // the ordinary one — a repo that refuses a provider hostname outright — and
    // the reason it prints is the only thing telling a reader whose rule fired.
    const { code, io, gov } = run('block-direct-llm', cmd('URL=https://api.openai.com'),
      { conf: 'refuse api\\.openai\\.com | this repo refuses provider hostnames outright\n' });
    expect(code).toBe(2);
    expect(io.stderr).toBe('BLOCKED by project-walls.conf: this repo refuses provider hostnames outright\n');
    const row = events(gov)[0]!;
    expect(row['wall']).toBe('project-walls.conf');
    // No program word exists in an assignment-only command. bash writes "".
    expect(row['refused']).toBe('');
    expect(row['reason']).toBe('this repo refuses provider hostnames outright');
  });

  it('the shell dialling a provider with NO command word still refuses', () => {
    // `URL=/dev/tcp/api.openai.com/443` reaches the provider check through
    // shellDials, and every token is an assignment, so the recorded subject is
    // empty. The wall must still refuse and must still write a row.
    const { code, io, gov } = run('block-direct-llm', cmd('URL=/dev/tcp/api.openai.com/443'));
    expect(code).toBe(2);
    expect(io.stderr).toContain('this command targets an LLM provider API directly');
    const row = events(gov)[0]!;
    expect(row['wall']).toBe('block-direct-llm');
    expect(row['refused']).toBe('');
    expect(row['reason']).toBe('targets an LLM provider API directly instead of the gateway');
  });
});

// ====================================================== block-destructive ==
describe('block-destructive — the temp forms and the bookkeeping arms', () => {
  it('isTemp accepts the BRACED ${TMPDIR} spelling', () => {
    // `${TMPDIR}/x` and `$TMPDIR/x` are the same directory and two different
    // strings. Only the bare form was tested, so the braced arm — the spelling
    // anyone writing `"${TMPDIR}/build"` uses — was never exercised.
    expect(isTemp('${TMPDIR}/build')).toBe(true);
    expect(isTemp('${TMPDIR}')).toBe(true);
    expect(isTemp('${TMPDIRX}/build')).toBe(true);   // reproduced: the prefix test is not a boundary test
    expect(isTemp('$HOME/build')).toBe(false);
    expect(run('block-destructive', cmd('rm -rf ${TMPDIR}/build')).code).toBe(0);
  });

  it('an operand that is only quotes is not a target, so the temp exemption survives', () => {
    // `rm -rf "" /tmp/x` strips to an empty word before the temp test. Judging
    // it would make `isTemp('')` the answer — false — and a command whose only
    // real target is temp would start blocking.
    expect(rmTargetsTemp('rm -rf "" /tmp/x')).toEqual({ allTemp: true, first: '/tmp/x' });
    expect(run('block-destructive', cmd('rm -rf "" /tmp/x')).code).toBe(0);
  });

  it('a conf refusal on a wordless command records an EMPTY subject', () => {
    const { code, io, gov } = run('block-destructive', cmd('ZZ=zzdanger'),
      { conf: 'refuse zzdanger | this repo refuses zzdanger\n' });
    expect(code).toBe(2);
    expect(io.stderr).toBe('BLOCKED by project-walls.conf: this repo refuses zzdanger\n');
    expect(events(gov)[0]!['refused']).toBe('');
  });

  it('CREATES governance/ when the attestation is the first thing to need it', () => {
    // A fresh deployment has no governance directory until something writes
    // one. If the attestation write assumed the directory, the first attested
    // command in a repo's life would be recorded nowhere — and this log is the
    // only record that a person claimed a backup.
    const { code, gov } = run('block-destructive', cmd('HARNESS_BACKUP_DONE=1 rm -rf /Users/x/data'),
      { governance: false });
    expect(code).toBe(0);
    const row = JSON.parse(readFileSync(join(gov, 'governance/attestations.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect(row['class']).toBe('rm-rf');
    expect(row['attested_path']).toBe('/Users/x/data');
    expect(row['command']).toBe('HARNESS_BACKUP_DONE=1 rm -rf /Users/x/data');
  });

  it('A FAILED ATTESTATION WRITE IS SILENT AND STILL EXITS 0', () => {
    // Logging never blocks the command and never prints: "a broken record must
    // not become a broken tool call." An exception escaping here would reach
    // runAsEntry's catch-all and REFUSE — turning an unwritable log into a
    // blocked command, which is the inversion this contract exists to prevent.
    const { code, io } = run('block-destructive', cmd('HARNESS_BACKUP_DONE=1 rm -rf /Users/x/data'),
      { attestBlocked: true });
    expect(code).toBe(0);
    expect(io.stderr).toBe('');
  });
});
