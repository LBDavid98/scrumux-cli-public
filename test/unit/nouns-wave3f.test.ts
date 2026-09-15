/**
 * Unit cover for the Wave 3F write nouns.
 *
 * THE DIFFERENTIAL IS THE GATE, not this file. `test/fixtures/tier2.mjs`
 * carries a case per verb per branch and compares exit code, stdout, stderr,
 * the whole post-state tree and the seal map against bash. What is here is the
 * two things a byte comparison cannot reach:
 *
 *   1. THE VERDICT STATE MACHINE in `issue validate`, whose branches multiply
 *      faster than fixtures should. Eight refusals and two record shapes come
 *      out of one flag set, and the interesting half is what the write does
 *      NOT touch -- `.authorization` must survive a validation, because
 *      `sprint new --hotfix` reads the two fields as disjoint facts (I-0010).
 *   2. `secret set`'s FILE MODE. run.mjs does compare modes (`repo.mjs`
 *      snapshot records `mode` per path and compareTrees diffs it), so the
 *      tier-2 cases already prove bash and this port agree. They do NOT prove
 *      the agreed value is 600 -- two sides can agree on 644. Asserted here as
 *      an absolute, because "gitignored, mode 600" is the noun's stated
 *      contract and a same-as-bash comparison cannot state it.
 *
 * The pure helpers below (`envDropText`, `gitignoreCoversEnv`) are covered
 * directly for the same reason `parseEnv` is: PK-13's export-prefix handling
 * is one regex away from silently leaving an old secret in the file, and a
 * fixture can only show one shape at a time.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { redactArgv } from '../../src/cli/argv.js';
import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as issue } from '../../src/nouns/issue.js';
import { MODULE as rank } from '../../src/nouns/rank.js';
import { MODULE as repair } from '../../src/nouns/repair.js';
import { MODULE as secret, envDropText, gitignoreCoversEnv } from '../../src/nouns/secret.js';
import { MODULE as sprint } from '../../src/nouns/sprint.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');

const TODAY = todayStamp();
const J = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scrumux-w3f-unit-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}

function ctxFor(root: string, env: NodeJS.ProcessEnv = {}): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: TODAY,
    io: captureIo(),
    scriptsDir: SCRIPTS,
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
  const cli = new Cli(`${verb}`, args, json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctx, io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

function readGov(root: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'governance', name), 'utf8')) as Record<string, unknown>;
}

interface Row { [k: string]: unknown }
function entry(root: string, name: string, id: string): Row {
  const rows = (readGov(root, name)['entries'] ?? []) as Row[];
  return rows.find((r) => r['id'] === id) as Row;
}

/** One issue per gate state, which is what the verdict machine writes into. */
function seedIssues(root: string): void {
  writeFileSync(join(root, 'governance', 'issues.json'), J({
    entries: [
      {
        id: 'I-0001', type: 'defect', source: 'claude', summary: 's',
        resolution_pointer: 'the first pointer', status: 'open', created_at: '2026-08-01',
        refs: { files: [] },
      },
      {
        id: 'I-0002', type: 'defect', source: 'User', summary: 's',
        resolution_pointer: 'p', status: 'open', created_at: '2026-08-01',
        authorization: { by: 'User', date: '2026-08-01' },
      },
      { id: 'I-0003', type: 'defect', source: '', summary: 's', resolution_pointer: 'p', status: 'open', created_at: '2026-08-01' },
    ],
  }));
  writeFileSync(join(root, 'governance', 'tasks.json'), J({
    entries: [{ id: 'T-0001', title: 'a task', status: 'proposed', acceptance_check: 'c' }],
  }));
}

const EVIDENCE = 'Ran the named command at HEAD in a sandbox GOV_ROOT and watched it print the refusal';

// ------------------------------------------------- issue validate --------

describe("issue validate's verdict state machine", () => {
  it('admits exactly four verdicts and names all four when it refuses', () => {
    const d = scratch();
    try {
      seedIssues(d);
      // Each verdict is admitted on a FRESH record. The loop used to reuse
      // I-0001 and leaned on the silent overwrite F7 removed -- a verdict is
      // write-once now, so a second validate on one id refuses by design and
      // reusing the row would test the guard rather than the vocabulary.
      for (const v of ['reproduced', 'evidenced', 'invalidated']) {
        seedIssues(d);
        const { rc } = drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', v, '--evidence', EVIDENCE, '--by', 'debugger']);
        expect(rc).toBe(0);
      }
      seedIssues(d);
      const bad = drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', 'confirmed', '--evidence', EVIDENCE]);
      expect(bad.rc).toBe(2);
      expect(bad.io.stderr).toContain('--verdict must be reproduced|evidenced|invalidated|duplicate');
      // The verdict check runs BEFORE the evidence check, so a bad verdict
      // with no evidence reports the verdict.
      const neither = drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', 'confirmed']);
      expect(neither.io.stderr).toContain('--verdict must be');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('requires evidence, and the refusal carries the worked examples (D-0011)', () => {
    const d = scratch();
    try {
      seedIssues(d);
      const { io, rc } = drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', 'reproduced']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('validation without evidence is noise (D-0011)');
      // Article 5 at maximum density: the refusal IS the spec for the field.
      expect(io.stderr).toContain('GOOD (reproduced)');
      expect(io.stderr).toContain('GOOD (invalidated)');
      expect(io.stderr).toContain('BAD "confirmed"');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('binds --duplicate-of to the duplicate verdict in both directions', () => {
    const d = scratch();
    try {
      seedIssues(d);
      const missing = drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', 'duplicate', '--evidence', EVIDENCE]);
      expect(missing.rc).toBe(2);
      expect(missing.io.stderr).toContain('verdict duplicate needs --duplicate-of');

      const stray = drive(issue, ctxFor(d), 'validate',
        ['I-0001', '--verdict', 'reproduced', '--evidence', EVIDENCE, '--duplicate-of', 'I-0002']);
      expect(stray.rc).toBe(2);
      expect(stray.io.stderr).toContain('--duplicate-of only goes with --verdict duplicate');

      const self = drive(issue, ctxFor(d), 'validate',
        ['I-0001', '--verdict', 'duplicate', '--evidence', EVIDENCE, '--duplicate-of', 'I-0001', '--by', 'debugger']);
      expect(self.rc).toBe(2);
      expect(self.io.stderr).toContain('an issue cannot duplicate itself');

      const unknown = drive(issue, ctxFor(d), 'validate',
        ['I-0001', '--verdict', 'duplicate', '--evidence', EVIDENCE, '--duplicate-of', 'I-9999', '--by', 'debugger']);
      expect(unknown.io.stderr).toContain('duplicate-of I-9999 not found in issues.json');

      const notAnId = drive(issue, ctxFor(d), 'validate',
        ['I-0001', '--verdict', 'duplicate', '--evidence', EVIDENCE, '--duplicate-of', 'X-0001', '--by', 'debugger']);
      expect(notAnId.io.stderr).toContain('must be an issue (I-XXXX) or backlog task (T-XXXX) id');

      // A TASK id resolves through the same door, and lands in the record.
      const viaTask = drive(issue, ctxFor(d), 'validate',
        ['I-0001', '--verdict', 'duplicate', '--evidence', EVIDENCE, '--duplicate-of', 'T-0001', '--by', 'debugger']);
      expect(viaTask.rc).toBe(0);
      const v = entry(d, 'issues.json', 'I-0001')['validation'] as Row;
      expect(v['duplicate_of']).toBe('T-0001');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses self-validation by DISJOINTNESS ONLY, and exempts User (P-47/I-0054)', () => {
    const d = scratch();
    try {
      seedIssues(d);
      // I-0001 was raised by 'claude'.
      const self = drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', 'reproduced', '--evidence', EVIDENCE, '--by', 'claude']);
      expect(self.rc).toBe(2);
      expect(self.io.stderr).toContain('self-validation refused');
      // I-0099: the refusal must NOT prescribe the --by value it just refused.
      expect(self.io.stderr).toContain("is NOT 'claude'");
      expect(self.io.stderr).not.toContain('--by issue-validator');

      // Any other identity is admitted -- there is no roster allowlist.
      expect(drive(issue, ctxFor(d), 'validate',
        ['I-0001', '--verdict', 'reproduced', '--evidence', EVIDENCE, '--by', 'some-agent-nobody-registered']).rc).toBe(0);

      // I-0002 was raised BY User, and User validating his own report is the
      // authority the gate defers to.
      expect(drive(issue, ctxFor(d), 'validate',
        ['I-0002', '--verdict', 'reproduced', '--evidence', EVIDENCE, '--by', 'User']).rc).toBe(0);

      // An issue with an EMPTY source turns the gate off rather than refusing.
      expect(drive(issue, ctxFor(d), 'validate',
        ['I-0003', '--verdict', 'reproduced', '--evidence', EVIDENCE, '--by', '']).rc).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('writes only .validation, and leaves .authorization alone (I-0010)', () => {
    const d = scratch();
    try {
      seedIssues(d);
      drive(issue, ctxFor(d), 'validate',
        ['I-0002', '--verdict', 'evidenced', '--evidence', EVIDENCE, '--by', 'debugger', '--repro-cmd', 'sh tests/x.sh']);
      const row = entry(d, 'issues.json', 'I-0002');
      expect(row['validation']).toEqual({
        verdict: 'evidenced', evidence: EVIDENCE, by: 'debugger', date: TODAY, repro_cmd: 'sh tests/x.sh',
      });
      // The whole point of the two fields being disjoint.
      expect(row['authorization']).toEqual({ by: 'User', date: '2026-08-01' });
      expect(row['updated_at']).toBe(TODAY);

      // ...and the reverse: authorize must never write .validation.
      const d2 = scratch();
      try {
        seedIssues(d2);
        drive(issue, ctxFor(d2), 'authorize', ['I-0001', '--by', 'User']);
        const r2 = entry(d2, 'issues.json', 'I-0001');
        expect(r2['authorization']).toEqual({ by: 'User', date: TODAY });
        expect(r2['validation']).toBeUndefined();
      } finally {
        rmSync(d2, { recursive: true, force: true });
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('omits the optional blocks entirely rather than writing them empty', () => {
    const d = scratch();
    try {
      seedIssues(d);
      drive(issue, ctxFor(d), 'validate', ['I-0001', '--verdict', 'reproduced', '--evidence', EVIDENCE, '--by', 'debugger']);
      const v = entry(d, 'issues.json', 'I-0001')['validation'] as Row;
      expect(Object.keys(v)).toEqual(['verdict', 'evidence', 'by', 'date']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('keeps the prior resolution pointer where the wrong one used to be (T-0114/I-0057)', () => {
    const d = scratch();
    try {
      seedIssues(d);
      drive(issue, ctxFor(d), 'update', ['I-0001', '--fix', 'the corrected pointer']);
      const row = entry(d, 'issues.json', 'I-0001');
      expect(row['resolution_pointer']).toBe('the corrected pointer');
      expect(row['prior_resolution_pointers']).toEqual([
        { text: 'the first pointer', replaced_on: TODAY },
      ]);
      // A SECOND correction appends rather than replacing the history.
      drive(issue, ctxFor(d), 'update', ['I-0001', '--fix', 'and again']);
      expect((entry(d, 'issues.json', 'I-0001')['prior_resolution_pointers'] as unknown[]).length).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------- the hotfix promotion gate ---

describe('the promotion gate sprint new --hotfix reads back', () => {
  function gateRepo(): string {
    const d = scratch();
    writeFileSync(join(d, 'governance', 'issues.json'), J({
      entries: [
        { id: 'I-0001', source: 'claude', summary: 's', status: 'open' },
        { id: 'I-0002', source: 'claude', summary: 's', status: 'open', validation: { verdict: 'reproduced' } },
        { id: 'I-0003', source: 'claude', summary: 's', status: 'open', validation: { verdict: 'invalidated' } },
        { id: 'I-0004', source: 'claude', summary: 's', status: 'open', validation: { verdict: 'duplicate', duplicate_of: 'I-0002' } },
        { id: 'I-0005', source: 'User', summary: 's', status: 'open', authorization: { by: 'User', date: '2026-08-01' } },
        { id: 'I-0006', source: 'claude', summary: 's', status: 'open', validation: { verdict: 'something-else' } },
        { id: 'I-0007', source: 'claude', summary: 's', status: 'open', validation: {} },
      ],
    }));
    writeFileSync(join(d, 'governance', 'sprints.json'), J({ entries: [] }));
    return d;
  }

  it('opens on reproduced and on authorization, and refuses per state', () => {
    const d = gateRepo();
    try {
      const none = drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0001']);
      expect(none.rc).toBe(2);
      expect(none.io.stderr).toContain('has neither validation nor authorization');
      // The refusal names BOTH commands that would open it.
      expect(none.io.stderr).toContain('scrumux issue validate I-0001');
      expect(none.io.stderr).toContain('scrumux issue authorize I-0001 --by User');

      expect(drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0002']).rc).toBe(0);
      expect(drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0005']).rc).toBe(0);

      const inval = drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0003']);
      expect(inval.rc).toBe(2);
      expect(inval.io.stderr).toContain('close it instead of fixing it');

      const dup = drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0004']);
      expect(dup.rc).toBe(2);
      expect(dup.io.stderr).toContain('is a duplicate of I-0002');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('REFUSES an unknown verdict — the case has a default arm now', () => {
    // IT USED TO LET THIS THROUGH, on both sides: bash's `case` named four
    // verdicts and had no `*)`, so anything it could not read fell past the
    // gate and opened the sprint. `{"verdict":"something-else"}` promoted an
    // issue nobody had validated. Ruled by User (Harden C) and fixed in bash
    // and TypeScript together, which is why it stays byte-comparable --
    // t2-hC-hotfix-unrecognised-verdict is the case that proves it.
    const d = gateRepo();
    try {
      const odd = drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0006']);
      expect(odd.rc).toBe(2);
      expect(odd.io.stderr).toContain('does not recognise (verdict: something-else)');
      // The refusal names the vocabulary AND the command that records one --
      // Article 5: the error message is the instruction set.
      expect(odd.io.stderr).toContain('reproduced or evidenced');
      expect(odd.io.stderr).toContain('scrumux issue validate I-0006 --verdict');

      // `.validation` present but with no verdict renders as the four letters
      // `null` through jq -r, which also matched no arm. The commoner shape of
      // the same hole: a record that LOOKS validated to a reader.
      const bare = drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0007']);
      expect(bare.rc).toBe(2);
      expect(bare.io.stderr).toContain('does not recognise (verdict: null)');

      // AND IT WROTE NOTHING. A gate that refuses and allocates an SP id
      // anyway has not refused.
      expect(readGov(d, 'sprints.json')['entries']).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('forces parallel to 1 and refuses a cap it cannot honour', () => {
    const d = gateRepo();
    try {
      const refused = drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0002', '--parallel', '2']);
      expect(refused.rc).toBe(2);
      expect(refused.io.stderr).toContain('a hotfix sprint runs one task');
      expect(drive(sprint, ctxFor(d), 'new', ['--hotfix', '--issue', 'I-0002', '--parallel', '1']).rc).toBe(0);
      const row = entry(d, 'sprints.json', 'SP-0001');
      expect(row['parallel']).toBe(1);
      expect(row['hotfix']).toBe(true);
      expect(row['epic']).toBe(null);
      expect(row['source_issue']).toBe('I-0002');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------- ranking ---

describe('ranking touches the ranked set and nothing else (I-0044/T-0096)', () => {
  function rankRepo(): string {
    const d = scratch();
    writeFileSync(join(d, 'governance', 'tasks.json'), J({
      entries: [
        { id: 'T-0001', title: 'a', status: 'proposed', rank: 2 },
        { id: 'T-0002', title: 'b', status: 'proposed', rank: 1 },
        { id: 'T-0003', title: 'c', status: 'proposed' },
        { id: 'T-0004', title: 'd', status: 'accepted' },
      ],
    }));
    return d;
  }

  it('never stamps a rank onto work nobody prioritised', () => {
    const d = rankRepo();
    try {
      expect(drive(rank, ctxFor(d), 'set', ['T-0001', '1']).rc).toBe(0);
      expect(entry(d, 'tasks.json', 'T-0001')['rank']).toBe(1);
      expect(entry(d, 'tasks.json', 'T-0002')['rank']).toBe(2);
      expect(entry(d, 'tasks.json', 'T-0003')['rank']).toBeUndefined();
      expect(entry(d, 'tasks.json', 'T-0004')['rank']).toBeUndefined();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('DELETES the key on clear -- not null, not zero', () => {
    const d = rankRepo();
    try {
      drive(rank, ctxFor(d), 'clear', ['T-0002']);
      const row = entry(d, 'tasks.json', 'T-0002');
      expect('rank' in row).toBe(false);
      // ...and the survivor re-densifies over the remaining RANKED list only.
      expect(entry(d, 'tasks.json', 'T-0001')['rank']).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('clamps an out-of-range position instead of refusing (OQ-DN3, unruled)', () => {
    const d = rankRepo();
    try {
      expect(drive(rank, ctxFor(d), 'set', ['T-0003', '99']).rc).toBe(0);
      expect(entry(d, 'tasks.json', 'T-0003')['rank']).toBe(3);
      // The number path is the asymmetry: it refuses rather than clamping.
      const oor = drive(rank, ctxFor(d), 'set', ['99', '1']);
      expect(oor.rc).toBe(2);
      expect(oor.io.stderr).toContain('out of range 1..3');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------- secret's file mode ---

describe('secret set stores what it says it stores', () => {
  it('leaves .env at mode 600 and .gitignore covering it', () => {
    const d = scratch();
    try {
      const { rc } = drive(secret, ctxFor(d), 'set', ['WIDGET_API_KEY', 'wk_live_5f3a9c21b7e4']);
      expect(rc).toBe(0);
      const envf = join(d, '.env');
      // AN ABSOLUTE, not a same-as-bash comparison: the differential already
      // proves the two sides agree, and two sides can agree on 644.
      expect(statSync(envf).mode & 0o777).toBe(0o600);
      expect(readFileSync(envf, 'utf8')).toBe('WIDGET_API_KEY=wk_live_5f3a9c21b7e4\n');
      expect(gitignoreCoversEnv(readFileSync(join(d, '.gitignore'), 'utf8'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('re-asserts 600 on a file that was already there with looser bits', () => {
    const d = scratch();
    try {
      writeFileSync(join(d, '.env'), 'OTHER=keep\n');
      chmodSync(join(d, '.env'), 0o644);
      writeFileSync(join(d, '.gitignore'), '.env\n');
      drive(secret, ctxFor(d), 'set', ['TOKEN', 'v']);
      expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(d, '.env'), 'utf8')).toBe('OTHER=keep\nTOKEN=v\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('never prints the value in its prose or its data payload', () => {
    const d = scratch();
    try {
      const { io } = drive(secret, ctxFor(d), 'set', ['TOKEN', 'super-secret-value']);
      expect(io.stdout).not.toContain('super-secret-value');
      expect(io.stderr).not.toContain('super-secret-value');
      const j = drive(secret, ctxFor(d), 'set', ['TOKEN', 'another-secret-value'], true);
      expect(JSON.parse(j.io.stdout)['data']).toEqual({
        name: 'TOKEN', action: 'replaced', bytes: 20, sha256_prefix: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown,
      });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('is handed the REAL value — the redaction is the dispatcher\'s, not this module\'s', () => {
    // THE FINDING THIS TEST USED TO PIN IS FIXED (User's ruling, Harden C).
    // `cli_init` captured the whole argv into the envelope, so
    // `scrumux --json secret set NAME VALUE` wrote the credential onto stdout
    // inside `.argv` -- on the one noun whose stated contract is that nothing
    // prints a value back. It was pinned rather than repaired because `.argv`
    // is compared LITERALLY by the differential, precisely so a port cannot
    // make that call on its own; the ruling made it on both sides at once.
    //
    // What this test now holds is the SEAM's location. `redactArgv` runs in
    // `dispatch`, at the one line that hands a list to `new Cli`, and the
    // module below it still receives the real arguments -- it has to, or there
    // is nothing to store. `drive` constructs its own Cli, so it sees the
    // unredacted list by construction; the envelope assertion lives in
    // test/unit/dispatch.test.ts, where the seam actually is.
    const d = scratch();
    try {
      expect(redactArgv('secret', 'set', ['TOKEN', 'no-longer-leaked'])).toEqual(
        ['TOKEN', '<redacted>'],
      );
      drive(secret, ctxFor(d), 'set', ['TOKEN', 'no-longer-leaked'], true);
      expect(readFileSync(join(d, '.env'), 'utf8')).toBe('TOKEN=no-longer-leaked\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a value it cannot store, and writes nothing when it does', () => {
    const d = scratch();
    try {
      const nl = drive(secret, ctxFor(d), 'set', ['TOKEN', 'line one\nline two']);
      expect(nl.rc).toBe(2);
      expect(nl.io.stderr).toContain('contains a newline');
      const bad = drive(secret, ctxFor(d), 'set', ['1TOKEN', 'v']);
      expect(bad.rc).toBe(2);
      expect(bad.io.stderr).toContain('not a usable environment variable name');
      const get = drive(secret, ctxFor(d), 'set', ['get', 'API_KEY']);
      expect(get.rc).toBe(2);
      expect(get.io.stderr).toContain("there is no 'get'");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('the .env line surgery (PK-13)', () => {
  it('drops an export-prefixed line, which is the same secret', () => {
    // The failure this closes: the old line was NOT dropped, the new one was
    // appended, and the old secret value survived beside the new one.
    expect(envDropText('export A=old\nB=keep\n', 'A')).toBe('B=keep\n');
    expect(envDropText('export\tA=old\nB=keep\n', 'A')).toBe('B=keep\n');
    expect(envDropText('A=old\nB=keep\n', 'A')).toBe('B=keep\n');
    // A name that only PREFIXES another is untouched -- the `=` anchors it.
    expect(envDropText('AB=keep\nA=drop\n', 'A')).toBe('AB=keep\n');
  });

  it('keeps an unterminated final line, which the list parse drops', () => {
    // grep sees it; `while read` does not. Both behaviours are bash's.
    expect(envDropText('A=one\nB=two', 'A')).toBe('B=two\n');
  });

  it('loses trailing blank lines, because $( ) strips them', () => {
    expect(envDropText('A=one\nB=two\n\n\n', 'A')).toBe('B=two\n');
    expect(envDropText('A=only\n', 'A')).toBe('');
  });

  it('recognises the three ways a .gitignore covers .env, and no fourth', () => {
    expect(gitignoreCoversEnv('.env\n')).toBe(true);
    expect(gitignoreCoversEnv('/.env\n')).toBe(true);
    expect(gitignoreCoversEnv('.env   \n')).toBe(true);
    expect(gitignoreCoversEnv('x\n.env\ny\n')).toBe(true);
    expect(gitignoreCoversEnv('.env.local\n')).toBe(false);
    expect(gitignoreCoversEnv('**/.env\n')).toBe(false);
    expect(gitignoreCoversEnv('')).toBe(false);
  });
});

// ----------------------------------------- jq's shape edges, on a damaged --
//                                            journal, where guessing writes a
//                                            NEW journal over a corrupt one.
describe('the entries filters against a hand-damaged journal', () => {
  function withIssues(shape: string): { d: string; run: () => Driven } {
    const d = scratch();
    writeFileSync(join(d, 'governance', 'issues.json'), shape + '\n');
    return {
      d,
      run: () => drive(issue, ctxFor(d), 'new', [
        '--type', 'defect', '--source', 'claude', '--summary', 's', '--fix', 'f',
      ]),
    };
  }

  it('turns a `null` journal into a real one at rc 0, as bash does', () => {
    // `null | .entries += [x]` is `{"entries":[x]}`. `null` is the ONE
    // non-object jq accepts on this side, so the append SUCCEEDS -- and the id
    // is I-0001 on both sides, because bash's next_id errors on the same
    // document and falls back to 1 where this port's empty stream lands on 1.
    const { d, run } = withIssues('null');
    try {
      const { io, rc } = run();
      expect(rc).toBe(0);
      expect(io.stdout).toBe('I-0001\n');
      expect(entry(d, 'issues.json', 'I-0001')['type']).toBe('defect');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('does the same for `{}`, where .entries is merely absent', () => {
    const { d, run } = withIssues('{}');
    try {
      expect(run().rc).toBe(0);
      expect(entry(d, 'issues.json', 'I-0001')['type']).toBe('defect');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses an ARRAY through guard (a), not guard (c), and writes nothing', () => {
    // `[] | .entries` is an error in jq, so bash lands on "jq write failed for
    // <path>". A helper that answered `{}` here -- or that fell through to the
    // shape guard's "not an object with an entries array" -- would either
    // write a NEW journal over the corrupt one or name the wrong damage.
    const { d, run } = withIssues('[]');
    try {
      const { io, rc } = run();
      expect(rc).toBe(2);
      expect(io.stderr).toContain('jq write failed for ');
      expect(io.stderr).not.toContain('not an object with an entries array');
      expect(readFileSync(join(d, 'governance', 'issues.json'), 'utf8')).toBe('[]\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses an .entries that is not an array, and leaves it alone', () => {
    const { d, run } = withIssues('{"entries":"s"}');
    try {
      const { io, rc } = run();
      expect(rc).toBe(2);
      expect(io.stderr).toContain('jq write failed for ');
      expect(readFileSync(join(d, 'governance', 'issues.json'), 'utf8')).toBe('{"entries":"s"}\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------- repair ---

describe('repair journal', () => {
  function repairRepo(): string {
    const d = scratch();
    writeFileSync(join(d, 'governance', 'tasks.json'), J({
      entries: [
        { id: 'T-0001', title: 'a', status: 'proposed' },
        { id: 'T-0002', title: 'b', status: 'proposed' },
      ],
    }));
    return d;
  }

  it('writes the correction and its log entry in ONE operation, and SAYS WHAT IT DID', () => {
    const d = repairRepo();
    try {
      const { io, rc } = drive(repair, ctxFor(d), 'journal', [
        'tasks.json', '--apply', '.entries |= map(.status = "ready")',
        '--why', 'the statuses were corrected by hand and never written back', '--by', 'User',
      ]);
      // THE SILENCE THIS CASE USED TO PIN WAS THE DEFECT. `log_new ...
      // >/dev/null` ends in `emitted` -> `emit`, and `emit` EXITS, so both
      // streams went to the redirect and every line after that call --
      // including the success line -- was unreachable. Measured against bash
      // and reproduced faithfully: empty stdout, empty stderr, rc 0. A
      // MUTATING GOVERNANCE WRITE THAT SUCCEEDS IN TOTAL SILENCE, on the one
      // command reached for when a journal is already damaged, left the
      // operator opening governance/log.json to learn whether anything had
      // happened; it was reported on the 2026-09-02 E2E run and fixed on both
      // sides. What the summary owes its caller is the three facts it alone
      // knows: WHICH journal, what the entry count did, and the id of the log
      // record that now carries the reason.
      expect(rc).toBe(0);
      expect(io.stdout).toBe('repaired governance/tasks.json — entries 2 -> 2, logged as L-0001\n');
      expect(io.stderr).toBe('');
      expect(entry(d, 'tasks.json', 'T-0001')['status']).toBe('ready');
      const log = entry(d, 'log.json', 'L-0001');
      expect(log['actor']).toBe('User');
      expect(log['title']).toBe('Repair applied to governance/tasks.json');
      expect(String(log['what_was_done'])).toContain('Reason: the statuses were corrected by hand');
      // Twelve characters of each hash, which is what `printf '%.12s'` gives.
      expect(String(log['what_was_done'])).toMatch(/Content hash [0-9a-f]{12} -> [0-9a-f]{12}\.$/);
      expect(log['task']).toBe(null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a no-op BEFORE writing, so a tampered journal is not resealed', () => {
    const d = repairRepo();
    try {
      const { io, rc } = drive(repair, ctxFor(d), 'journal', ['tasks.json', '--apply', '.', '--why', 'w', '--by', 'User']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('changed nothing in governance/tasks.json');
      // Nothing was written, so there is no log entry either.
      expect(() => readGov(d, 'log.json')).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("carries jq's own diagnostic into the refusal (D-0085/OQ-13)", () => {
    const d = repairRepo();
    try {
      const { io, rc } = drive(repair, ctxFor(d), 'journal',
        ['tasks.json', '--apply', '.entries |= map(', '--why', 'w', '--by', 'User']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('the jq expression failed against governance/tasks.json');
      expect(io.stderr).toContain('jq: error');
      expect(io.stderr).toContain('Check the filter.');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('lets the writer refuse a shrink, and writes no log entry when it does', () => {
    const d = repairRepo();
    try {
      const { io, rc } = drive(repair, ctxFor(d), 'journal',
        ['tasks.json', '--apply', '.entries |= [.[0]]', '--why', 'w', '--by', 'User']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('this would DROP 1 of 2 entries');
      expect(io.stderr).toContain('ALLOW_ENTRY_REMOVAL=1');
      expect(() => readGov(d, 'log.json')).toThrow();
      // And the journal itself is untouched.
      expect(((readGov(d, 'tasks.json')['entries']) as unknown[]).length).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('honours ALLOW_ENTRY_REMOVAL from the environment it was handed', () => {
    // The env var is the ONLY way to shrink a journal on purpose, and it is
    // read through the noun context rather than from the ambient process --
    // which is the carrier session-sprint-repair.md asks the port to be
    // explicit about.
    const d = repairRepo();
    try {
      const { rc } = drive(repair, ctxFor(d, { ALLOW_ENTRY_REMOVAL: '1' }), 'journal',
        ['tasks.json', '--apply', '.entries |= [.[0]]', '--why', 'the second entry was a duplicate', '--by', 'User']);
      expect(rc).toBe(0);
      expect(((readGov(d, 'tasks.json')['entries']) as unknown[]).length).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a journal that is not there, before hashing anything', () => {
    const d = repairRepo();
    try {
      const { io, rc } = drive(repair, ctxFor(d), 'journal', ['nope.json', '--apply', '.', '--why', 'w', '--by', 'User']);
      expect(rc).toBe(2);
      expect(io.stderr).toContain('no journal at governance/nope.json');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
