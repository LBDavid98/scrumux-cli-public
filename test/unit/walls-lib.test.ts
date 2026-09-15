import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConf, splitRule, allows, refuses, reasonFor, emitWarnings } from '../../src/walls/lib/conf.js';
import { canCallOut, canReadFile, shellReads, shellDials } from '../../src/walls/lib/predicates.js';
import { wallsRecord } from '../../src/walls/lib/record.js';
import { jqCompact, jqString } from '../../src/walls/lib/jsonl.js';
import {
  captureWallIo, wallExitCode, WallExit, allow, refuse, refuseOldNode, runAsEntry,
} from '../../src/walls/lib/hook.js';
import { pathToFileURL } from 'node:url';

const scratch: string[] = [];
function repoWith(conf: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'wallconf-'));
  scratch.push(d);
  mkdirSync(join(d, '.claude'), { recursive: true });
  if (conf !== null) writeFileSync(join(d, '.claude/project-walls.conf'), conf);
  return d;
}
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// ------------------------------------------------------------------ conf --
describe('project-walls.conf — the one pathway a repo extends the walls', () => {
  it('splits the reason at the LAST pipe, not the first', () => {
    // Splitting at the first truncated any pattern that legally contained one:
    // `refuse (foo|bar)\.env` became `(foo`, and the merged alternation became
    // unbalanced-parens garbage.
    expect(splitRule('refuse', 'refuse (foo|bar)\\.env | this repo ships neither'))
      .toEqual({ pattern: '(foo|bar)\\.env', reason: 'this repo ships neither' });
  });

  it('allow wins, including over a built-in wall (P-29)', () => {
    const c = loadConf(repoWith('allow rm -rf ./archive | the archive really is meant to go\n'));
    expect(allows(c, 'rm -rf ./archive')).toBe(true);
  });

  it('a refuse rule refuses, and says whose rule it was', () => {
    const c = loadConf(repoWith('refuse terraform destroy | this repo owns production\n'));
    expect(refuses(c, 'terraform destroy -auto-approve').refused).toBe(true);
    expect(reasonFor(c, 'refuse', 'terraform destroy')).toBe('this repo owns production');
  });

  it('ONE BAD PATTERN DOES NOT TAKE THE REST DOWN (P-28)', () => {
    // The measured failure this closes: a conf with a legal `(foo|bar)\.env`
    // rule disabled its `id_rsa` rule too, because the MERGED alternation
    // failed to compile and any non-zero read as "not refused".
    const c = loadConf(repoWith(
      'refuse ( | a pattern that cannot compile\n'
      + 'refuse id_rsa | this repo has no ssh keys in it\n',
    ));
    expect(refuses(c, 'cat ~/.ssh/id_rsa').refused).toBe(true);
    expect(c.warnings.some((w) => w.includes('invalid refuse pattern'))).toBe(true);
  });

  it('a rule with NO REASON is skipped and NAMED, on both verbs (OQ-4)', () => {
    // The bash filter is `grep -F '|'`, which proves a pipe is present and not
    // that anything follows it. So a reasonless rule was silently ACTIVE:
    // "BLOCKED by project-walls.conf: " with nothing after the colon on the
    // refuse side, and an unauditable exemption on the allow side.
    const c = loadConf(repoWith('refuse zzdanger|\nallow zzfine|   \n'));
    expect(refuses(c, 'zzdanger --now').refused).toBe(false);
    expect(allows(c, 'zzfine')).toBe(false);
    expect(c.warnings.filter((w) => w.includes('no reason'))).toHaveLength(2);
  });

  it('names every skip on stderr, and does it ONCE', () => {
    // bash re-parses the conf per call and can print the same complaint three
    // times in one hook run. This parses once. Observable, batched at the gate.
    const c = loadConf(repoWith('refuse ( | broken\n'));
    const lines: string[] = [];
    emitWarnings(c, (s) => lines.push(s));
    expect(lines).toHaveLength(1);
  });

  it('comments are stripped and a bare comment line is not a rule', () => {
    const c = loadConf(repoWith('# refuse everything | nope\nrefuse zz | real\n'));
    expect(c.rules.filter((r) => r.skipped === null)).toHaveLength(1);
  });

  it('an absent conf is a normal state, not an error', () => {
    const c = loadConf(repoWith(null));
    expect(c.present).toBe(false);
    expect(allows(c, 'anything')).toBe(false);
    expect(refuses(c, 'anything').refused).toBe(false);
  });

  it('matches case-INSENSITIVELY, as every wall matcher does', () => {
    const c = loadConf(repoWith('refuse DROP TABLE | this repo owns production data\n'));
    expect(refuses(c, 'psql -c "drop table users"').refused).toBe(true);
  });

  it('allows fails closed by returning NOT EXEMPT when it cannot tell', () => {
    // An exemption is the one place a wall stops looking, so the doubtful
    // answer is "keep looking".
    const c = loadConf(repoWith('allow ( | broken exemption\n'));
    expect(allows(c, 'anything')).toBe(false);
  });

  it('refuses fails closed by REFUSING on a pattern it cannot evaluate (OQ-8/D-0085)', () => {
    // Two different codes, one direction: when in doubt, refuse. This is the
    // case bash cannot have -- a valid ERE that JavaScript will not compile.
    const c = loadConf(repoWith('refuse a{2,1} | an interval JS rejects\n'));
    const r = refuses(c, 'totally unrelated command');
    expect(r.refused).toBe(true);
    expect(r.failedClosed).toBe(true);
  });

  it('...and the same pattern on an ALLOW line is skipped, never honoured', () => {
    const c = loadConf(repoWith('allow a{2,1} | an interval JS rejects\n'));
    expect(allows(c, 'aa')).toBe(false);
  });
});

// ------------------------------------------------------------ predicates --
describe('what a command can actually DO', () => {
  it('a program that can reach the network', () => {
    expect(canCallOut('curl https://example.com')).toBe(true);
    expect(canCallOut('echo https://example.com')).toBe(false);
  });

  it('a program that can read a file', () => {
    expect(canReadFile('cat .env')).toBe(true);
    expect(canReadFile('git commit -m "wired .env loading"')).toBe(false);
  });

  it('the D-0085 readers are in the list (OQ-11, tightened in BASH first)', () => {
    for (const p of ['dd', 'nl', 'tac', 'bat', 'vim', 'view', 'ex']) {
      expect(canReadFile(`${p} .env`), p).toBe(true);
    }
  });

  it('EXACT whole-word match: catfish does not answer for cat', () => {
    expect(canReadFile('catfish .env')).toBe(false);
    expect(canCallOut('curlicue http://x')).toBe(false);
  });

  it('a wrapped reader still surfaces (P-27 item 2)', () => {
    expect(canReadFile('nice -n 10 cat .env')).toBe(true);
    expect(canReadFile('busybox cat .env')).toBe(true);
    expect(canCallOut('timeout 5 curl https://x')).toBe(true);
  });

  it('shell-level reads, where no program ever sees a path (I-0142)', () => {
    expect(shellReads('read K < .env')).toBe(true);
    expect(shellReads('X=$(<.env)')).toBe(true);
    expect(shellReads('while read l; do :; done < .env')).toBe(true);
    expect(shellReads('exec 3<> /dev/tcp/h/443')).toBe(true);
    expect(shellReads('echo hi')).toBe(false);
  });

  it('the shell as a network client', () => {
    expect(shellDials('exec 3<>/dev/tcp/host/443')).toBe(true);
    expect(shellDials('curl https://x')).toBe(false);
  });

  it('shellReads is NOT quote-aware, and that is reproduced not repaired (OQ-W1)', () => {
    // The opposite discipline from cmdWords, whose whole reason for existing is
    // that a raw match over an unparsed string trips on quoted prose. Nothing
    // in bash, a ruling or a test addresses the asymmetry; making these
    // quote-aware would LOOSEN two walls, which is a ruling and not a port.
    expect(shellDials('scrumux issue new --summary "never leave /dev/tcp/h/1 open"')).toBe(true);
  });
});

// ---------------------------------------------------------------- record --
describe('walls_record cannot fail the caller (P-08)', () => {
  it('writes one compact row', () => {
    const d = repoWith(null);
    wallsRecord({
      root: d, wall: 'block-destructive', subject: 'rm', reason: 'because',
      payload: { session_id: 's1', agent_id: 'a1' }, now: new Date('2026-08-31T12:00:00Z'), pid: 42,
    });
    const rows = readFileSync(join(d, '.scrumux/events.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    const row = JSON.parse(rows[0]!);
    expect(row).toMatchObject({
      v: 1, kind: 'wall', wall: 'block-destructive', refused: 'rm', reason: 'because',
      sessionId: 's1', subAgent: 'a1', repoPath: d, sanctionedPath: null,
    });
    expect(row.at).toBe('2026-08-31T12:00:00Z');
  });

  it('sessionId and subAgent are NULL, never a manufactured id', () => {
    // A wall fires from a plain CLI run with no agent near it, and "unknown"
    // was being grouped into a SESSION that showed as running for ever with no
    // close event. Same defect class as --by defaulting to User.
    const d = repoWith(null);
    wallsRecord({ root: d, wall: 'w', subject: 's', reason: 'r' });
    const row = JSON.parse(readFileSync(join(d, '.scrumux/events.jsonl'), 'utf8').trim());
    expect(row.sessionId).toBeNull();
    expect(row.subAgent).toBeNull();
  });

  it('truncates the subject at 200 and the reason at 400', () => {
    const d = repoWith(null);
    wallsRecord({ root: d, wall: 'w', subject: 'x'.repeat(500), reason: 'y'.repeat(900) });
    const row = JSON.parse(readFileSync(join(d, '.scrumux/events.jsonl'), 'utf8').trim());
    expect(row.refused).toHaveLength(200);
    expect(row.reason).toHaveLength(400);
  });

  it('DOES NOT THROW when the directory cannot be created', () => {
    // The whole contract. A failed record must never become a failed tool
    // call: "a wall that fails because its bookkeeping failed would be worse
    // than the write it prevented."
    expect(() => wallsRecord({ root: '/dev/null/nope', wall: 'w', subject: 's', reason: 'r' })).not.toThrow();
  });

  it('DOES NOT THROW on an unwritable events file', () => {
    const d = repoWith(null);
    mkdirSync(join(d, '.scrumux'), { recursive: true });
    mkdirSync(join(d, '.scrumux/events.jsonl'), { recursive: true });   // a DIRECTORY
    expect(() => wallsRecord({ root: d, wall: 'w', subject: 's', reason: 'r' })).not.toThrow();
    expect(existsSync(join(d, '.scrumux/events.jsonl'))).toBe(true);
  });
});

// ----------------------------------------------------------------- jsonl --
describe('the .jsonl writer is jq -c, a second formatter', () => {
  it('is compact: no spaces after a colon or a comma', () => {
    expect(jqCompact({ a: 1, b: [1, 2], c: { d: null } })).toBe('{"a":1,"b":[1,2],"c":{"d":null}}');
  });

  it('escapes DEL, which jq does and JSON.stringify does not', () => {
    expect(jqString('ab')).toBe('"a\\u007fb"');
  });

  it('does NOT escape a forward slash', () => {
    expect(jqString('https://a/b')).toBe('"https://a/b"');
  });

  it('emits non-ASCII raw, as jq does without -a', () => {
    expect(jqString('café 🙂')).toBe('"café 🙂"');
  });

  it('escapes the control characters jq names, and \\u-escapes the rest', () => {
    expect(jqString('\b\t\n\f\r"\\')).toBe('"\\b\\t\\n\\f\\r\\"\\\\"');
    expect(jqString('')).toBe('"\\u0001"');
  });
});

// ------------------------------------------------------------ the seam ---
describe('the wall runtime seam', () => {
  it('captureWallIo collects stderr and throws on exit', () => {
    const io = captureWallIo('{}');
    io.err('a line\n');
    expect(io.stderr).toBe('a line\n');
    expect(() => io.exit(2)).toThrow(WallExit);
  });

  it('wallExitCode reports the code a wall asked for', () => {
    expect(wallExitCode(() => { throw new WallExit(2); })).toBe(2);
  });

  it('a wall that RETURNS without exiting is a defect, not a pass', () => {
    // Every path must end in io.exit. A wall that fell off the end would
    // otherwise read as exit 0 — waving the tool call through.
    expect(() => wallExitCode(() => { /* falls off the end */ })).toThrow(/without exiting/);
  });

  it('a real error is not swallowed as an exit code', () => {
    expect(() => wallExitCode(() => { throw new TypeError('a genuine bug'); })).toThrow(TypeError);
  });

  it('allow and refuse go through the seam', () => {
    const io = captureWallIo('{}');
    expect(() => allow(io)).toThrow(WallExit);
    const io2 = captureWallIo('{}');
    let code = -1;
    try { refuse(io2, 'BLOCKED by x: because'); } catch (e) { code = (e as WallExit).code; }
    expect(code).toBe(2);
    expect(io2.stderr).toBe('BLOCKED by x: because\n');
  });

  it('refuseOldNode passes a supported runtime and REFUSES an old one', () => {
    const ok = captureWallIo('{}');
    expect(() => refuseOldNode('w', ok, 'v24.0.0')).not.toThrow();
    const old = captureWallIo('{}');
    let code = -1;
    try { refuseOldNode('block-x', old, 'v20.0.0'); } catch (e) { code = (e as WallExit).code; }
    expect(code).toBe(2);
    expect(old.stderr).toContain('BLOCKED by block-x');
    expect(old.stderr).toContain('Node >=22.11');
    expect(old.stderr).toContain('nothing was read or written');
  });
});

describe('runAsEntry — the guard, written once', () => {
  const noop = (): never => { throw new WallExit(0); };

  // DERIVED, not the literal 'file:///a.mjs' these two cases used to pass.
  // `fileURLToPath` is what runAsEntry calls first, and on Windows a file
  // URL with no drive letter is not a path it can produce one from -- it
  // throws ERR_INVALID_FILE_URL_PATH before the guard is reached, so the
  // case died on the exception rather than asserting the guard (measured on
  // windows-latest, first CI run, 2026-09-02). `resolve` makes an absolute
  // path this platform recognises; the shape under test -- a module URL and
  // an argv[1] that name DIFFERENT files -- is exactly as before.
  const modUrl = pathToFileURL(resolve('/a.mjs')).href;
  const otherEntry = resolve('/b.mjs');

  it('does nothing when this module is not the process entry', () => {
    let exited = -1;
    runAsEntry('w', modUrl, noop, ['node', otherEntry], (c) => { exited = c; });
    expect(exited).toBe(-1);
  });

  it('does nothing when there is no entry at all', () => {
    let exited = -1;
    runAsEntry('w', modUrl, noop, ['node'], (c) => { exited = c; });
    expect(exited).toBe(-1);
  });

  it('RUNS when argv[1] names the same file through a `..` component', () => {
    // The regression this exists for: the shim execs
    // `node ".../.claude/hooks/../dist/<wall>.mjs"`, and comparing URL strings
    // does not normalise the `..`. The guard declined, every wall exited 0
    // having evaluated nothing, and 211 hook assertions went red at once while
    // the direct-.mjs differential stayed green.
    const real = resolve(import.meta.dirname, '../../package.json');
    const viaDotDot = resolve(import.meta.dirname, '../../src/../package.json');
    let exited = -1;
    runAsEntry('w', pathToFileURL(real).href, () => { throw new WallExit(2); },
      ['node', viaDotDot], (c) => { exited = c; });
    expect(exited).toBe(2);
  });

  it('...and a relative argv[1] naming the same file', () => {
    const real = resolve(import.meta.dirname, '../../package.json');
    let exited = -1;
    runAsEntry('w', pathToFileURL(real).href, () => { throw new WallExit(0); },
      ['node', relative(process.cwd(), real)], (c) => { exited = c; });
    expect(exited).toBe(0);
  });

  it('turns a WallExit into a real exit code', () => {
    let exited = -1;
    runAsEntry('w', pathToFileURL('/a.mjs').href, () => { throw new WallExit(2); },
      ['node', '/a.mjs'], (c) => { exited = c; });
    expect(exited).toBe(2);
  });

  it('an UNHANDLED error REFUSES, it does not wave the call through', () => {
    // A wall that crashed open would be the silent no-op the jq guard exists
    // to prevent (CLI-1). Exit 2 means block.
    let exited = -1;
    let err = '';
    runAsEntry('block-x', pathToFileURL('/a.mjs').href, () => { throw new TypeError('boom'); },
      ['node', '/a.mjs'], (c) => { exited = c; }, (s) => { err += s; });
    expect(exited).toBe(2);
    expect(err).toContain('BLOCKED by block-x');
    expect(err).toContain('boom');
    expect(err).toContain('fail-closed, CLI-1');
  });
});
