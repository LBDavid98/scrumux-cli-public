/**
 * Wave 4H — the harness noun's tricky pure logic, plus one real deploy.
 *
 * The differential fixtures (test/fixtures/tier2-wave4h.mjs) hold the two
 * verbs to bash byte-for-byte; what belongs HERE is the logic whose failure
 * modes a byte comparison would only show as a mystery diff:
 *
 *   - the find-order walk (raw readdir, in-place descent — asserted against
 *     /usr/bin/find by PATH, because a first cut compared against a shell
 *     whose `find` was silently a bfs wrapper and learned a wrong order);
 *   - the payload-exclude list's parsing corners;
 *   - the dot-file exclusion being per-BASENAME, never a directory prune
 *     (module brief, open item 7);
 *   - the settings inspectors' error shape (empty answers, as bash's
 *     `jq … 2>/dev/null` yields — the recorded looseness);
 *   - the probe verdict precedence (traceback first, then the fixed rc set,
 *     then the declared refusal);
 *   - the drift split and the ls-mode string;
 *   - the schema sweep's two arms (rewritten in Wave 5I: the sweep is native
 *     now, so "no interpreter can run" is a state this side does not have —
 *     see the note on that describe block).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cli } from '../../src/cli/envelope.js';
import { captureIo, ExitSignal } from '../../src/cli/exit.js';
import {
  allPayloadFiles, parseExcludeList, payloadExcluded, payloadFiles, srcPathOf, walkLikeFind,
  SURFACE_PROBES, SURFACE_EXEMPT,
} from '../../src/nouns/harness/payload.js';
import { hookTargets, lsMode, missingChains, settingsFixText } from '../../src/nouns/harness/settings.js';
import { driftClass, probeVerdict, schemaSweepCheck } from '../../src/nouns/harness/verify.js';
import {
  firstLineCut, grepHead3Semis, shHead, shQuote, stripTrailingNewlines, trNewlines,
} from '../../src/nouns/harness/util.js';
import { MODULE, VERBS } from '../../src/nouns/harness.js';

const CHECKOUT = resolve(__dirname, '../..');
const SRC_CLAUDE = join(CHECKOUT, '.deploy-claude');

describe('walkLikeFind matches /usr/bin/find', () => {
  it('agrees with find -type f over every payload directory', () => {
    for (const d of ['scripts', 'rules', 'skills', 'schemas', 'agents', 'dist']) {
      const base = join(SRC_CLAUDE, d);
      const found = execFileSync('/usr/bin/find', [base, '-type', 'f'], { encoding: 'utf8' })
        .split('\n').filter((l) => l !== '');
      expect(walkLikeFind(base), `order for ${d}`).toEqual(found);
    }
  });

  it('descends into a directory at the point it is encountered, not after its siblings', () => {
    const t = mkdtempSync(join(tmpdir(), 'w4h-walk-'));
    try {
      mkdirSync(join(t, 'z_first/nested'), { recursive: true });
      mkdirSync(join(t, 'a_dir'));
      for (const f of ['mm', 'aa', 'zz', 'z_first/f1', 'z_first/nested/f3', 'a_dir/f2']) {
        writeFileSync(join(t, f), 'x\n');
      }
      const found = execFileSync('/usr/bin/find', [t, '-type', 'f'], { encoding: 'utf8' })
        .split('\n').filter((l) => l !== '');
      expect(walkLikeFind(t)).toEqual(found);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe('the payload roster', () => {
  it('parses the exclude list the way payload_excluded reads it', () => {
    const rules = parseExcludeList([
      '# a comment',
      '   # indented comment',
      '',
      '.claude/rules/source-session.md',
      '  .claude/agents/finding-validator.md',
      '.claude/skills/source-implement/   # a skill is a DIRECTORY',
      '.claude/rules/other.md trailing words absorbed',
    ].join('\n'));
    expect(payloadExcluded('.claude/rules/source-session.md', rules)).toBe(true);
    expect(payloadExcluded('.claude/agents/finding-validator.md', rules)).toBe(true);
    expect(payloadExcluded('.claude/skills/source-implement/SKILL.md', rules)).toBe(true);
    expect(payloadExcluded('.claude/skills/source-implement/new-reference.md', rules)).toBe(true);
    expect(payloadExcluded('.claude/rules/other.md', rules)).toBe(true);
    // a prefix rule is a PREFIX, not a parent: the bare dir name misses it
    expect(payloadExcluded('.claude/skills/source-implement', rules)).toBe(false);
    expect(payloadExcluded('.claude/rules/source-session.md.bak', rules)).toBe(false);
  });

  it('excludes dot-files by BASENAME only — a regular file inside a dot-directory still ships', () => {
    const t = mkdtempSync(join(tmpdir(), 'w4h-dots-'));
    try {
      mkdirSync(join(t, 'rules/.hidden'), { recursive: true });
      writeFileSync(join(t, 'rules/.dotfile'), 'skip\n');
      writeFileSync(join(t, 'rules/keep.md'), 'ship\n');
      writeFileSync(join(t, 'rules/.hidden/inside.md'), 'ships too — find tests the basename\n');
      writeFileSync(join(t, 'rules/x.pyc'), 'skip\n');
      writeFileSync(join(t, 'rules/.DS_Store'), 'skip\n');
      const got = payloadFiles('rules', t, []);
      expect(got).toContain('.claude/rules/keep.md');
      expect(got).toContain('.claude/rules/.hidden/inside.md');
      expect(got.some((p) => p.endsWith('.dotfile') || p.endsWith('.pyc') || p.endsWith('.DS_Store'))).toBe(false);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it('maps roster paths through the ONE seam: .claude/* onto the payload dir, the rest onto the repo', () => {
    expect(srcPathOf('.claude/scripts/scrumux', '/s/.deploy-claude', '/s')).toBe('/s/.deploy-claude/scripts/scrumux');
    expect(srcPathOf('agents/lib/schema_check.py', '/s/.deploy-claude', '/s')).toBe('/s/agents/lib/schema_check.py');
  });

  it('this repo\'s roster ships the built bundles and drops the excluded guidance', () => {
    const roster = allPayloadFiles(SRC_CLAUDE, CHECKOUT);
    expect(roster).toContain('.claude/scripts/scrumux');
    expect(roster).toContain('.claude/dist/scrumux.mjs');
    expect(roster).not.toContain('.claude/rules/source-session.md');
    expect(roster).not.toContain('.claude/agents/finding-validator.md');
    expect(roster.some((p) => p.startsWith('.claude/skills/source-implement/'))).toBe(false);
  });

  it('every .claude/scripts roster entry is probed or exempt — the coverage rule holds over the real payload', () => {
    const roster = allPayloadFiles(SRC_CLAUDE, CHECKOUT).filter((p) => p.startsWith('.claude/scripts/'));
    for (const sp of roster) {
      const covered = SURFACE_PROBES.some((p) => `${p.argv} `.startsWith(`${sp} `))
        || SURFACE_EXEMPT.some((e) => (e.path.endsWith('/') ? sp.startsWith(e.path) : e.path === sp));
      expect(covered, `${sp} must be probed or exempt`).toBe(true);
    }
  });
});

describe('settings inspection', () => {
  const full = JSON.parse(readFileSync(join(SRC_CLAUDE, 'settings.json'), 'utf8'));

  it('the shipped settings.json declares all four chains', () => {
    expect(missingChains(full)).toBe('');
  });

  it('names every absent chain in roster order', () => {
    expect(missingChains({ hooks: {} }))
      .toBe('PreToolUse:Bash|PowerShell PreToolUse:Read PreToolUse:Edit|Write|NotebookEdit SessionStart');
    expect(missingChains({
      hooks: { SessionStart: [{ matcher: 'resume', hooks: [] }] },
    })).toBe('PreToolUse:Bash|PowerShell PreToolUse:Read PreToolUse:Edit|Write|NotebookEdit');
  });

  it('answers EMPTY on anything jq would error on — the recorded looseness, reproduced', () => {
    // bash: `jq … 2>/dev/null` yields no output, and the caller reads that as
    // "nothing missing" — over a scalar, a string .hooks, a non-string matcher.
    expect(missingChains(undefined)).toBe('');
    expect(missingChains(5 as never)).toBe('');
    expect(missingChains({ hooks: 'nope' } as never)).toBe('');
    expect(missingChains({ hooks: { PreToolUse: [{ matcher: 7 }] } } as never)).toBe('');
    // `true` cannot be matched either — jq errors, the answer collapses.
    expect(missingChains({ hooks: { PreToolUse: [{ matcher: true }] } } as never)).toBe('');
  });

  it('treats a false matcher and a null element as jq does: no match, NOT an error', () => {
    // `false // ""` is "" in jq (`//` treats false like null), and
    // `null | .matcher` is null, not an error — so both shapes leave the
    // chains unmatched and REPORTED MISSING, unlike the error shapes above.
    // Verified against jq 1.7.1 with the live predicate.
    const all = 'PreToolUse:Bash|PowerShell PreToolUse:Read PreToolUse:Edit|Write|NotebookEdit SessionStart';
    expect(missingChains({ hooks: { PreToolUse: [{ matcher: false }] } } as never)).toBe(all);
    expect(missingChains({ hooks: { PreToolUse: [null] } } as never)).toBe(all);
  });

  it('hook_targets walks the declared chains and applies the // defaults', () => {
    const doc = {
      hooks: {
        PreToolUse: [
          { hooks: [{ command: 'a.sh' }, { type: 'command', command: 'b.sh arg' }] },
          { hooks: [{ type: 'other', command: 'skipped.sh' }, { type: 'command' }] },
        ],
        SessionStart: 'not-an-array',
      },
    };
    // Shell form: `file` is the command CUT AT THE FIRST SPACE, which is what
    // both callers used to do for themselves (`${hp%% *}`).
    expect(hookTargets(doc as never)).toEqual([
      { form: 'shell', program: '', file: 'a.sh', raw: 'a.sh' },
      { form: 'shell', program: '', file: 'b.sh', raw: 'b.sh arg' },
    ]);
    expect(hookTargets(undefined)).toEqual([]);
    expect(hookTargets({ hooks: 42 } as never)).toEqual([]);
  });

  /**
   * EXEC FORM IS A DIFFERENT ANSWER TO THE SAME QUESTION, and getting it wrong
   * is silent. `command` is the EXECUTABLE Claude Code resolves on PATH and
   * the script is `args[0]`; the old shell-form cut over an exec-form entry
   * yields the word "node", `[ -f node ]` is false, and deploy would report
   * all four walls as dead hooks on a target where nothing is wrong.
   */
  it('hook_targets reads exec form as program + args[0], never as a cut command', () => {
    const doc = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash|PowerShell',
          hooks: [{
            type: 'command',
            command: 'node',
            args: ['${CLAUDE_PROJECT_DIR}/.claude/dist/block-destructive.mjs'],
          }],
        }],
      },
    };
    expect(hookTargets(doc as never)).toEqual([{
      form: 'exec',
      program: 'node',
      file: '${CLAUDE_PROJECT_DIR}/.claude/dist/block-destructive.mjs',
      raw: 'node',
    }]);
    // An EMPTY args array is shell form by the doc's rule ("runs as exec form
    // when `args` is set") only when it is set to something to spawn with; an
    // empty vector spawns the command with no arguments, and reading it as
    // shell form is the safe direction — the whole command string is then
    // still tested as a path.
    expect(hookTargets({ hooks: { S: [{ hooks: [{ command: 'x.sh', args: [] }] }] } } as never))
      .toEqual([{ form: 'shell', program: '', file: 'x.sh', raw: 'x.sh' }]);
    // A path with SPACES survives exec form, because exec form does no
    // tokenisation — the cut that shell form needs would corrupt it.
    expect(hookTargets({
      hooks: { S: [{ hooks: [{ command: 'node', args: ['/My Repo/.claude/dist/w.mjs'] }] }] },
    } as never)[0]?.file).toBe('/My Repo/.claude/dist/w.mjs');
  });

  it('settings_fix_text names both sides of the layout seam', () => {
    expect(settingsFixText('/src/.deploy-claude', '/t'))
      .toBe('copy the missing chain(s) from /src/.deploy-claude/settings.json into /t/.claude/settings.json under .hooks (deploy will not merge for you); if the existing file has nothing worth keeping: cp /src/.deploy-claude/settings.json /t/.claude/settings.json');
  });

  it('lsMode renders what `ls -l | cut -c1-10` shows', () => {
    expect(lsMode(0o644)).toBe('-rw-r--r--');
    expect(lsMode(0o755)).toBe('-rwxr-xr-x');
    expect(lsMode(0o4755)).toBe('-rwsr-xr-x');
    expect(lsMode(0o4644)).toBe('-rwSr--r--');
    expect(lsMode(0o1777)).toBe('-rwxrwxrwt');
    expect(lsMode(0)).toBe('----------');
  });
});

describe('the probe verdict table', () => {
  it('rc 0 passes', () => {
    expect(probeVerdict('n', 'a', '', 0, 'fine')).toBe('');
  });
  it('a traceback fails FIRST, even at rc 0', () => {
    const v = probeVerdict('n', 'a', '', 0, 'x\nTraceback (most recent call last)\ny');
    expect(v).toContain('a Python traceback reached the operator');
    expect(v).toContain('first line: x');
  });
  it('the fixed rc set fails whatever the regex says', () => {
    expect(probeVerdict('n', 'a', 'declared', 126, 'declared')).toContain('rc 126 — present but not executable');
    expect(probeVerdict('n', 'a', 'declared', 127, 'declared')).toContain('rc 127 — command or interpreter not found');
    expect(probeVerdict('n', 'a', 'declared', 142, 'declared')).toContain('exceeded the 30s probe budget');
  });
  it('a DECLARED refusal is a pass; an undeclared nonzero is not', () => {
    expect(probeVerdict('task-lint', 'x', 'scrumux task lint: error: usage:', 2,
      'scrumux task lint: error: usage: scrumux task lint T-1')).toBe('');
    expect(probeVerdict('n', 'a', 'scrumux task lint: error: usage:', 2, 'something else'))
      .toContain('does not match its declared refusal /scrumux task lint: error: usage:/');
    expect(probeVerdict('n', 'a', '', 1, 'oops'))
      .toContain('rc 1, and this surface declares no refusal — its no-op must exit 0');
  });
  it('the quoted first line is cut at 120 characters, and silence reads (no output)', () => {
    const v = probeVerdict('n', 'a', '', 1, 'y'.repeat(300));
    expect(v).toContain(`first line: ${'y'.repeat(120)}`);
    expect(v.endsWith('y'.repeat(121))).toBe(false);
    expect(probeVerdict('n', 'a', '', 1, '')).toContain('first line: (no output)');
  });
});

describe('drift classification', () => {
  it('rules and skills are TRACKED prose; everything else is FROZEN', () => {
    expect(driftClass('.claude/rules/x.md')).toBe('tracked');
    expect(driftClass('.claude/skills/session-open/SKILL.md')).toBe('tracked');
    expect(driftClass('.claude/scripts/scrumux')).toBe('frozen');
    // R-019 (D-S027): schemas are variance, like rules and skills.
    expect(driftClass('.claude/schemas/task.schema.json')).toBe('tracked');
    expect(driftClass('.claude/dist/scrumux.mjs')).toBe('frozen');
    expect(driftClass('.claude/hooks/block-destructive.sh')).toBe('frozen');
    expect(driftClass('agents/lib/schema_check.py')).toBe('frozen');
    // the classification is a PREFIX test on the target-relative path
    expect(driftClass('.claude/rulesx/x.md')).toBe('frozen');
  });
});

/**
 * PER-SIDE, NOT PINNED TOGETHER (Wave 5I, the OQ-7 mismatch-assertion shape).
 *
 * The module-presence arm RETIRED WITH THE MODULE (2026-09-03): the sweep was
 * `python3 -m agents.lib.schema_check`, so a target missing that file could
 * not check its own records, and T-0129 demanded a FAIL rather than a silent
 * skip. The sweep has been native since Wave 5I (`src/schema/check.ts`) — no
 * interpreter is spawned, so there is no module left to be absent, and the
 * bash CLI that used to run it is gone too. What survives is the underlying
 * contract: a sweep that cannot read what it needs still refuses, asserted
 * below in the one shape this side can still reach — a broken or absent
 * schema file.
 */
describe('the schema sweep fails CLOSED', () => {
  it('a target whose schemas are gone is a FAIL, never a quiet pass', () => {
    const t = mkdtempSync(join(tmpdir(), 'w4h-sweep2-'));
    try {
      mkdirSync(join(t, 'governance'), { recursive: true });
      writeFileSync(join(t, 'governance/tasks.json'), '{"entries":[{"id":"T-0001"}]}');
      // No .claude/schemas at all: every pair reports its own load failure and
      // the sweep exits 1 rather than calling an unchecked repo clean.
      const r = schemaSweepCheck(t, '/scripts');
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('the schema sweep exited 1 against');
      expect(r.detail).toContain('FileNotFoundError');
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it('a deployed target with conforming journals is clean', () => {
    const t = mkdtempSync(join(tmpdir(), 'w4h-sweep3-'));
    try {
      mkdirSync(join(t, 'agents/lib'), { recursive: true });
      writeFileSync(join(t, 'agents/lib/schema_check.py'), '');
      mkdirSync(join(t, '.claude'), { recursive: true });
      cpSync(join(SRC_CLAUDE, 'schemas'), join(t, '.claude/schemas'), { recursive: true });
      mkdirSync(join(t, 'governance'), { recursive: true });
      writeFileSync(join(t, 'governance/tasks.json'), '{"entries":[]}');
      const r = schemaSweepCheck(t, '/scripts');
      expect(r.ok).toBe(true);
      expect(r.detail).toContain('schema sweep clean against');
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe('the shell-pipeline text helpers', () => {
  it('reproduce head/tr/cut/strip byte behaviour', () => {
    expect(stripTrailingNewlines('a\nb\n\n')).toBe('a\nb');
    expect(shHead('l1\nl2\nl3\nl4', 2)).toBe('l1\nl2\n');
    expect(shHead('l1', 3)).toBe('l1');
    expect(trNewlines('a\nb\n', ';')).toBe('a;b;');
    expect(firstLineCut('abc\ndef', 2)).toBe('ab');
    expect(grepHead3Semis('  FAIL a x\nok b\n  WARN c y\n  FAIL d\n  FAIL e', /^ *(FAIL|WARN) /))
      .toBe('  FAIL a x;  WARN c y;  FAIL d;');
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('harness deploy, for real, into a scratch target', () => {
  it('installs the payload, seeds the skeletons, prunes and keeps on redeploy', () => {
    const t = mkdtempSync(join(tmpdir(), 'w4h-deploy-'));
    try {
      const ctx = {
        roots: { root: t, gov: join(t, 'governance'), workRoot: t },
        today: '2026-09-01',
        io: captureIo(),
        scriptsDir: join(SRC_CLAUDE, 'scripts'),
        // The two post-install checks re-invoke SCRUMUX_SELF (bash retired);
        // under vitest `process.argv[1]` is the test runner, not a scrumux
        // bundle, so this repo's own built bundle stands in for it.
        env: { ...process.env, SCRUMUX_SELF: join(SRC_CLAUDE, 'dist/scrumux.mjs') },
        cwd: t,
      };
      const run = (args: string[]): { code: number; out: string } => {
        const io = captureIo();
        const cli = new Cli('harness deploy', args, false, io);
        try {
          MODULE.run(cli, { ...ctx, io }, 'deploy', args);
        } catch (e) {
          if (!(e instanceof ExitSignal)) throw e;
          return { code: e.code, out: io.stdout };
        }
        throw new Error('run returned');
      };

      // fresh deploy, against a RELATIVE target — the resolution seam
      const first = run(['.']);
      expect(first.code).toBe(0);
      expect(first.out).toContain('CREATED');
      expect(first.out).toContain(', 0 removed (');
      expect(readFileSync(join(t, 'governance/log.json'), 'utf8')).toBe('{"entries": []}\n');
      expect((statSync(join(t, '.claude/scripts/scrumux')).mode & 0o111)).not.toBe(0);
      expect(readFileSync(join(t, '.claude/settings.json')))
        .toEqual(readFileSync(join(SRC_CLAUDE, 'settings.json')));
      const man = JSON.parse(readFileSync(join(t, '.claude/DEPLOYED'), 'utf8'));
      expect(Object.keys(man.files).length).toBe(allPayloadFiles(SRC_CLAUDE, CHECKOUT).length);
      expect(man.files['.claude/DEPLOYED']).toBeUndefined();

      // mutate: an old manifest claiming a retired file and a seeded path
      writeFileSync(join(t, '.claude/scripts/zz-retired'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(t, '.claude/scripts/zz-retired'), 0o755);
      const doc = JSON.parse(readFileSync(join(t, '.claude/DEPLOYED'), 'utf8'));
      doc.files['.claude/scripts/zz-retired'] = '0'.repeat(64);
      doc.files['.claude/rules/project-standards.md'] = 'stale';
      writeFileSync(join(t, '.claude/DEPLOYED'), JSON.stringify(doc, null, 2) + '\n');
      // The repo's own standards keep valid frontmatter — the terminal
      // `records check` validates every rule file, and this test must fail
      // only on what it is about.
      writeFileSync(
        join(t, '.claude/rules/project-standards.md'),
        '---\nname: project-standards\npaths: ["**"]\nskills: []\nscripts: []\n---\n# this repo wrote its own standards\n',
      );

      const second = run(['.']);
      expect(second.code).toBe(0);
      expect(second.out).toContain('REMOVED   .claude/scripts/zz-retired');
      expect(second.out).toMatch(/KEPT {6}\.claude\/rules\/project-standards\.md/);
      expect(readFileSync(join(t, '.claude/rules/project-standards.md'), 'utf8'))
        .toContain('wrote its own standards');
      const man2 = JSON.parse(readFileSync(join(t, '.claude/DEPLOYED'), 'utf8'));
      expect(man2.files['.claude/scripts/zz-retired']).toBeUndefined();
      expect(man2.files['.claude/rules/project-standards.md']).toBeUndefined();
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 30000);
});

describe('the noun seam', () => {
  it('publishes the two verbs and refuses an unknown one with bash\'s wording', () => {
    expect([...VERBS]).toEqual(['deploy', 'verify']);
    expect(MODULE.verbs()).toBe('deploy\tinstall the machinery into a target repo\nverify\tprove the machinery is INSTALLED in a target repo\n');
    const io = captureIo();
    const cli = new Cli('harness frob', [], false, io);
    const ctx = {
      roots: { root: '/tmp', gov: '/tmp/governance', workRoot: '/tmp' },
      today: '2026-09-01',
      io,
    };
    let code = -1;
    try {
      MODULE.run(cli, ctx, 'frob', []);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
      code = e.code;
    }
    expect(code).toBe(2);
    expect(io.stderr).toContain("unknown verb 'frob' for noun harness — verbs: deploy, verify. See: scrumux help harness");
  });

  it('refuses a missing, a duplicated and a flag-shaped target, and a non-directory', () => {
    const cases: [string[], string][] = [
      [[], 'deploy needs a target repo'],
      [['a', 'b'], "harness takes ONE target, got 'a' and 'b'"],
      [['--frob'], 'unknown flag --frob'],
      [['/definitely/not/there'], 'is not a directory — create it first'],
    ];
    for (const [args, want] of cases) {
      const io = captureIo();
      const cli = new Cli('harness deploy', args, false, io);
      const ctx = {
        roots: { root: '/tmp', gov: '/tmp/governance', workRoot: '/tmp' },
        today: '2026-09-01',
        io,
        cwd: '/tmp',
        scriptsDir: join(SRC_CLAUDE, 'scripts'),
      };
      let code = -1;
      try {
        MODULE.run(cli, ctx, 'deploy', args);
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
        code = e.code;
      }
      expect(code).toBe(2);
      expect(io.stderr).toContain(want);
    }
  });
});
