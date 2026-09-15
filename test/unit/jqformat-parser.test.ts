import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePreservingNumbers, jqFormat, RawNumber } from '../../src/journal/jqformat.js';

/**
 * The literal-preserving parser's REFUSAL arms, and the places they disagree
 * with jq.
 *
 * This parser sits on the write path: the bytes it round-trips become the
 * journal and are then SHA-256 sealed, so a parser that quietly accepted
 * malformed input would produce a journal bash cannot read back, sealed as
 * though scrumux had written it. Its error paths are therefore as
 * load-bearing as its success path.
 *
 * THE SECOND DESCRIBE BLOCK IS A MEASURED DIVERGENCE MATRIX, NOT A WISH LIST.
 * It was produced by driving both `/usr/bin/jq` and this parser over the same
 * seventeen inputs, and it PINS what each one does.
 *
 * RULED AT THE PHASE 1 GATE (D-0089). The matrix carried four ts-STRICTER
 * rows — the one direction the port may not take. User split them:
 *
 *   `1 2`, a top-level value stream, is now ACCEPTED exactly as jq accepts
 *   it. That was the one REACHABLE case: `jq . file` over two top-level
 *   values exits 0, so a hand-edited journal in that shape passed bash's
 *   guard and would have read as "unreadable" on the TypeScript side.
 *
 *   `+1`, `Infinity` and `NaN` stay stricter, as an
 *   `APPROVED-DIVERGENCE: D-0089`. None is reachable from a CLI verb —
 *   every field arrives via `--arg` — and none appears in any live journal,
 *   so the port is stricter only on inputs no bash path can produce.
 *   Accepting them would also force a serializer question (jq renders NaN
 *   as `null` on output), which is spike-level, not a tidy-up.
 *
 * The rows below are the enforcement of that ruling: each one names its side
 * of the split, so widening or narrowing it is a deliberate act.
 */
describe('the parser refuses malformed JSON', () => {
  for (const [label, src] of [
    ['a truncated array', '[1, 2'],
    ['a missing comma in an array', '[1 2]'],
    ['a truncated object', '{"a": 1'],
    ['a missing comma in an object', '{"a": 1 "b": 2}'],
    ['a missing colon', '{"a" 1}'],
    ['a non-string key', '{1: 2}'],
    ['an unterminated string', '"abc'],
    ['a bad escape', '"a\\qb"'],
    ['a bare word', 'nope'],
    ['nothing at all', ''],
    ['a double minus', '--1'],
    ['two decimal points', '1..2'],
    ['a hex literal', '0x10'],
    // APPROVED-DIVERGENCE: D-0089 — jq accepts all three; the port does not.
    ['a leading plus (D-0089)', '+1'],
    ['Infinity (D-0089)', 'Infinity'],
    ['NaN (D-0089)', 'NaN'],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(() => parsePreservingNumbers(src), src).toThrow();
    });
  }
});

function jqAccepts(src: string): boolean {
  try {
    execFileSync('jq', ['.'], { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}
function tsAccepts(src: string): boolean {
  try {
    parsePreservingNumbers(src);
    return true;
  } catch {
    return false;
  }
}

/** Measured 2026-08-31 against jq-1.7.1-apple. `null` means "they agree". */
const MATRIX: Array<[string, 'ts-looser' | 'ts-STRICTER' | null]> = [
  ['-', 'ts-looser'],
  ['1e', 'ts-looser'],
  ['1e+', 'ts-looser'],
  ['{"n":-}', 'ts-looser'],
  ['{"n":1e}', 'ts-looser'],
  // APPROVED-DIVERGENCE: D-0089 — kept stricter, deliberately and narrowly.
  ['+1', 'ts-STRICTER'],
  ['Infinity', 'ts-STRICTER'],
  ['NaN', 'ts-STRICTER'],
  // D-0089 closed this one: it was the only reachable bash-passes/TS-fails
  // case, so it moved to agreement rather than staying a pinned divergence.
  ['1 2', null],
  ['1.', null],
  ['.5', null],
  ['01', null],
  ['--1', null],
  ['1..2', null],
  ['0x10', null],
  ['{"n":1.}', null],
  ['{"n":01}', null],
];

describe('where this parser and jq disagree (measured, pinned, surfaced)', () => {
  for (const [src, verdict] of MATRIX) {
    it(`${JSON.stringify(src)} — ${verdict ?? 'agree'}`, () => {
      const jq = jqAccepts(src);
      const ts = tsAccepts(src);
      if (verdict === null) expect(ts, 'agreement changed').toBe(jq);
      if (verdict === 'ts-looser') { expect(jq).toBe(false); expect(ts).toBe(true); }
      // The prohibited direction. Not fixed here: it is a gate question, and
      // this assertion is what makes the answer land deliberately.
      if (verdict === 'ts-STRICTER') { expect(jq).toBe(true); expect(ts).toBe(false); }
    });
  }

  it('the ts-STRICTER set is exactly the three D-0089 approved it to be', () => {
    // "TS never fails where bash passed", over the whole corpus, every verb.
    // Three inputs still break that, each carrying an APPROVED-DIVERGENCE
    // marker at its refusal site in src/journal/jqformat.ts. A fourth entry
    // appearing here is a divergence nobody ruled on.
    const stricter = MATRIX.filter(([, v]) => v === 'ts-STRICTER').map(([s]) => s);
    expect(stricter).toEqual(['+1', 'Infinity', 'NaN']);
  });

  it('every ts-STRICTER row has an APPROVED-DIVERGENCE marker in the source', () => {
    // The anti-strictness backstop, made mechanical: a refusal with no bash
    // counterpart must carry a ruling, and this asserts the marker is
    // actually there rather than trusting the comment above.
    const src = readFileSync(resolve(import.meta.dirname, '../../src/journal/jqformat.ts'), 'utf8');
    expect(src).toContain('APPROVED-DIVERGENCE: D-0089');
    expect(src.match(/APPROVED-DIVERGENCE: D-0089/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the parser keeps what jq keeps', () => {
  it('every legal escape survives a round trip', () => {
    const src = '{"s": "q\\" b\\\\ sl\\/ bs\\b ff\\f nl\\n cr\\r tab\\t u\\u00e9"}';
    const v = parsePreservingNumbers(src) as Record<string, string>;
    expect(v.s).toContain('é');
    // `/` is NOT escaped on the way out, which is where a hand-rolled
    // serialiser usually differs from jq.
    expect(jqFormat(v as never)).toContain('sl/');
  });

  it("keeps a number's source text through every exponent spelling", () => {
    for (const t of ['1.0', '1.10', '1.000', '-0.0', '1e3', '1e-3', '1E+3',
      '12345678901234567890', '0', '-7']) {
      const v = parsePreservingNumbers(`{"n": ${t}}`) as Record<string, RawNumber | undefined>;
      expect(v.n, t).toBeInstanceOf(RawNumber);
      expect(v.n!.text, t).toBe(t);
    }
  });

  it('accepts the three literals and the empty containers', () => {
    expect(parsePreservingNumbers('{"a":true,"b":false,"c":null,"d":{},"e":[]}'))
      .toEqual({ a: true, b: false, c: null, d: {}, e: [] });
  });

  it('tolerates whitespace anywhere a JSON grammar allows it', () => {
    expect(parsePreservingNumbers('  {\n "a" :\t[ 1 , 2 ]\n}  \n')).toEqual({
      a: [new RawNumber('1'), new RawNumber('2')],
    });
  });

  it('last key wins on a duplicate, exactly as jq does', () => {
    expect(jqFormat(parsePreservingNumbers('{"a":1,"a":2}'))).toBe('{\n  "a": 2\n}\n');
  });

  it('accepts a top-level value STREAM and answers with the first value (D-0089)', () => {
    // `jq . file` over two top-level values reads both and exits 0, so a
    // hand-edited journal in that shape passes bash's guard. Refusing it here
    // would report "unreadable" where bash reported "ok".
    expect(parsePreservingNumbers('{"entries": []}\n{"entries": [1]}\n'))
      .toEqual({ entries: [] });
    expect(parsePreservingNumbers('1 2')).toEqual(new RawNumber('1'));
    expect(parsePreservingNumbers('  {"a":1}  [2]  "three"  '))
      .toEqual({ a: new RawNumber('1') });
  });

  it('still refuses genuine trailing garbage after a value', () => {
    // Accepting a stream is not accepting anything: what follows must itself
    // parse as a value, or the input is malformed and says so.
    for (const src of ['{} }', '[1] ,', '{"a":1} nope']) {
      expect(() => parsePreservingNumbers(src), src).toThrow();
    }
  });
});
