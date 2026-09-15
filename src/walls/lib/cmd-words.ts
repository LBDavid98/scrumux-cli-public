/**
 * A character state machine that tokenizes a shell command line into its
 * command words — the highest-risk module in the walls, because every wall
 * defect this project has paid for was the same shape: reasoning about a
 * command string without respecting its structure.
 *
 * WHAT IT ANSWERS, and why the question is shaped this way. Three walls decide
 * WHAT TO LOOK AT from this function's output. A `--rationale "we refuse rm -rf
 * outside temp"` yielded a bogus `rm` command word and tripped the destructive
 * wall on prose that ran nothing (I-0001); a `--file "config.json | ... writes
 * .env"` yielded a `grep` and opened the secret wall on a governance record
 * that read nothing. So the tokenizer asks WHAT RUNS each segment before any
 * wall asks what is in it, and a separator inside quotes is data, not
 * structure.
 *
 * IT IS A STATE MACHINE, NOT A REGEX, because this needs a character scan
 * with quote state that a regex cannot express cleanly: one variable for one
 * variable — `sq`, `dq`, `expect`, `skipargs`, `tok`.
 *
 * TESTED AGAINST A FROZEN ORACLE. `test/oracle/cmd-words.awk.sh` is the
 * original awk tokenizer, kept permanently as the fixed reference this state
 * machine is checked against, on a golden corpus plus 10,000 generated cases
 * per run. A mismatch there is a regression, not a judgment call.
 *
 * THE INVARIANT THAT MATTERS MOST: over-report, never under-report.
 * Heredoc bodies are yielded as if their lines were commands. Wrappers are
 * stepped over so the real program surfaces. Both make a wall look at MORE,
 * never less (P-27). A "more accurate" tokenizer that stops yielding heredoc
 * bodies WEAKENS every wall that sources this and re-opens I-0121.
 *
 * TWO KNOWN WARTS ARE REPRODUCED ON PURPOSE, not inherited by accident:
 *
 *  - `nice 7z x archive.7z` yields `x`, not `7z`. The prefixer's numeric-value
 *    skip matches `^[0-9]+[a-zA-Z]?$`, `7z` fits, so it is swallowed AND the
 *    next token is promoted into command position. That is worse than a
 *    missing word — it is a wrong one — and it is the one case where the
 *    "over-report only strengthens a wall" claim does not hold. Pinned in
 *    the oracle corpus as OQ-W2. Not fixed here: widening a wall is a
 *    ruling, not a refactor.
 *  - Quote state carries ACROSS an embedded newline (`sq`/`dq` persist across
 *    records), while `expect` and `skipargs` reset at every newline. So a
 *    multi-line quoted argument stays data end to end. Pinned in the corpus
 *    as OQ-W5.
 */

/**
 * Exec-wrappers and non-mutating prefixers, stepped over so the real program
 * surfaces. Two kinds in one list:
 *
 *   env sudo time nohup exec command   run a command directly
 *   nice ionice timeout xargs stdbuf setsid flock chrt doas
 *                                      take their OWN options and values
 *                                      first (`nice -n 10 rm`), so the flag
 *                                      group is skipped too
 *   busybox toybox                     MULTIPLEXERS — the real program is
 *                                      their first argument (D-0085)
 */
const WRAPPERS = new Set([
  'env', 'sudo', 'time', 'nohup', 'exec', 'command',
  'nice', 'ionice', 'timeout', 'xargs', 'stdbuf', 'setsid', 'flock', 'chrt', 'doas',
  'busybox', 'toybox',
]);

/** A prefixer's own value: a bare number, optionally with one unit letter. */
const PREFIXER_VALUE = /^[0-9]+[a-zA-Z]?$/;

/** flush_tok's strip set: `"`, `'`, backtick, parens, angle brackets. */
const STRIP = /["'`()<>]/g;

export function cmdWords(command: string): string[] {
  const out: string[] = [];

  // The input splits into RECORDS at every newline, one main-loop pass per
  // record. `sq`/`dq` persist across records; `expect` and `skipargs` reset
  // at the end of each one. That split is not cosmetic: it is what makes a
  // heredoc body scan as commands while a multi-line quoted argument stays
  // data.
  //
  // A trailing newline does not produce a final empty record, and an empty
  // input produces NO records at all -- which is why `''` yields nothing
  // rather than one empty pass.
  const records = command === '' ? [] : command.split('\n');
  if (records.length > 1 && records[records.length - 1] === '') records.pop();

  let sq = false;
  let dq = false;

  for (const rec of records) {
    let expect = true;
    let skipargs = false;
    let tok = '';

    const flush = (): void => {
      if (tok === '') return;
      if (expect) {
        // A VAR=value prefix: the real command is still ahead, so `expect`
        // STAYS set and any number of assignments are walked past.
        if (tok.includes('=')) { tok = ''; return; }
        if (WRAPPERS.has(tok)) { tok = ''; skipargs = true; return; }
        // Inside a prefixer's flag group, an option or a bare numeric value
        // belongs to the prefixer. See the `7z` wart in the header: this is
        // the line that swallows it.
        if (skipargs && (tok.startsWith('-') || PREFIXER_VALUE.test(tok))) { tok = ''; return; }
        skipargs = false;
        // basename: `.claude/scripts/scrumux` reports as `scrumux`. Greedy
        // to the LAST slash.
        const slash = tok.lastIndexOf('/');
        if (slash >= 0) tok = tok.slice(slash + 1);
        tok = tok.replace(STRIP, '');
        if (tok !== '') out.push(tok);
        expect = false;
      }
      tok = '';
    };

    for (let i = 0; i < rec.length; i += 1) {
      const c = rec[i]!;
      if (c === "'" && !dq) { sq = !sq; continue; }
      if (c === '"' && !sq) { dq = !dq; continue; }
      if (sq || dq) { tok += c; continue; }        // inside quotes: data
      if (c === ' ' || c === '\t') { flush(); continue; }
      if (c === ';') { flush(); expect = true; skipargs = false; continue; }
      if (c === '|') {
        if (rec[i + 1] === '|') i += 1;
        flush(); expect = true; skipargs = false; continue;
      }
      if (c === '&') {
        if (rec[i + 1] === '&') i += 1;
        flush(); expect = true; skipargs = false; continue;
      }
      tok += c;
    }
    flush();
    // A newline ends a command. `sq`/`dq` deliberately survive it.
  }

  return out;
}
