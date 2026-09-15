/**
 * R-003, at the anchor that ruling cites.
 *
 * `src/nouns/records.ts:332` has pointed at `test/unit/records-unparseable.test.ts`
 * since the sweep was written, and until this file existed it pointed at
 * nothing: the live assertion was one `expect(internal).toHaveLength(1)` inside
 * `test/unit/nouns-wave1b.test.ts`, three hundred lines from anything else
 * about the divergence. RULINGS.md R-003 carried a "note for the next reader"
 * naming the dangling pointer and leaving it as found. This is the repair, and
 * it is the direction the repair had to go: the CITATION was the honest half —
 * a ruled divergence deserves a file of its own — so the file was written and
 * the assertions moved into it rather than the pointer being bent to match
 * where they happened to live.
 *
 * WHAT THE MOVE ALSO BOUGHT. The assertion that came over said only that THIS
 * side emits one finding. That is half a divergence: it pins the port and
 * takes bash's half on trust, from a ruling that describes it as "a dozen
 * near-identical FAIL rows". Measured on 2026-09-01 against the deployed bash
 * CLI, a corrupt `tasks.json` produces FOUR and a corrupt `issues.json` TWO —
 * so the shape of the claim was right and its magnitude was prose. Both halves
 * are now run, per side, in one test, and the numbers are the measured ones.
 * A divergence asserted from only one side is a divergence that can close
 * behind your back: if bash were ever fixed to emit one, this file would still
 * be green and R-003 would still be on the books describing something that had
 * stopped happening.
 *
 * NOT A DIFFERENTIAL CASE, and that is the point of the ruling: the two sides
 * are told to produce different bytes here, so a byte comparison cannot hold
 * it. `tools/differential/run.mjs` would report it red forever.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext } from '../../src/nouns/lib/context.js';
import { MODULE as records } from '../../src/nouns/records.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');
const CLI = join(SCRIPTS, 'scrumux');

/** The prefix both implementations put on the finding this ruling is about. */
const INTERNAL = 'validator internal: jq failed on';

interface Envelope {
  ok: boolean;
  exit: number;
  checks: { name: string; tier: string; detail: string }[];
}

/**
 * A REAL DEPLOYED REPO, not a hand-built `governance/` directory.
 *
 * The count this file pins is the count of jq READERS that touch the corrupt
 * file, and most of those readers are cross-journal: they only run when the
 * repo has a roster, a rules directory and the rest of the deployed shape. A
 * bare `governance/` gets bash as far as the section-0 parse failure and no
 * further, which reports ZERO internal findings and would have let this file
 * pass while proving the opposite of what it claims. Deployed once (~2s),
 * copied per case.
 */
let skeleton: string | null = null;
let scratch: string | null = null;

function deploySkeleton(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-r003-skel-')));
  writeFileSync(join(dir, 'README.md'), 'R-003 skeleton\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.js'), 'export function hello() { return 1; }\n');
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'base'], { cwd: dir });
  const r = spawnSync(process.execPath, [CLI, 'harness', 'deploy', dir], { cwd: CHECKOUT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`R-003: skeleton deploy failed (rc=${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return dir;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-r003-')));
  skeleton = deploySkeleton();
}, 120_000);

afterAll(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  if (skeleton !== null) rmSync(skeleton, { recursive: true, force: true });
});

/** A copy of the deployed skeleton with one named journal replaced by non-JSON. */
function corruptRepo(journal: string): string {
  const root = realpathSync(mkdtempSync(join(scratch!, 'case-')));
  cpSync(skeleton!, root, { recursive: true });
  writeFileSync(join(root, 'governance', journal), '{not json\n');
  return root;
}

function ctxFor(root: string): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: todayStamp(),
    io: captureIo(),
    scriptsDir: SCRIPTS,
    env: {},
    cwd: root,
  };
}

/** `records check --json` through the port, in process. */
function tsCheck(root: string): { env: Envelope; rc: number } {
  const io = captureIo();
  const cli = new Cli('check', [], true, io);
  let rc = 0;
  try {
    records.run(cli, { ...ctxFor(root), io }, 'check', []);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { env: JSON.parse(io.stdout) as Envelope, rc };
}

const internals = (env: Envelope): string[] =>
  env.checks.filter((c) => c.name.startsWith(INTERNAL)).map((c) => c.name);

describe('R-003 — an unparseable journal is ONE finding per file, not one per reader', () => {
  it('the port emits exactly one internal finding per corrupt journal, whichever it is', () => {
    for (const j of ['tasks.json', 'issues.json', 'decisions.json', 'sprints.json']) {
      const d = corruptRepo(j);
      try {
        const { env, rc } = tsCheck(d);
        expect(rc, `${j}: a corrupt journal can never be a clean run`).toBe(1);
        expect(env.ok).toBe(false);
        expect(internals(env), `${j}: one finding per FILE is the ruled shape`).toHaveLength(1);
        expect(internals(env)[0]).toContain(join(d, 'governance', j));
        // The message names ITSELF as a validator internal, which is the half
        // that tells the reader not to trust the run. R-003 rules the COUNT
        // and leaves the wording alone; a count fix that quietly softened the
        // sentence would be a different change.
        const row = env.checks.find((c) => c.name.startsWith(INTERNAL))!;
        expect(`${row.name} ${row.detail}`).toContain('records-check itself needs fixing; do not trust this run');
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('fails closed and names the restore command, which is what did NOT diverge', () => {
    // R-003 rules the COUNT of internal findings and nothing else. Section 0's
    // row -- the one an operator acts on -- was never part of the divergence,
    // so it is pinned here on its own terms rather than against a second
    // implementation. bash-vs-TypeScript is proved by the differential and the
    // parity suites, which run the whole corpus; a third, weaker copy of that
    // comparison inside a unit test bought nothing and died with bash.
    const d = corruptRepo('tasks.json');
    try {
      const ts = tsCheck(d);
      expect(ts.rc).toBe(1);
      const namedBy = (env: Envelope): string[] =>
        env.checks.filter((c) => c.name.endsWith('tasks.json is not valid JSON')).map((c) => c.detail);
      expect(namedBy(ts.env)).toHaveLength(1);
      expect(namedBy(ts.env)[0]).toContain('git checkout --');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('the ruled site still cites this file (a citation is only worth its anchor)', () => {
    // The dangling pointer this file exists to repair. Asserted so it cannot
    // dangle again: rename this file and the ruling's anchor goes red rather
    // than silent.
    const src = readFileSync(join(CHECKOUT, 'src/nouns/records.ts'), 'utf8');
    expect(src).toContain('test/unit/records-unparseable.test.ts');
    const rulings = readFileSync(join(CHECKOUT, 'RULINGS.md'), 'utf8');
    expect(rulings).toContain('test/unit/records-unparseable.test.ts');
  });
});
