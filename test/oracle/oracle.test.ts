import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cmdWords } from '../../src/walls/lib/cmd-words.js';

/**
 * THE PERMANENT ORACLE. The awk tokenizer, frozen, driven against the
 * TypeScript state machine — on the golden corpus, and on ten thousand
 * generated cases per run.
 *
 * WHY GENERATED CASES AND NOT JUST THE CORPUS. A corpus proves the two agree
 * on inputs somebody thought of. The tokenizer's failures have never been
 * inputs somebody thought of — they were a pipe inside a `--file` value and a
 * semicolon inside a `--command` value, both of which read as perfectly
 * ordinary until a wall fired on prose. So the generator builds strings out
 * of the pieces that actually interact: quotes, separators, wrappers,
 * assignments, newlines, and program names, in random order. It is looking
 * for the combination nobody wrote down.
 *
 * THIS FILE OUTLIVES BASH. When `.claude/hooks/` is deleted in Phase 6 the
 * awk copy at `test/oracle/cmd-words.awk.sh` stays and this keeps running
 * against it. That is the whole point of freezing it rather than deleting it
 * with its parent.
 */
const HERE = import.meta.dirname;
const ORACLE = resolve(HERE, 'cmd-words.awk.sh');
const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'cmd-words.golden.json'), 'utf8')) as {
  counts: { total: number; fromSuites: number; hand: number };
  cases: Array<{ input: string; from: string; why?: string; words: string[] }>;
};

function awkOracle(input: string): string[] {
  return execFileSync('sh', [ORACLE], { input, encoding: 'utf8' })
    .split('\n').filter((l) => l !== '');
}

describe('the frozen oracle is still the thing it froze', () => {
  // The byte-identical-to-walls-lib.sh case retired with bash itself
  // (2026-09-03, as its own comment always said it would): the frozen copy
  // here is now the sole record of what bash's tokenizer did, with nothing
  // left to drift against.

  it('the corpus is mostly harvested from the suites, not hand-written', () => {
    // Derived-never-hand-listed: a case added to a hook suite next month
    // joins this corpus by being in the suite.
    expect(GOLDEN.counts.fromSuites).toBeGreaterThan(100);
    expect(GOLDEN.counts.total).toBe(GOLDEN.cases.length);
  });

  it('every hand-written case says why it is here', () => {
    for (const c of GOLDEN.cases.filter((x) => x.from === 'hand')) {
      expect(c.why, `hand case ${JSON.stringify(c.input)} has no reason`).toBeTruthy();
    }
  });
});

describe('cmdWords agrees with the awk on the golden corpus', () => {
  it(`all ${GOLDEN.cases.length} cases`, () => {
    const bad: string[] = [];
    for (const c of GOLDEN.cases) {
      const got = cmdWords(c.input);
      if (JSON.stringify(got) !== JSON.stringify(c.words)) {
        bad.push(`${JSON.stringify(c.input)}\n    awk: ${JSON.stringify(c.words)}\n    ts : ${JSON.stringify(got)}`);
      }
    }
    expect(bad.join('\n  '), `${bad.length} divergence(s)`).toBe('');
  });

  it('the golden answers still match the live awk (the corpus has not gone stale)', () => {
    // Sampled rather than exhaustive: 169 subprocesses on every test run is a
    // cost with no extra signal, and the property run below drives the real
    // binary thousands of times anyway.
    for (const c of GOLDEN.cases.filter((_, i) => i % 7 === 0)) {
      expect(awkOracle(c.input), JSON.stringify(c.input)).toEqual(c.words);
    }
  });
});

// --- the property run --------------------------------------------------
const PIECES = [
  'rm', 'cat', 'curl', 'grep', 'scrumux', 'git', '7z', 'x', 'node',
  '/usr/bin/rm', './.claude/scripts/scrumux', 'a', 'b',
  'env', 'sudo', 'nice', 'timeout', 'xargs', 'busybox', 'toybox', 'exec',
  'FOO=1', 'A=b', '-n', '10', '30m', '-rf', '--force', '.env',
  ';', '&&', '||', '|', '&', ' ', '  ', '\t', '\n',
  '"', "'", '`', '(', ')', '<', '>', '=', '#',
  'café', '🙂', '<<EOF', 'EOF', '/dev/tcp/h/1', '--rationale',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many generated cases per run. The plan says 10k; the env can lower it. */
const N = Number(process.env['ORACLE_CASES'] ?? 10000);

describe('cmdWords agrees with the awk over generated input', () => {
  it(`${N} generated cases, in batches, against the real awk`, () => {
    const rand = mulberry32(0x5c12ab);
    const inputs: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const len = 1 + Math.floor(rand() * 12);
      let s = '';
      for (let j = 0; j < len; j += 1) {
        s += PIECES[Math.floor(rand() * PIECES.length)]!;
        if (rand() < 0.55) s += ' ';
      }
      inputs.push(s);
    }

    // ONE subprocess per BATCH, not per case: 10,000 `sh` spawns is ninety
    // seconds of process creation and zero extra signal. A NUL byte separates
    // cases on the way in and a sentinel line separates the answers on the way
    // out, because a case's own output can contain anything except those.
    const SEP = '\0';
    const BATCH = 250;
    const bad: string[] = [];
    for (let b = 0; b < inputs.length && bad.length < 5; b += BATCH) {
      const chunk = inputs.slice(b, b + BATCH);
      const script = `while IFS= read -r -d '' c; do printf '%s' "$c" | sh ${JSON.stringify(ORACLE)}; printf '@@@\\n'; done`;
      const out = execFileSync('bash', ['-c', script], {
        input: chunk.map((c) => c + SEP).join(''),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const answers = out.split('@@@\n');
      for (let k = 0; k < chunk.length; k += 1) {
        const want = (answers[k] ?? '').split('\n').filter((l) => l !== '');
        const got = cmdWords(chunk[k]!);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          bad.push(`${JSON.stringify(chunk[k])}\n    awk: ${JSON.stringify(want)}\n    ts : ${JSON.stringify(got)}`);
          if (bad.length >= 5) break;
        }
      }
    }
    expect(bad.join('\n  '), `${bad.length} divergence(s) over ${N} generated cases`).toBe('');
  }, 300_000);
});
