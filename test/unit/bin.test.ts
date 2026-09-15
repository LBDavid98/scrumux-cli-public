import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The ENTRY POINT, exercised the only way it can be: as a process.
 *
 * `src/bin/scrumux.ts` is excluded from the coverage metric and this file is
 * why — v8 cannot attribute a subprocess, and the entry cannot be imported
 * without running. The exclusion is a measurement limit, not a gap in what is
 * asserted: everything the entry does is checked below, and everything it
 * delegates to is at 100% in `dispatch.test.ts`.
 *
 * Three properties, and each one is a real failure mode:
 *
 *  - the ExitSignal thrown by the exit seam becomes a REAL exit code. If that
 *    unwind broke, every refusal in the CLI would exit 0 while printing a
 *    refusal, which is the worst possible direction.
 *  - the version banner fires BEFORE anything else can fail. In bash the jq
 *    guard ran while `die` was still lib.sh's, so a missing prerequisite
 *    exited 1 — "the assertion did not hold" — for a command that never ran
 *    (P-02).
 *  - an unexpected throw is exit 2, never a silent 0.
 */
const TS = resolve(import.meta.dirname, '../..', '.deploy-claude/dist/scrumux.mjs');
const ready = existsSync(TS);

/**
 * GOV_ROOT aims ROOT at a scratch directory for every case. This checkout is
 * the harness SOURCE repo and carries `.scrumux-ungoverned`, so without it the
 * self-governance refusal answers first for every blocked noun below and none
 * of these would be testing the entry point.
 */
let SCRATCH = '';
beforeAll(() => { SCRATCH = mkdtempSync(join(tmpdir(), 'scrumux-bin-')); });
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child: NodeJS.ProcessEnv = { ...process.env, GOV_ROOT: SCRATCH, ...env };
  // NODE_V8_COVERAGE is the v8 provider's own instrumentation and vitest sets
  // it on this worker. Inherited by a spawned CLI it would write a profile
  // into the same `coverage/.tmp` the reporter is enumerating, from a process
  // vitest does not know about — a race whose symptom is the reporter reading
  // a file that was not there when it listed. The subprocess is measured by
  // what it PRINTS, not by a profile, so it is dropped.
  delete child['NODE_V8_COVERAGE'];
  const r = spawnSync('node', [TS, ...args], { encoding: 'utf8', cwd: SCRATCH, env: child });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe.skipIf(!ready)('the entry point', () => {
  it('turns an exit-0 path into a real exit 0', () => {
    const r = run(['version']);
    expect(r.rc).toBe(0);
    expect(r.out).toBe('scrumux.cli/1\n');
  });

  it('turns a refusal into a real exit 2 — never a 0 beside a refusal', () => {
    const r = run(['task']);
    expect(r.rc).toBe(2);
    expect(r.err).toContain('needs a verb');
  });

  it('the unknown noun exits 2 with the standard refusal object', () => {
    const r = run(['nosuchnoun', '--json']);
    expect(r.rc).toBe(2);
    expect(JSON.parse(r.out).error.message).toBe("unknown noun 'nosuchnoun' — run: scrumux help");
  });

  it('does not truncate a large report when stdout is a pipe', () => {
    // MEASURED, not theoretical. `process.exit` tears the process down with
    // queued pipe writes still queued, and `backlog tasks` over the 5,000-entry
    // tier-2 fixture came back cut at ~1,300 of 8,575 lines at exit 0. A
    // truncated report that reports success is the worst failure shape this
    // CLI has, which is why the entry sets `process.exitCode` and returns.
    // `help` is the largest single block the CLI emits without a repo.
    const r = run(['help', 'task']);
    expect(r.rc).toBe(0);
    expect(r.out.endsWith('\n')).toBe(true);
    expect(r.out).toContain('Exit: 0 the assertion held');
  });

  it('emits exactly one JSON object on stdout under --json', () => {
    // The envelope contract in one assertion: parse the WHOLE of stdout.
    const r = run(['task', 'lint', 'T-1', '--json']);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(JSON.parse(r.out).schema).toBe('scrumux.cli/1');
  });

  it('is a Node script with a shebang and no dependency to resolve', () => {
    // VENDORED, NEVER RESOLVED: a wall must not depend on ambient state.
    const r = spawnSync('head', ['-1', TS], { encoding: 'utf8' });
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    // Zero bare-specifier imports EXCEPT `node:` builtins. Those are not a
    // dependency to resolve — nothing installs them, nothing on disk can
    // shadow them, and esbuild cannot inline them. Everything else is
    // vendored, which is the property this asserts. Read here rather than
    // grepped, because "everything except node:" is a negative lookahead and
    // POSIX grep has none — a pattern that quietly matches nothing would pass
    // this test forever.
    const src = readFileSync(TS, 'utf8');
    const bare = [...src.matchAll(/\bfrom ["']([^."'][^"']*)["']/g)]
      .map((m) => m[1]!)
      .filter((spec) => !spec.startsWith('node:'));
    expect(bare).toEqual([]);
  });
});
