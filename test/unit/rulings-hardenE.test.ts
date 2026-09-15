/**
 * Two ruled behaviours that had nothing holding them, and one that is new.
 *
 * TWO LOOSE ENDS FROM THE HARDEN C AUDIT, closed here rather than named again:
 *
 *   R-006 — `graph gov build`'s failure path prints ONE named exception. The
 *           ruling says, in as many words, "**There is no dedicated test**,
 *           and that is stated rather than implied: no test file imports
 *           `src/nouns/graph.ts`". A behaviour whose only defence is review is
 *           a behaviour that changes behind your back.
 *
 *   R-011 — a NON-OBJECT `.validation` on the hotfix gate. NEW, and made
 *           visible by the Harden C fix rather than by it: before the default
 *           arm the gate FELL THROUGH and opened the sprint, so there was
 *           nothing to refuse with. Now it refuses, at exit 2, quoting the
 *           verdict it actually read. Same fail-closed class as R-009.
 *
 * ONE IMPLEMENTATION, ASSERTED DIRECTLY. These tests carried a second half
 * that ran the bash CLI and asserted how ITS output differed; the cutover made
 * that half inert — the flip routes the same argv to this code — and it is
 * gone rather than pinned back to bash with an override, which would be
 * scaffolding with a deletion date. What the CLI does is what is asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext, type NounModule } from '../../src/nouns/lib/context.js';
import { MODULE as graph } from '../../src/nouns/graph.js';
import { MODULE as sprint } from '../../src/nouns/sprint.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(CHECKOUT, '.deploy-claude/scripts');
const CLI = join(SCRIPTS, 'scrumux');

let skeleton: string | null = null;
let scratch: string | null = null;

/**
 * A REAL DEPLOYED REPO. `graph gov` runs `graph_need_python` on both sides
 * before it does anything (the port keeps the guard deliberately — see
 * `src/nouns/graph.ts` — because refusing where bash refuses is the contract),
 * and the gov graph needs `agents/lib/governance_graph.py` to be present for
 * the import check above the builder. A hand-built `governance/` gets neither.
 */
function deploySkeleton(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-hE-skel-')));
  writeFileSync(join(dir, 'README.md'), 'Harden E skeleton\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.js'), 'export function hello() { return 1; }\n');
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'base'], { cwd: dir });
  const r = spawnSync(process.execPath, [CLI, 'harness', 'deploy', dir], { cwd: CHECKOUT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`Harden E: skeleton deploy failed (rc=${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return dir;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-hE-')));
  skeleton = deploySkeleton();
}, 120_000);

afterAll(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  if (skeleton !== null) rmSync(skeleton, { recursive: true, force: true });
});

function caseRepo(): string {
  const root = realpathSync(mkdtempSync(join(scratch!, 'case-')));
  cpSync(skeleton!, root, { recursive: true });
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

function drive(mod: NounModule, root: string, verb: string, args: string[], json = false): { io: CapturedIo; rc: number } {
  const io = captureIo();
  const cli = new Cli(verb, args, json, io);
  let rc = 0;
  try {
    mod.run(cli, { ...ctxFor(root), io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

// ---------------------------------------------------------------- R-006 ---

describe('R-006 — a failed `graph gov build` prints one named exception, never a traceback', () => {
  /** The corruption the gov builder trips over: a journal it reads. */
  function corrupt(root: string): void {
    writeFileSync(join(root, 'governance', 'decisions.json'), '{not json\n');
  }

  it('the port prints exactly one line, and it names the exception', () => {
    const root = caseRepo();
    corrupt(root);
    const { io, rc } = drive(graph, root, 'gov', ['build']);
    // The DISPOSITION never diverged: exit 1 and the same fail row. The row is
    // the ENVELOPE's (stdout); the divergent text is the diagnostic above it
    // (stderr), which is exactly the split the ruling describes.
    expect(rc).toBe(1);
    expect(io.stdout).toContain('FAIL gov-graph');
    expect(io.stdout).toContain('graph gov build could not answer — see the message above');

    // …and "the message above" points at something, which is the half the
    // ruling had to argue for: printing nothing was the rejected alternative.
    const lines = io.stderr.split('\n').filter((l) => l.trim() !== '');
    const named = lines.filter((l) => l.startsWith('graph gov: error: build failed — '));
    expect(named, 'exactly one line, never zero and never a dump').toHaveLength(1);
    expect(named[0]!.length).toBeGreaterThan('graph gov: error: build failed — '.length + 5);

    // NO FABRICATED FRAMES. A TypeScript traceback would have to invent CPython
    // ones, which the ruling calls a worse failure than a stated gap; a raw JS
    // stack would be the same mistake wearing the other language's clothes.
    expect(io.stderr).not.toContain('Traceback');
    expect(io.stderr).not.toMatch(/^\s+at /m);
    expect(io.stderr).not.toContain('.ts:');
  });

  it('a HEALTHY repo builds, so the failure arm is the only one being pinned', () => {
    // Without this the assertions above would still pass over a CLI that
    // failed unconditionally.
    const root = caseRepo();
    const { io, rc } = drive(graph, root, 'gov', ['build']);
    expect(rc).toBe(0);
    expect(io.stdout).toMatch(/graph gov: \d+ nodes, \d+ edges -> /);
    expect(io.stderr).not.toContain('build failed');
  });

  it('the ruled site still carries its APPROVED-DIVERGENCE marker', () => {
    // R-006's enforcement point is a comment, so the comment is asserted. The
    // refusal-parity backstop cannot do this one: `graph gov` writes its
    // diagnostics with `sayAlways`, not `cli.die`, so it is not in that
    // corpus's population at all.
    const src = readFileSync(join(CHECKOUT, 'src/nouns/graph.ts'), 'utf8');
    expect(src).toContain('APPROVED-DIVERGENCE');
    expect(src).toContain('graph gov: error: build failed — ');
  });
});

// ---------------------------------------------------------------- R-011 ---

describe('R-011 — a non-object `.validation` fails closed', () => {
  /**
   * An issue whose `.validation` is a STRING. jq cannot index a string with
   * "verdict"; the port can render it.
   */
  function seed(root: string, validation: unknown): void {
    writeFileSync(
      join(root, 'governance', 'issues.json'),
      JSON.stringify({
        entries: [{
          id: 'I-0001',
          type: 'defect',
          source: 'claude',
          summary: 'a validation that is not an object',
          status: 'open',
          created_at: '2026-08-01',
          validation,
        }],
      }, null, 2) + '\n',
    );
  }

  const GATE = 'carries a validation verdict this gate does not recognise';

  it('the port: no jq line, and the refusal quotes the value it actually read', () => {
    const root = caseRepo();
    seed(root, 'yes');
    const { io, rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
    expect(rc, 'same exit code, same disposition').toBe(2);
    expect(io.stderr).toContain(GATE);
    expect(io.stderr).toContain('(verdict: yes)');
    expect(io.stderr).not.toContain('Cannot index string');
    expect(io.stderr).not.toContain('jq:');
  });

  it('EVERY non-object shape lands in the same arm', () => {
    // The ruled divergence is about the RENDERING, not about which shapes
    // reach the arm — and "which shapes reach the arm" is the half that has to
    // be exhaustive, because a shape that MISSES the arm promotes an
    // unvalidated issue. Seven shapes, every one exit 2 — the same seven
    // RULINGS.md R-011 lists as its measured renderings.
    //
    // THE ARRAY ROWS ARE THE REGRESSION TEST. `["reproduced"]` used to render
    // through `String()` as the bare word `reproduced`, match the passing
    // verdict, and open the hotfix lane at rc 0 while bash refused at rc 2 —
    // a fail-OPEN on a security gate, closed in this wave by giving `jqRaw`
    // the JSON-text fallback its own docstring always promised. If that
    // regresses, these two rows go red before anything else in the repo does.
    for (const [v, rendered] of [
      ['yes', 'yes'],
      [42, '42'],
      [3.5, '3.5'],
      [true, 'true'],
      [false, 'false'],
      [['reproduced'], '["reproduced"]'],
      [['evidenced'], '["evidenced"]'],
    ] as const) {
      const root = caseRepo();
      seed(root, v);
      const ts = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
      expect(ts.rc, `port on ${JSON.stringify(v)}`).toBe(2);
      expect(ts.io.stderr, `port on ${JSON.stringify(v)}`).toContain(`(verdict: ${rendered})`);
    }
  });

  it('a one-element array cannot widen a ratified sprint either', () => {
    // THE SECOND FAIL-OPEN THE SAME `String()` OPENED, found by the same
    // audit. `sprintUpdate` reads `status !== 'proposed'` to decide whether
    // changing `--parallel` is an edit or a re-ratification (D-0084), so
    // `"status": ["proposed"]` rendered as `proposed`, passed the guard, and
    // let a RATIFIED plan's parallelism be edited — where bash refuses.
    const root = caseRepo();
    writeFileSync(
      join(root, 'governance', 'sprints.json'),
      JSON.stringify({ entries: [{ id: 'SP-0001', status: ['proposed'], parallel: 1, tasks: [] }] }, null, 2) + '\n',
    );
    const ts = drive(sprint, root, 'update', ['SP-0001', '--parallel', '3']);
    expect(ts.rc, 'the port refuses, as bash always did').toBe(2);
    expect(ts.io.stderr).toContain('is ["proposed"] — changing how many tasks a RATIFIED plan runs at once');
    // The parallelism is untouched on this side, which is the fact the exit
    // code is standing in for.
    expect(readFileSync(join(root, 'governance', 'sprints.json'), 'utf8')).toContain('"parallel": 1');
  });

  it('NOTHING is written — a gate that allocates an id has not refused', () => {
    const root = caseRepo();
    seed(root, 'yes');
    const before = readFileSync(join(root, 'governance', 'sprints.json'), 'utf8');
    drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
    expect(readFileSync(join(root, 'governance', 'sprints.json'), 'utf8')).toBe(before);
  });

  it('a PROPER validation still opens the lane — the arm is narrow', () => {
    // Without this, everything above is satisfied by a gate that refuses every
    // hotfix, which is a different defect with the same test results.
    const root = caseRepo();
    seed(root, { verdict: 'reproduced', evidence: 'e', by: 'debugger', date: '2026-08-01' });
    const { rc } = drive(sprint, root, 'new', ['--hotfix', '--issue', 'I-0001']);
    expect(rc).toBe(0);
  });

  it('the ruled site carries an APPROVED-DIVERGENCE: R-011 marker', () => {
    const src = readFileSync(join(CHECKOUT, 'src/nouns/sprint.ts'), 'utf8');
    expect(src).toContain('APPROVED-DIVERGENCE: R-011');
    // The marker has to sit at the site that DIVERGES — the vstate
    // computation — not merely somewhere in the file.
    const idx = src.indexOf('APPROVED-DIVERGENCE: R-011');
    expect(src.slice(idx, idx + 1600)).toContain('const vstate =');
  });
});
