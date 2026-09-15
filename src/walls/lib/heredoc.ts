/**
 * Heredoc scope for the POSIX line scanner in `block-upstream-edit` (SX-021).
 *
 * `scanCommand` reads every token of a heredoc BODY as program text (I-0121:
 * a body can write files through an API no redirect or mutator rule sees).
 * It used to enter that mode on any line containing `<<` and never leave it,
 * so a later, unrelated argument in the same Bash call — `--verified "(run via
 * .claude/scripts/scrumux task verify T-0017)"` after a `--did "$(cat <<'EOF'
 * … EOF)"` — was read as body and refused as a write. A real shell ends the
 * body at its terminator line; this module gives the scanner the same scope.
 *
 * PRECISION OVER CONVENIENCE, in one direction only. Closing a body too early
 * would hand the rest of it to the command scanner, where
 * `open('.claude/dist/x','w')` is a harmless command word — an evasion. So a
 * body closes only on the line a shell closes it on: the delimiter alone
 * (`<<`), or after leading TABS (`<<-`). When the operator's word cannot be
 * read, the body runs to the end of the command: the old latch, a false
 * positive at worst, never a hole.
 *
 * Dependencies: none (pure string functions).
 */

/** One heredoc opened on a line: its terminator word, and whether `<<-` strips leading tabs. `word` is null when it could not be read. */
export interface HeredocOpen { word: string | null; stripTabs: boolean }

// `<<` not part of a `<<<` here-string (which has no body), then an optional
// `-`, optional blanks, and the word: 'quoted', "quoted", \escaped or bare.
const OPEN = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"`]+))?/g;

/**
 * The heredocs a line opens, in the order their bodies follow it.
 *
 * Dependencies: none.
 * @param line one line of the command text (no newline).
 */
export function heredocOpens(line: string): HeredocOpen[] {
  const out: HeredocOpen[] = [];
  for (const m of line.matchAll(OPEN)) {
    const word = m[2] ?? m[3] ?? m[4] ?? null;
    out.push({ word: word === '' ? null : word, stripTabs: m[1] === '-' });
  }
  return out;
}

/**
 * True when `line` terminates the body of `open`, exactly as a POSIX shell
 * decides it: the whole line equals the word (after leading tabs for `<<-`).
 * A trailing CR is ignored so CRLF text reads the same. An unreadable word
 * never terminates.
 *
 * Dependencies: none.
 */
export function closesHeredoc(line: string, open: HeredocOpen): boolean {
  if (open.word === null) return false;
  let l = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (open.stripTabs) l = l.replace(/^\t+/, '');
  return l === open.word;
}
