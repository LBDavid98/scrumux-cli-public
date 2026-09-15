/**
 * POSIX ERE → JavaScript RegExp. The #1 named silent-divergence risk in this
 * codebase.
 *
 * WHY A SINGLE CANONICAL DIALECT, NOT "WHATEVER grep SAYS". Every wall
 * pattern a repo writes in `.claude/project-walls.conf` is POSIX ERE syntax
 * -- a format historically matched by whichever `grep -Eqi` happened to be on
 * PATH, and real greps disagree with each other. Measured 2026-08-31,
 * comparing `/usr/bin/grep` (BSD) with the `grep` on PATH (ugrep 7.8.4), same
 * flags, same inputs:
 *
 *   pattern    subject   BSD    ugrep
 *   \b         ab        match  no match
 *   (a)\1      aa        match  WILL NOT COMPILE (rc 2)
 *   a{         a{        match  WILL NOT COMPILE (rc 2)
 *
 * That last column is not cosmetic: a grep that refuses to compile a pattern
 * makes that rule INACTIVE, and on a `refuse` line an inactive rule is the
 * fail-open direction. Two machines running the SAME `.claude/
 * project-walls.conf` could end up with different rules active depending on
 * which grep happened to be installed.
 *
 * RATIFIED AS BSD-COMPAT (D-0090). This translator is now the ONLY evaluator
 * -- there is no grep in the loop at all -- and it implements one documented
 * dialect everywhere, so a conf rule never activates or deactivates by
 * machine. The same ruling settles a second axis measured later: whether
 * `[[:space:]]` matches U+00A0 is LOCALE-dependent in a real grep (BSD says
 * no under `LC_ALL=C` and YES under a UTF-8 locale). `POSIX_CLASSES` below
 * implements the C-locale, ASCII definition, because it is the only one that
 * does not change with the environment the hook happens to run in.
 *
 * SO THE TRANSLATOR PICKS, AND SAYS SO. Where real greps disagree this
 * module reproduces the BSD answer — `\b` is a word boundary, a backreference
 * compiles, a dangling `{` is a literal — because in all three that is the
 * direction where the repo's rule STAYS ACTIVE rather than being silently
 * skipped, and an active refuse rule is the safe side of a fail-open/
 * fail-closed choice.
 *
 * WHAT DOES NOT MATTER HERE, stated so nobody chases it. POSIX is
 * leftmost-longest and JavaScript is leftmost-first, and ERE has no lazy
 * quantifiers while `a*?` in JS is lazy. Both change WHICH substring matches.
 * Every caller in the wall layer asks a boolean question -- does anything
 * match -- so neither can change an answer. If a future caller ever needs
 * the matched text, this paragraph stops being true and the difference
 * becomes real.
 *
 * FAIL-CLOSED PER OQ-8, ruled in D-0085: an ERE this module cannot faithfully
 * translate FAILS CLOSED on a `refuse` line (the rule refuses) and is
 * SKIPPED-AND-NAMED on an `allow` line (the exemption does not apply). That
 * is the same "when in doubt, refuse" asymmetry `allows`/`refuses` apply one
 * layer down in conf.ts; this module only reports which case it is.
 */

export type EreResult =
  | { ok: true; regex: RegExp }
  /** Not a valid ERE at all — a POSIX grep would reject it too. */
  | { ok: false; kind: 'invalid'; reason: string }
  /** Valid ERE, but this translator cannot express it as a JS regex. */
  | { ok: false; kind: 'untranslatable'; reason: string };

/**
 * POSIX bracket expressions. JS has no `[:alpha:]`, so the contents of every
 * character class are rewritten. Ranges are ASCII/POSIX-locale definitions,
 * which is what `grep` in the C locale uses and what every wall pattern in
 * this repo assumes.
 */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
  word: '0-9A-Za-z_',
};

/**
 * Rewrite one bracket expression's body, starting at the `[`.
 * Returns the JS body and the index just past the closing `]`.
 *
 * TWO POSIX RULES JS DOES NOT SHARE, and both are silent when missed:
 *   `[]abc]`  a `]` FIRST in a class is a literal `]`. JS reads it as an
 *             empty class followed by `abc]`.
 *   `[^]abc]` the same after a negation.
 */
function bracket(src: string, start: number): { body: string; next: number } | null {
  let i = start + 1;
  let out = '[';
  if (src[i] === '^') { out += '^'; i += 1; }
  if (src[i] === ']') { out += '\\]'; i += 1; }
  for (; i < src.length; i += 1) {
    const c = src[i]!;
    if (c === ']') return { body: out + ']', next: i + 1 };
    if (c === '[' && src[i + 1] === ':') {
      const end = src.indexOf(':]', i + 2);
      if (end < 0) { out += '\\['; continue; }
      const name = src.slice(i + 2, end);
      const cls = POSIX_CLASSES[name];
      if (cls === undefined) return null;      // [:nosuch:] — invalid ERE
      out += cls;
      i = end + 1;
      continue;
    }
    // JS-significant inside a class and literal in POSIX unless escaped.
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null;        // a trailing backslash
      out += '\\' + n;
      i += 1;
      continue;
    }
    out += c;
  }
  return null;                                  // unterminated `[`
}

/**
 * @param pattern  a POSIX ERE as written in project-walls.conf.
 * @param flags    defaults to `i`, because every wall matcher uses
 *                 `grep -Eqi`. NOT `m`, and not `s`: line-orientation is
 *                 modelled by splitting the subject into lines in
 *                 `matchesAnyLine` below, which is what grep actually does.
 *                 See that function for why the flag is the wrong tool.
 */
export function translateEre(pattern: string, flags = 'i'): EreResult {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '[') {
      const b = bracket(pattern, i);
      if (b === null) {
        return { ok: false, kind: 'invalid', reason: `unterminated or unknown bracket expression at offset ${i}` };
      }
      out += b.body;
      i = b.next;
      continue;
    }
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === undefined) {
        return { ok: false, kind: 'invalid', reason: 'a trailing backslash escapes nothing' };
      }
      out += '\\' + n;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(out, flags);
  } catch (e) {
    // JS rejected it. Two different facts wear this one face, and they need
    // different answers, so they are separated by asking grep-shaped
    // questions of the pattern rather than by guessing.
    const msg = e instanceof Error ? e.message : String(e);
    return looksLikeValidEre(pattern)
      ? { ok: false, kind: 'untranslatable', reason: `valid ERE that JavaScript will not compile: ${msg}` }
      : { ok: false, kind: 'invalid', reason: msg };
  }
  return { ok: true, regex };
}

/**
 * A conservative structural check for "grep would have accepted this".
 *
 * It is deliberately NOT a second regex engine. It answers one question: is
 * this pattern's failure a JavaScript limitation, or is the pattern simply
 * broken? Getting that wrong in the "broken" direction only loses a named
 * skip message; getting it wrong in the "JS limitation" direction makes a
 * refuse line fail closed, which is loud. Both are recoverable and neither is
 * silent, which is why a heuristic is acceptable here and nowhere else in
 * this module.
 */
function looksLikeValidEre(pattern: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\') { i += 1; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') depth += 1;
    if (c === ')') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0 && !inClass;
}

/**
 * GREP IS LINE-ORIENTED, AND THE `m` FLAG IS NOT THE SAME THING.
 *
 * `grep -q` reads its input as a sequence of LINES and asks whether any one of
 * them matches. The newline is a separator; it is never part of a line and no
 * pattern can ever match it. A JavaScript `RegExp` with the `m` flag fixes
 * `^`/`$` but leaves the newline IN the subject, and three divergence classes
 * fall straight out of that — every one of them found by the property run
 * against real greps, not by reading a manual:
 *
 *   [[:space:]]  vs "a\nb"   grep: no match. The class contains \n, but no
 *                            LINE contains one. With `m`, JS matched.
 *   $$           vs ""        grep: no match. Empty input has ZERO lines, so
 *                            nothing can match, not even an empty pattern.
 *                            JS tested the empty string and matched.
 *   $0*          vs ""        the same, one shape along.
 *
 * So the subject is split the way grep splits it. `.` then cannot cross a
 * newline for free, `^`/`$` anchor per line for free, and an empty subject
 * has nothing to match for free — three behaviours reproduced by modelling
 * the mechanism instead of three patches to the flags.
 */
export function toLines(subject: string): string[] {
  if (subject === '') return [];
  const lines = subject.split('\n');
  // A trailing newline terminates the last line; it does not add an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Any line matches — `grep -q`'s question, asked exactly. */
export function matchesAnyLine(regex: RegExp, subject: string): boolean {
  for (const line of toLines(subject)) if (regex.test(line)) return true;
  return false;
}

/**
 * Compile a POSIX ERE that is COMPILED INTO THE PRODUCT, not supplied by a
 * repo. Throws if it will not translate.
 *
 * Throwing is right here and wrong for a conf line, and the difference is who
 * wrote the pattern. A `project-walls.conf` rule is a repo's input: an
 * untranslatable one is skipped-and-named on an allow line and fails closed on
 * a refuse line (OQ-8, D-0085), because a person's typo must not take a wall
 * down. A pattern in THIS repository's source is ours, and one that does not
 * compile is a build defect that should stop the build rather than silently
 * disable a wall predicate.
 *
 * Every wall predicate goes through here, never a hand-rolled `new
 * RegExp(...)`. A hand-translated `[[:space:]]` written two different ways
 * inside one regex -- `[ \t]` for one occurrence and `\s` for a negated one
 * -- is narrower in one place and WIDER in the other; that exact mistake
 * once cost the secret wall a shell-read it should have refused.
 * `POSIX_CLASSES` above defines `[[:space:]]` once, and nowhere else.
 */
export function ereOrThrow(pattern: string, flags = ''): RegExp {
  const t = translateEre(pattern, flags);
  if (!t.ok) {
    throw new Error(`ere: a pattern compiled into this build will not translate (${t.reason}): ${pattern}`);
  }
  return t.regex;
}

/** Does this pattern match, with the wall layer's flags and grep's line model? */
export function ereMatches(pattern: string, subject: string): boolean {
  const t = translateEre(pattern);
  return t.ok ? matchesAnyLine(t.regex, subject) : false;
}
