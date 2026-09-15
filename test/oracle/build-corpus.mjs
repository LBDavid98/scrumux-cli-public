#!/usr/bin/env node
/**
 * Build the frozen tokenizer corpus: every command string the hook suites
 * actually assert on, plus the hand cases the suites do not cover, each
 * paired with what the AWK ORACLE answers for it.
 *
 *   node test/oracle/build-corpus.mjs        (writes test/oracle/cmd-words.golden.json)
 *
 * DERIVED, NEVER HAND-LISTED. The suite half is harvested out of
 * `tests/hook-*.sh` and `tests/project-walls-tests.sh` by pulling every
 * `"command": "..."` and `"file_path": "..."` literal out of the JSON payloads
 * they feed the hooks. That is the same discipline SURFACE_PROBES uses: a case
 * somebody adds to a suite next month joins this corpus by being in the suite,
 * not by anyone remembering to copy it here. 2,000+ assertions of real,
 * argued-over behaviour become the tokenizer's parity spec for free.
 *
 * The hand half is short and each case says what it is for. Three of them
 * exist because the module inspection (docs/port/modules/walls-lib.md) raised
 * them as open questions and nothing in any suite covered them: quote state
 * across an embedded newline (OQ-W5), the `7z`-after-a-wrapper swallow
 * (OQ-W2), and heredoc bodies yielded as commands (P-27 item 1).
 *
 * The golden file records the ORACLE's answer, whatever it is. It is not a
 * statement that the answer is right — for `7z` it is measurably wrong. It is
 * a statement that this is what bash does, which is the only thing a port is
 * allowed to reproduce.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const ORACLE = join(HERE, 'cmd-words.awk.sh');

/** Ask the frozen awk. One subprocess per case; this runs at build time only. */
export function oracle(input) {
  const out = execFileSync('sh', [ORACLE], { input, encoding: 'utf8' });
  return out.split('\n').filter((l) => l !== '');
}

/** Every JSON string literal fed to a hook as a command or a path. */
function harvest() {
  const found = new Set();
  const dir = join(ROOT, 'tests');
  for (const f of readdirSync(dir).sort()) {
    if (!/^(hook-|project-walls|walls-jq|upstream-wall)/.test(f)) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    // "command":"..." and "file_path":"..." inside the single-quoted shell
    // payloads. The payloads are shell-single-quoted, so a JSON \" survives as
    // \" and JSON.parse of the quoted span gives the real string back.
    for (const m of src.matchAll(/"(?:command|file_path|old_string|new_string)"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      try {
        const v = JSON.parse(m[1]);
        if (typeof v === 'string' && v !== '') found.add(v);
      } catch { /* a payload built by shell interpolation; skip it */ }
    }
  }
  return [...found];
}

/**
 * Cases no suite covers. Each names why it is here; a case with no reason is
 * a case nobody can justify keeping.
 */
const HAND = [
  ['', 'the empty command — the hooks exit 0 on it before the tokenizer runs, but the tokenizer must not throw'],
  ['   ', 'whitespace only'],
  ['rm', 'a bare command word, no arguments'],
  ['/usr/bin/rm -rf /x', 'basename: a path-qualified program reports as its basename'],
  ['./.claude/scripts/scrumux task new', 'the basename rule on the harness CLI itself'],
  ['FOO=1 BAR=2 rm -rf /x', 'VAR=value prefixes: expect stays set past any number of them'],
  ['env FOO=1 rm -rf /x', 'a wrapper AND an assignment prefix in the same segment'],
  ['nice -n 10 rm -rf /x', 'the prefixer flag group is skipped so the real program surfaces (P-27 item 2)'],
  ['timeout 30m curl https://api.openai.com', 'a duration-shaped prefixer value is skipped'],
  ['busybox cat .env', 'the busybox multiplexer step-over (D-0085)'],
  ['toybox head -c 20 .env', 'the toybox multiplexer step-over'],
  ['nice 7z x archive.7z', 'OQ-W2: MEASURED — the wrapper flag-group skip swallows 7z and promotes `x` to command position. Wrong, and reproduced deliberately: it is what bash does'],
  ['7z x archive.7z', 'the same program with no wrapper, which does surface — the contrast that makes OQ-W2 legible'],
  ['cat <<EOF\nrm -rf /tmp\nEOF', 'P-27 item 1: heredoc body lines are yielded as commands. Over-reporting, the safe direction'],
  ['scrumux decide new --rationale "line one\nline two; rm -rf /" --by User',
    'OQ-W5, MEASURED: quote state carries ACROSS an embedded newline (sq/dq live in BEGIN), so the `rm` inside a multi-line quoted argument stays data. No suite covered this'],
  ['scrumux task order T-1 --file "a.json | writes .env" --command "grep -o sk-x nb; grep -i host nb"',
    'I-0001: separators inside quotes are data. This exact shape opened the secret wall on prose'],
  ["scrumux issue new --summary 'it broke; rm -rf happened'", 'single quotes, same property'],
  ['echo "unterminated', 'an unterminated double quote — everything after it is data to end of input'],
  ["echo 'unterminated", 'an unterminated single quote'],
  ['a && b || c | d ; e & f', 'every separator, one per segment'],
  ['a|b', 'a single pipe with no spaces'],
  ['a||b', 'a logical-or, which must not yield an empty segment'],
  ['a&&b', 'a logical-and, likewise'],
  ['a & b', 'a bare background ampersand'],
  ['(cat .env)', 'the paren strip in flush_tok'],
  ['`cat .env`', 'backtick strip'],
  ['cat < .env', 'a shell-level read: the tokenizer sees `cat`, walls_shell_reads sees the redirect'],
  ['read K < .env', 'I-0142: the shell opens it and `read` is not in the reader list'],
  ['X=$(<.env)', 'I-0142: a slurp with no program at all'],
  ['exec 3<> /dev/tcp/host/443', 'the shell as a network client'],
  ['sudo   nice   -n   5   rm   -rf   /x', 'runs of whitespace between every token'],
  ['\trm -rf /x', 'a leading tab'],
  ['rm -rf /x\n', 'a trailing newline'],
  ['\n\nrm -rf /x', 'leading blank lines'],
  ['café --naïve', 'non-ASCII in a command word'],
  ['emoji 🙂 arg', 'an astral-plane character mid-string'],
  ['nice -n 10', 'a prefixer with a flag group and NO command after it'],
  ['env', 'a bare wrapper with nothing after it'],
  ['FOO=1', 'a bare assignment with nothing after it'],
];

const cases = [];
for (const input of harvest()) {
  cases.push({ input, from: 'suite', words: oracle(input) });
}
for (const [input, why] of HAND) {
  if (cases.some((c) => c.input === input)) continue;
  cases.push({ input, from: 'hand', why, words: oracle(input) });
}
cases.sort((a, b) => (a.input < b.input ? -1 : a.input > b.input ? 1 : 0));

writeFileSync(join(HERE, 'cmd-words.golden.json'), JSON.stringify({
  '//': 'GENERATED by test/oracle/build-corpus.mjs from the frozen awk. Records what bash DOES, not what is right.',
  oracle: 'test/oracle/cmd-words.awk.sh',
  counts: {
    total: cases.length,
    fromSuites: cases.filter((c) => c.from === 'suite').length,
    hand: cases.filter((c) => c.from === 'hand').length,
  },
  cases,
}, null, 2) + '\n');

console.log(`oracle corpus: ${cases.length} cases `
  + `(${cases.filter((c) => c.from === 'suite').length} harvested from the hook suites, `
  + `${cases.filter((c) => c.from === 'hand').length} hand-written) -> test/oracle/cmd-words.golden.json`);
