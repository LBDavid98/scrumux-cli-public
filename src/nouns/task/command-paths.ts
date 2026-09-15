/**
 * What a verification command says about PATHS: the directories it runs in
 * and the path-shaped words it names. Two readers need it:
 *
 *   - `task lint`'s scope scan (SX-027): an order whose command runs
 *     `uv run --directory agents pytest tests/test_fast.py` may call that file
 *     `tests/test_fast.py` in prose; it is `agents/tests/test_fast.py` listed.
 *   - `task accept`'s check fingerprint (D-S045, SX-041): the files the
 *     command references, hashed so a later change to the check itself shows.
 *
 * String work only, no shell parse: a word is split at blanks and shell
 * punctuation and stripped of quotes. A miss costs one advisory line or one
 * unhashed file; nothing here refuses.
 *
 * Dependencies: none (pure).
 */

/** Flags whose value is a directory the command then works in. */
const DIR_FLAGS = new Set(['--directory', '--cwd', '--prefix', '-C', '--project', '--root-dir', '--rootdir']);

/** The command split into plain words: blanks and shell operators separate, quotes are dropped. */
export function commandWords(command: string): string[] {
  return command
    .replace(/["'`]/g, ' ')
    .split(/[\s;&|()<>]+/)
    .filter((w) => w !== '');
}

/**
 * The directories the command works in, in order of mention: `cd X`,
 * `pushd X`, `--directory X` / `--directory=X`, `-C X`, `--cwd X`, `--prefix X`.
 * Normalised without a leading `./` or trailing `/`.
 *
 * Dependencies: commandWords.
 */
export function commandWorkDirs(command: string): string[] {
  const out: string[] = [];
  const words = commandWords(command);
  const add = (d: string | undefined): void => {
    if (d === undefined || d === '' || d.startsWith('-') || d.includes('$')) return;
    const n = d.replace(/^\.\//, '').replace(/\/+$/, '');
    if (n !== '' && n !== '.' && !out.includes(n)) out.push(n);
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === 'cd' || w === 'pushd' || DIR_FLAGS.has(w)) { add(words[i + 1]); continue; }
    const eq = /^(--[a-z-]+)=(.+)$/.exec(w);
    if (eq !== null && DIR_FLAGS.has(eq[1]!)) add(eq[2]);
  }
  return out;
}

/**
 * The path-shaped words of the command: a word with a `/` or a file
 * extension, or a `--flag=value` whose value is one. No flags, no `$VAR`,
 * no URLs.
 *
 * Dependencies: commandWords.
 */
export function commandPathWords(command: string): string[] {
  const out: string[] = [];
  for (const raw of commandWords(command)) {
    const eq = /^--?[A-Za-z][A-Za-z0-9-]*=(.+)$/.exec(raw);
    const w = eq !== null ? eq[1]! : raw;
    if (w.startsWith('-') || w.includes('$') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(w)) continue;
    if (!(w.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(w))) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}
