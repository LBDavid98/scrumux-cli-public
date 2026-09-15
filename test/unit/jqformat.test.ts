import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { jqFormat, parsePreservingNumbers, canonNumber, jqDouble, jqString } from '../../src/journal/jqformat.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const GOV = resolve(REPO, 'governance');

function haveJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const JQ = haveJq();

/** `jq .` over a string, as the reference implementation. */
function jqRef(input: string): string {
  return execFileSync('jq', ['.'], { input, encoding: 'utf8', maxBuffer: 1 << 30 });
}

function round(src: string): string {
  return jqFormat(parsePreservingNumbers(src));
}

describe('jqformat: the structural rules', () => {
  it('renders empty containers inline', () => {
    expect(round('{"a":{},"b":[]}')).toBe('{\n  "a": {},\n  "b": []\n}\n');
  });
  it('does not escape a forward slash', () => {
    expect(round('{"p":"a/b"}')).toContain('"a/b"');
  });
  it('escapes DEL, which JSON.stringify does not', () => {
    expect(jqString('')).toBe('"\\u007f"');
    expect(JSON.stringify('')).not.toBe('"\\u007f"');
  });
  it('emits non-ASCII as raw UTF-8', () => {
    expect(round('{"s":"café"}')).toContain('café');
  });
  it('preserves insertion key order, never sorts', () => {
    expect(round('{"z":1,"a":2,"m":3}')).toBe('{\n  "z": 1,\n  "a": 2,\n  "m": 3\n}\n');
  });
  it('takes the last of duplicate keys, as jq does', () => {
    expect(round('{"a":1,"a":2}')).toBe('{\n  "a": 2\n}\n');
  });
  it('ends with exactly one newline, even for a top-level scalar', () => {
    expect(round('"hi"')).toBe('"hi"\n');
  });
});

describe('jqformat: numbers keep their literal', () => {
  // The whole reason the reader is hand-rolled. JSON.parse turns 1.10 into
  // 1.1 and the literal is gone before a reviver could see it.
  const cases = ['1.0', '1.10', '1.000', '-0.0', '100', '12345678901234567890', '0.30000000000000004'];
  for (const c of cases) {
    it(`preserves ${c}`, () => {
      expect(round(`{"n":${c}}`)).toBe(`{\n  "n": ${c}\n}\n`);
    });
  }
  it('renders an exponent in decNumber sci form', () => {
    expect(canonNumber('1e3')).toBe('1E+3');
    expect(canonNumber('1e-3')).toBe('0.001');
    expect(canonNumber('5e-324')).toBe('5E-324');
  });
  it('renders a COMPUTED double in jvp_dtoa form (lowercase, padded)', () => {
    expect(jqDouble(1e17)).toBe('1e+17');
    expect(jqDouble(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(jqDouble(-0)).toBe('-0');
  });
});

describe.skipIf(!JQ)('jqformat: the permanent jq oracle', () => {
  // This outlives bash. It is the thing that says the serializer is still
  // right after any refactor -- byte-for-byte against the real binary.
  it('reproduces `jq .` over every real JSON document in the tree', () => {
    // THE LIVE JOURNALS ARE THE BEST CORPUS AND THEY DO NOT TRAVEL.
    // governance/*.json is gitignored -- the working record is the author's
    // diary -- so on a clone this read `files.length` 0 and the case failed
    // its own anti-vacuity guard on all three POSIX lanes of the first CI
    // run (2026-09-02) without ever asking jq anything.
    //
    // The guard was right and stays: an oracle that silently checks nothing
    // is worse than no oracle. What changes is the corpus. The journals are
    // still preferred and still read where they exist, and where they do not
    // the COMMITTED json in the tree stands in -- the schemas, the settings,
    // the deployable manifests and the canonicalised bash baseline, which is
    // a real journal transcript and the largest document here. Different
    // bytes on the two machines, the same claim on both, and neither can be
    // empty: the tree always carries these.
    const live = existsSync(GOV)
      ? readdirSync(GOV).filter((f) => f.endsWith('.json')).map((f) => resolve(GOV, f))
      : [];
    const committed = [
      ...readdirSync(resolve(REPO, '.deploy-claude/schemas'))
        .filter((f) => f.endsWith('.json')).map((f) => resolve(REPO, '.deploy-claude/schemas', f)),
      resolve(REPO, '.deploy-claude/settings.json'),
      resolve(REPO, 'deployable-artifacts/manifest.schema.json'),
      resolve(REPO, 'test/baseline/sandbox-bash.json'),
      resolve(REPO, 'test/oracle/cmd-words.golden.json'),
    ].filter((p) => existsSync(p));
    const files = [...live, ...committed];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(round(src), `${f} diverged from jq`).toBe(jqRef(src));
    }
  });

  it('reproduces `jq .` over the structural edge corpus', () => {
    const corpus = [
      '{}', '[]', 'null', '"hi"', '42', 'true',
      '{"a":{"b":{}},"c":[[],{},[[]]]}',
      '{"p":"a/b/c","url":"https://x.y/z?q=1&r=2"}',
      '{"s":"he said \\"hi\\" \\\\ path"}',
      '{"s":"line1\\nline2\\tcol\\rret"}',
      '{"s":"\\u0000\\u0001\\u001f"}',
      '{"s":"\\u007f"}',
      '{"s":"caf\\u00e9 \\u65e5\\u672c\\u8a9e"}',
      '{"a\\nb":1}', '{"":1}', '{"z":1,"a":2}',
      '{"n":0,"m":100,"p":-100}',
      '{"n":1.0}', '{"n":1.10}', '{"n":12345678901234567890}',
      '[1,"a",null,true,false,{},[],{"k":[1,2]}]',
      '{"t":"2026-08-31T13:06:00Z"}',
      '{"c":"$(cat .env) && rm -rf * | tee ${X}"}',
    ];
    for (const src of corpus) {
      expect(round(src), `corpus case diverged: ${src}`).toBe(jqRef(src));
    }
  });
});
