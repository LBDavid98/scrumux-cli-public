/**
 * Unit cover for the SMALL WRITE NOUNS -- `exception`, `epic`, `story`,
 * `feature`, `secret`'s two un-differentiated verbs, `log`, `memory`,
 * `decide`, `repair`, and the shared filter seam `nouns/lib/writers.ts`.
 *
 * WHY THIS FILE EXISTS, given that `test/fixtures/tier2*.mjs` already compares
 * every one of these nouns against `.deploy-claude/scripts/lib/cmd-*.sh` byte
 * for byte on stdout, stderr, exit code, `.argv` and the whole post-state tree.
 *
 * A differential case proves the two implementations AGREE. It does not prove
 * they agree on the right thing, and there are four classes of behaviour a
 * fixture corpus structurally cannot hold:
 *
 *   1. THE REFUSAL SURFACE IS THE PRODUCT (Article 5), and these nine nouns
 *      refuse in about seventy distinct ways. Most of the required-field
 *      messages are PARAGRAPHS carrying GOOD/BAD worked examples lifted from
 *      this repo's own ratified records -- `decide --rationale` cites D-0084's
 *      three rejected shapes, `log --did` cites L-0285's diffstat, `exception
 *      --finding` cites X-0001 and X-0002. The corpus cannot afford one case
 *      per paragraph, so they are asserted HERE as ABSOLUTES: the exact bytes
 *      on stderr and the exact exit code. A message that quietly loses its
 *      worked example -- which is the whole teaching mechanism, and a social
 *      one (docs/port/modules/design-nouns.md) -- goes red without needing a
 *      second implementation to disagree with.
 *
 *   2. THE ORDER OF THE GUARDS IS OBSERVABLE IN THE POST-STATE, and the
 *      orderings differ between nouns ON PURPOSE. `story new` runs
 *      `design_ensure` BEFORE the feature ref check, so a story filed against
 *      a missing feature on a fresh repo SEEDS design.json and then refuses;
 *      `decide new` runs its ref checks BEFORE `ensure_file`, so
 *      `--supersedes` against a repo with no decisions.json refuses without
 *      creating one; `exception new` resolves `--task` before it seeds
 *      exceptions.json. Each is asserted as a file that does or does not
 *      exist after a refusal, because that is the only place the difference
 *      shows.
 *
 *   3. THE TWO-JOURNAL WRITES. `log --task`, `decide --supersedes` and
 *      `story new` each write a back-reference, and only the last does it
 *      inside ONE lock. The assertions below pin the exact resulting bytes of
 *      BOTH files, key order included -- a spread that moved `stories` or
 *      `log_entries` off the end of the row it is appended to would still
 *      round-trip through `JSON.parse` and would still satisfy every
 *      "the id is in the array" assertion.
 *
 *   4. `repair journal`'s FOUR PRE-WRITE GATES and its one unreachable
 *      success line. The verb spawns real `jq`, and the branch a fixture takes
 *      depends on the filter it happens to carry; here the filter is chosen
 *      per test, so the syntax-error relay (OQ-13, jq's own first line inside
 *      the refusal), the empty-output truncation guard (I-0058's shape), the
 *      no-op guard and the multi-document stream limit are all seen in one
 *      run. The success path is asserted as EMPTY STDOUT IN BOTH MODES,
 *      because `log_new` is called inside a `>/dev/null` redirect in bash and
 *      everything after it in `cmd-repair.sh` is dead code -- reproduced, and
 *      pinned here so a port that "fixes" it has to say so.
 *
 * NOTHING HERE MAY BE "FIXED". Several shapes below are deliberate and are
 * named in the sources they come from: `exception list` writing its rows
 * straight to stdout so that under `--json` the caller gets prose AHEAD of the
 * envelope; `epic new update E-0001 ...` performing an UPDATE because the bash
 * dispatch branches on the first argument; `exception resolve` being the one
 * write verb in its family with no `seal_bootstrap`; every repeated flag
 * accumulating with no de-duplication; and the unquoted command substitution
 * that field-splits `--feature 'F-1 F-2'` into two ids to CHECK and one string
 * to STORE. Each is pinned as it is. A change that repairs one must change the
 * assertion on purpose, with a ruling.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { RawNumber, type JsonValue } from '../../src/journal/jqformat.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as decide } from '../../src/nouns/decide.js';
import { MODULE as epic } from '../../src/nouns/epic.js';
import { MODULE as exception } from '../../src/nouns/exception.js';
import { MODULE as feature } from '../../src/nouns/feature.js';
import { MODULE as log } from '../../src/nouns/log.js';
import { MODULE as memory } from '../../src/nouns/memory.js';
import { MODULE as repair } from '../../src/nouns/repair.js';
import { MODULE as secret } from '../../src/nouns/secret.js';
import { MODULE as story } from '../../src/nouns/story.js';
import {
  appendEntry,
  idStream,
  mapEntries,
  mergeFields,
  setField,
} from '../../src/nouns/lib/writers.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');

const TODAY = todayStamp();

/** `{"entries": []}` plus the newline `ensure_file` writes (P-49). */
const SEEDED = '{"entries": []}\n';

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'scrumux-writeE-'));
  mkdirSync(join(d, 'governance'), { recursive: true });
  return d;
}

function ctxFor(root: string, env: NodeJS.ProcessEnv = {}): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: TODAY,
    io: captureIo(),
    // Pinned rather than derived: under vitest `process.argv[1]` is the test
    // runner, so the default would answer with a path inside this checkout's
    // src/ and a verb that shelled out would run the WRONG harness. None of
    // the nouns here shells out, but the context is built the same way every
    // other unit file builds it so that stays true by construction.
    scriptsDir: SCRIPTS,
    env,
    cwd: root,
  };
}

interface Driven {
  io: CapturedIo;
  rc: number;
}

/**
 * One invocation, with the `Cli` the dispatcher would have built.
 *
 * The COMMAND string matters: every refusal is rendered
 * `scrumux <command>: error: <message>`, so a test that asserts whole-stderr
 * bytes is also asserting that the noun and verb reached the envelope.
 */
function drive(
  mod: NounModule,
  ctx: DispatchContext,
  noun: string,
  verb: string,
  args: readonly string[],
  json = false,
): Driven {
  const io = captureIo();
  const cli = new Cli(`${noun} ${verb}`, [...args], json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctx, io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

const govPath = (root: string, name: string): string => join(root, 'governance', name);
const govText = (root: string, name: string): string => readFileSync(govPath(root, name), 'utf8');
function plant(root: string, name: string, doc: unknown): void {
  writeFileSync(govPath(root, name), JSON.stringify(doc, null, 2) + '\n');
}

/** `scrumux <command>: error: <message>` plus the newline, on stderr. */
const refusal = (command: string, message: string): string =>
  `scrumux ${command}: error: ${message}\n`;

// ===========================================================================
// exception
// ===========================================================================

const X_LENS =
  'exception: --lens is required (which reviewer raised it) — name the question the reviewer was asking, not the reviewer. GOOD "Scope against the order". GOOD "Repo standards" (X-0001). GOOD "scripts_run" (X-0002). BAD "review" — every finding comes from a review, so it separates nothing when the list is grouped.';

const X_REF =
  'exception: --ref is required (what it is about — a task, a file, a rule) — point at the exact thing, with a line number where there is one. GOOD "harness .claude/scripts/lib/cmd-records.sh:264" (X-0001). GOOD "T-0217" for a task. GOOD "issue-validation.md" for a rule. BAD "the CLI" — nobody can open it.';

const X_FINDING =
  'exception: --finding is required (what was found, in a sentence a person can act on) — say what happened, what is believed to explain it, and what remains unproven, because the person deciding was not there. GOOD "Running records check through the control plane appended printf: write error: Broken pipe to the output the app displayed. The cause is believed to be grep -q closing the pipe under printf, which only reports when the parent has SIGPIPE ignored — as Node does. Eleven call sites were hardened and 497 harness tests stay green, but the symptom was NOT reproduced in eight attempts, so the fix is not confirmed to address it" (X-0001). GOOD "The command refused by block-upstream-edit was re-run after the refusal, but the first run has null exitCode in scriptsRun; the evidence does not show whether it exited nonzero or was blocked pre-execution" (X-0002). BAD "the session did not follow the rules" — no act, no rule named, nothing a person can settle.';

/** The four flags every valid `exception new` needs, in bash's own order. */
const XNEW = ['--lens', 'Scope against the order', '--ref', 'T-0217', '--finding', 'The order says A and the diff does B'];

describe('exception new — the five field gates, in the order bash applies them', () => {
  it('refuses an unknown flag before it validates anything else', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', ['--lense', 'typo']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(
      refusal('exception new', 'exception: unknown flag --lense — see: scrumux help exception'),
    );
    // Nothing was seeded: the flag loop runs before `ensure_file`.
    expect(existsSync(govPath(d, 'exceptions.json'))).toBe(false);
  });

  it('refuses a flag with no value — the STATED divergence from bash `${2?}`', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', ['--lens']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('exception new', 'exception: --lens needs a value'));
  });

  it('names the reviewer question --lens is for, with the two filed examples', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', ['--ref', 'r', '--finding', 'f']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('exception new', X_LENS));
  });

  it('demands a --ref a person can open', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', ['--lens', 'L', '--finding', 'f']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('exception new', X_REF));
  });

  it('demands a --finding that says what remains unproven', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', ['--lens', 'L', '--ref', 'r']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('exception new', X_FINDING));
  });

  it('admits red and yellow and says why there is no green', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', [...XNEW, '--severity', 'green']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'exception new',
      "exception: --severity must be red or yellow, got 'green'. There is no green: a finding nobody needs to see is not filed.",
    ));
    expect(drive(exception, ctxFor(d), 'exception', 'new', [...XNEW, '--severity', 'red']).rc).toBe(0);
  });

  it('names all four dispositions when it refuses a fifth', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', [...XNEW, '--disposition', 'block_the_sprint']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'exception new',
      "exception: --disposition must be one of accept_and_track, requires_ratification, correct_the_record, reject_the_task — got 'block_the_sprint'",
    ));
  });

  it('resolves --task BEFORE it seeds exceptions.json, so a bad ref leaves no file', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', [...XNEW, '--task', 'T-9999']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'exception new',
      'task T-9999 not found in governance/tasks.json — create it first: scrumux task new --title ... --check ...',
    ));
    // THE ORDERING, and the only place it is visible.
    expect(existsSync(govPath(d, 'exceptions.json'))).toBe(false);
  });

  it('leaves --session, --sprint and --rule UNVALIDATED — schema is a later pass', () => {
    const d = scratch();
    // No sessions journal, no sprints journal, no rules file: all three are
    // free text by design (`records check` is the enforcement pass, never a
    // write-time gate), so this succeeds.
    const { rc } = drive(exception, ctxFor(d), 'exception', 'new', [
      ...XNEW, '--session', 'no-such-session', '--sprint', 'SP-9999', '--rule', 'no-such-rule.md',
    ]);
    expect(rc).toBe(0);
  });

  it('writes the record with the four optional keys as explicit nulls, and seals', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'new', XNEW);
    expect(rc).toBe(0);
    // `emitted` -- the bare id and nothing else on stdout.
    expect(io.stdout).toBe('X-0001\n');
    expect(io.stderr).toBe('');
    expect(govText(d, 'exceptions.json')).toBe(`{
  "entries": [
    {
      "id": "X-0001",
      "lens": "Scope against the order",
      "severity": "yellow",
      "ref": "T-0217",
      "finding": "The order says A and the diff does B",
      "disposition": "accept_and_track",
      "status": "open",
      "source": "claude",
      "created_at": "${TODAY}",
      "session": null,
      "task": null,
      "sprint": null,
      "rule": null
    }
  ]
}
`);
    // `new` DOES seal_bootstrap. `resolve` does not -- see below.
    expect(existsSync(govPath(d, 'seals.json'))).toBe(true);
  });

  it('takes its source from GOV_ACTOR, and --source overrides that', () => {
    const d = scratch();
    drive(exception, ctxFor(d, { GOV_ACTOR: 'issue-validator' }), 'exception', 'new', XNEW);
    // An EMPTY GOV_ACTOR falls back exactly as `${GOV_ACTOR:-claude}` does.
    drive(exception, ctxFor(d, { GOV_ACTOR: '' }), 'exception', 'new', XNEW);
    drive(exception, ctxFor(d, { GOV_ACTOR: 'ignored' }), 'exception', 'new', [...XNEW, '--source', 'User']);
    const rows = (JSON.parse(govText(d, 'exceptions.json')) as { entries: { id: string; source: string }[] }).entries;
    expect(rows.map((r) => [r.id, r.source])).toEqual([
      ['X-0001', 'issue-validator'],
      ['X-0002', 'claude'],
      ['X-0003', 'User'],
    ]);
  });

  it('stores every optional field it was given, with a task ref that resolves', () => {
    const d = scratch();
    plant(d, 'tasks.json', { entries: [{ id: 'T-0217', title: 't', status: 'proposed' }] });
    const { rc } = drive(exception, ctxFor(d), 'exception', 'new', [
      ...XNEW,
      '--severity', 'red',
      '--disposition', 'requires_ratification',
      '--source', 'User',
      '--session', 'S-2026-09-01',
      '--task', 'T-0217',
      '--sprint', 'SP-0004',
      '--rule', 'issue-validation.md',
    ]);
    expect(rc).toBe(0);
    const row = (JSON.parse(govText(d, 'exceptions.json')) as { entries: Record<string, JsonValue>[] }).entries[0]!;
    expect(Object.keys(row)).toEqual([
      'id', 'lens', 'severity', 'ref', 'finding', 'disposition', 'status',
      'source', 'created_at', 'session', 'task', 'sprint', 'rule',
    ]);
    expect(row).toMatchObject({
      severity: 'red',
      disposition: 'requires_ratification',
      source: 'User',
      session: 'S-2026-09-01',
      task: 'T-0217',
      sprint: 'SP-0004',
      rule: 'issue-validation.md',
    });
  });
});

describe('exception resolve — records what a person did, and never does it', () => {
  /** One open finding, so a test can vary exactly one thing about the call. */
  function repoWithX(): string {
    const d = scratch();
    plant(d, 'exceptions.json', {
      entries: [
        {
          id: 'X-0001', lens: 'Scope', severity: 'red', ref: 'T-0217', finding: 'f',
          disposition: 'accept_and_track', status: 'open', source: 'claude', created_at: '2026-08-30',
        },
        { id: 'X-0002', lens: 'Standards', severity: 'yellow', ref: 'f.sh:1', finding: 'g', disposition: 'reject_the_task', status: 'open', source: 'User', created_at: '2026-08-30' },
      ],
    });
    return d;
  }

  it('asks which exception when the id is missing', () => {
    const d = repoWithX();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'resolve', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'exception resolve',
      'exception: which exception? Example: scrumux exception resolve X-0001 --status tracked --by user',
    ));
  });

  it('refuses an unknown flag, and a flag with no value', () => {
    const d = repoWithX();
    const bad = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--stat', 'tracked']);
    expect(bad.rc).toBe(2);
    expect(bad.io.stderr).toBe(refusal(
      'exception resolve', 'exception: unknown flag --stat — see: scrumux help exception',
    ));
    const bare = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal('exception resolve', 'exception: --status needs a value'));
  });

  it('says the repo has no exceptions.json before it says anything about the id', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status', 'tracked', '--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('exception resolve', 'exception: this repo has no exceptions.json yet'));
  });

  it('names the id it could not find', () => {
    const d = repoWithX();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0009', '--status', 'tracked', '--by', 'User']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('exception resolve', 'exception: no X-0009 in this repo'));
  });

  it('requires a --status, refuses `open`, and lists the five it takes', () => {
    const d = repoWithX();
    const none = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--by', 'User']);
    expect(none.rc).toBe(2);
    expect(none.io.stderr).toBe(refusal(
      'exception resolve', 'exception: --status is required (tracked|ratified|corrected|rejected|withdrawn)',
    ));
    // `open` is a member of nothing: it is the FILING state, and it is refused
    // one guard earlier than the enum, with its own sentence.
    const open = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status', 'open', '--by', 'User']);
    expect(open.rc).toBe(2);
    expect(open.io.stderr).toBe(refusal(
      'exception resolve', 'exception: --status open is the filing state; resolve moves it off open',
    ));
    const bad = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status', 'escalated', '--by', 'User']);
    expect(bad.rc).toBe(2);
    expect(bad.io.stderr).toBe(refusal(
      'exception resolve',
      "exception: --status must be one of tracked, ratified, corrected, rejected, withdrawn — got 'escalated'",
    ));
  });

  it('will not settle a finding on nobody\'s authority', () => {
    const d = repoWithX();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status', 'tracked']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'exception resolve', 'exception: --by is required. A finding settled by nobody is not settled.',
    ));
  });

  it('keeps status in place, appends the two new keys, and touches no other row', () => {
    const d = repoWithX();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'resolve', [
      'X-0001', '--status', 'corrected', '--by', 'User', '--note', 'record corrected in D-0090', '--authority', 'direct',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('X-0001\n');
    // `. + {…}`: `status` does NOT move, and the two new keys land in the
    // RHS object's order, after everything the row already had.
    expect(govText(d, 'exceptions.json')).toBe(`{
  "entries": [
    {
      "id": "X-0001",
      "lens": "Scope",
      "severity": "red",
      "ref": "T-0217",
      "finding": "f",
      "disposition": "accept_and_track",
      "status": "corrected",
      "source": "claude",
      "created_at": "2026-08-30",
      "resolved_by": "User",
      "resolution": "record corrected in D-0090",
      "resolution_status": "ratified",
      "authority": "direct",
      "recorded_by": "User",
      "ratified_by": "User"
    },
    {
      "id": "X-0002",
      "lens": "Standards",
      "severity": "yellow",
      "ref": "f.sh:1",
      "finding": "g",
      "disposition": "reject_the_task",
      "status": "open",
      "source": "User",
      "created_at": "2026-08-30"
    }
  ]
}
`);
  });

  it('writes an explicit null resolution when there is no --note', () => {
    const d = repoWithX();
    expect(drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0002', '--status', 'withdrawn', '--by', 'User']).rc).toBe(0);
    const rows = (JSON.parse(govText(d, 'exceptions.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect(rows[1]!['resolution']).toBeNull();
    expect('resolution' in rows[1]!).toBe(true);
  });

  it('is the ONE write verb in this family with no seal_bootstrap', () => {
    const d = repoWithX();
    drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status', 'tracked', '--by', 'User']);
    // `new` would have created it. `resolve` reseals -- twice -- and
    // `reseal_one` is a no-op before the repo has ever been sealed, so a repo
    // that predates sealing stays unsealed through a resolve. OQ-DN1.
    expect(existsSync(govPath(d, 'seals.json'))).toBe(false);
  });
});

describe('exception list — rows straight to stdout, in BOTH modes', () => {
  it('says so when the repo has no exceptions.json, and still emits the summary', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'list', []);
    expect(rc).toBe(0);
    // `say` then the dispatcher's own safety net -- the sentence is not typed
    // twice in the source and is not typed twice here.
    expect(io.stdout).toBe('no exceptions recorded in this repo\nscrumux exception list: ok.\n');
  });

  it('renders only the OPEN rows, and skips anything that is not an object', () => {
    const d = scratch();
    plant(d, 'exceptions.json', {
      entries: [
        { id: 'X-0001', lens: 'Scope', severity: 'red', ref: 'T-0217', finding: 'the order says A', disposition: 'reject_the_task', status: 'open' },
        { id: 'X-0002', lens: 'Standards', severity: 'yellow', ref: 'f.sh:1', finding: 'closed one', disposition: 'accept_and_track', status: 'tracked' },
        'a hand-edited string where a row should be',
        { id: 'X-0003', lens: 'scripts_run', severity: 'yellow', ref: 'X-0002', finding: 'evidence is silent', disposition: 'correct_the_record', status: 'open' },
      ],
    });
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'list', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      'X-0001  red  reject_the_task  Scope — T-0217: the order says A\n' +
      'X-0003  yellow  correct_the_record  scripts_run — X-0002: evidence is silent\n' +
      'scrumux exception list: ok.\n',
    );
  });

  it('answers an unparseable journal with no rows rather than a report', () => {
    const d = scratch();
    writeFileSync(govPath(d, 'exceptions.json'), '{ this is not json');
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'list', []);
    expect(rc).toBe(0);
    // Still NO ROWS and still rc 0 -- that is the claim. What the reply no
    // longer is is silent: an answer of "nothing is open" now says so, in the
    // vocabulary the rest of the CLI already uses, instead of leaving the
    // dispatcher's `ok.` to stand in for it. On an UNPARSEABLE journal that
    // matters most: the operator is looking at the one surface that still
    // reads, and a blank reply is the same shape as a command that never ran.
    expect(io.stdout).toBe('(no open exceptions)\nscrumux exception list: ok.\n');
  });

  it('puts PROSE AHEAD OF THE ENVELOPE under --json, which is the measured shape', () => {
    const d = scratch();
    plant(d, 'exceptions.json', {
      entries: [{ id: 'X-0001', lens: 'Scope', severity: 'red', ref: 'T-0217', finding: 'f', disposition: 'reject_the_task', status: 'open' }],
    });
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'list', [], true);
    expect(rc).toBe(0);
    const line = 'X-0001  red  reject_the_task  Scope — T-0217: f\n';
    // A machine consumer of `scrumux --json exception list` gets one line of
    // prose and THEN an object. Reproduced from bash, not repaired.
    expect(io.stdout.startsWith(line)).toBe(true);
    const env = JSON.parse(io.stdout.slice(line.length)) as { ok: boolean; summary: string };
    expect(env.ok).toBe(true);
    expect(env.summary).toBe('scrumux exception list: ok.');
  });

  it('names its verbs when the verb is not one of them', () => {
    const d = scratch();
    const { io, rc } = drive(exception, ctxFor(d), 'exception', 'close', ['X-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'exception close',
      "unknown verb 'close' for noun exception — try new, resolve, list, ratify, reject or acknowledge. See: scrumux help exception",
    ));
  });
});

// ===========================================================================
// epic
// ===========================================================================

const E_NAME =
  'epic: --name is required — the state of the world the epic reaches, said as a claim rather than a heading. GOOD "Self-knowledge: the harness sees its own code and its own governance" (E-0005). GOOD "CLI MVP" (E-0006). BAD "Improvements" — it names no destination, so nothing can be said to be inside or outside it.';

const E_DESC =
  'epic: --desc is required — what changes when the epic lands, and where the scope came from. GOOD "The harness stops reasoning about itself by reading and starts reasoning about itself by query. A code graph and a governance graph on one shared library, so context packs are derived rather than hand-assembled and impact questions are answered mechanically. Fulfils D-0009, ratified but never built, and closes I-0018" (E-0005). GOOD "The harness stands alone: it installs into any repo, proves it is live there, refuses only what is dangerous, runs its gates in seconds, and records enough about its own behaviour that the next round of priorities comes from data. Everything in this epic comes from the deep-dive review of 2026-08-20 and D-0058..D-0061" (E-0006). BAD "various fixes" — a later reader cannot tell what belongs in it.';

/** A design.json holding two features and nothing else. */
function designWithFeatures(root: string): void {
  plant(root, 'design.json', {
    entries: [
      { kind: 'feature', id: 'F-0001', name: 'Gate integrity', description: 'd' },
      { kind: 'feature', id: 'F-0002', name: 'Deployability', description: 'd' },
    ],
  });
}

describe('epic new', () => {
  it('refuses an unknown flag and a flag with no value', () => {
    const d = scratch();
    const unknown = drive(epic, ctxFor(d), 'epic', 'new', ['--titel', 'x']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(refusal('epic new', 'epic: unknown flag --titel — see: scrumux help epic'));
    const bare = drive(epic, ctxFor(d), 'epic', 'new', ['--name']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal('epic new', 'epic: --name needs a value — see: scrumux help epic'));
  });

  it('demands a destination for --name and a mechanism for --desc', () => {
    const d = scratch();
    const noName = drive(epic, ctxFor(d), 'epic', 'new', ['--desc', 'd']);
    expect(noName.rc).toBe(2);
    expect(noName.io.stderr).toBe(refusal('epic new', E_NAME));
    const noDesc = drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'CLI MVP']);
    expect(noDesc.rc).toBe(2);
    expect(noDesc.io.stderr).toBe(refusal('epic new', E_DESC));
    // Both refusals are BEFORE `design_ensure`.
    expect(existsSync(govPath(d, 'design.json'))).toBe(false);
  });

  it('seeds design.json and THEN refuses an unknown --feature', () => {
    const d = scratch();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'n', '--desc', 'd', '--feature', 'F-9999']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic new', 'epic: feature F-9999 not found — add it first: scrumux feature new --name ... --desc ...',
    ));
    // The 16 literal bytes, never jq's rendering (P-49) -- and the file is
    // there, because `design_ensure` ran before the ref check.
    expect(govText(d, 'design.json')).toBe(SEEDED);
  });

  it('writes the epic with no features key when none were given', () => {
    const d = scratch();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'CLI MVP', '--desc', 'The CLI ships']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('E-0001\n');
    expect(govText(d, 'design.json')).toBe(`{
  "entries": [
    {
      "kind": "epic",
      "id": "E-0001",
      "name": "CLI MVP",
      "description": "The CLI ships"
    }
  ]
}
`);
  });

  it('allocates E- ids against E- rows only, since design.json is polymorphic', () => {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [
        { kind: 'feature', id: 'F-0001', name: 'f', description: 'd' },
        { kind: 'story', id: 'S-0007', feature: 'F-0001', narrative: 'n', acceptance_criteria: ['c'] },
      ],
    });
    drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'n', '--desc', 'd']);
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: { id: string }[] }).entries;
    // Not E-0003: the F- and S- rows are not in the E- stream.
    expect(rows[2]!.id).toBe('E-0001');
  });

  it('CHECKS a space-separated --feature as two ids and STORES it as one string', () => {
    const d = scratch();
    designWithFeatures(d);
    // The command substitution bash iterates is UNQUOTED, so the shell
    // field-splits it before the ref check; the accumulator the WRITE reads is
    // the array. Both halves are reproduced, and this is the only place the
    // difference is visible.
    const { rc } = drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'n', '--desc', 'd', '--feature', 'F-0001 F-0002']);
    expect(rc).toBe(0);
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect(rows[2]!['features']).toEqual(['F-0001 F-0002']);
    // ...and a value that field-splits into an id that does NOT exist refuses.
    const bad = drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'n', '--desc', 'd', '--feature', 'F-0001 F-0404']);
    expect(bad.rc).toBe(2);
    expect(bad.io.stderr).toContain('epic: feature F-0404 not found');
  });

  it('accumulates a repeated --feature with NO de-duplication', () => {
    const d = scratch();
    designWithFeatures(d);
    drive(epic, ctxFor(d), 'epic', 'new', ['--name', 'n', '--desc', 'd', '--feature', 'F-0001', '--feature', 'F-0001']);
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect(rows[2]!['features']).toEqual(['F-0001', 'F-0001']);
  });
});

describe('epic update', () => {
  /** Two features and an epic carrying one of them. */
  function epicRepo(features: string[] = ['F-0001']): string {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [
        { kind: 'feature', id: 'F-0001', name: 'Gate integrity', description: 'd' },
        { kind: 'feature', id: 'F-0002', name: 'Deployability', description: 'd' },
        { kind: 'epic', id: 'E-0001', name: 'CLI MVP', description: 'd', features },
      ],
    });
    return d;
  }

  it('prints the usage line when the id is missing', () => {
    const d = epicRepo();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update',
      'usage: scrumux epic update E-0001 [--add-feature F-0001]... [--remove-feature F-0001]...',
    ));
  });

  it('hands over the jq that lists the ids when the epic is not there', () => {
    const d = epicRepo();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0009', '--add-feature', 'F-0002']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update',
      `epic update: E-0009 not found in design.json — list ids: jq -r '.entries[] | select(.kind=="epic") | .id' governance/design.json`,
    ));
  });

  it('refuses an unknown flag and a flag with no value, with `epic update`\'s own wording', () => {
    const d = epicRepo();
    const unknown = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--add', 'F-0002']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(refusal(
      'epic update', 'epic update: unknown flag --add — see: scrumux help epic',
    ));
    const bare = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--add-feature']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal(
      'epic update', 'epic update: --add-feature needs a value — see: scrumux help epic',
    ));
  });

  it('refuses an update with neither flag', () => {
    const d = epicRepo();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update', 'epic update: nothing to update — pass --add-feature and/or --remove-feature',
    ));
  });

  it('refuses a feature that is not in design.json', () => {
    const d = epicRepo();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--add-feature', 'F-0404']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update', 'epic update: feature F-0404 not found — add it first: scrumux feature new --name ... --desc ...',
    ));
  });

  it("refuses a second copy — an epic's features are a set", () => {
    const d = epicRepo();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--add-feature', 'F-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update', "epic update: F-0001 is already on E-0001 — an epic's features are a set",
    ));
  });

  it('prints the CURRENT list when a removal has nothing to remove', () => {
    const d = epicRepo(['F-0001', 'F-0002']);
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--remove-feature', 'F-0404']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update', 'epic update: F-0404 is not on E-0001 — nothing to remove; current: F-0001, F-0002',
    ));
  });

  it('renders an EMPTY current list rather than "(none)" — it is a jq join', () => {
    const d = epicRepo([]);
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--remove-feature', 'F-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update', 'epic update: F-0001 is not on E-0001 — nothing to remove; current: ',
    ));
  });

  it('adds and removes in one write, and says the epic was updated', () => {
    const d = epicRepo(['F-0001']);
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', [
      'E-0001', '--add-feature', 'F-0002', '--remove-feature', 'F-0001',
    ]);
    expect(rc).toBe(0);
    // NOT `emitted` -- this verb ends in `cli.emit`, so the summary is the
    // sentence and there is no bare id.
    expect(io.stdout).toBe('E-0001 updated\n');
    expect(govText(d, 'design.json')).toBe(`{
  "entries": [
    {
      "kind": "feature",
      "id": "F-0001",
      "name": "Gate integrity",
      "description": "d"
    },
    {
      "kind": "feature",
      "id": "F-0002",
      "name": "Deployability",
      "description": "d"
    },
    {
      "kind": "epic",
      "id": "E-0001",
      "name": "CLI MVP",
      "description": "d",
      "features": [
        "F-0002"
      ]
    }
  ]
}
`);
  });

  it('removes EVERY occurrence of a duplicate in one removal, as jq\'s array minus does', () => {
    const d = epicRepo(['F-0001', 'F-0002', 'F-0001']);
    expect(drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--remove-feature', 'F-0001']).rc).toBe(0);
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect(rows[2]!['features']).toEqual(['F-0002']);
  });

  it('`epic new update E-0001 ...` performs an UPDATE — the dispatch is on $1', () => {
    const d = epicRepo(['F-0001']);
    // Not a shape worth inventing and not a shape worth quietly closing: the
    // deployed CLI does exactly this, and the differential compares the argv
    // the caller actually typed.
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'new', ['update', 'E-0001', '--add-feature', 'F-0002']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('E-0001 updated\n');
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect(rows[2]!['features']).toEqual(['F-0001', 'F-0002']);
  });

  it('names both verbs when the verb is neither', () => {
    const d = scratch();
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'list', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic list', "unknown verb 'list' for noun epic — verbs: new, update. See: scrumux help epic",
    ));
  });
});

// ===========================================================================
// story
// ===========================================================================

const S_NARRATIVE =
  'story: --narrative is required — "As the <specific who>, I <do what> so that <outcome>". The who is a named person or system, never "a user". GOOD "As User, I accept a task directly — my documented approval is the review — and acceptance refuses any task whose verify receipt is red, so a false close cannot recur" (S-0069). GOOD "As User, I deploy the harness into another repo and every registered command actually runs there, and a cold agent in either lane arrives at working code without hunting" (S-0070). BAD "As a user, I want acceptance to work" — no named who, no outcome, and nothing an acceptance criterion could be written against.';

const S_CRITERION =
  'story: at least one --criterion is required (acceptance_criteria, minItems 1) — each one an observable check a person could confirm or deny by looking at the running thing or its record: a shape returned, a refusal given, a record written, a command exiting a stated code. One behaviour per criterion; a criterion with "and" in it is usually two. GOOD "scrumux accept T-XXXX --authority refuses a red or missing receipt and is write-once" (S-0069). GOOD "harness verify executes every registered surface" (S-0070). GOOD "cold probes of the standalone and app lanes pass with task-verify under 15s and close under 10s" (S-0070). BAD "acceptance is reliable" — an adjective, not a check.';

describe('story new — one verb, and one filter that writes twice inside one lock', () => {
  it('refuses an unknown flag and a flag with no value', () => {
    const d = scratch();
    const unknown = drive(story, ctxFor(d), 'story', 'new', ['--story', 'x']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(refusal('story new', 'story: unknown flag --story — see: scrumux help story'));
    const bare = drive(story, ctxFor(d), 'story', 'new', ['--criterion']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal('story new', 'story: --criterion needs a value — see: scrumux help story'));
  });

  it('names the three required fields, and only --feature has a short message', () => {
    const d = scratch();
    const noFeature = drive(story, ctxFor(d), 'story', 'new', ['--narrative', 'n', '--criterion', 'c']);
    expect(noFeature.rc).toBe(2);
    expect(noFeature.io.stderr).toBe(refusal('story new', 'story: --feature is required'));
    const noNarrative = drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0001', '--criterion', 'c']);
    expect(noNarrative.io.stderr).toBe(refusal('story new', S_NARRATIVE));
    const noCriterion = drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0001', '--narrative', 'n']);
    expect(noCriterion.io.stderr).toBe(refusal('story new', S_CRITERION));
    // All three refuse before `design_ensure`.
    expect(existsSync(govPath(d, 'design.json'))).toBe(false);
  });

  it('SEEDS design.json and then refuses a missing feature — bash\'s order, visible in the post-state', () => {
    const d = scratch();
    const { io, rc } = drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0009', '--narrative', 'n', '--criterion', 'c']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'story new', 'story: feature F-0009 not found — add it first: scrumux feature new --name ... --desc ...',
    ));
    // `decide` does NOT do this; `story` does. The difference is the point.
    expect(govText(d, 'design.json')).toBe(SEEDED);
  });

  it('appends the story AND stamps the parent feature, in one write', () => {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [{ kind: 'feature', id: 'F-0001', name: 'Gate integrity', description: 'd' }],
    });
    const { io, rc } = drive(story, ctxFor(d), 'story', 'new', [
      '--feature', 'F-0001',
      '--narrative', 'As User, I accept a task directly',
      '--criterion', 'the receipt is green',
      '--criterion', 'acceptance is write-once',
    ]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('S-0001\n');
    // `stories` is an ASSIGNMENT onto a row that lacks the key, so it lands at
    // the END of the feature row; the story row is appended after it.
    expect(govText(d, 'design.json')).toBe(`{
  "entries": [
    {
      "kind": "feature",
      "id": "F-0001",
      "name": "Gate integrity",
      "description": "d",
      "stories": [
        "S-0001"
      ]
    },
    {
      "kind": "story",
      "id": "S-0001",
      "feature": "F-0001",
      "narrative": "As User, I accept a task directly",
      "acceptance_criteria": [
        "the receipt is green",
        "acceptance is write-once"
      ]
    }
  ]
}
`);
  });

  it('appends to a stories array that is already there, keeping its position', () => {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [
        { kind: 'feature', id: 'F-0001', name: 'f', stories: ['S-0001'], description: 'd' },
        { kind: 'story', id: 'S-0001', feature: 'F-0001', narrative: 'n', acceptance_criteria: ['c'] },
      ],
    });
    expect(drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0001', '--narrative', 'n2', '--criterion', 'c2']).rc).toBe(0);
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect(rows[0]!['stories']).toEqual(['S-0001', 'S-0002']);
    // The key did NOT move to the end: jq's assignment leaves it where it was.
    expect(Object.keys(rows[0]!)).toEqual(['kind', 'id', 'name', 'stories', 'description']);
  });

  it('names its only verb when the verb is not it', () => {
    const d = scratch();
    const { io, rc } = drive(story, ctxFor(d), 'story', 'update', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'story update', "unknown verb 'update' for noun story — the only verb is 'new'. See: scrumux help story",
    ));
  });
});

// ===========================================================================
// feature
// ===========================================================================

const F_NAME =
  'feature: --name is required — two or three words naming the capability, not the work. GOOD "Governance graph" (F-0008). GOOD "Gate integrity" (F-0009). GOOD "Deployability" (F-0013). BAD "Phase 2 improvements" — a schedule, not a capability.';

const F_DESC =
  'feature: --desc is required — what the capability makes possible and how you will be able to tell, in two or three sentences. GOOD "No gate reports a pass it did not earn. The four cross-script dependencies fail closed instead of open; the destructive-command attestation leaves a record; the issue source field is a constrained enum so drift data has a reliable who-raised-this dimension" (F-0009). GOOD "The harness installs into any repo and can prove it is actually live there. Root resolution decoupled from script location, harness deploy and harness verify as CLI commands with machine-readable output, and a read-only sandbox that works on Linux as well as darwin" (F-0013). BAD "makes deploys better" — no mechanism and nothing a story could be written against.';

describe('feature new', () => {
  it('refuses an unknown flag and a flag with no value', () => {
    const d = scratch();
    const unknown = drive(feature, ctxFor(d), 'feature', 'new', ['--depends', 'F-0001']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(refusal('feature new', 'feature: unknown flag --depends — see: scrumux help feature'));
    const bare = drive(feature, ctxFor(d), 'feature', 'new', ['--dep']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal('feature new', 'feature: --dep needs a value — see: scrumux help feature'));
  });

  it('demands a capability for --name and a mechanism for --desc', () => {
    const d = scratch();
    expect(drive(feature, ctxFor(d), 'feature', 'new', ['--desc', 'd']).io.stderr).toBe(refusal('feature new', F_NAME));
    expect(drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'n']).io.stderr).toBe(refusal('feature new', F_DESC));
    expect(existsSync(govPath(d, 'design.json'))).toBe(false);
  });

  it('refuses a --dep that is not a feature in design.json', () => {
    const d = scratch();
    const { io, rc } = drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'n', '--desc', 'd', '--dep', 'F-0404']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('feature new', 'feature: --dep F-0404 not found'));
    expect(govText(d, 'design.json')).toBe(SEEDED);
  });

  it('leaves .rank unset — rank is never manufactured (P-44)', () => {
    const d = scratch();
    const { io, rc } = drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'Gate integrity', '--desc', 'No gate reports a pass it did not earn']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('F-0001\n');
    expect(govText(d, 'design.json')).toBe(`{
  "entries": [
    {
      "kind": "feature",
      "id": "F-0001",
      "name": "Gate integrity",
      "description": "No gate reports a pass it did not earn"
    }
  ]
}
`);
  });

  it('allocates F- ids against F- rows only, not against everything in design.json', () => {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [
        { kind: 'epic', id: 'E-0001', name: 'e', description: 'd' },
        { kind: 'story', id: 'S-0004', feature: 'F-0001', narrative: 'n', acceptance_criteria: ['c'] },
      ],
    });
    drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'n', '--desc', 'd']);
    const rows = (JSON.parse(govText(d, 'design.json')) as { entries: { id: string }[] }).entries;
    expect(rows[2]!.id).toBe('F-0001');
  });

  it('writes a duplicated --dep twice, and stores a space-separated one as ONE id', () => {
    const d = scratch();
    designWithFeatures(d);
    drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'n', '--desc', 'd', '--dep', 'F-0001', '--dep', 'F-0001']);
    const dup = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries[2]!;
    expect(dup['dependencies']).toEqual(['F-0001', 'F-0001']);
    drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'n', '--desc', 'd', '--dep', 'F-0001 F-0002']);
    const split = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries[3]!;
    expect(split['dependencies']).toEqual(['F-0001 F-0002']);
  });

  it('names its only verb when the verb is not it', () => {
    const d = scratch();
    const { io, rc } = drive(feature, ctxFor(d), 'feature', 'list', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'feature list', "unknown verb 'list' for noun feature — the only verb is 'new'. See: scrumux help feature",
    ));
  });
});

// ===========================================================================
// secret -- the two verbs the differential corpus does not drive
// ===========================================================================

describe('secret remove', () => {
  it('refuses a name that is the READ verb, in remove\'s own argv shape', () => {
    const d = scratch();
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'remove', ['reveal']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'secret remove',
      "secret: there is no 'reveal' — a stored value is never printed back, which is the point of storing it here. Names and fingerprints: scrumux secret list. The value is read by this repo's own code from .env at runtime.",
    ));
  });

  it('refuses a name that is not a usable environment variable name', () => {
    const d = scratch();
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'remove', ['MY-TOKEN']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'secret remove',
      "secret: 'MY-TOKEN' is not a usable environment variable name — letters, digits and underscore only, not starting with a digit. The name is what the repo's code will reference, so it is not normalised for you",
    ));
  });

  it('says there is no .env before it says the name is missing from one', () => {
    const d = scratch();
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'remove', ['TOKEN']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('secret remove', 'secret: no .env to remove TOKEN from'));
  });

  it('refuses a name .env does not carry, and leaves the file alone', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'OTHER=keep\n');
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'remove', ['TOKEN']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('secret remove', 'secret: TOKEN is not in .env — nothing removed'));
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('OTHER=keep\n');
  });

  it('drops the line, re-asserts mode 600, and carries no value in its payload', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'FIRST=a\nTOKEN=the-secret-value\nLAST=z\n');
    chmodSync(join(d, '.env'), 0o644);
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'remove', ['TOKEN'], true);
    expect(rc).toBe(0);
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('FIRST=a\nLAST=z\n');
    // `env_drop` chmods twice and bash guards neither; the file must still
    // come out 600 -- an absolute, not a same-as-bash comparison.
    expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o600);
    const env = JSON.parse(io.stdout) as { data: Record<string, JsonValue>; summary: string };
    expect(env.data).toEqual({ name: 'TOKEN', removed: true });
    expect(env.summary).toBe('TOKEN removed from .env');
    expect(io.stdout).not.toContain('the-secret-value');
  });

  it('matches an `export NAME=` line, which is the PK-13 half that used to be invisible', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'export TOKEN=v\nOTHER=keep\n');
    const { rc } = drive(secret, ctxFor(d), 'secret', 'remove', ['TOKEN']);
    expect(rc).toBe(0);
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('OTHER=keep\n');
  });

  it('strips the trailing blank lines a hand edit left behind — `$( )` does', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'KEEP=1\nTOKEN=v\n\n\n');
    drive(secret, ctxFor(d), 'secret', 'remove', ['TOKEN']);
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('KEEP=1\n');
  });

  it('empties .env entirely when the dropped line was the only one', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'TOKEN=v\n');
    drive(secret, ctxFor(d), 'secret', 'remove', ['TOKEN']);
    // The file is TRUNCATED, not deleted: `env_drop` rewrites it.
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('');
  });
});

describe('secret set — the gitignore-first ordering, which is the security property', () => {
  it('refuses an argument list whose first positional is the empty string', () => {
    const d = scratch();
    // `secret set ''` reaches `requireUsableName` with an empty name, which is
    // the usage arm rather than the enum or the charset one.
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'secret set',
      'secret: usage: scrumux secret set NAME [VALUE] — the value may be omitted and piped on stdin instead, which keeps it out of shell history and out of every hook that reads the command string',
    ));
  });

  it('creates a .gitignore that covers .env when there is none', () => {
    const d = scratch();
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(rc).toBe(0);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('# secrets — never commit\n.env\n');
    expect(io.stdout).toContain('created .gitignore covering .env\n');
  });

  it('APPENDS to a .gitignore that does not cover .env, and says which it did', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(rc).toBe(0);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('node_modules\n\n# secrets — never commit\n.env\n');
    expect(io.stdout).toContain('added .env to .gitignore\n');
    expect(io.stdout).not.toContain('created .gitignore');
  });

  it('leaves a .gitignore that already covers .env untouched and says nothing about it', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n/.env\n');
    const { io } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('node_modules\n/.env\n');
    expect(io.stdout).not.toContain('.gitignore');
  });

  it('reports `replaced` and drops the PRIOR line, including an export-prefixed one', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), '.env\n');
    writeFileSync(join(d, '.env'), 'export TOKEN=old-secret\nOTHER=keep\n');
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'new-secret']);
    expect(rc).toBe(0);
    // THE PK-13 WORST CASE: before the fix the old line was not dropped, the
    // new one was appended, and the OLD SECRET SURVIVED beside the new one.
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('OTHER=keep\nTOKEN=new-secret\n');
    expect(io.stdout).toContain('TOKEN replaced in .env (10 bytes, sha256:');
    expect(io.stdout).not.toContain('old-secret');
  });

  it('measures the value in BYTES and prints the NOTE when it came from argv', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), '.env\n');
    // Four characters, seven UTF-8 bytes: `wc -c` is what bash reports.
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'aé€']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('TOKEN stored in .env (6 bytes, sha256:');
    expect(io.stdout).toContain('— mode 600, gitignored\n');
    expect(io.stdout).toContain(
      "NOTE: you passed the value as an argument, so it is in this shell's history and in any transcript of this call.",
    );
  });

  it('refuses an .env git already tracks — AFTER it has fixed the .gitignore', () => {
    const d = scratch();
    // A real repo, because `gitTracksEnv` runs three real git probes and the
    // "already tracked" arm is unreachable without one. Tracked is WORSE than
    // un-ignored: .gitignore does not apply to a file git already follows.
    execFileSync('git', ['-C', d, 'init', '-q'], { stdio: 'ignore' });
    writeFileSync(join(d, '.env'), 'TOKEN=already-committed\n');
    execFileSync('git', ['-C', d, 'add', '-f', '.env'], { stdio: 'ignore' });
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'secret set',
      'secret: .env is ALREADY TRACKED by git — .gitignore does not apply to a tracked file and this would be committed. Untrack it first: git rm --cached .env',
    ));
    // THE WRITE-THROUGH (User's 2026-09-01 ruling). The verb SPOKE and then
    // REFUSED, and the operator must still learn their .gitignore changed --
    // a buffered `say` loses exactly this line.
    expect(io.stdout).toBe('created .gitignore covering .env\n');
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('# secrets — never commit\n.env\n');
    // ...and the value was not written.
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('TOKEN=already-committed\n');
  });

  it('is silent about git when the root is not a repo at all', () => {
    const d = scratch();
    const { rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(rc).toBe(0);
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('TOKEN=v\n');
  });
});

// ===========================================================================
// log
// ===========================================================================

const L_TITLE =
  'log: --title is required — one sentence naming what changed and the record ids it settles, in the past tense. GOOD (build) "The prune stopped eating the two files deploy promises never to overwrite (I-0152, I-0153)" (L-0285). GOOD (defect) "A wall stops recording a sub-agent refusal as the session own (I-0154)". GOOD (governance) "Repair applied to governance/decisions.json" (L-0284). BAD "fixed hook" — eight words of jargon that name neither the hook nor what stopped being wrong.';

const L_DID =
  'log: --did is required (what_was_done) — the EVIDENCE, not a story: the verify command and its rc, git diff --stat, and every refusal you hit and what you did about it. GOOD "harness deploy seeding lane creates .claude/rules/project-standards.md and .claude/project-walls.conf create-if-absent; the I-0143 prune then removed any path the previous manifest names that payload.list lacks. Fixed by writing each seeded path into TMPD/seeded.list and skipping it in the prune. sh tests/harness-tests.sh rc=0; 3 files changed, 61 insertions" (L-0285). GOOD "scrumux repair on governance/decisions.json. Reason: stamping the back-references for D-0081 and D-0082, without which the twenty dead rulings go on rendering as current law" (L-0284). BAD "created X, verified Y" — nothing there can be checked by a reader who was not present.';

describe('log new — the append-only work log and its second, non-atomic write', () => {
  it('refuses an unknown flag and a flag with no value', () => {
    const d = scratch();
    const unknown = drive(log, ctxFor(d), 'log', 'new', ['--what', 'x']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(refusal('log new', 'log: unknown flag --what — see: scrumux help log'));
    const bare = drive(log, ctxFor(d), 'log', 'new', ['--pending']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal('log new', 'log: --pending needs a value — see: scrumux help log'));
  });

  it('demands a past-tense --title and EVIDENCE in --did', () => {
    const d = scratch();
    expect(drive(log, ctxFor(d), 'log', 'new', ['--did', 'x']).io.stderr).toBe(refusal('log new', L_TITLE));
    expect(drive(log, ctxFor(d), 'log', 'new', ['--title', 't']).io.stderr).toBe(refusal('log new', L_DID));
    expect(existsSync(govPath(d, 'log.json'))).toBe(false);
  });

  it('writes task as an explicit null and omits the two tail keys', () => {
    const d = scratch();
    const { io, rc } = drive(log, ctxFor(d), 'log', 'new', ['--title', 'The prune stopped eating two files', '--did', 'rc=0; 3 files changed']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('L-0001\n');
    expect(govText(d, 'log.json')).toBe(`{
  "entries": [
    {
      "id": "L-0001",
      "date": "${TODAY}",
      "task": null,
      "actor": "claude",
      "title": "The prune stopped eating two files",
      "what_was_done": "rc=0; 3 files changed"
    }
  ]
}
`);
  });

  it('takes its actor from GOV_ACTOR unless --actor says otherwise', () => {
    const d = scratch();
    drive(log, ctxFor(d, { GOV_ACTOR: 'User' }), 'log', 'new', ['--title', 't', '--did', 'd']);
    drive(log, ctxFor(d, { GOV_ACTOR: 'User' }), 'log', 'new', ['--title', 't', '--did', 'd', '--actor', 'issue-validator']);
    // An EMPTY GOV_ACTOR is the same case as an unset one -- `:-`, not `-`.
    drive(log, ctxFor(d, { GOV_ACTOR: '' }), 'log', 'new', ['--title', 't', '--did', 'd']);
    const rows = (JSON.parse(govText(d, 'log.json')) as { entries: { actor: string }[] }).entries;
    expect(rows.map((r) => r.actor)).toEqual(['User', 'issue-validator', 'claude']);
  });

  it('pushes the new id into the task\'s log_entries — a SECOND write, a second lock', () => {
    const d = scratch();
    plant(d, 'tasks.json', { entries: [{ id: 'T-0001', title: 't', status: 'in_progress' }] });
    const { rc } = drive(log, ctxFor(d), 'log', 'new', [
      '--title', 'Fixed the prune', '--did', 'rc=0', '--task', 'T-0001',
      '--verified', 'sh tests/harness-tests.sh rc=0',
      '--pending', 'the second half', '--pending', 'the docs',
    ]);
    expect(rc).toBe(0);
    expect(govText(d, 'log.json')).toBe(`{
  "entries": [
    {
      "id": "L-0001",
      "date": "${TODAY}",
      "task": "T-0001",
      "actor": "claude",
      "title": "Fixed the prune",
      "what_was_done": "rc=0",
      "verification": "sh tests/harness-tests.sh rc=0",
      "pending": [
        "the second half",
        "the docs"
      ]
    }
  ]
}
`);
    // The back-reference lands at the END of the task row, because the row
    // did not have the key.
    expect(govText(d, 'tasks.json')).toBe(`{
  "entries": [
    {
      "id": "T-0001",
      "title": "t",
      "status": "in_progress",
      "log_entries": [
        "L-0001"
      ]
    }
  ]
}
`);
  });

  it('appends to a log_entries array that already exists, keeping its position', () => {
    const d = scratch();
    plant(d, 'tasks.json', { entries: [{ id: 'T-0001', log_entries: ['L-0001'], title: 't' }] });
    plant(d, 'log.json', { entries: [{ id: 'L-0001', date: '2026-08-01', task: 'T-0001', actor: 'claude', title: 't', what_was_done: 'd' }] });
    expect(drive(log, ctxFor(d), 'log', 'new', ['--title', 't2', '--did', 'd2', '--task', 'T-0001']).rc).toBe(0);
    const task = (JSON.parse(govText(d, 'tasks.json')) as { entries: Record<string, JsonValue>[] }).entries[0]!;
    expect(task['log_entries']).toEqual(['L-0001', 'L-0002']);
    expect(Object.keys(task)).toEqual(['id', 'log_entries', 'title']);
  });

  it('names its verbs when the verb is not one of them', () => {
    const d = scratch();
    const { io, rc } = drive(log, ctxFor(d), 'log', 'list', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'log list', "unknown verb 'list' for noun log — verbs: new, show. See: scrumux help log",
    ));
  });
});

// ===========================================================================
// memory
// ===========================================================================

describe('memory add — the one append scrumux owns because the caller cannot write it', () => {
  it('requires --by, so a reader can tell whose memory this is', () => {
    const d = scratch();
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--file', '/dev/null']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'memory add',
      'memory: --by is required (who produced this block — the agent name, so a reader can tell whose memory this is)',
    ));
  });

  it('refuses an unknown flag and a flag with no value', () => {
    const d = scratch();
    const unknown = drive(memory, ctxFor(d), 'memory', 'add', ['--who', 'x']);
    expect(unknown.rc).toBe(2);
    expect(unknown.io.stderr).toBe(refusal('memory add', 'memory: unknown flag --who — see: scrumux help memory'));
    const bare = drive(memory, ctxFor(d), 'memory', 'add', ['--file']);
    expect(bare.rc).toBe(2);
    expect(bare.io.stderr).toBe(refusal('memory add', 'memory: --file needs a value — see: scrumux help memory'));
  });

  it('names a --file that is not there', () => {
    const d = scratch();
    const missing = join(d, 'no-such-block.md');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'issue-validator', '--file', missing]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('memory add', `memory: --file ${missing} does not exist`));
  });

  it('treats a DIRECTORY as "does not exist" — `[ -f ]` is a regular file', () => {
    const d = scratch();
    const dir = join(d, 'governance');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'issue-validator', '--file', dir]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('memory add', `memory: --file ${dir} does not exist`));
  });

  it('refuses a --file whose content is nothing but newlines', () => {
    const d = scratch();
    const f = join(d, 'block.md');
    writeFileSync(f, '\n\n\n');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'issue-validator', '--file', f]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'memory add',
      'memory: the block is empty — refusing to append a heading with nothing under it (an empty run is not a run)',
    ));
    // Nothing was created: the emptiness check is before the file is made.
    expect(existsSync(govPath(d, 'validator-memory.md'))).toBe(false);
  });

  it('appends a --file block under a dated heading and counts its lines', () => {
    const d = scratch();
    const f = join(d, 'block.md');
    // Three lines of content and three trailing newlines: `$(cat …)` strips
    // EVERY trailing newline and the single `printf '%s\n'` puts one back.
    writeFileSync(f, 'one\ntwo\nthree\n\n\n');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'issue-validator', '--file', f]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      `created validator-memory.md and appended 3 line(s) under '## Run ${TODAY} — issue-validator'\n`,
    );
    expect(govText(d, 'validator-memory.md')).toContain(
      `\n## Run ${TODAY} — issue-validator\n\none\ntwo\nthree\n`,
    );
  });

  it('says APPENDED, not created, the second time — and touches no byte already there', () => {
    const d = scratch();
    const f = join(d, 'block.md');
    writeFileSync(f, 'a single line');
    drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'agent-one', '--file', f]);
    const first = govText(d, 'validator-memory.md');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'agent-two', '--file', f]);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      `appended 1 line(s) to validator-memory.md under '## Run ${TODAY} — agent-two'\n`,
    );
    // APPEND-ONLY: the first version is a strict prefix of the second.
    const second = govText(d, 'validator-memory.md');
    expect(second.startsWith(first)).toBe(true);
    expect(second.slice(first.length)).toBe(`\n## Run ${TODAY} — agent-two\n\na single line\n`);
  });
});

// ===========================================================================
// decide
// ===========================================================================

const D_TITLE =
  'decide: --title is required — the ruling itself in one line, so a reader who greps the journal gets the answer without opening it. GOOD "Parallel dispatch admission: a per-sprint cap declared at planning" (D-0084). GOOD "Rulings whose machinery was deleted are retired" (D-0081). GOOD "Four gates became advice, and the rulings still say fail" (D-0082). BAD "sprint changes" — names the area and withholds the ruling, which is the whole content.';

const D_DECISION =
  'decide: --decision is required (what was decided) — the rule as it will be applied: the shape, the defaults, and what each surface does about it. Write it so an implementer can act without asking a follow-up. GOOD "A sprint carries parallel (integer >= 1, default 1), declared at scrumux sprint new --parallel N. The CLI admits a task to in_progress while the same RATIFIED sprint has fewer than parallel tasks in_progress, and still refuses a task whose in-flight neighbour belongs to a DIFFERENT sprint. The cap may be changed only while the sprint is proposed; changing it after ratification is a re-ratification, not an edit. --hotfix implies parallel 1" (D-0084). BAD "we will allow parallel work" — a direction, not a rule; every surface would have to invent its own version of it.';

const D_RATIONALE =
  'decide: --rationale is required (why) — what was weighed, including the options that were REJECTED and what was wrong with each. That is the part a later session needs when it is tempted to undo this. GOOD "Three shapes were put to User. A: a per-sprint cap declared at planning. B: per-worktree admission. C: the app is the gate. User ruled A. The sprint is already the unit he ratifies, so the cap is declared where the plan is made; B ties a governance rule to a git detail no journal models; C moves a guard out of the CLI into the app and would leave a hand-driven session ungated entirely" (D-0084). BAD "it is better this way" — it gives the next reader nothing to weigh against.';

/** The four required fields, so a test can vary exactly one other thing. */
const DNEW = ['--title', 'A ruling', '--decision', 'The rule', '--rationale', 'What was weighed', '--by', 'User (in session)', '--authority', 'direct'];

describe('decide new — four paragraphs of refusal, and a back-stamp under its own lock', () => {
  it('names each required field with its worked example', () => {
    const d = scratch();
    expect(drive(decide, ctxFor(d), 'decide', 'new', DNEW.slice(2)).io.stderr).toBe(refusal('decide new', D_TITLE));
    expect(drive(decide, ctxFor(d), 'decide', 'new', [...DNEW.slice(0, 2), ...DNEW.slice(4)]).io.stderr)
      .toBe(refusal('decide new', D_DECISION));
    expect(drive(decide, ctxFor(d), 'decide', 'new', [...DNEW.slice(0, 4), ...DNEW.slice(6)]).io.stderr)
      .toBe(refusal('decide new', D_RATIONALE));
    expect(drive(decide, ctxFor(d), 'decide', 'new', DNEW.slice(0, 6)).io.stderr).toBe(refusal(
      'decide new', 'decide: --by is required — name who is recording this (yourself, if you are an agent). With --authority direct|app:<session>|standing:D-XXXX the decision is recorded ratified; without one it is recorded PROPOSED until a person ratifies it (D-S039). Decisions are ratified, never assumed.',
    ));
    expect(existsSync(govPath(d, 'decisions.json'))).toBe(false);
  });

  it('admits an empty scope, repo and cross-repo, and nothing else', () => {
    const d = scratch();
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--scope', 'global']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('decide new', 'decide: --scope must be repo or cross-repo'));
    expect(drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--scope', 'repo']).rc).toBe(0);
    expect(drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--scope', 'cross-repo']).rc).toBe(0);
  });

  it('checks the refs BEFORE ensure_file, so a bad --supersedes creates no journal', () => {
    const d = scratch();
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--supersedes', 'D-9999']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('decide new', 'decide: --supersedes D-9999 not found in decisions.json'));
    // `story` seeds and then refuses. `decide` does not seed at all.
    expect(existsSync(govPath(d, 'decisions.json'))).toBe(false);
  });

  it('refuses an --issue that is not in issues.json', () => {
    const d = scratch();
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--issue', 'I-9999']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('decide new', 'decide: --issue I-9999 not found in issues.json'));
  });

  it('resolves --task through the shared task-ref refusal', () => {
    const d = scratch();
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--task', 'T-9999']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'decide new',
      'task T-9999 not found in governance/tasks.json — create it first: scrumux task new --title ... --check ...',
    ));
  });

  it('stamps superseded_by onto the predecessor in a SECOND write', () => {
    const d = scratch();
    plant(d, 'decisions.json', {
      entries: [{ id: 'D-0001', date: '2026-08-01', title: 'old', decision: 'x', rationale: 'y', ratified_by: 'User', refs: {}, supersedes: null }],
    });
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--supersedes', 'D-0001']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('D-0002\n');
    // Two writes, two locks, and the old row gains its key at the END. The
    // gap between them is OQ-DN4, open and unruled; the shape is reproduced.
    expect(govText(d, 'decisions.json')).toBe(`{
  "entries": [
    {
      "id": "D-0001",
      "date": "2026-08-01",
      "title": "old",
      "decision": "x",
      "rationale": "y",
      "ratified_by": "User",
      "refs": {},
      "supersedes": null,
      "superseded_by": "D-0002"
    },
    {
      "id": "D-0002",
      "date": "${TODAY}",
      "title": "A ruling",
      "decision": "The rule",
      "rationale": "What was weighed",
      "ratified_by": "User (in session)",
      "status": "ratified",
      "authority": "direct",
      "recorded_by": "User (in session)",
      "refs": {},
      "supersedes": "D-0001"
    }
  ]
}
`);
  });

  it('builds refs in FLAG order and puts scope between the standing fields and refs', () => {
    const d = scratch();
    plant(d, 'tasks.json', { entries: [{ id: 'T-0001', title: 't' }] });
    plant(d, 'issues.json', { entries: [{ id: 'I-0001', summary: 's' }] });
    const { rc } = drive(decide, ctxFor(d), 'decide', 'new', [
      ...DNEW, '--scope', 'cross-repo', '--issue', 'I-0001', '--task', 'T-0001', '--push-hold', 'PH-1',
    ]);
    expect(rc).toBe(0);
    const row = (JSON.parse(govText(d, 'decisions.json')) as { entries: Record<string, JsonValue>[] }).entries[0]!;
    expect(Object.keys(row)).toEqual(['id', 'date', 'title', 'decision', 'rationale', 'ratified_by', 'status', 'authority', 'recorded_by', 'scope', 'refs', 'supersedes']);
    // `refs` is built by the ENTRY builder in task/issue/push_hold order, not
    // in the order the flags were typed.
    expect(Object.keys(row['refs'] as Record<string, JsonValue>)).toEqual(['task', 'issue', 'push_hold']);
  });

  it('names its verbs when the verb is not one of them', () => {
    const d = scratch();
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'list', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'decide list', "unknown verb 'list' for noun decide — verbs: new, ratify, reject, acknowledge. See: scrumux help decide",
    ));
  });
});

// ===========================================================================
// repair
// ===========================================================================

describe('repair journal — four gates before any write, and a log entry in the same operation', () => {
  /** A jq-formatted tasks.json, so `--apply '.'` really is a no-op. */
  function repairRepo(): string {
    const d = scratch();
    plant(d, 'tasks.json', {
      entries: [
        { id: 'T-0001', title: 'first', status: 'proposed' },
        { id: 'T-0002', title: 'second', status: 'proposed' },
      ],
    });
    return d;
  }

  const OK = ['--why', 'the dates were restored by hand and left no record', '--by', 'User'];

  it('refuses `repair journal` with no operand at all', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'repair journal',
      "repair journal needs a journal name — scrumux repair journal tasks.json --apply '<jq>' --why TEXT",
    ));
  });

  it('refuses an EMPTY journal name, which is the only way to reach bash\'s ${1:?}', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('repair journal', 'repair journal needs a journal name'));
  });

  it('refuses an unknown flag with the whole usage line', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--filter', '.']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'repair journal',
      "repair: unknown flag --filter — usage: scrumux repair journal <name.json> --apply '<jq>' --why TEXT --by WHO",
    ));
  });

  it('refuses a flag with no value', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('repair journal', 'repair: --apply needs a value'));
  });

  it('requires the expression, the reason and the name of who is repairing', () => {
    const d = repairRepo();
    expect(drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', ...OK]).io.stderr).toBe(refusal(
      'repair journal', 'repair: --apply is required — the jq expression that makes the correction',
    ));
    expect(drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply', '.', '--by', 'User']).io.stderr)
      .toBe(refusal(
        'repair journal',
        'repair: --why is required — a repair with no recorded reason is the hand edit this command exists to replace',
      ));
    expect(drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply', '.', '--why', 'w']).io.stderr)
      .toBe(refusal(
        'repair journal',
        'repair: --by is required — name who is repairing. It defaulted to User, which is the wrong name to put on the most consequential write in the CLI.',
      ));
  });

  it('names the journal it could not find, relative to governance/', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['nope.json', '--apply', '.', ...OK]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('repair journal', 'repair: no journal at governance/nope.json'));
  });

  it("relays jq's OWN first line when the expression will not compile (OQ-13)", () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply', '.entries[', ...OK]);
    expect(rc).toBe(2);
    // The message the operator reaches for when the journal is ALREADY
    // damaged has to carry the tool's own diagnostic, not a paraphrase.
    expect(io.stderr.startsWith('scrumux repair journal: error: repair: the jq expression failed against governance/tasks.json — ')).toBe(true);
    expect(io.stderr.endsWith('. Check the filter.\n')).toBe(true);
    expect(io.stderr).toContain('syntax error');
    // ONE line of jq's stderr, so the refusal is a single line.
    expect(io.stderr.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('refuses a filter that produces NO output, which would truncate the journal', () => {
    const d = repairRepo();
    const before = govText(d, 'tasks.json');
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply', 'empty', ...OK]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'repair journal',
      'repair: the jq expression produced NO output, which would truncate governance/tasks.json — check the filter',
    ));
    expect(govText(d, 'tasks.json')).toBe(before);
  });

  it('refuses a NO-OP before writing, so a tampered journal cannot be relaundered', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply', '.', ...OK]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'repair journal',
      'repair: the expression changed nothing in governance/tasks.json — check the filter rather than recording a no-op repair',
    ));
    // The whole reason the check moved ahead of the write: `write_json` now
    // RESEALS what it wrote, so a no-op over a tampered journal would erase
    // the mismatch with no record of having done so. Nothing was logged.
    expect(existsSync(govPath(d, 'log.json'))).toBe(false);
  });

  it('refuses a filter that emits a STREAM, at the SHAPE guard rather than the parser', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', ['tasks.json', '--apply', '.entries[]', ...OK]);
    expect(rc).toBe(2);
    // MEASURED, and NOT what `src/nouns/repair.ts`'s comment beside its
    // `catch` predicts. That comment says a multi-document stream is refused
    // in the writer's vocabulary by the local `jq write failed` arm; in fact
    // `parsePreservingNumbers` ACCEPTS a top-level value stream on purpose
    // (D-0089: TS must never fail where bash passed) and returns the FIRST
    // value, so the two concatenated task rows arrive at the writer as one
    // object with no `entries` array and guard (c) is what speaks. Pinned as
    // it behaves, not as the comment reads; the mismatch is reported rather
    // than repaired, because repairing it means choosing which of the two
    // refusals is the contract and that is a ruling.
    expect(io.stderr).toBe(refusal(
      'repair journal',
      `refusing to write ${govPath(d, 'tasks.json')}: the jq filter produced output that is not an object with an entries ` +
      'array — check the filter (T-0157: every governance journal is {entries:[...]})',
    ));
  });

  it('refuses a repair that would DROP entries — the writer\'s guard, not this verb\'s', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', [
      'tasks.json', '--apply', '.entries |= [.[0]]', ...OK,
    ]);
    expect(rc).toBe(2);
    // `repair` never sets ALLOW_ENTRY_REMOVAL and its usage never mentions it.
    expect(io.stderr).toContain('this would DROP 1 of 2 entries, leaving 1');
    expect(io.stderr).toContain('re-run with ALLOW_ENTRY_REMOVAL=1 and say why in the repair\'s --why');
  });

  it('writes the correction and its log entry in ONE operation, and NAMES ALL THREE', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', [
      'tasks.json', '--apply', '.entries |= map(.status = "accepted")', ...OK,
    ]);
    expect(rc).toBe(0);
    // THIS CASE USED TO PIN SILENCE, and the silence was the defect rather
    // than the contract. `log_new` was called inside `>/dev/null` and it
    // EXITS, so the id, the "repaired governance/X (logged)" line and the
    // whole harness-verify tail in cmd-repair.sh were unreachable -- measured
    // against bash as empty stdout, empty stderr, rc 0, and reproduced
    // faithfully here. A mutating governance write succeeding in total silence
    // on the one command reached for when a journal is ALREADY damaged is the
    // finding the 2026-09-02 E2E run filed; both sides now end in one summary.
    //
    // THE THREE FACTS ARE THE CONTRACT, not the sentence: which journal, what
    // the entry count did (a repair that silently dropped rows is the failure
    // the writer's own guard exists for, so the count is what the operator
    // needs to see), and the id of the log record that now carries the reason.
    expect(io.stdout).toBe('repaired governance/tasks.json — entries 2 -> 2, logged as L-0001\n');
    expect(io.stderr).toBe('');
    const rows = (JSON.parse(govText(d, 'tasks.json')) as { entries: { status: string }[] }).entries;
    expect(rows.map((r) => r.status)).toEqual(['accepted', 'accepted']);

    const entry = (JSON.parse(govText(d, 'log.json')) as { entries: Record<string, JsonValue>[] }).entries[0]!;
    expect(Object.keys(entry)).toEqual(['id', 'date', 'task', 'actor', 'title', 'what_was_done', 'verification']);
    expect(entry['id']).toBe('L-0001');
    expect(entry['task']).toBeNull();
    expect(entry['actor']).toBe('User');
    expect(entry['title']).toBe('Repair applied to governance/tasks.json');
    expect(entry['verification']).toBe(
      'Journal reseals clean after the write; the correction and this record were made in one operation, ' +
      'so the record cannot be omitted (T-0100).',
    );
    // BOTH hashes, 12 characters each, and they must differ -- the no-op gate
    // above is what guarantees that, and this is where it is visible.
    const what = entry['what_was_done'] as string;
    const m = /^scrumux repair on governance\/tasks\.json\. Reason: the dates were restored by hand and left no record\. Applied: \.entries \|= map\(\.status = "accepted"\)\. Content hash ([0-9a-f]{12}) -> ([0-9a-f]{12})\.$/.exec(what);
    expect(m, what).not.toBeNull();
    expect(m![1]).not.toBe(m![2]);
  });

  it('carries the same summary AND the minted log id under --json', () => {
    const d = repairRepo();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', [
      'tasks.json', '--apply', '.entries |= map(.status = "accepted")', ...OK,
    ], true);
    expect(rc).toBe(0);
    expect(io.stderr).toBe('');
    // The envelope used to go to the redirect with everything else, so
    // `--json` on a successful repair returned nothing for a caller to parse.
    // `.data.id` is `emitted`'s own line -- in bash it is what crosses back
    // out of the subshell the `log_new` call now runs in -- so a caller that
    // wants the record rather than the sentence has it as a field.
    const env = JSON.parse(io.stdout) as { ok: boolean; exit: number; summary: string; data: { id: string } };
    expect(env.ok).toBe(true);
    expect(env.exit).toBe(0);
    expect(env.summary).toBe('repaired governance/tasks.json — entries 2 -> 2, logged as L-0001');
    expect(env.data.id).toBe('L-0001');
  });

  it('refuses WITHOUT the envelope when the log entry itself cannot be written', () => {
    const d = repairRepo();
    // A directory where log.json belongs: `ensure_file` cannot seed it.
    mkdirSync(govPath(d, 'log.json'));
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', [
      'tasks.json', '--apply', '.entries |= map(.status = "accepted")', ...OK,
    ], true);
    expect(rc).toBe(2);
    // bash's `log_new` writes its envelope to the REDIRECTED stdout and its
    // refusal line to stderr, which is not redirected -- so under --json this
    // refusal carries NO object. Reproduced by writing the line directly.
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe(refusal('repair journal', `cannot create ${govPath(d, 'log.json')}`));
    // ...and the correction itself already landed. The record is what failed.
    const rows = (JSON.parse(govText(d, 'tasks.json')) as { entries: { status: string }[] }).entries;
    expect(rows.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('names its only verb when the verb is not it', () => {
    const d = scratch();
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'apply', []);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'repair apply', "unknown verb 'apply' for noun repair — the only verb is 'journal'. See: scrumux help repair",
    ));
  });
});

// ===========================================================================
// nouns/lib/writers.ts -- jq's own type errors, in jq's own words
// ===========================================================================

describe("the filter helpers speak jq's diagnostics, because guessing writes a new journal over a corrupt one", () => {
  it('names the TYPE of a document `+=` cannot index', () => {
    // MEASURED against jq 1.7: each of these is the message jq prints, and
    // `_write_json_body`'s guard (a) is what turns it into
    // "jq write failed for <path>". A helper that answered `{}` here would
    // write a FRESH journal over a corrupt one.
    expect(() => appendEntry([], { id: 'X' })).toThrow('Cannot index array with string "entries"');
    expect(() => appendEntry('text', { id: 'X' })).toThrow('Cannot index string with string "entries"');
    expect(() => appendEntry(true, { id: 'X' })).toThrow('Cannot index boolean with string "entries"');
    expect(() => appendEntry(7, { id: 'X' })).toThrow('Cannot index number with string "entries"');
    // A number that KEPT ITS SOURCE LITERAL is a RawNumber instance, so
    // `typeof` calls it an object -- the exact confusion that let a journal of
    // the four bytes `1` be appended to before the two copies of this file
    // were merged.
    expect(() => appendEntry(new RawNumber('1'), { id: 'X' })).toThrow('Cannot index number with string "entries"');
  });

  it('accepts null and an absent/null entries key, and refuses one of the wrong type', () => {
    // `null | .entries += [x]` is `{"entries":[x]}` in jq -- the ONE
    // non-object it accepts, and it is reachable by hand (`printf null > f`).
    expect(appendEntry(null, { id: 'X' })).toEqual({ entries: [{ id: 'X' }] });
    // An ABSENT or null key appends at the END of the object.
    expect(Object.keys(appendEntry({ text: 'x' }, { id: 'X' }) as object)).toEqual(['text', 'entries']);
    expect(appendEntry({ entries: null }, { id: 'X' })).toEqual({ entries: [{ id: 'X' }] });
    // ...and one that is neither array nor null is jq's addition error.
    expect(() => appendEntry({ entries: 'x' }, { id: 'X' })).toThrow('string and array cannot be added');
    expect(() => appendEntry({ entries: 5 }, { id: 'X' })).toThrow('number and array cannot be added');
  });

  it('`|=` iterates, so it fails where `+=` succeeded', () => {
    const same = (r: { [k: string]: JsonValue }): JsonValue => r;
    expect(() => mapEntries(null, same)).toThrow('Cannot index null with string "entries"');
    expect(() => mapEntries(3, same)).toThrow('Cannot index number with string "entries"');
    expect(() => mapEntries({}, same)).toThrow('Cannot iterate over null');
    expect(() => mapEntries({ entries: 'x' }, same)).toThrow('Cannot iterate over string');
    expect(() => mapEntries({ entries: true }, same)).toThrow('Cannot iterate over boolean');
  });

  it('leaves a row that is not an object untouched rather than erroring on it', () => {
    // `if .id==$id then … else . end` on a string row: the comparison is
    // false, so the row comes back as it was.
    const out = mapEntries({ entries: ['a string row', { id: 'T-1' }] }, (r) => ({ ...r, seen: true }));
    expect(out).toEqual({ entries: ['a string row', { id: 'T-1', seen: true }] });
  });

  it('yields NOTHING from an id stream it cannot walk, which is how the allocator falls back to 1', () => {
    // bash's `next_id` pipes a failing jq into `read -r n || n=1`, so an empty
    // stream and an errored one are the same fact. Both reach `nextId` here.
    expect(idStream([])).toEqual([]);
    expect(idStream('text')).toEqual([]);
    expect(idStream({ entries: 'not an array' })).toEqual([]);
    // A row with no id, and a row that is not an object, are both `null` in
    // the stream -- which is exactly what `.entries[].id` produces.
    expect(idStream({ entries: [{ id: 'T-0002' }, { title: 'no id' }, 'a string', 4] }))
      .toEqual(['T-0002', null, null, null]);
  });

  it('keeps an existing key in place and appends a new one — jq object assignment', () => {
    // Journals are compared byte-for-byte, so key ORDER is the contract.
    expect(Object.keys(setField({ a: 1, b: 2 }, 'a', 9))).toEqual(['a', 'b']);
    expect(setField({ a: 1, b: 2 }, 'a', 9)['a']).toBe(9);
    expect(Object.keys(setField({ a: 1 }, 'z', 0))).toEqual(['a', 'z']);
    // `a + b`: b wins on a shared key, and the key keeps a's position.
    const merged = mergeFields({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(Object.keys(merged)).toEqual(['a', 'b', 'c']);
    expect(merged['b']).toBe(3);
  });
});

// ===========================================================================
// The seam every one of these modules publishes
// ===========================================================================

describe('verbs() and usage() — the surface the control plane reads', () => {
  /** The verb list each module DISPATCHES, typed out rather than derived. */
  const MODS: [string, NounModule, string[]][] = [
    ['decide', decide, ['new', 'ratify', 'reject', 'acknowledge']],
    ['epic', epic, ['new', 'update']],
    ['exception', exception, ['new', 'resolve', 'list', 'ratify', 'reject', 'acknowledge']],
    ['feature', feature, ['new']],
    ['log', log, ['new', 'show']],
    ['memory', memory, ['add']],
    ['repair', repair, ['journal']],
    ['story', story, ['new']],
  ];

  it('names every verb the module dispatches, one TAB-separated row each', () => {
    for (const [noun, m, verbs] of MODS) {
      const rows = m.verbs().split('\n').filter((l) => l !== '');
      // The EXACT list, not just the shape wave 1B asserts: a verb added to
      // the `switch` and forgotten here is invisible to `scrumux help` and to
      // the control plane's surface reader, and nothing else notices.
      expect(rows.map((r) => r.split('\t')[0]), noun).toEqual(verbs);
      for (const row of rows) {
        const [verb, gloss] = row.split('\t');
        expect(verb, noun).toBeTruthy();
        expect(gloss, noun).toBeTruthy();
      }
      expect(m.verbs().endsWith('\n'), noun).toBe(true);
    }
  });

  it('answers usage() with the noun\'s own block, ending in a newline', () => {
    for (const [noun, m] of MODS) {
      expect(m.usage(), noun).toContain(`scrumux ${noun}`);
      expect(m.usage().endsWith('\n'), noun).toBe(true);
    }
  });
});

// ===========================================================================
// A reseal that FAILS -- D-0085/OQ-18, across every write verb here
// ===========================================================================

/**
 * The exact sentence `reseal_one` returns when it could not update the seal.
 *
 * WHY IT MATTERS ENOUGH TO PIN. In bash this status reaches NOBODY: it is the
 * last statement of `_write_json_body`, so its `return 1` becomes the body's
 * status and `write_json` then ends in `journal_unlock`, which is
 * `rmdir … || :` and always 0. The seal silently stopped matching a file
 * scrumux had just legitimately written, and the NEXT `records check` reported
 * it as "changed outside scrumux" -- a false accusation of tampering pointing
 * at the wrong culprit.
 */
const resealWarning = (base: string): string =>
  `seals.json: could not update the seal for ${base} — the next records check will report it ` +
  `as changed outside scrumux, wrongly. Re-run the write, or reseal with: scrumux repair journal ${base}`;

/** A repo whose seals.json exists, is a file, and cannot be parsed. */
function repoWithBrokenSeals(): string {
  const d = scratch();
  // Present and a FILE, which is what `reseal_one` gates on -- an ABSENT
  // seals.json is a no-op (a repo may legitimately predate sealing) and would
  // take the other arm entirely.
  writeFileSync(govPath(d, 'seals.json'), '{ not json at all');
  return d;
}

describe('a failed reseal reaches stderr always, and the envelope only under --json', () => {
  /** One minimal successful invocation per write verb, and the file it seals. */
  const CASES: [string, NounModule, string, string[], string][] = [
    ['decide', decide, 'new', DNEW, 'decisions.json'],
    ['epic', epic, 'new', ['--name', 'n', '--desc', 'd'], 'design.json'],
    ['exception', exception, 'new', XNEW, 'exceptions.json'],
    ['feature', feature, 'new', ['--name', 'n', '--desc', 'd'], 'design.json'],
    ['log', log, 'new', ['--title', 't', '--did', 'd'], 'log.json'],
  ];

  for (const [noun, mod, verb, args, base] of CASES) {
    it(`${noun} ${verb} prints the warning and still exits 0`, () => {
      const d = repoWithBrokenSeals();
      const { io, rc } = drive(mod, ctxFor(d), noun, verb, args);
      // THE EXIT CODE IS UNCHANGED. D-0085 is explicit that the fact reaches
      // the envelope, not the verdict: the write SUCCEEDED.
      expect(rc).toBe(0);
      // Routed at the CLI's stderr seam, not at process.stderr -- which is the
      // whole reason `writeOpts` exists and the only reason a test can see it.
      expect(io.stderr).toBe(resealWarning(base) + '\n');
      // Human mode is byte-for-byte bash's, and bash prints no WARN row.
      expect(io.stdout).not.toContain('WARN');
    });

    it(`${noun} ${verb} adds the WARN row under --json, exit still 0`, () => {
      const d = repoWithBrokenSeals();
      const { io, rc } = drive(mod, ctxFor(d), noun, verb, args, true);
      expect(rc).toBe(0);
      expect(io.stderr).toBe(resealWarning(base) + '\n');
      const env = JSON.parse(io.stdout) as { ok: boolean; exit: number; checks: { name: string; tier: string; detail: string }[] };
      expect(env.checks).toEqual([{ name: 'reseal', ok: true, tier: 'warn', detail: resealWarning(base) }]);
      // An advisory NEVER moves the verdict (D-0072 boundary 7).
      expect(env.ok).toBe(true);
      expect(env.exit).toBe(0);
    });
  }

  it('story new warns once, because its two stages share ONE write', () => {
    const d = repoWithBrokenSeals();
    plant(d, 'design.json', { entries: [{ kind: 'feature', id: 'F-0001', name: 'f', description: 'd' }] });
    const { io, rc } = drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0001', '--narrative', 'n', '--criterion', 'c']);
    expect(rc).toBe(0);
    expect(io.stderr).toBe(resealWarning('design.json') + '\n');
  });

  it('log new --task warns TWICE, because it takes two locks over two journals', () => {
    const d = repoWithBrokenSeals();
    plant(d, 'tasks.json', { entries: [{ id: 'T-0001', title: 't' }] });
    const { io, rc } = drive(log, ctxFor(d), 'log', 'new', ['--title', 't', '--did', 'd', '--task', 'T-0001'], true);
    expect(rc).toBe(0);
    // TWO journals, two locks, two reseals, two warnings -- and the order is
    // the write order. OQ-DN4's non-atomic pair, visible.
    expect(io.stderr).toBe(resealWarning('log.json') + '\n' + resealWarning('tasks.json') + '\n');
    const env = JSON.parse(io.stdout) as { checks: { detail: string }[] };
    expect(env.checks.map((c) => c.detail)).toEqual([resealWarning('log.json'), resealWarning('tasks.json')]);
  });

  it('decide new --supersedes warns twice for ONE journal, once per write', () => {
    const d = repoWithBrokenSeals();
    plant(d, 'decisions.json', { entries: [{ id: 'D-0001', title: 'old' }] });
    const { io, rc } = drive(decide, ctxFor(d), 'decide', 'new', [...DNEW, '--supersedes', 'D-0001']);
    expect(rc).toBe(0);
    expect(io.stderr).toBe(resealWarning('decisions.json') + '\n' + resealWarning('decisions.json') + '\n');
  });

  it('epic update and exception resolve carry it too', () => {
    const d = repoWithBrokenSeals();
    plant(d, 'design.json', {
      entries: [
        { kind: 'feature', id: 'F-0001', name: 'f', description: 'd' },
        { kind: 'epic', id: 'E-0001', name: 'e', description: 'd', features: [] },
      ],
    });
    const e = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--add-feature', 'F-0001']);
    expect(e.rc).toBe(0);
    expect(e.io.stderr).toBe(resealWarning('design.json') + '\n');

    plant(d, 'exceptions.json', { entries: [{ id: 'X-0001', status: 'open', lens: 'l', ref: 'r', finding: 'f' }] });
    const x = drive(exception, ctxFor(d), 'exception', 'resolve', ['X-0001', '--status', 'tracked', '--by', 'User', '--authority', 'direct'], true);
    expect(x.rc).toBe(0);
    // `resolve` reseals TWICE -- once inside write_json, once explicitly and
    // OUTSIDE the lock write_json has already released (OQ-DN1, unruled). Both
    // fail, so both are reported.
    expect(x.io.stderr).toBe(resealWarning('exceptions.json') + '\n');
    const env = JSON.parse(x.io.stdout) as { checks: { detail: string }[] };
    expect(env.checks.map((c) => c.detail)).toEqual([
      resealWarning('exceptions.json'), resealWarning('exceptions.json'),
    ]);
  });

  it('repair journal carries it for both of its writes, on stderr AND now in the envelope', () => {
    const d = repoWithBrokenSeals();
    plant(d, 'tasks.json', { entries: [{ id: 'T-0001', title: 't', status: 'proposed' }] });
    const { io, rc } = drive(repair, ctxFor(d), 'repair', 'journal', [
      'tasks.json', '--apply', '.entries |= map(.status = "accepted")', '--why', 'w', '--by', 'User',
    ], true);
    expect(rc).toBe(0);
    // THE STDERR LINE IS STILL THE ONE THAT HAS TO SURVIVE, and that is what
    // this case is for: it is written unconditionally, in both modes, by the
    // writer itself. What has changed is the half that used to be thrown away
    // -- the verdict object went to the same redirect the summary did, so the
    // two WARN rows this verb files were computed and discarded. Now the
    // envelope is emitted, so a --json caller sees both reseal failures as
    // rows as well, and the assertion holds BOTH halves rather than trading
    // one for the other.
    expect(io.stderr).toBe(resealWarning('tasks.json') + '\n' + resealWarning('log.json') + '\n');
    const env = JSON.parse(io.stdout) as { ok: boolean; checks: { name: string; tier: string; detail: string }[] };
    expect(env.ok).toBe(true);
    expect(env.checks.map((c) => [c.name, c.tier])).toEqual([['reseal', 'warn'], ['reseal', 'warn']]);
    expect(env.checks.map((c) => c.detail))
      .toEqual([resealWarning('tasks.json'), resealWarning('log.json')]);
  });
});

// ===========================================================================
// Hand-damaged journals: the shapes a verb cannot produce and a person can
// ===========================================================================

describe('reads that must answer rather than throw', () => {
  it('exception list yields no rows from a journal that is not {entries:[…]}', () => {
    // None of these is reachable through a verb; all three are one `printf`
    // away by hand, and a `list` that threw would take the operator's only
    // read surface away at exactly the moment they need it.
    for (const damaged of ['[]', 'null', '{"rows": []}', '{"entries": "not an array"}']) {
      const d = scratch();
      writeFileSync(govPath(d, 'exceptions.json'), damaged);
      const { io, rc } = drive(exception, ctxFor(d), 'exception', 'list', []);
      expect(rc, damaged).toBe(0);
      // NO ROWS IS AN ANSWER AND MUST LOOK LIKE ONE. The dispatcher's
      // `scrumux exception list: ok.` used to be the WHOLE reply, which is
      // thinner than every other empty state in the CLI (`(no open tasks)`,
      // `(none open)`, `(none declared)`) and indistinguishable, to a reader,
      // from a command that did not run -- on a journal a person has damaged
      // by hand, which is exactly when they need to trust what they are
      // reading. The claim this case makes is unchanged: a damaged journal
      // yields NO ROWS rather than a throw or a report.
      expect(io.stdout, damaged).toBe('(no open exceptions)\nscrumux exception list: ok.\n');
    }
  });

  it('epic update reads a non-array features as "no features at all"', () => {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [
        { kind: 'feature', id: 'F-0001', name: 'f', description: 'd' },
        { kind: 'epic', id: 'E-0001', name: 'e', description: 'd', features: 'F-0001' },
      ],
    });
    // `(.features // [])` is jq's alternative operator, not a type check: a
    // STRING is truthy, so jq would index it and error. This port answers the
    // empty list, which is the same ANSWER the refusal below needs.
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--remove-feature', 'F-0001']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal(
      'epic update', 'epic update: F-0001 is not on E-0001 — nothing to remove; current: ',
    ));
    // ...and an ADD is admitted, because the membership test also sees none.
    expect(drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--add-feature', 'F-0001']).rc).toBe(0);
    const row = (JSON.parse(govText(d, 'design.json')) as { entries: Record<string, JsonValue>[] }).entries[1]!;
    // The string is REPLACED by the rebuilt array -- `((.features // []) + $adds)`.
    expect(row['features']).toEqual(['F-0001']);
  });

  it('epic update renders a non-string entry of `current` as the empty string', () => {
    const d = scratch();
    plant(d, 'design.json', {
      entries: [
        { kind: 'feature', id: 'F-0001', name: 'f', description: 'd' },
        { kind: 'epic', id: 'E-0001', name: 'e', description: 'd', features: [null, 'F-0001'] },
      ],
    });
    const { io, rc } = drive(epic, ctxFor(d), 'epic', 'update', ['E-0001', '--remove-feature', 'F-0002']);
    expect(rc).toBe(2);
    // `join(", ")` over a list holding a null: jq renders null as nothing.
    expect(io.stderr).toBe(refusal(
      'epic update', 'epic update: F-0002 is not on E-0001 — nothing to remove; current: , F-0001',
    ));
  });

  it('story and feature select on .kind, so a same-id row of another kind is not a match', () => {
    const d = scratch();
    // design.json is POLYMORPHIC and the id spaces are separate per kind. A
    // row that is not a feature must not satisfy a feature reference -- and
    // it must be looked PAST rather than stopped at, which is why it is first.
    plant(d, 'design.json', {
      entries: [
        { kind: 'epic', id: 'F-0001', name: 'an epic wearing an F- id', description: 'd' },
        { kind: 'feature', id: 'F-0002', name: 'the real feature', description: 'd' },
      ],
    });
    const wrongKind = drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0001', '--narrative', 'n', '--criterion', 'c']);
    expect(wrongKind.rc).toBe(2);
    expect(wrongKind.io.stderr).toContain('story: feature F-0001 not found');
    // ...and the real one, two rows further in, IS found.
    expect(drive(story, ctxFor(d), 'story', 'new', ['--feature', 'F-0002', '--narrative', 'n', '--criterion', 'c']).rc).toBe(0);

    const dep = drive(feature, ctxFor(d), 'feature', 'new', ['--name', 'n', '--desc', 'd', '--dep', 'F-0001']);
    expect(dep.rc).toBe(2);
    expect(dep.io.stderr).toBe(refusal('feature new', 'feature: --dep F-0001 not found'));
  });

  it('log new --task stamps ONLY the task it names', () => {
    const d = scratch();
    plant(d, 'tasks.json', {
      entries: [
        { id: 'T-0001', title: 'not this one' },
        { id: 'T-0002', title: 'this one' },
      ],
    });
    expect(drive(log, ctxFor(d), 'log', 'new', ['--title', 't', '--did', 'd', '--task', 'T-0002']).rc).toBe(0);
    const rows = (JSON.parse(govText(d, 'tasks.json')) as { entries: Record<string, JsonValue>[] }).entries;
    expect('log_entries' in rows[0]!).toBe(false);
    expect(rows[1]!['log_entries']).toEqual(['L-0001']);
  });
});

// ===========================================================================
// The filesystem refusals -- every `cannot …` clause these nouns can print
// ===========================================================================

describe('memory add refuses a filesystem it cannot use, naming the path', () => {
  it('treats an unreadable --file as an empty block, which is what `cat` gives bash', () => {
    const d = scratch();
    const f = join(d, 'block.md');
    writeFileSync(f, 'content that cannot be read');
    chmodSync(f, 0o000);
    try {
      const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'agent', '--file', f]);
      expect(rc).toBe(2);
      // `[ -f ]` said yes and `cat` then failed: bash's BLOCK is empty and the
      // NEXT guard is the one that speaks. Not a read error -- an empty run.
      expect(io.stderr).toBe(refusal(
        'memory add',
        'memory: the block is empty — refusing to append a heading with nothing under it (an empty run is not a run)',
      ));
    } finally {
      chmodSync(f, 0o600);
    }
  });

  it('names the governance directory it could not create', () => {
    const d = mkdtempSync(join(tmpdir(), 'scrumux-writeE-'));
    // A FILE where governance/ belongs: `mkdir -p` cannot make a directory
    // through it.
    writeFileSync(join(d, 'governance'), 'not a directory\n');
    const f = join(d, 'block.md');
    writeFileSync(f, 'a line');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'agent', '--file', f]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('memory add', `memory: cannot create ${join(d, 'governance')}`));
  });

  it('names the memory file it could not create', () => {
    const d = scratch();
    // A DIRECTORY where validator-memory.md belongs: `-f` is false, so this
    // takes the create arm, and the create fails.
    mkdirSync(govPath(d, 'validator-memory.md'));
    const f = join(d, 'block.md');
    writeFileSync(f, 'a line');
    const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'agent', '--file', f]);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('memory add', `memory: cannot create ${govPath(d, 'validator-memory.md')}`));
  });

  it('names the memory file it could not append to', () => {
    const d = scratch();
    const mem = govPath(d, 'validator-memory.md');
    writeFileSync(mem, '# an existing memory\n');
    chmodSync(mem, 0o444);
    const f = join(d, 'block.md');
    writeFileSync(f, 'a line');
    try {
      const { io, rc } = drive(memory, ctxFor(d), 'memory', 'add', ['--by', 'agent', '--file', f]);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(refusal('memory add', `memory: cannot append to ${mem}`));
      // APPEND-ONLY means the refusal touched nothing.
      expect(readFileSync(mem, 'utf8')).toBe('# an existing memory\n');
    } finally {
      chmodSync(mem, 0o600);
    }
  });
});

describe('secret list — names, sizes and fingerprints, never a value', () => {
  it('says there is nothing stored when there is no .env', () => {
    const d = scratch();
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'list', []);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('no .env yet — nothing stored\n');
  });

  it('pads the name to 28 and carries eight hex characters of sha256', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'TOKEN=abcd\n# a comment\n\nexport OTHER=xy\nno-equals-here\n');
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'list', []);
    expect(rc).toBe(0);
    // Eight hex characters is enough to tell WHICH secret is in place across
    // two machines and not enough to be one (P-45). The two prefixes below
    // come from an INDEPENDENT oracle -- `printf %s abcd | shasum -a 256` and
    // the same for `xy` -- not from this implementation's own output, so a
    // hash taken over the wrong bytes (the name, the whole line, the value
    // plus its newline) cannot agree with them by construction.
    const lines = io.stdout.split('\n');
    expect(lines[0]).toBe('secrets in .env (names and fingerprints only — values are never printed):');
    expect(lines[1]).toBe(`  ${'TOKEN'.padEnd(28)} 4 bytes  sha256:88d4266f`);
    // `export OTHER=` renders under its BARE name (PK-13).
    expect(lines[2]).toBe(`  ${'OTHER'.padEnd(28)} 2 bytes  sha256:769a4e6d`);
    expect(io.stdout).not.toContain('abcd');
    expect(lines[3]).toBe('scrumux secret list: ok.');
  });

  it('carries the same three fields and no fourth into the --json payload', () => {
    const d = scratch();
    writeFileSync(join(d, '.env'), 'TOKEN=abcd\n');
    const { io } = drive(secret, ctxFor(d), 'secret', 'list', [], true);
    const env = JSON.parse(io.stdout) as { data: { secrets: Record<string, JsonValue>[] } };
    expect(env.data.secrets).toEqual([{ name: 'TOKEN', bytes: 4, sha256_prefix: '88d4266f' }]);
    expect(io.stdout).not.toContain('abcd');
  });

  it('refuses an argument, because `list` takes none', () => {
    const d = scratch();
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'list', ['TOKEN']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('secret list', 'secret list takes no arguments'));
  });
});

describe('secret set refuses a filesystem it cannot use, naming the path', () => {
  it('names the .gitignore it could not create', () => {
    const d = scratch();
    // A DIRECTORY where .gitignore belongs. GITIGNORE FIRST, ALWAYS -- so
    // this refusal comes before anything touches .env.
    mkdirSync(join(d, '.gitignore'));
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('secret set', `secret: cannot create ${join(d, '.gitignore')}`));
    expect(existsSync(join(d, '.env'))).toBe(false);
  });

  it('names the .gitignore it could not append to', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    chmodSync(join(d, '.gitignore'), 0o444);
    try {
      const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(refusal('secret set', `secret: cannot append to ${join(d, '.gitignore')}`));
      expect(existsSync(join(d, '.env'))).toBe(false);
    } finally {
      chmodSync(join(d, '.gitignore'), 0o600);
    }
  });

  it('names the .env it could not write to', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), '.env\n');
    // A DIRECTORY where .env belongs. `[ -f ] || : > "$ENVF"` has no `|| die`
    // of its own, the chmod SUCCEEDS on a directory, the grep read fails to
    // the empty string, and the APPEND is what finally refuses -- four guards
    // deep, exactly as bash falls through them.
    mkdirSync(join(d, '.env'));
    const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe(refusal('secret set', `secret: cannot write to ${join(d, '.env')}`));
  });

  it('names the .env it could not secure to mode 600', () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), '.env\n');
    // A read-only ROOT: .env cannot be created, so the `: > "$ENVF"` failure
    // is swallowed (deliberately -- bash has no `|| die` there) and the CHMOD
    // is the guard that speaks. That fall-through is the whole reason the
    // creation is allowed to fail silently.
    chmodSync(d, 0o555);
    try {
      const { io, rc } = drive(secret, ctxFor(d), 'secret', 'set', ['TOKEN', 'v']);
      expect(rc).toBe(2);
      expect(io.stderr).toBe(refusal('secret set', `secret: cannot secure ${join(d, '.env')} to mode 600`));
    } finally {
      chmodSync(d, 0o700);
    }
  });
});
