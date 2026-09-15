import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jqFormat, parsePreservingNumbers, type JsonValue } from '../../src/journal/jqformat.js';
import { writeJson } from '../../src/journal/write.js';

/**
 * LF, ON EVERY PLATFORM, WITH NO EXCEPTIONS.
 *
 * The journals are compared BYTE FOR BYTE against what bash writes (`npm run
 * diff` compares post-state as text; `harness verify` hashes the payload;
 * `records check` reads seals computed over those bytes). One CR anywhere in
 * that pipeline turns every one of those comparisons red on Windows and
 * nowhere else, and the failure would present as "the port is wrong" rather
 * than "the line ending is wrong" -- which is the most expensive way to find
 * a one-character bug.
 *
 * Nothing in src/ reaches for os.EOL today, and that is exactly the state
 * worth PINNING rather than trusting: the next person to format output has a
 * platform-aware helper one autocomplete away, and on macOS and Linux the
 * mistake is invisible. These assertions are written on the BYTES, not on the
 * string, because a string comparison after a readFileSync('utf8') is not
 * where a CR hides.
 *
 * The other half of this guarantee -- that the bytes survive a real process
 * on a real Windows box -- is tools/ci/smoke.mjs, which re-reads the journals
 * a deployed CLI just wrote and refuses any 0x0D. This file is the unit half:
 * it holds the formatter itself to the rule without needing a CLI at all,
 * which is why it runs in the Windows partition.
 */

const CR = 0x0d;

/** A corpus wide enough that a newline appears in every position the formatter emits one. */
const CORPUS: Array<[string, JsonValue]> = [
  ['an empty object', {}],
  ['an empty array', []],
  ['a flat object', { a: 1, b: 'two', c: true, d: null }],
  ['a nested object', { outer: { inner: { deep: [1, 2, 3] } } }],
  ['an array of objects', [{ id: 'T-0001' }, { id: 'T-0002' }]],
  ['a journal-shaped document', {
    schema: 'scrumux.tasks/1',
    tasks: [
      { id: 'T-0001', title: 'one', status: 'done', notes: [] },
      { id: 'T-0002', title: 'two', status: 'todo', notes: ['a', 'b'] },
    ],
  }],
  // The one case where a CR is legitimate: INSIDE a string, where it must be
  // escaped as \r rather than emitted raw. If this stopped escaping, the raw
  // byte would sail past a naive scan of the file and corrupt the JSON.
  ['a string containing a carriage return', { text: 'before\rafter' }],
  ['a string containing a newline', { text: 'before\nafter' }],
  ['a string containing CRLF', { text: 'line one\r\nline two' }],
];

describe('jqFormat emits LF and only LF', () => {
  for (const [label, value] of CORPUS) {
    it(`${label} carries no raw CR byte`, () => {
      const bytes = Buffer.from(jqFormat(value), 'utf8');
      const at = bytes.indexOf(CR);
      expect(
        at,
        at === -1 ? '' : `raw 0x0D at byte ${at} of:\n${JSON.stringify(jqFormat(value))}`,
      ).toBe(-1);
    });
  }

  it('escapes a carriage return rather than dropping it', () => {
    // The value survives; only its ENCODING is constrained.
    const out = jqFormat({ text: 'before\rafter' });
    expect(out).toContain('\\r');
    const round = parsePreservingNumbers(out) as { text: string };
    expect(round.text).toBe('before\rafter');
  });

  it('terminates the document with exactly one LF and no CR', () => {
    const out = jqFormat({ a: 1 });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\r\n')).toBe(false);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('separates every line with a bare LF — no line of the output ends in CR', () => {
    const out = jqFormat({ a: [1, 2], b: { c: 'd' } });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(4);
    for (const l of lines) expect(l.endsWith('\r')).toBe(false);
  });
});

describe('the journal writer puts LF on disk', () => {
  it('writes a journal whose bytes contain no CR, on whatever platform this is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-only-'));
    try {
      // {entries:[...]} is the shape every governance journal has (T-0157);
      // the writer refuses anything else, so the fixture uses the real one.
      const p = join(dir, 'tasks.json');
      writeFileSync(p, jqFormat({ schema: 'scrumux.tasks/1', entries: [] }));
      writeJson(
        p,
        (doc) => {
          const d = doc as { entries: JsonValue[] };
          d.entries.push({ id: 'T-0001', title: 'a task with a CRLF in it: x\r\ny' });
          return d;
        },
        { gov: dir, today: '2026-09-01' },
      );

      const bytes = readFileSync(p);
      const at = bytes.indexOf(CR);
      expect(at, at === -1 ? '' : `raw 0x0D on disk at byte ${at}`).toBe(-1);
      expect(bytes[bytes.length - 1], 'the file must end in LF').toBe(0x0a);

      // And the escaped CR is still the value it was handed.
      const doc = JSON.parse(bytes.toString('utf8')) as { entries: Array<{ title: string }> };
      expect(doc.entries[0]?.title).toContain('\r\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
