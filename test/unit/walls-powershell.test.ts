/**
 * THE POWERSHELL DIALECT, DRIVEN IN PROCESS.
 *
 * The matrix itself lives in `test/fixtures/ps-dialect-matrix.mjs` and is
 * shared with `tools/walls-parity.mjs --mode powershell`, which runs the same
 * rows against the BUILT BUNDLES as real processes. Two drivers, one table:
 * this one exists so v8 coverage sees the branches and so a failure names the
 * predicate rather than an exit code, and the gate exists so what ships is
 * what was asserted about. Neither is redundant and neither owns a copy.
 *
 * WHY THE ROWS ARE EXIT CODES AND NOT SENTENCES. The PowerShell arm reaches
 * the SAME `refuse()` sites the POSIX arm does — that is the whole shape of
 * the change, one act getting one sentence however it was spelled — so there
 * are no new refusal strings to assert. `walls-main.test.ts` still owns what
 * each wall SAYS; this file owns what each wall SEES.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWallIo, wallExitCode } from '../../src/walls/lib/hook.js';
import { jqCompact } from '../../src/walls/lib/jsonl.js';
import { main as destructive } from '../../src/walls/block-destructive.js';
import { main as secretReads } from '../../src/walls/block-secret-reads.js';
import { main as upstreamEdit } from '../../src/walls/block-upstream-edit.js';
import { main as directLlm } from '../../src/walls/block-direct-llm.js';
// @ts-expect-error -- .mjs fixture shared with tools/walls-parity.mjs, which is run by node; giving the fixture tree a tsconfig of its own buys nothing this comment does not.
import { PS_CASES } from '../fixtures/ps-dialect-matrix.mjs';

type Row = [string, string, number, string];

const MAINS: Record<string, (io: ReturnType<typeof captureWallIo>) => never> = {
  'block-destructive': destructive,
  'block-secret-reads': secretReads,
  'block-upstream-edit': upstreamEdit,
  'block-direct-llm': directLlm,
};

/**
 * A DEPLOYED root, because `block-upstream-edit` allows outright where there
 * is no `.claude/DEPLOYED` — it protects the upstream from a DEPLOYMENT, and a
 * repo that is not one has nothing for it to protect.
 */
const root = mkdtempSync(join(tmpdir(), 'ps-matrix-'));
mkdirSync(join(root, '.claude'), { recursive: true });
writeFileSync(join(root, '.claude/DEPLOYED'), jqCompact({ source_remote: 'x', files: {} }));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function verdict(wall: string, command: string): number {
  const io = captureWallIo(jqCompact({ tool_name: 'PowerShell', tool_input: { command } }));
  const prev = process.env['GOV_ROOT'];
  process.env['GOV_ROOT'] = root;
  try {
    return wallExitCode(() => MAINS[wall]!(io));
  } finally {
    if (prev === undefined) delete process.env['GOV_ROOT'];
    else process.env['GOV_ROOT'] = prev;
  }
}

describe('the PowerShell dialect matrix', () => {
  it('is not empty, and covers all four walls — a matrix that shrank to nothing passes forever', () => {
    const rows = PS_CASES as Row[];
    expect(rows.length).toBeGreaterThan(120);
    expect(new Set(rows.map((r) => r[0])).size).toBe(4);
    // BOTH VERDICTS MUST BE REPRESENTED. A matrix that only ever expects a
    // block is satisfied by a wall that blocks everything, which is the other
    // way for a security wall to be useless.
    expect(rows.some((r) => r[2] === 2)).toBe(true);
    expect(rows.filter((r) => r[2] === 0).length).toBeGreaterThan(15);
  });

  for (const wall of ['block-destructive', 'block-secret-reads', 'block-direct-llm', 'block-upstream-edit']) {
    describe(wall, () => {
      for (const [w, command, want, why] of PS_CASES as Row[]) {
        if (w !== wall) continue;
        it(`${want === 2 ? 'BLOCKS' : 'allows'}: ${why}`, () => {
          expect(verdict(w, command), JSON.stringify(command)).toBe(want);
        });
      }
    });
  }
});
