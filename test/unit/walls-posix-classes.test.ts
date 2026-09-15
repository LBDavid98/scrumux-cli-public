import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { shellReads, shellDials } from '../../src/walls/lib/predicates.js';
import { splitRule } from '../../src/walls/lib/conf.js';

/**
 * `[[:space:]]` IS NOT `\s`, AND IT IS NOT `[ \t]` EITHER.
 *
 * Three definitions of "whitespace" met in one hand-translated regex and the
 * wall lost a case to it:
 *
 *   POSIX [[:space:]]  space tab newline vertical-tab form-feed carriage-return
 *   JS    \s           all of those PLUS U+00A0, U+1680, U+2000-200A, U+2028,
 *                      U+2029, U+202F, U+205F, U+3000 and the BOM
 *   [ \t]              two of them
 *
 * `walls_shell_reads`'s ERE is
 * `(^|[^0-9<>])<[[:space:]]*[^<&|[:space:]]|…`, and the first cut of the port
 * wrote `[ \t]*` for the run and `[^<&|\s]` for the NEGATED class — narrower
 * in one place and WIDER in the other, in the same expression. The negated one
 * is the one that bites: a NBSP after `<` is not POSIX space, so bash's
 * `[^<&|[:space:]]` matches it and the wall sees a shell read; JS `\s` DOES
 * include NBSP, so `[^<&|\s]` rejects it and the TypeScript wall saw nothing.
 *
 *   $ printf 'cat <<NBSP>.env' | /usr/bin/grep -qE '<[[:space:]]*[^<&|[:space:]]'
 *   rc=0        (and rc=0 under ugrep too — locale-independent)
 *
 * `block-secret-reads` then allow()s a read the bash wall refuses on every
 * machine. Caught by review, not by the differential: `walls-parity.mjs`
 * replays payloads HARVESTED from the existing bash suites, and no suite ever
 * put a non-breaking space next to a redirect.
 *
 * The fix is not a better hand-translation. It is to stop hand-translating:
 * every wall predicate now compiles its POSIX ERE through `ere.ts`, where
 * `[[:space:]]` is defined once.
 */
const NBSP = '\u00a0';
const GREPS = ['/usr/bin/grep', 'grep'].filter((g) => (g.startsWith('/') ? existsSync(g) : true));
const BASH_SHELL_READS = '(^|[^0-9<>])<[[:space:]]*[^<&|[:space:]]|[$]\\([[:space:]]*<|<>';

/**
 * `LC_ALL=C`, and that is the ruling rather than a convenience.
 *
 * Whether `[[:space:]]` matches U+00A0 is LOCALE-DEPENDENT. Measured on this
 * machine against `refuse<NBSP>zz`:
 *
 *   BSD grep   LC_ALL=C           no match
 *   BSD grep   LC_ALL=en_US.UTF-8 MATCH
 *   ugrep      either             MATCH
 *
 * So "what bash does" is not one answer even on one machine with one grep. The
 * port implements the C-locale (ASCII) definition, because it is the only one
 * that does not change with the environment — the same reasoning D-0090
 * ratified for the ERE dialect: one documented dialect everywhere, so a conf
 * rule never activates or deactivates by machine. The comparison below is
 * against the dialect the port implements, and the divergence from a UTF-8
 * locale is pinned explicitly further down rather than averaged away.
 */
function grepSays(pattern: string, subject: string): boolean[] {
  return GREPS.map((g) => spawnSync(g, ['-qE', '--', pattern], {
    input: subject, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
  }).status === 0);
}

describe('shellReads agrees with grep on every POSIX-space edge', () => {
  const CASES: Array<[string, string]> = [
    ['a NBSP after the redirect — THE DEFECT', `cat <${NBSP}.env`],
    ['a NBSP after a redirect, later in the line', `read K <${NBSP}.env`],
    ['an ordinary space', 'cat < .env'],
    ['a tab', 'cat <\t.env'],
    ['no gap at all', 'cat <.env'],
    ['a vertical tab, which IS POSIX space', 'cat <\v.env'],
    ['a form feed, which IS POSIX space', 'cat <\f.env'],
    ['a carriage return, which IS POSIX space', 'cat <\r.env'],
    ['an em space, which is NOT POSIX space', `cat <${' '}.env`],
    ['a NBSP as the redirect TARGET start', `X=$(<${NBSP}.env)`],
    ['a here-string, not a read', 'cat <<< hello'],
    ['a numeric fd, which the leading class excludes', 'exec 3< .env'],
    ['read-write, which matches on its own', 'exec 3<> /dev/tcp/h/1'],
    ['nothing at all', 'echo hi'],
  ];

  for (const [label, subject] of CASES) {
    it(label, () => {
      const answers = grepSays(BASH_SHELL_READS, subject);
      const agreed = new Set(answers).size === 1;
      expect(agreed, `the greps on this machine disagree: ${JSON.stringify(answers)}`).toBe(true);
      expect(shellReads(subject), `bash says ${answers[0]}`).toBe(answers[0]);
    });
  }
});

describe('shellDials agrees with grep, including where the class does not appear', () => {
  for (const s of ['exec 3<>/dev/tcp/h/1', `curl${NBSP}/dev/udp/h/1`, 'echo /dev/null']) {
    it(JSON.stringify(s), () => {
      const answers = grepSays('/dev/(tcp|udp)/', s);
      expect(new Set(answers).size).toBe(1);
      expect(shellDials(s)).toBe(answers[0]);
    });
  }
});

describe('the conf verb parser is POSIX space too, not JS \\s', () => {
  it('splits on a POSIX-space run', () => {
    expect(splitRule('refuse', 'refuse \tzz | a reason')).toEqual({ pattern: 'zz', reason: 'a reason' });
  });

  it('does NOT treat a NBSP as the verb separator', () => {
    // `^[[:space:]]*refuse[[:space:]]+` under bash: a NBSP is not the
    // separator, so the line is not a rule at all and is silently ignored.
    // With `\s` it WOULD parse, and the repo would gain a rule bash does not
    // have -- fail-open on an allow line, and a tightening on a refuse line.
    expect(splitRule('refuse', `refuse${NBSP}zz | a reason`)).toBeNull();
    expect(splitRule('refuse', `${NBSP}refuse zz | a reason`)).toBeNull();
  });

  it('agrees with C-locale grep on which lines are rules at all', () => {
    const label = (l: string): string => JSON.stringify(l).replace(/\u00a0/g, '<NBSP>');
    for (const line of ['refuse zz | r', ' \trefuse zz | r', `refuse${NBSP}zz | r`, `${NBSP}refuse zz | r`, 'refusezz | r']) {
      const answers = grepSays('^[[:space:]]*refuse[[:space:]]+', line);
      expect(new Set(answers).size, label(line)).toBe(1);
      expect(splitRule('refuse', line) !== null, label(line)).toBe(answers[0]);
    }
  });

  it('PINS the locale divergence rather than averaging it away, and NAMES the two libcs', () => {
    /**
     * THE RATIFIED ANSWER FIRST, BECAUSE IT IS THE ONE THAT IS THE SAME
     * EVERYWHERE. `[[:space:]]` in the C locale is the seven ASCII spaces and
     * nothing else, on every libc measured; the port implements that, so a
     * `project-walls.conf` line with a NBSP in it is not a rule on any
     * machine. Those two assertions are unconditional and they are the
     * contract.
     *
     * THE HOST MEASUREMENT IS CLASSIFIED, NOT ASSERTED FLAT — this is the
     * Linux red that Harden D found in a container, and the reason the
     * original line could not stand. It read
     * `expect(utf8, 'a UTF-8 locale treats NBSP as POSIX space').toBe(true)`,
     * which is a fact about BSD libc that this file had generalised into a
     * fact about UTF-8 locales:
     *
     *   BSD libc (Darwin)     LC_ALL=en_US.UTF-8  MATCH   — NBSP IS a space
     *   glibc (Debian/Ubuntu) every locale        no match — NBSP is NOT,
     *                                             en_US.UTF-8 and C.UTF-8 both
     *   ugrep                 either              MATCH
     *
     * glibc's `[[:space:]]` follows the character's POSIX class in its charmap
     * and U+00A0 is deliberately NOT space there (it is the whole point of a
     * NON-BREAKING space); BSD's derives from the wide-character `iswspace`,
     * which says it is. Neither is a bug and there is no version of this test
     * that can make them agree.
     *
     * So the divergence is named per libc, read from the binary's own banner,
     * and a THIRD answer is red — which is what "pinned" has to mean once the
     * measurement is known to have two legitimate values. Same extension of
     * D-0090's one-dialect principle as the `{n}`-with-nothing-to-repeat class
     * in `ere.test.ts`: the ratified dialect is asserted everywhere, and the
     * host's disagreement is an expected, classified condition rather than a
     * change to what a wall does.
     */
    const line = `refuse${NBSP}zz | r`;
    const RE = '^[[:space:]]*refuse[[:space:]]+';

    const c = grepSays(RE, line)[0];
    expect(c, 'the C locale does not treat NBSP as POSIX space, on any libc').toBe(false);
    expect(splitRule('refuse', line), 'the port follows the C locale, on every host').toBeNull();

    // Both a generated and a guaranteed UTF-8 locale, because a locale that is
    // not installed silently falls back to C and would fake glibc's answer on
    // a BSD box. `C.UTF-8` is always present on glibc; `en_US.UTF-8` is what
    // Darwin ships. Asking for both means at least one is real on either.
    const matchesUnder = (loc: string): boolean => spawnSync(GREPS[0]!, ['-qE', '--', RE], {
      input: line, encoding: 'utf8', env: { ...process.env, LC_ALL: loc },
    }).status === 0;
    const utf8 = ['en_US.UTF-8', 'C.UTF-8'].map(matchesUnder);

    const banner = spawnSync(GREPS[0]!, ['--version'], { encoding: 'utf8' }).stdout ?? '';
    const family = banner.includes('GNU grep') ? 'GNU' : banner.includes('BSD grep') ? 'BSD' : 'other';

    if (family === 'GNU') {
      expect(utf8, 'glibc: NBSP is not [[:space:]] in ANY locale').toEqual([false, false]);
    } else if (family === 'BSD') {
      expect(utf8.includes(true), 'BSD libc: a UTF-8 locale DOES treat NBSP as POSIX space').toBe(true);
    } else {
      // ugrep and friends: recorded, not ruled on. The unconditional pair
      // above is what this file actually defends.
      expect(utf8.every((v) => typeof v === 'boolean')).toBe(true);
    }
  });
});
