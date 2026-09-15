import { describe, it, expect } from 'vitest';
import {
  lexResolve, isTemp, rmTargetsTemp, hasAttestation, rmDestructiveFlags,
  ATT_RM, ATT_GIT, ATT_DB,
} from '../../src/walls/block-destructive.js';
import { isProtected, scanCommand } from '../../src/walls/block-upstream-edit.js';
import { readOperands } from '../../src/walls/block-secret-reads.js';

/**
 * The wall predicates, at the function.
 *
 * `tools/walls-parity.mjs` proves the four bundles agree with the four bash
 * hooks over 684 real payloads. That is the parity spec. This file is the
 * other half: the reasoning INSIDE each wall, asserted where a break points at
 * a line rather than at a subprocess — and it is where the three assertions
 * the bash suites make by reaching into shell internals get their TypeScript
 * replacement (see KNOWN_INAPPLICABLE in walls-parity.mjs).
 */

// --------------------------------------------------------- destructive ----
describe('lexResolve — `..` collapsed TEXTUALLY, never on disk', () => {
  it('resolves the traversal the delete actually performs', () => {
    // I-0103: an unanchored keyword search exempted a root wipe because
    // `/tmp/../Users/foo/data` contained "/tmp/". It deletes /Users/foo/data.
    expect(lexResolve('/tmp/../Users/foo/data')).toBe('/Users/foo/data');
    expect(lexResolve('/a/./b//c')).toBe('/a/b/c');
    expect(lexResolve('a/../b')).toBe('b');
    expect(lexResolve('/')).toBe('/');
  });

  it('leaves an unexpanded variable as itself', () => {
    // The paths a PreToolUse hook judges must not be touched and mostly do not
    // exist yet, so realpath is unavailable and `$SANDBOX` has to survive.
    expect(lexResolve('$SANDBOX/x')).toBe('$SANDBOX/x');
  });
});

describe('isTemp — a component boundary, never a spelling', () => {
  it('accepts a path under a temp root', () => {
    for (const p of ['/tmp/x', '/private/tmp/x', '/var/folders/ab/x', '$TMPDIR/x', '$SANDBOX', '$(mktemp -d)']) {
      expect(isTemp(p), p).toBe(true);
    }
  });

  it('REFUSES a path that merely starts with the letters', () => {
    // /tmpfoo is not in /tmp. The boundary is the whole point.
    for (const p of ['/tmpfoo', '/private/tmpfoo', '/tmp', '/Users/foo/mktemp-archive', '/Users/foo/scratchpad-old']) {
      expect(isTemp(p), p).toBe(false);
    }
  });
});

describe('rmTargetsTemp — EVERY operand of EVERY rm, or no exemption', () => {
  it('exempts a command whose only target is temp', () => {
    expect(rmTargetsTemp('rm -rf /tmp/build-cache').allTemp).toBe(true);
  });

  it('refuses when a SECOND rm leaves temp', () => {
    // A second rm must not hide behind a temp-looking first one.
    expect(rmTargetsTemp('rm -rf /tmp/a && rm -rf /Users/x').allTemp).toBe(false);
  });

  it('refuses when one operand of the same rm leaves temp', () => {
    expect(rmTargetsTemp('rm -rf /tmp/a /Users/x').allTemp).toBe(false);
  });

  it('a trailing comment cannot supply the exemption (CLI-3)', () => {
    expect(rmTargetsTemp('rm -rf $HOME/data # /tmp/').allTemp).toBe(false);
  });

  it('NO OPERAND AT ALL FAILS CLOSED — an odd shape is not an exemption', () => {
    expect(rmTargetsTemp('rm -rf').allTemp).toBe(false);
  });

  it('keeps the exemption for the GNU long spellings (D-0085)', () => {
    // Without the optional second dash in the flag-group strip,
    // `rm --recursive --force /tmp/x` loses its temp exemption and starts
    // blocking a command that was always fine.
    expect(rmTargetsTemp('rm --recursive --force /tmp/x').allTemp).toBe(true);
  });

  it('reports the first operand, for the attestation record', () => {
    expect(rmTargetsTemp('rm -rf /Users/x/p /Users/y').first).toBe('/Users/x/p');
  });

  it('strips quoting so "$TMPDIR"/x compares as $TMPDIR/x', () => {
    expect(rmTargetsTemp('rm -rf "$SANDBOX"').allTemp).toBe(true);
  });
});

describe('rmDestructiveFlags — both r and f, or r and d, or the long pair', () => {
  it('matches every spelling that carries both', () => {
    for (const c of ['rm -rf x', 'rm -fr x', 'rm -r -f x', 'rm -f -r x', 'rm -Rf x', 'rm -rd x',
      'rm --recursive --force x', 'rm --force --recursive x']) {
      expect(rmDestructiveFlags(c), c).toBe(true);
    }
  });

  it('a SINGLE flag is not this class, and this does not widen that', () => {
    // P-32: `rm -r`, `rm -f`, `rm --recursive` and `rm --force` alone were
    // never blocked.
    for (const c of ['rm -r x', 'rm -f x', 'rm x', 'rm --recursive x', 'rm --force x']) {
      expect(rmDestructiveFlags(c), c).toBe(false);
    }
  });

  it('matches on a SECOND LINE, which is where a shell payload lands', () => {
    // The bug the differential caught on its first run: bash's grep is
    // line-oriented, so `(^|[;&| ])rm` matches at the payload line's start.
    // A JS .test() over the joined string does not, and all six
    // `sh -c "rm -rf …"` cases walked through at exit 0.
    expect(rmDestructiveFlags('sh -c "rm -rf /x"\nrm -rf /x')).toBe(true);
  });
});

describe('hasAttestation — command position (CLI-3) AND before the act (D-0090)', () => {
  it('accepts it at the start and after a separator', () => {
    expect(hasAttestation('HARNESS_BACKUP_DONE=1 rm -rf /x', ATT_RM)).toBe(true);
    expect(hasAttestation('cd /app && HARNESS_BACKUP_DONE=1 rm -rf /x', ATT_RM)).toBe(true);
  });

  it('accepts it from an EARLIER segment — backing up first is the point', () => {
    expect(hasAttestation('HARNESS_BACKUP_DONE=1 echo done && rm -rf /x', ATT_RM)).toBe(true);
  });

  it('REFUSES an attestation that comes AFTER the act (D-0090)', () => {
    // It attests for an rm that has already run, and writes a row claiming a
    // backup that never happened.
    expect(hasAttestation('rm -rf /x && HARNESS_BACKUP_DONE=1 echo done', ATT_RM)).toBe(false);
    expect(hasAttestation('rm -rf /x ; HARNESS_BACKUP_DONE=1 echo done', ATT_RM)).toBe(false);
  });

  it('...for every class, not just rm', () => {
    expect(hasAttestation('psql -c "DROP DATABASE p" && HARNESS_BACKUP_DONE=1 echo x', ATT_DB)).toBe(false);
    expect(hasAttestation('HARNESS_BACKUP_DONE=1 psql -c "DROP DATABASE p"', ATT_DB)).toBe(true);
    expect(hasAttestation('git reset --hard && HARNESS_BACKUP_DONE=1 echo x', ATT_GIT)).toBe(false);
    expect(hasAttestation('HARNESS_BACKUP_DONE=1 git reset --hard', ATT_GIT)).toBe(true);
  });

  it('REFUSES it anywhere else', () => {
    // The old match-anywhere version let a trailing comment disarm the wall
    // AND drive a FALSE backup row into attestations.jsonl.
    expect(hasAttestation('rm -rf /x # HARNESS_BACKUP_DONE=1 ', ATT_RM)).toBe(false);
    expect(hasAttestation('echo HARNESS_BACKUP_DONE=1 ', ATT_RM)).toBe(false);
  });

  it('one attestation still covers two classes in the same command', () => {
    const c = 'HARNESS_BACKUP_DONE=1 rm -rf /Users/x/db && sqlite3 app.db "drop table users"';
    expect(hasAttestation(c, ATT_RM)).toBe(true);
    expect(hasAttestation(c, ATT_DB)).toBe(true);
  });
});

// ------------------------------------------------------------- upstream ---
describe('isProtected — a SUBSTRING test, deliberately generous (I-0133)', () => {
  it('hits absolute, relative and punctuation-mangled forms', () => {
    for (const p of ['/abs/repo/.claude/scripts/scrumux', '.claude/scripts/scrumux',
      'open.claude/scripts/scrumux', '.claude/schemas/task.schema.json',
      '.claude/agents/debugger.md']) {
      expect(isProtected(p), p).toBe(true);
    }
  });

  it('protects .claude/dist, which is where the walls themselves live', () => {
    // The four wall bundles, the CLI bundle and the session guard are all
    // under `.claude/dist/`. An agent that can write here can rewrite the
    // wall that is refusing it.
    for (const p of ['.claude/dist/block-destructive.mjs', '.claude/dist/scrumux.mjs',
      '/abs/repo/.claude/dist/session-guard.mjs', '.claude/dist']) {
      expect(isProtected(p), p).toBe(true);
    }
  });

  it('does NOT hit rules or skills — a repo localises those (D-0072 boundary 7)', () => {
    // Their drift is REPORTED by `harness verify`, never blocked. The same
    // split `driftClass` makes in src/nouns/harness/verify.ts.
    for (const p of ['.claude/rules/project-standards.md', '.claude/skills/mine/SKILL.md']) {
      expect(isProtected(p), p).toBe(false);
    }
  });

  it('does NOT hit an app\'s own scripts directory', () => {
    // The `.claude/` component is what separates the harness from a repo's own
    // scripts/, not the leading slash.
    for (const p of ['scripts/scrumux', 'src/agents/lib/thing.ts', 'agents/lib/notes.md']) {
      expect(isProtected(p), p).toBe(false);
    }
  });

  it('does NOT hit a repo\'s own agents/lib python — the harness ships none', () => {
    // The wall used to protect `agents/lib/*.py` at the repo ROOT, because the
    // harness shipped its schema-check and graph builders there. It ships no
    // python at all now (SHIPPED_MODULE_FILES is empty), so anything at that
    // path belongs to the repo, and refusing it would block a user's own work
    // in a wall that deliberately ignores project-walls.conf (P-23) — there
    // would be no repo-level escape from the false positive.
    for (const p of ['agents/lib/code_graph.py', '/abs/repo/agents/lib/x.py',
      'agents/lib/sub/dir/deep.py', 'agents/lib/helper.pyc']) {
      expect(isProtected(p), p).toBe(false);
    }
  });
});

describe('scanCommand — what RUNS the segment decides, not where a path sits', () => {
  const hits = (c: string): string | null => scanCommand(c)?.path ?? null;

  it('blocks a mutator writing harness machinery', () => {
    expect(hits('cp /tmp/x .claude/scripts/scrumux')).toBe('.claude/scripts/scrumux');
    expect(hits('rm .claude/dist/block-destructive.mjs')).toBe('.claude/dist/block-destructive.mjs');
  });

  it('blocks a redirect at one, whatever runs it', () => {
    // `cat /tmp/x > .claude/scripts/scrumux` matched the old read-allowlist and
    // exited 0 before the scan ever ran.
    expect(hits('cat /tmp/x > .claude/scripts/scrumux')).toBe('.claude/scripts/scrumux');
    expect(hits('echo x >> .claude/dist/scrumux.mjs')).toBe('.claude/dist/scrumux.mjs');
  });

  it('blocks the heredoc route (I-0121), including a RELATIVE path', () => {
    // Arm 2 strips ( and ' before testing, so `open('.claude/scripts/scrumux','a')`
    // arrives as `open.claude/scripts/scrumux,a` — no slash in front, and it
    // does not START with the pattern. The two-anchor version missed it.
    expect(hits("python3 <<EOF\nopen('.claude/scripts/scrumux','a').write('x')\nEOF")).not.toBeNull();
  });

  it('LETS A READER NAME ONE FREELY (I-0134)', () => {
    // An order that says "graph is unavailable in this deployment" is prose
    // ABOUT the machinery, not an edit of it — and session-open asks for
    // exactly such sentences.
    for (const c of ['cat .claude/scripts/scrumux', 'grep -n x .claude/dist/scrumux.mjs',
      'git diff .claude/scripts/scrumux', 'sed -n 1,5p .claude/scripts/scrumux',
      'scrumux task order T-1 --file ".claude/scripts/scrumux | the dispatcher"']) {
      expect(hits(c), c).toBeNull();
    }
  });

  it('sed writes only with -i; git writes only on six subcommands', () => {
    expect(hits('sed -i "" s/a/b/ .claude/scripts/scrumux')).not.toBeNull();
    expect(hits('git checkout .claude/scripts/scrumux')).not.toBeNull();
    expect(hits('git log .claude/scripts/scrumux')).toBeNull();
  });

  it('A NEWLINE ENDS A COMMAND (I-0136)', () => {
    // Splitting only on ;/&&/||/| carried a segment's class across the break,
    // so `chmod +x a.sh` on one line judged the NEXT line's scrumux as its
    // argument and refused it.
    expect(hits('chmod +x scripts/verify/t02.sh\n.claude/scripts/scrumux task order T-2')).toBeNull();
  });

  it('...but a backslash continuation does NOT end it', () => {
    expect(hits('cp /tmp/x \\\n.claude/scripts/scrumux')).not.toBeNull();
  });

  it('steps over a wrapper and an assignment to find the real command', () => {
    expect(hits('sudo cp /tmp/x .claude/scripts/scrumux')).not.toBeNull();
    expect(hits('FOO=1 cp /tmp/x .claude/scripts/scrumux')).not.toBeNull();
  });
});

// --------------------------------------------------------------- secret ---
describe('readOperands — the TS replacement for the sed-and-eval assertion', () => {
  // tests/hook-secret-tests.sh:230-246 tests this by cutting the shell
  // function out of the hook source and evaluating it. That cannot survive any
  // port, so the same cases live here, driven against the real thing.
  it("'cat .env' emits .env", () => {
    expect(readOperands('cat .env')).toContain('.env');
  });

  it("the LAST segment's operands survive", () => {
    // In bash this needed `printf '%s\n'` rather than `printf '%s'`: command
    // substitution strips the trailing newline, `read` returns non-zero for
    // the final segment, and EVERY command has a final segment. With the wrong
    // printf this emitted nothing and turned the whole Bash arm into exit 0.
    expect(readOperands('echo hi && cat .env')).toContain('.env');
  });

  it('drops cp/mv\'s POSITIONAL destination — it is written, not read', () => {
    expect(readOperands('cp .env.example .env')).not.toContain('.env');
    expect(readOperands('cp .env.example .env')).toContain('.env.example');
  });

  it('...but keeps every operand when the destination is in a FLAG', () => {
    // `cp -t /tmp .env` would otherwise exfiltrate: every remaining operand
    // there is a SOURCE.
    expect(readOperands('cp -t /tmp .env')).toContain('.env');
    expect(readOperands('cp --target-directory=/tmp .env')).toContain('.env');
  });

  it('a two-word cp is not well-formed, so nothing is deleted', () => {
    // `cp .env` must not become a no-op by having its only operand removed.
    expect(readOperands('cp .env')).toContain('.env');
  });

  it('a cp cannot launder a later reader — the segments are judged apart', () => {
    expect(readOperands('cp .env.example .env && cat .env')).toContain('.env');
  });

  it('a flag-attached path is still an operand', () => {
    expect(readOperands('docker run --env-file=.env img')).toContain('--env-file=.env');
  });
});
