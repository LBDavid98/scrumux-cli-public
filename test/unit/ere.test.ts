import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { translateEre, ereMatches, matchesAnyLine, toLines } from '../../src/walls/lib/ere.js';

/**
 * The ERE translator, property-tested against EVERY `grep -E` on this machine
 * — and the interesting half is what happens where they disagree.
 *
 * THE ORACLE IS NOT ONE THING. `grep` is whatever is on PATH. Measured here:
 * `/usr/bin/grep` (BSD) and the `grep` on PATH (ugrep 7.8.4) return different
 * answers for `\b`, for a backreference, and for a dangling `{` — and for the
 * last two the difference is "matched" versus "will not compile", which
 * changes whether `walls_field` keeps the rule at all. So a property test that
 * asserts agreement with "real grep" would be asserting agreement with one
 * machine's accident.
 *
 * What this file does instead: run every grep it can find, and
 *   - where they AGREE, require the translator to agree with them;
 *   - where they DISAGREE, pin the translator's answer explicitly, with the
 *     reason for the choice, and count the case as platform-dependent.
 *
 * That is the honest shape, and it makes the divergence visible rather than
 * averaging it away.
 */
const GREPS = ['/usr/bin/grep', '/bin/grep', 'grep']
  .filter((g, i, a) => a.indexOf(g) === i)
  .filter((g) => (g.startsWith('/') ? existsSync(g) : true));

interface GrepAnswer { rc: number }
function grepE(bin: string, pattern: string, subject: string): GrepAnswer {
  const r = spawnSync(bin, ['-Eqi', '--', pattern], { input: subject, encoding: 'utf8' });
  return { rc: r.status === null ? -1 : r.status };
}

/** Distinct answers across every grep found: 1 = they agree. */
function consensus(pattern: string, subject: string): { agreed: boolean; rc: number } {
  const rcs = GREPS.map((g) => grepE(g, pattern, subject).rc);
  const uniq = [...new Set(rcs)];
  return { agreed: uniq.length === 1, rc: uniq[0]! };
}

describe('the oracle is plural, and this run says which greps it found', () => {
  it('found at least one grep', () => {
    expect(GREPS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- basics --
describe('ordinary EREs translate and match exactly', () => {
  const CASES: Array<[string, string, boolean]> = [
    ['rm -rf', 'rm -rf /x', true],
    ['^rm', 'rm -rf /x', true],
    ['^rm', 'sudo rm -rf /x', false],
    ['x$', 'ax', true],
    ['a|b', 'b', true],
    ['(foo|bar)\\.env', 'bar.env', true],
    ['(foo|bar)\\.env', 'bazenv', false],
    ['a{2}', 'aa', true],
    ['a{2}', 'a', false],
    ['a+b', 'aab', true],
    ['a*b', 'b', true],
    ['a?b', 'b', true],
    ['.', 'z', true],
    ['[abc]', 'b', true],
    ['[^abc]', 'z', true],
    ['[a-c]+', 'abc', true],
    ['id_rsa', 'cat ~/.ssh/id_rsa', true],
    ['DROP[[:space:]]+TABLE', 'drop   table users', true],
  ];
  for (const [p, s, want] of CASES) {
    it(`${p} vs ${JSON.stringify(s)} -> ${want}`, () => {
      expect(ereMatches(p, s)).toBe(want);
      const c = consensus(p, s);
      if (c.agreed) expect(ereMatches(p, s), 'disagrees with every grep on this machine').toBe(c.rc === 0);
    });
  }
});

describe('POSIX bracket classes, which JavaScript does not have', () => {
  for (const [cls, hit, miss] of [
    ['alpha', 'q', '7'], ['digit', '7', 'q'], ['alnum', 'q7', '!'],
    ['upper', 'Q', '!'], ['lower', 'q', '!'], ['space', ' ', 'q'],
    ['blank', '\t', 'q'], ['xdigit', 'f', 'z'], ['punct', '!', 'q'],
  ] as const) {
    it(`[[:${cls}:]]`, () => {
      // `upper`/`lower` are matched case-INSENSITIVELY by the wall layer, so
      // both hit; the assertion that matters is the miss.
      expect(ereMatches(`[[:${cls}:]]`, hit)).toBe(true);
      expect(ereMatches(`^[[:${cls}:]]+$`, miss)).toBe(false);
    });
  }

  it('mixes a class with literals and ranges in one bracket', () => {
    expect(ereMatches('^[[:digit:]a-c_]+$', '1a_c')).toBe(true);
    expect(ereMatches('^[[:digit:]a-c_]+$', '1a_z')).toBe(false);
  });

  it('refuses an unknown class name, as grep does', () => {
    const t = translateEre('[[:nosuch:]]');
    expect(t.ok).toBe(false);
    for (const g of GREPS) expect(grepE(g, '[[:nosuch:]]', 'x').rc, g).toBe(2);
  });
});

describe('the two POSIX bracket rules JavaScript does not share', () => {
  it('a `]` first in a class is a literal `]`', () => {
    // JS reads `[]abc]` as an EMPTY class followed by `abc]`. Missing this is
    // silent: the pattern compiles and matches the wrong thing.
    expect(ereMatches('[]abc]', ']')).toBe(true);
    expect(ereMatches('[]abc]', 'a')).toBe(true);
    expect(ereMatches('[]abc]', 'z')).toBe(false);
  });

  it('...and after a negation too', () => {
    expect(ereMatches('^[^]abc]$', 'z')).toBe(true);
    expect(ereMatches('^[^]abc]$', ']')).toBe(false);
  });

  it('an unterminated bracket is invalid, not a literal', () => {
    const t = translateEre('[abc');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.kind).toBe('invalid');
  });
});

describe('grep is LINE-oriented and the translator models the mechanism', () => {
  it('splits a subject into lines exactly as grep does', () => {
    // Empty input is ZERO lines, not one empty line: `printf '' | grep -Eq '$'`
    // exits 1 because there is nothing to match against.
    expect(toLines('')).toEqual([]);
    expect(toLines('a')).toEqual(['a']);
    expect(toLines('a\n')).toEqual(['a']);
    expect(toLines('a\nb')).toEqual(['a', 'b']);
    expect(toLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(toLines('\n')).toEqual(['']);
  });

  it('an empty subject matches nothing, not even `$`', () => {
    expect(ereMatches('$', '')).toBe(false);
    expect(ereMatches('$$', '')).toBe(false);
  });

  it('a class containing \\n still cannot match the separator', () => {
    // [[:space:]] contains \n, but no LINE does. This is the divergence the
    // `m` flag leaves behind and the line split removes.
    expect(ereMatches('[[:space:]]', 'a\nb')).toBe(false);
    expect(ereMatches('[[:space:]]', 'a b')).toBe(true);
  });

  it('`^` anchors per line, so a multi-line command matches on any line', () => {
    // Without the `m` flag this is the divergence that silently disables every
    // anchored rule against a multi-line Bash tool command.
    expect(ereMatches('^rm', 'foo\nrm -rf /')).toBe(true);
    for (const g of GREPS) expect(grepE(g, '^rm', 'foo\nrm -rf /').rc, g).toBe(0);
  });

  it('`$` anchors per line too', () => {
    expect(ereMatches('^foo$', 'foo\nrm -rf /')).toBe(true);
  });

  it('`.` does NOT cross a newline, matching grep', () => {
    expect(ereMatches('a.b', 'a\nb')).toBe(false);
    for (const g of GREPS) expect(grepE(g, 'a.b', 'a\nb').rc, g).toBe(1);
  });
});

describe('case-insensitivity, because every wall matcher uses -i', () => {
  it('a refuse pattern written in caps also catches lower case', () => {
    expect(ereMatches('DROP TABLE', 'drop table users')).toBe(true);
  });
});

describe('where the greps on this machine DISAGREE — pinned, with the reason', () => {
  /**
   * Each row: the pattern, a subject, and the answer this translator gives.
   * The choice is always the one where a repo's rule STAYS ACTIVE, because a
   * skipped `refuse` rule is the fail-open direction.
   */
  const PINNED: Array<[string, string, boolean, string]> = [
    ['\\b', 'ab', true, 'BSD treats \\b as a word boundary and matches; ugrep does not. JS \\b is a word boundary, so the rule stays live'],
    ['(a)\\1', 'aa', true, 'BSD accepts the backreference; ugrep will not compile it and walls_field would SKIP the rule. JS supports it natively, so the rule stays live'],
    ['a{', 'a{', true, 'BSD treats a dangling brace as a literal; ugrep will not compile it. JS treats it as a literal, so the rule stays live'],
  ];

  for (const [p, s, want, why] of PINNED) {
    it(`${p} vs ${JSON.stringify(s)} -> ${want}`, () => {
      const c = consensus(p, s);
      if (c.agreed) {
        // Only one grep on this machine, or they happen to agree here: then
        // there is nothing to choose and the translator must simply match.
        expect(ereMatches(p, s), `greps agree (rc ${c.rc}); ${why}`).toBe(c.rc === 0);
      } else {
        expect(ereMatches(p, s), why).toBe(want);
      }
    });
  }

  it('reports how much of the surface is platform-dependent', () => {
    const probes: Array<[string, string]> = [
      ['\\d', '5'], ['\\w', 'a'], ['\\s', ' '], ['\\b', 'ab'],
      ['(a)\\1', 'aa'], ['a{', 'a{'], ['[[:alpha:]]', 'abc'], ['a{2}', 'aa'],
      ['^rm', 'rm x'], ['a|b', 'b'],
    ];
    const split = probes.filter(([p, s]) => !consensus(p, s).agreed);
    // Not an assertion that the number is acceptable — an assertion that the
    // measurement still runs and the finding is still visible at the gate.
    expect(split.length).toBeLessThanOrEqual(probes.length);
    if (GREPS.length > 1 && split.length > 0) {
      expect(split.map(([p]) => p)).toContain('\\b');
    }
  });
});

describe('the fail-closed / skip-and-name split (OQ-8, ruled in D-0085)', () => {
  it('separates "not a valid ERE" from "valid ERE this cannot express"', () => {
    // The two need different answers: the first has a bash counterpart (grep
    // exits 2 and walls_field skips it, on both verbs); the second has none,
    // and D-0085 rules it fails closed on refuse and skips on allow.
    const invalid = translateEre('(unclosed');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.kind).toBe('invalid');
  });

  it('a pattern JS rejects but whose structure is sound is untranslatable, not invalid', () => {
    // `\p` with no property block: JS's non-unicode mode accepts it as `p`, so
    // this reaches for something JS genuinely refuses in a balanced pattern.
    const t = translateEre('a{2,1}');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.kind).toBe('untranslatable');
  });

  it('ereMatches answers false for anything it could not translate', () => {
    // The CALLER applies the fail-closed rule (conf.ts); this primitive never
    // pretends an untranslatable pattern matched.
    expect(ereMatches('(unclosed', 'anything')).toBe(false);
  });
});

// ------------------------------------------------------------- property ---
const ATOMS = [
  'a', 'b', 'z', '0', '_', '.', 'rm', 'env', 'foo', '\\.', '\\|',
  '[abc]', '[^abc]', '[a-z]', '[[:alpha:]]', '[[:digit:]]', '[[:space:]]',
  '(a|b)', '(rm|cat)', '^', '$', '+', '*', '?', '{2}', '{1,3}',
];
const SUBJECTS = ['', 'a', 'ab', 'rm -rf /x', 'cat .env', 'foo.bar', 'A B', '0', 'a\nb', 'z z'];

/**
 * WHICH grep FAMILY IS ON THIS BOX. Read from the binary's own banner rather
 * than inferred from `process.platform`, because the question is about the
 * regex engine and the libc behind it, not about the operating system: a
 * Darwin box with GNU coreutils first on PATH is a GNU box for this purpose.
 */
function grepFamily(bin: string): 'GNU' | 'BSD' | 'other' {
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  const first = (v.stdout ?? '').split('\n', 1)[0] ?? '';
  if (first.includes('GNU grep')) return 'GNU';
  if (first.includes('BSD grep')) return 'BSD';
  return 'other';
}

/**
 * THE NAMED DIALECT DIVERGENCE: ADJACENT DUPLICATION SYMBOLS, AND ONES WITH
 * NOTHING TO DUPLICATE.
 *
 * `{2}a`, `*_`, `+env`, `$?`, `foo{2}*` — a `*`, `+`, `?` or `{n,m}` with no
 * repeatable atom before it. And the same territory one step over: `a{2}?`,
 * `[^abc]{2}?` — two duplication symbols in a row. POSIX ERE leaves BOTH
 * UNDEFINED (`{ }` is "undefined" for a leading duplication symbol, and
 * "undefined" for multiple adjacent ones), so every implementation picked a
 * reading and they are not the same reading:
 *
 *   nothing to duplicate — `{2}a`, `*_`, `+env`, `$?`
 *     BSD grep 2.6.0-FreeBSD   exit 2, "repetition-operator operand invalid"
 *     ugrep 7.8.4              exit 2, "empty (sub)expression"
 *     GNU grep 3.8 (glibc)     COMPILES, warns `{...} at start of expression`
 *                              for the brace form, treats the operator as a
 *                              LITERAL
 *     V8                       throws — `translateEre` refuses
 *
 *   adjacent — `a{2}?` against `0`
 *     BSD grep                 rc 1, no match: the `?` does not make the
 *                              braced atom optional
 *     GNU grep                 rc 0, match: it reads `(a{2})?`, which is
 *                              satisfied by the empty string, so it matches
 *                              EVERY line
 *     V8                       `{2}?` is the LAZY form — same match/no-match
 *                              answer as BSD, different only in what a
 *                              capture would take, and nothing here captures
 *
 * Measured 2026-09-02 on Darwin (BSD grep 2.6.0-FreeBSD) and Debian bookworm
 * (GNU grep 3.8), over every member this corpus generates, subject `zz`: BSD
 * exits 2 on all 333 of the first kind; GNU exits 2 on NONE of them (91 rc 0,
 * 242 rc 1). The second kind is why this class is defined over ADJACENCY and
 * not just over "nothing to repeat" — it was found by running the fixed test
 * on glibc, where `[^abc]{2}?` against `0` is the one pair that still parted.
 *
 * THE RESOLUTION IS D-0090's ONE-DIALECT PRINCIPLE, EXTENDED (RULINGS.md
 * D-0090 §2, amended). The ratified dialect is BSD-compatible, C-locale, and
 * it is ratified EVERYWHERE — so:
 *
 *   - on a BSD-family host the oracle still applies to the whole class, and
 *     these patterns go through the ordinary comparison below with nothing
 *     weakened. That is the assertion that keeps the ratified dialect honest:
 *     it is compared against the implementation it is named after.
 *   - on a glibc host the disagreement is EXPECTED and is counted rather than
 *     failed, exactly as `platformDependent` already counts two greps that
 *     part on one box — widened to two libcs on two boxes.
 *
 * It is NOT a wall-semantics change, and that distinction is the point.
 * `ere.ts` refused the first kind and lazily-matched the second before this
 * classification existed and does the same after; what changed is that the
 * TEST no longer asks a glibc box to confirm a BSD box's answer. A
 * `project-walls.conf` rule carrying one of these is skipped-and-named, or
 * matched, identically on every machine — which is the whole reason to ratify
 * a dialect. The alternative is a repo whose active rule set depends on which
 * grep the box happens to have.
 */
function adjacentQuantifier(p: string): boolean {
  let repeatable = false;
  for (let i = 0; i < p.length;) {
    const ch = p[i]!;
    if (ch === '\\') { repeatable = true; i += 2; continue; }
    if (ch === '[') {
      // A bracket expression, with POSIX's two positional literals (`^` first,
      // `]` immediately after) and `[: :]` / `[. .]` / `[= =]` inside it.
      let j = i + 1;
      if (p[j] === '^') j += 1;
      if (p[j] === ']') j += 1;
      while (j < p.length && p[j] !== ']') {
        const nxt = p[j + 1];
        if (p[j] === '[' && (nxt === ':' || nxt === '.' || nxt === '=')) {
          const close = p.indexOf(nxt + ']', j + 2);
          if (close === -1) { j = p.length; break; }
          j = close + 2;
          continue;
        }
        j += 1;
      }
      repeatable = true;
      i = j + 1;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      if (!repeatable) return true;
      repeatable = false;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = p.indexOf('}', i);
      // An unclosed `{` is an ORDINARY CHARACTER in ERE, not a quantifier.
      if (close === -1) { repeatable = true; i += 1; continue; }
      if (!repeatable) return true;
      repeatable = false;
      i = close + 1;
      continue;
    }
    if (ch === '(' || ch === '|' || ch === '^' || ch === '$') { repeatable = false; i += 1; continue; }
    repeatable = true;
    i += 1;
  }
  return false;
}

/**
 * IS THIS HOST THE RATIFIED DIALECT? MEASURED, NOT READ OFF A BANNER.
 *
 * The question is behavioural, so it is asked behaviourally: does every grep
 * on this box REFUSE a leading `{n}` at rc 2? That is the defining property of
 * the BSD-compatible reading, and it is the one the class turns on. Parsing
 * `--version` instead would answer a narrower question and get it wrong: ugrep
 * calls itself neither "BSD grep" nor "GNU grep" and refuses the construct
 * exactly as BSD does, so a banner test would classify a BSD-compatible box as
 * unknown and quietly stop comparing 470 pairs on it. `grepFamily` stays for
 * NAMING the divergence in the report below, which is what a banner is for.
 *
 * Measured on this checkout, Darwin with two BSD greps: HOST_IS_BSD true,
 * dialectDivergence 0, compared 1536, bothRejected 464 — nothing set aside.
 */
const HOST_IS_BSD = GREPS.length > 0 && GREPS.every((g) => grepE(g, '{2}', 'zz').rc === 2);

describe('the glibc/GNU dialect divergence, named rather than averaged away', () => {
  it('the ratified dialect refuses a duplication symbol with nothing to duplicate', () => {
    for (const p of ['{2}', '{2}a', '{1,3}b+', '*_', '+env', '?rm', '$?', 'foo{2}*', '.++', '$??$']) {
      expect(translateEre(p).ok, `${JSON.stringify(p)} must not translate`).toBe(false);
      expect(ereMatches(p, 'zz'), `${JSON.stringify(p)} must not match`).toBe(false);
      expect(adjacentQuantifier(p), `${JSON.stringify(p)} is in the named class`).toBe(true);
    }
  });

  it('and it reads ADJACENT duplication symbols the way BSD does, not the way GNU does', () => {
    // `a{2}?` against `0`: BSD rc 1, GNU rc 0. The port answers BSD's.
    for (const p of ['a{2}?', '[^abc]{2}?', '[a-z]??', 'a*?']) {
      expect(adjacentQuantifier(p), `${JSON.stringify(p)} is in the named class`).toBe(true);
    }
    expect(ereMatches('a{2}?', '0'), 'a{2}? does not match a line with no `aa` in it').toBe(false);
    expect(ereMatches('[^abc]{2}?', '0'), 'one character is not two').toBe(false);
    expect(ereMatches('a{2}?', 'xaay'), '...and it still matches when the two ARE there').toBe(true);
  });

  it('does not swallow the ordinary patterns beside it', () => {
    for (const p of ['a{2}', 'a{1,3}b', 'a*', 'a+', 'a?', '(a|b){2}', 'a{unclosed', '[abc]+x']) {
      expect(adjacentQuantifier(p), `${JSON.stringify(p)} is NOT in the class`).toBe(false);
      expect(translateEre(p).ok, `${JSON.stringify(p)} translates`).toBe(true);
    }
  });

  it('says which side of the divergence THIS box is on, and measures it', () => {
    // The live half of the comment above. Whichever family answers here, the
    // translator's answer is the same one — that is what "ratified" means.
    const bin = GREPS[0]!;
    const fam = grepFamily(bin);
    if (fam === 'GNU') {
      expect(grepE(bin, '{2}', 'zz').rc, 'GNU compiles a leading `{n}` as a literal').not.toBe(2);
      expect(grepE(bin, 'a{2}?', '0').rc, 'GNU reads `a{2}?` as optional, so it matches every line').toBe(0);
    } else if (fam === 'BSD') {
      expect(grepE(bin, '{2}', 'zz').rc, 'BSD will not compile a leading `{n}`').toBe(2);
      expect(grepE(bin, 'a{2}?', '0').rc, 'BSD does not make the braced atom optional').toBe(1);
    }
    expect(ereMatches('{2}', 'zz'), 'the ratified dialect answers false on every host').toBe(false);
    expect(ereMatches('a{2}?', '0'), 'and BSD-compatibly on the adjacent form').toBe(false);
  });
});

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

describe('property: the translator agrees with every grep that agrees with itself', () => {
  it('2000 generated pattern/subject pairs', () => {
    const rand = mulberry32(0xe2e2);
    let compared = 0;
    let platformDependent = 0;
    let bothRejected = 0;
    let dialectDivergence = 0;
    const bad: string[] = [];
    const classMembers = new Set<string>();

    for (let n = 0; n < 2000 && bad.length < 5; n += 1) {
      const parts = 1 + Math.floor(rand() * 4);
      let p = '';
      for (let k = 0; k < parts; k += 1) p += ATOMS[Math.floor(rand() * ATOMS.length)]!;
      const s = SUBJECTS[Math.floor(rand() * SUBJECTS.length)]!;

      // THE NAMED CLASS IS DECIDED BY THE PATTERN, BEFORE ANY grep IS ASKED,
      // so a glibc box and a BSD box reach the same verdict about the same
      // pattern. Deciding it from the host's ANSWERS instead is what made this
      // run green here and red on Ubuntu: on this box the two greps part and
      // the pair fell into `platformDependent`, and on Ubuntu /bin and
      // /usr/bin are the same GNU binary, so they AGREE at rc 0 and the pair
      // fell into `compared` against a translator that reads it BSD's way.
      // The classification has to be a property of the dialect, not of the box.
      //
      // ON A BSD HOST NOTHING IS SET ASIDE: the host IS the ratified dialect
      // there, so the class goes through the comparison below like every other
      // pattern and this file keeps asserting the thing it is for.
      if (!HOST_IS_BSD && adjacentQuantifier(p)) {
        dialectDivergence += 1;
        classMembers.add(p);
        continue;
      }

      const rcs = GREPS.map((g) => grepE(g, p, s).rc);
      if (new Set(rcs).size !== 1) { platformDependent += 1; continue; }
      const rc = rcs[0]!;
      const t = translateEre(p);

      if (rc === 2) {
        // Every grep refused to compile it. The translator must refuse too,
        // or it would activate a rule bash silently skipped — the direction
        // that changes which rules a repo has.
        bothRejected += 1;
        if (t.ok) bad.push(`grep rc=2 but the translator compiled it: ${JSON.stringify(p)}`);
        continue;
      }
      compared += 1;
      const got = t.ok ? matchesAnyLine(t.regex, s) : false;
      if (got !== (rc === 0)) {
        bad.push(`${JSON.stringify(p)} vs ${JSON.stringify(s)}: grep=${rc === 0}, ts=${got}`);
      }
    }

    expect(bad.join('\n  '), `${bad.length} divergence(s)`).toBe('');
    // The run reports its own shape, so a change in the platform split is
    // visible rather than averaged away.
    expect(compared, 'the property run compared almost nothing').toBeGreaterThan(500);
    expect(compared + platformDependent + bothRejected + dialectDivergence).toBe(2000);

    // THE SET-ASIDE IS BOUNDED AND IT IS REPORTED, because a bucket nobody
    // counts is a bucket a real divergence can hide in. On a BSD host it must
    // be EMPTY — every class member was compared against the dialect the port
    // is named after. On a glibc host it must be a minority of the run: the
    // corpus generates 339 distinct members, and if that ever became most of
    // the run the property test would have stopped testing anything.
    if (HOST_IS_BSD) {
      expect(dialectDivergence, 'a BSD host sets nothing aside').toBe(0);
    } else {
      expect(dialectDivergence, 'the whole run went into the divergence bucket').toBeLessThan(1000);
      expect(classMembers.size, 'the named class is empty — the corpus stopped generating it').toBeGreaterThan(100);
      // EVERY MEMBER IS ONE OF THE TWO NAMED KINDS, and which one is a fact
      // about the TRANSLATOR rather than about the predicate that selected it.
      // Re-asserting `adjacentQuantifier(p)` here would be a tautology —
      // membership was defined by it — and a tautology is exactly the shape a
      // widened predicate would hide behind. So each member must either be
      // REFUSED (the nothing-to-duplicate kind) or be an ADJACENT form the
      // translator reads lazily; a member that is neither means the predicate
      // has started swallowing ordinary patterns, and names itself here.
      let refused = 0;
      let lazyRead = 0;
      for (const p of classMembers) {
        if (!translateEre(p).ok) { refused += 1; continue; }
        if (/[*+?}]\?/.test(p)) { lazyRead += 1; continue; }
        bad.push(`${JSON.stringify(p)} is in the class but is neither refused nor an adjacent lazy form`);
      }
      expect(bad.join('\n  '), 'a class member that is neither kind').toBe('');
      expect(refused, 'the nothing-to-duplicate kind vanished from the corpus').toBeGreaterThan(100);
      expect(lazyRead, 'the adjacent kind vanished from the corpus').toBeGreaterThan(0);
    }
  }, 300_000);
});
