/**
 * Unit cover for the Wave 1B nouns and the helpers they stand on.
 *
 * The mini-differential in test/differential/nouns-wave1b.test.ts is the
 * primary gate -- it proves these modules and bash agree byte for byte. This
 * file covers the two things it cannot:
 *
 *   1. THE PIECES, in isolation, where a fixture would have to be enormous to
 *      reach them -- jq's total order over a mixed key, the roster matcher's
 *      word boundary, the hand-printed seal format.
 *   2. THE ONE NAMED DIVERGENCE. An unparseable journal produces a different
 *      finding COUNT on the two sides (bash reports one per jq reader of the
 *      file, this port one per file), so it cannot be a byte-comparison case.
 *      It is asserted here instead, because a divergence nobody asserts is a
 *      divergence that quietly becomes something else.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { RawNumber, parsePreservingNumbers } from '../../src/journal/jqformat.js';
import { defaultScriptsDir, harnessDirOf, nounContext, scriptsDirFromBundle, todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { alt, cmp, cmpString, compact, entriesOf, field, interp, numberOf, sortBy, strOr, truthy, unique } from '../../src/nouns/lib/jqlike.js';
import { SEALED_JOURNALS, brokenSeals, sealBootstrap, sealJournals, sealsShapeProblem } from '../../src/journal/seals.js';
import { MODULE as records, rosterNames, rosterSection, ruleFrontmatter, frontmatterList, splitFix, splitName } from '../../src/nouns/records.js';
import { MODULE as secret, envLines, parseEnv } from '../../src/nouns/secret.js';
import { MODULE as session, mtimeOf, stubScan } from '../../src/nouns/session.js';
import { MODULE as views } from '../../src/nouns/views.js';
import { renderAiLog, renderBacklog, renderDecisions } from '../../src/nouns/views-render.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'scrumux-w1b-unit-'));
}

function ctxFor(root: string, env: NodeJS.ProcessEnv = {}, scriptsDir = SCRIPTS): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: todayStamp(),
    io: captureIo(),
    scriptsDir,
    env,
    cwd: root,
  };
}

interface Driven {
  io: CapturedIo;
  rc: number;
}

function drive(mod: NounModule, ctx: DispatchContext, verb: string, args: string[], json = false): Driven {
  const io = captureIo();
  const cli = new Cli(verb, args, json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctx, io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

// -------------------------------------------------------------- jq order --

describe('jq semantics the views and sweeps stand on', () => {
  it('only null and false are falsy -- rank 0 keeps its annotation', () => {
    expect(truthy(new RawNumber('0'))).toBe(true);
    expect(truthy('')).toBe(true);
    expect(truthy([])).toBe(true);
    expect(truthy(null)).toBe(false);
    expect(truthy(false)).toBe(false);
    expect(truthy(undefined)).toBe(false);
  });

  it('`//` swallows false as well as null, which is why lib.sh forbids it on a boolean', () => {
    expect(alt(false, 9999)).toBe(9999);
    expect(alt(null, 9999)).toBe(9999);
    expect(alt(0, 9999)).toBe(0);
  });

  it('interpolation is the string itself, or the compact JSON', () => {
    expect(interp('T-0001')).toBe('T-0001');
    expect(interp(null)).toBe('null');
    expect(interp(true)).toBe('true');
    expect(interp(new RawNumber('1.10'))).toBe('1.10');
    expect(interp([1, 'a'])).toBe('[1,"a"]');
    expect(compact({ b: 1, a: null })).toBe('{"b":1,"a":null}');
  });

  it('the total order is null < false < true < numbers < strings < arrays', () => {
    const mixed = ['s', [1], new RawNumber('2'), true, false, null];
    expect(mixed.slice().sort(cmp).map(interp)).toEqual(['null', 'false', 'true', '2', 's', '[1]']);
  });

  it('strings compare by CODEPOINT, not by UTF-16 code unit', () => {
    // U+1F600 is above U+FFFF as a codepoint and below it as a surrogate pair.
    expect(cmpString('\u{1F600}', '＀')).toBe(1);
    expect(cmpString('a', 'ab')).toBe(-1);
    expect(cmpString('ab', 'ab')).toBe(0);
  });

  it('sort_by is stable and unique both sorts AND dedupes', () => {
    const rows = [{ k: 1, n: 'b' }, { k: 1, n: 'a' }, { k: 0, n: 'c' }];
    expect(sortBy(rows, (r) => r.k).map((r) => r.n)).toEqual(['c', 'b', 'a']);
    expect(unique(['b', 'a', 'b']).map(interp)).toEqual(['a', 'b']);
  });

  it('field() walks through a null the way jq does, without throwing', () => {
    const doc = parsePreservingNumbers('{"a":{"b":"c"}}');
    expect(field(doc, 'a', 'b')).toBe('c');
    expect(field(doc, 'x', 'y')).toBe(null);
    expect(entriesOf(doc)).toEqual([]);
    expect(strOr(null, 'z')).toBe('z');
    expect(numberOf(new RawNumber('7'))).toBe(7);
    expect(numberOf('7')).toBe(null);
  });
});

// ---------------------------------------------------------------- context --

describe('the noun context', () => {
  it('resolves the harness dir by probing, defaulting to .claude', () => {
    const d = scratch();
    try {
      expect(harnessDirOf(d)).toBe('.claude');
      mkdirSync(join(d, '.deploy-claude'));
      expect(harnessDirOf(d)).toBe('.deploy-claude');
      mkdirSync(join(d, '.claude'));
      expect(harnessDirOf(d)).toBe('.claude');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('stamps the LOCAL date, which is what `date +%F` gives', () => {
    expect(todayStamp(new Date(2026, 8, 1, 3, 0, 0))).toBe('2026-09-01');
  });

  it('finds the bash scripts dir as the bundle dir sibling', () => {
    expect(scriptsDirFromBundle('/x/.claude/dist')).toBe('/x/.claude/scripts');
    // Derived from where this code is running, never configured.
    expect(defaultScriptsDir().endsWith('/scripts')).toBe(true);
  });

  it('derives $SCRIPTS, $HARNESS_DIR, the env and the cwd, honouring an override', () => {
    const d = scratch();
    try {
      const c = nounContext({
        roots: { root: d, gov: join(d, 'governance'), workRoot: d },
        today: '2026-09-01',
        io: captureIo(),
        scriptsDir: '/h/scripts',
        env: { X: '1' },
        cwd: '/w',
      });
      // `$SCRIPTS/../..` — two up from where the bash CLI lives.
      expect(c.codeRoot).toBe('/');
      expect(c.harnessDir).toBe('.claude');
      expect(c.env['X']).toBe('1');
      expect(c.cwd).toBe('/w');
      // With nothing pinned, every derived value comes from the process.
      const bare = nounContext({
        roots: { root: d, gov: join(d, 'governance'), workRoot: d },
        today: '2026-09-01',
        io: captureIo(),
      });
      expect(bare.env).toBe(process.env);
      expect(bare.cwd).toBe(process.cwd());
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ seals --

describe('the seal', () => {
  it('is HAND-PRINTED, not jq-formatted: 2-space top level, 4-space nested', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov);
    writeFileSync(join(gov, 'tasks.json'), '{"entries":[]}\n');
    try {
      sealJournals(gov, '2026-09-01');
      const text = readFileSync(join(gov, 'seals.json'), 'utf8');
      expect(text).toMatch(/^\{\n {2}"sealed_at": "2026-09-01",\n {2}"journals": \{\n {4}"tasks\.json": "[0-9a-f]{64}"\n {2}\}\n\}\n$/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('renders an EMPTY journals map as `{\\n  }`, never jq\'s inline `{}`', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov);
    try {
      sealJournals(gov, '2026-09-01');
      expect(readFileSync(join(gov, 'seals.json'), 'utf8'))
        .toBe('{\n  "sealed_at": "2026-09-01",\n  "journals": {\n  }\n}\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('stamps bootstrapped_over_existing_content only when a journal already had entries', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov);
    try {
      writeFileSync(join(gov, 'tasks.json'), '{"entries":[]}\n');
      sealBootstrap(gov, '2026-09-01');
      expect(readFileSync(join(gov, 'seals.json'), 'utf8')).not.toContain('bootstrapped_over_existing_content');

      rmSync(join(gov, 'seals.json'));
      writeFileSync(join(gov, 'tasks.json'), '{"entries":[{"id":"T-0001"}]}\n');
      sealBootstrap(gov, '2026-09-02');
      const text = readFileSync(join(gov, 'seals.json'), 'utf8');
      expect(text).toContain('"bootstrapped_over_existing_content": "2026-09-02"');
      // The flag stamp is a real jq rewrite in bash, so the file is
      // jq-shaped from here on and the new key lands LAST.
      expect(text.trimEnd().split('\n').at(-2)).toContain('bootstrapped_over_existing_content');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('never re-creates a seal file that already exists', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov);
    try {
      writeFileSync(join(gov, 'seals.json'), 'MINE\n');
      sealBootstrap(gov, '2026-09-01');
      expect(readFileSync(join(gov, 'seals.json'), 'utf8')).toBe('MINE\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports a journal whose bytes moved, and stays SILENT on one that is gone (P-17)', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov);
    try {
      writeFileSync(join(gov, 'tasks.json'), '{"entries":[]}\n');
      sealJournals(gov, '2026-09-01');
      expect(brokenSeals(gov)).toEqual([]);
      writeFileSync(join(gov, 'tasks.json'), '{"entries":[{"id":"T-0001"}]}\n');
      expect(brokenSeals(gov)).toEqual(['tasks.json']);
      rmSync(join(gov, 'tasks.json'));
      expect(brokenSeals(gov)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('names the three degenerate seal shapes, and is silent when the file is absent', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov);
    try {
      expect(sealsShapeProblem(gov)).toBe('');
      writeFileSync(join(gov, 'seals.json'), 'nope\n');
      expect(sealsShapeProblem(gov)).toContain('is not valid JSON');
      writeFileSync(join(gov, 'seals.json'), '{"journals":"x"}\n');
      expect(sealsShapeProblem(gov)).toContain('has no .journals object');
      writeFileSync(join(gov, 'seals.json'), '{"journals":{}}\n');
      expect(sealsShapeProblem(gov)).toContain('records zero sealed journals');
      writeFileSync(join(gov, 'seals.json'), '{"journals":{"tasks.json":"x"}}\n');
      expect(sealsShapeProblem(gov)).toBe('');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('is a fixed list, never a glob -- a derived file must stay unsealed (P-22)', () => {
    expect(SEALED_JOURNALS).not.toContain('governance-graph.json');
    expect(SEALED_JOURNALS).not.toContain('code-graph.json');
    expect(SEALED_JOURNALS).not.toContain('seals.json');
    expect(SEALED_JOURNALS).toHaveLength(8);
  });
});

// -------------------------------------------------------- records helpers --

describe('records: the finding split and the roster matchers', () => {
  it('splits on the FIRST em-dash clause, so a fail row name never contains one', () => {
    expect(splitName('a — b — c')).toBe('a');
    expect(splitFix('a — b — c')).toBe('b — c');
    expect(splitName('no dash here')).toBe('no dash here');
    expect(splitFix('no dash here')).toBe('run scrumux records check for the full finding and follow its line');
  });

  it('finds a section by case-insensitive PREFIX and stops at the next heading', () => {
    const doc = '# T\n\n## Agents (roster)\none\ntwo\n\n## Skills\nthree\n';
    expect(rosterSection(doc, 'Agents')).toEqual(['one', 'two', '']);
    expect(rosterSection(doc, 'skills')).toEqual(['three']);
    // Prefix, not substring: "The Agents" would not match `want=Agents`.
    expect(rosterSection('## The Agents\nx\n', 'Agents')).toBe(null);
  });

  it('distinguishes a MISSING section from an empty one', () => {
    expect(rosterSection('## Rules\n\n## Next\n', 'Rules')).toEqual(['']);
    expect(rosterSection('## Other\n', 'Rules')).toBe(null);
  });

  it('matches a WHOLE name -- `review` is not covered by `session-review`', () => {
    expect(rosterNames(['- session-review — the close'], 'review')).toBe(false);
    expect(rosterNames(['- review — the thing'], 'review')).toBe(true);
    // `.` is a name character, so lib.sh does not match inside mylib.sh...
    expect(rosterNames(['- mylib.sh'], 'lib.sh')).toBe(false);
    expect(rosterNames(['- lib.sh'], 'lib.sh')).toBe(true);
    // ...and it is also escaped, so it is not a regex wildcard.
    expect(rosterNames(['- libXsh'], 'lib.sh')).toBe(false);
  });

  it('takes every `---` range, then trims the first and last line of the whole', () => {
    expect(ruleFrontmatter('---\nname: x\npaths: ["a"]\n---\nbody\n')).toEqual(['name: x', 'paths: ["a"]']);
    expect(ruleFrontmatter('no frontmatter\n')).toEqual([]);
  });

  it('parses a bracketed frontmatter list, stripping spaces and quotes', () => {
    const fm = ['skills: [ "a", b ,"c" ]', 'scripts: [x]'];
    expect(frontmatterList(fm, 'skills')).toEqual(['a', 'b', 'c']);
    expect(frontmatterList(fm, 'scripts')).toEqual(['x']);
    expect(frontmatterList(fm, 'hooks')).toEqual([]);
  });
});

describe('records: the duplicate-id sweep over a journal whose entries have no id', () => {
  it('raises NOTHING, because jq joins a run of nulls to the empty string', () => {
    // `repo-health.json` entries carry no `id` at all, so `[.entries[].id]` is
    // a run of nulls that groups as ONE duplicate class -- and `join(", ")`
    // renders that class as "", which `[ -n "$DUP" ]` rejects. Testing the
    // COUNT of duplicate groups instead of the joined TEXT reports every
    // id-less journal as having duplicate ids while naming none of them.
    // Found by the mini-differential against real bash, not by reading.
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov, { recursive: true });
    writeFileSync(join(gov, 'repo-health.json'), JSON.stringify({
      entries: [{ name: 'a', command: 'true' }, { name: 'b', command: 'true' }],
    }, null, 2) + '\n');
    try {
      const { io } = drive(records, ctxFor(d), 'check', [], true);
      const env = JSON.parse(io.stdout) as { checks: Array<{ name: string }> };
      expect(env.checks.filter((c) => c.name.includes('duplicate ids'))).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('DOES name a real duplicate', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov, { recursive: true });
    writeFileSync(join(gov, 'tasks.json'), JSON.stringify({
      entries: [{ id: 'T-0001' }, { id: 'T-0001' }],
    }, null, 2) + '\n');
    try {
      const { io } = drive(records, ctxFor(d), 'check', [], true);
      const env = JSON.parse(io.stdout) as { checks: Array<{ name: string }> };
      expect(env.checks.some((c) => c.name.endsWith('has duplicate ids: T-0001'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- the named divergence ---

describe('records check over an unparseable journal (the one named divergence)', () => {
  it('names the restore command and NEVER reads as clean', () => {
    const d = scratch();
    const gov = join(d, 'governance');
    mkdirSync(gov, { recursive: true });
    writeFileSync(join(gov, 'issues.json'), '{not json\n');
    try {
      const { io, rc } = drive(records, ctxFor(d), 'check', [], true);
      expect(rc).toBe(1);
      const env = JSON.parse(io.stdout) as { ok: boolean; checks: Array<{ name: string; tier: string; detail: string }> };
      expect(env.ok).toBe(false);
      const bad = env.checks.find((c) => c.name.endsWith('issues.json is not valid JSON'));
      expect(bad?.tier).toBe('fail');
      expect(bad?.detail).toContain('git checkout --');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // THE COUNT MOVED OUT, to test/unit/records-unparseable.test.ts (Harden E).
  // `src/nouns/records.ts:332` had cited that file since the sweep was written
  // and the file did not exist; the R-003 assertions now live where the ruling
  // says they live, and they run BOTH sides rather than pinning this one and
  // taking bash's half on trust. What stays here is what this file is for: the
  // section-0 row, which did NOT diverge.
});

// ------------------------------------------------------------ views render --

describe('the generated views', () => {
  it('renders an empty log as its banner and nothing else', () => {
    expect(renderAiLog(parsePreservingNumbers('{"entries":[]}'))).toMatch(/^# AI_LOG\.MD\n<!-- GENERATED VIEW/);
    expect(renderAiLog(parsePreservingNumbers('{"entries":[]}')).endsWith('-->\n\n')).toBe(true);
  });

  it('omits Verified and Pending when the fields are absent, and includes them when not', () => {
    const bare = renderAiLog(parsePreservingNumbers(
      '{"entries":[{"id":"L-0001","date":"d","title":"t","actor":"a","what_was_done":"w"}]}',
    ));
    expect(bare).not.toContain('Verified:');
    expect(bare).not.toContain('Pending:');
    expect(bare).toContain('## L-0001 · d — t\nActor: a.\nw\n\n');

    const full = renderAiLog(parsePreservingNumbers(
      '{"entries":[{"id":"L-0001","date":"d","title":"t","actor":"a","task":"T-0001",'
      + '"what_was_done":"w","verification":"v","pending":["p1","p2"]}]}',
    ));
    expect(full).toContain('Actor: a. Task: T-0001.');
    expect(full).toContain('\nVerified: v');
    expect(full).toContain('\nPending:\n- p1\n- p2\n');
  });

  it('archives a decision retired in EITHER direction', () => {
    const out = renderDecisions(parsePreservingNumbers(JSON.stringify({
      entries: [
        { id: 'D-0001', date: 'd', title: 'old', ratified_by: 'D', decision: 'x', rationale: 'y' },
        { id: 'D-0002', date: 'd', title: 'new', ratified_by: 'D', supersedes: 'D-0001', decision: 'x', rationale: 'y' },
        { id: 'D-0003', date: 'd', title: 'other', ratified_by: 'D', superseded_by: 'D-0002', decision: 'x', rationale: 'y' },
      ],
    })));
    expect(out).toContain('# Superseded (archive — NOT current law)');
    expect(out).toContain('SUPERSEDED by D-0002:\n## D-0001');
    expect(out).toContain('SUPERSEDED by D-0002:\n## D-0003');
    // D-0002 is current law and must appear ABOVE the archive marker.
    expect(out.indexOf('## D-0002')).toBeLessThan(out.indexOf('# Superseded'));
  });

  it('ranks 0 first and annotates it -- 0 is TRUTHY in jq', () => {
    const out = renderBacklog(parsePreservingNumbers(JSON.stringify({
      entries: [
        { id: 'T-0002', title: 'second', status: 'ready', acceptance_check: 'b', rank: 5 },
        { id: 'T-0001', title: 'first', status: 'ready', acceptance_check: 'a', rank: 0 },
        { id: 'T-0003', title: 'last', status: 'ready', acceptance_check: 'c' },
      ],
    })), null);
    expect(out).toContain('- **T-0001** (rank 0) first');
    expect(out.indexOf('T-0001')).toBeLessThan(out.indexOf('T-0002'));
    // 9999 puts the unranked task after both.
    expect(out.indexOf('T-0002')).toBeLessThan(out.indexOf('T-0003'));
  });

  it('says so when there are no tasks at all', () => {
    expect(renderBacklog(null, null)).toContain('_No tasks yet. Create one:');
  });

  it('annotates a sprint by hotfix or by epic, never both', () => {
    const out = renderBacklog(parsePreservingNumbers('{"entries":[{"id":"T-0001","title":"t","status":"ready","acceptance_check":"a"}]}'), parsePreservingNumbers(JSON.stringify({
      entries: [
        { id: 'SP-0001', status: 'ratified', epic: 'E-0001', tasks: ['T-0001'] },
        { id: 'SP-0002', status: 'proposed', hotfix: true, source_issue: 'I-0001', tasks: [] },
      ],
    })));
    expect(out).toContain('- **SP-0001** [ratified] epic E-0001 — tasks: T-0001');
    expect(out).toContain('- **SP-0002** [proposed] HOTFIX from I-0001 — tasks: (none yet)');
  });
});

// ----------------------------------------------------------------- secret --

describe('secret list parsing', () => {
  it('drops a final line with no newline, the way `while read` does', () => {
    expect(envLines('A=1\nB=2\n')).toEqual(['A=1', 'B=2']);
    expect(envLines('A=1\nB=2')).toEqual(['A=1']);
    expect(envLines('')).toEqual([]);
  });

  it('strips an `export ` prefix so the name renders bare (PK-13)', () => {
    expect(parseEnv('export FOO=bar\n').map((r) => r.name)).toEqual(['FOO']);
    expect(parseEnv(' FOO=bar\n').map((r) => r.name)).toEqual(['FOO']);
  });

  it('skips blanks, comments and lines with no `=`', () => {
    expect(parseEnv('\n# c\nNOPAIR\nA=1\n').map((r) => r.name)).toEqual(['A']);
  });

  it('counts BYTES, not UTF-16 code units, and never carries the value', () => {
    const [row] = parseEnv('A=café\n');
    expect(row!.bytes).toBe(5);
    expect(row!.sha256_prefix).toHaveLength(8);
    expect(JSON.stringify(row)).not.toContain('café');
  });
});

// ---------------------------------------------------------------- session --

describe('session check helpers', () => {
  it('reports whole-second mtimes, and 0 for a path that is not there', () => {
    const d = scratch();
    try {
      const p = join(d, 'f');
      writeFileSync(p, 'x');
      utimesSync(p, 1_700_000_000, 1_700_000_000);
      expect(mtimeOf(p)).toBe(1_700_000_000);
      expect(mtimeOf(join(d, 'nope'))).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('finds every marker on a line, prunes the eight top-level dirs, and skips the generated views', () => {
    const d = scratch();
    try {
      writeFileSync(join(d, 'a.js'), 'x // STUB(I-0001)\ny STUB(I-0002) STUB(I-0003)\n');
      writeFileSync(join(d, 'BACKLOG.MD'), 'STUB(I-0009)\n');
      mkdirSync(join(d, 'node_modules'));
      writeFileSync(join(d, 'node_modules/dep.js'), 'STUB(I-0008)\n');
      mkdirSync(join(d, 'src/node_modules'), { recursive: true });
      writeFileSync(join(d, 'src/node_modules/nested.js'), 'STUB(I-0007)\n');
      const hits = stubScan(d);
      expect(hits).toContain('a.js:1:STUB(I-0001)');
      expect(hits).toContain('a.js:2:STUB(I-0002)');
      expect(hits).toContain('a.js:2:STUB(I-0003)');
      // Pruned at the TOP LEVEL only -- a nested node_modules is walked.
      expect(hits).not.toContain('node_modules/dep.js:1:STUB(I-0008)');
      expect(hits).toContain('src/node_modules/nested.js:1:STUB(I-0007)');
      expect(hits.some((h) => h.startsWith('BACKLOG.MD'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------ the module surface --

describe('the three-part seam every module publishes', () => {
  const mods: Array<[string, NounModule]> = [
    ['records', records], ['session', session], ['views', views], ['secret', secret],
  ];

  it('answers verbs() as TAB-separated rows and usage() as its own block', () => {
    for (const [noun, m] of mods) {
      // `<noun>_verbs` is `verb<TAB>gloss` per line, ending in a newline --
      // the same bytes the bash heredoc emits, which is what the control
      // plane's surface reader consumes.
      const rows = m.verbs().split('\n').filter((l) => l !== '');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const [verb, gloss] = row.split('\t');
        expect(verb).toBeTruthy();
        expect(gloss).toBeTruthy();
      }
      expect(m.verbs().endsWith('\n')).toBe(true);
      expect(m.usage()).toContain(`scrumux ${noun}`);
      expect(m.usage().endsWith('\n')).toBe(true);
    }
  });

  it('refuses an unknown verb at exit 2, naming what there is', () => {
    const d = scratch();
    try {
      for (const [noun, m] of mods) {
        const { io, rc } = drive(m, ctxFor(d), 'nonsense', []);
        expect(rc).toBe(2);
        expect(io.stderr).toContain(`unknown verb 'nonsense' for noun ${noun}`);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // The Wave 1B assertion here was that `secret set` and `secret remove`
  // REFUSED by name, because the write half was deliberately not ported. Both
  // landed in Wave 3F, so what is worth asserting is the opposite: that the
  // arity guards still refuse ahead of any filesystem work. The write path
  // itself is covered in test/unit/nouns-wave3f.test.ts and by the tier-2
  // differential cases, which compare `.env`'s bytes AND its mode.
  it('guards the secret write verbs by arity before touching the filesystem', () => {
    const d = scratch();
    try {
      expect(drive(secret, ctxFor(d), 'set', []).rc).toBe(2);
      expect(drive(secret, ctxFor(d), 'remove', []).rc).toBe(2);
      expect(drive(secret, ctxFor(d), 'remove', ['A', 'B']).rc).toBe(2);
      expect(existsSync(join(d, '.env'))).toBe(false);
      expect(existsSync(join(d, '.gitignore'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses arguments the verbs do not take', () => {
    const d = scratch();
    try {
      for (const [m, verb] of [[session, 'check'], [views, 'render'], [secret, 'list']] as const) {
        const { rc } = drive(m, ctxFor(d), verb, ['extra']);
        expect(rc).toBe(2);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a records flag it does not know, and a second directory', () => {
    const d = scratch();
    try {
      expect(drive(records, ctxFor(d), 'check', ['--nope']).rc).toBe(2);
      expect(drive(records, ctxFor(d), 'check', ['a', 'b']).rc).toBe(2);
      expect(drive(records, ctxFor(d), 'check', ['no-such-dir']).rc).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('views render turns a graph-build failure into a FAIL and exits there', () => {
    // No `<harness>/scripts/scrumux` under this root, so the graph cannot be
    // rebuilt. The explicit request must not report success it did not
    // achieve -- and it must not reach the pass row after failing (P-14).
    const d = scratch();
    mkdirSync(join(d, 'governance'), { recursive: true });
    try {
      const { io, rc } = drive(views, ctxFor(d, {}, join(d, 'nowhere')), 'render', [], true);
      expect(rc).toBe(1);
      expect(io.stderr).toContain('is missing or not executable');
      const env = JSON.parse(io.stdout) as { checks: Array<{ name: string; tier: string }> };
      expect(env.checks).toHaveLength(1);
      expect(env.checks[0]!.name).toBe('governance-graph');
      expect(env.checks[0]!.tier).toBe('fail');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('session check on a bare tree still produces a verdict', () => {
    const d = scratch();
    try {
      const { io, rc } = drive(session, ctxFor(d), 'check', []);
      expect(rc).toBe(0);
      expect(io.stdout).toContain('VERDICT: clean.');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
