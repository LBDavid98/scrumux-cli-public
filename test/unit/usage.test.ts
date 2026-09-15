import { describe, it, expect } from 'vitest';
import { NOUNS, nounKnown, usageNoun, usageTop } from '../../src/cli/usage.js';
import { NOUN_USAGE } from '../../src/cli/usage-text.js';

/**
 * The help surface is the instruction set (Article 5). These used to be
 * contract tests against bash's text (`npm run diff` proved the same thing
 * through the real binaries, at the function rather than the subprocess);
 * with bash retired there is nothing left to compare against, so what
 * remains here is the structural shape of the TypeScript text itself.
 */
describe('the noun table', () => {
  it('carries all 21 nouns, in registry order', () => {
    expect(NOUNS).toHaveLength(21);
    expect(NOUNS[0]).toBe('backlog');
    expect(NOUNS[NOUNS.length - 1]).toBe('views');
  });

  it('derives its column width from the longest noun, not a literal 9', () => {
    // `exception` is exactly nine characters. A hardcoded width put ONE space
    // between it and its gloss, and every reader that splits the table on a
    // run of spaces silently dropped the noun -- including the control
    // plane's surface reader, which feeds R-A6a's coverage check (T-0202).
    const line = usageTop().split('\n').find((l) => l.trim().startsWith('exception'));
    expect(line).toBeDefined();
    expect(line!.startsWith('  exception  ')).toBe(true);
  });

  it('every noun row separates name from gloss by at least two spaces', () => {
    for (const n of NOUNS) {
      const line = usageTop().split('\n').find((l) => l.startsWith(`  ${n} `) || l.startsWith(`  ${n}  `));
      expect(line, `no table row for ${n}`).toBeDefined();
      expect(line!.slice(2 + n.length).startsWith('  ')).toBe(true);
    }
  });
});

describe('the 21 noun usage blocks', () => {
  it('knows every noun in the roster and nothing else', () => {
    for (const n of NOUNS) expect(nounKnown(n)).toBe(true);
    for (const n of ['nosuchnoun', '', 'toString', 'constructor', '__proto__']) {
      expect(nounKnown(n), `${n} must not be a noun`).toBe(false);
    }
  });

  it('answers rather than throwing for a noun with no compiled block', () => {
    // Unreachable through the dispatcher, which validates first. A help
    // surface that crashes is worse than one that says what it does not know.
    expect(usageNoun('not-a-noun')).toContain('no usage block is compiled');
  });

  it('every block ends in exactly one newline', () => {
    for (const [n, t] of Object.entries(NOUN_USAGE)) {
      expect(t.endsWith('\n'), `${n} must end with a newline`).toBe(true);
      expect(t.endsWith('\n\n'), `${n} must not end with a blank line`).toBe(false);
    }
  });
});
