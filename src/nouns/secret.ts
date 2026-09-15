/**
 * The `secret` noun.
 *
 * THERE IS NO `scrumux secret get`, AND THAT IS THE WHOLE DESIGN (P-45).
 * Nothing here prints a value back, in prose or in JSON. `list` carries a
 * name, a byte count and an 8-hex-character sha256 prefix, which is exactly
 * enough for a human to tell WHICH secret is in place across two machines and
 * not enough to be one. The value is read only by the repo's own code, from
 * `.env`, at runtime. `set`'s success line and its `--json` payload carry the
 * same three fields and no fourth.
 *
 * THE ORDER OF THE WRITE PATH IS THE SECURITY PROPERTY, not the write itself:
 *
 *   1. REFUSE A VALUE THAT CANNOT BE STORED -- empty (it would read as
 *      "configured" and fail at the call site) or carrying a newline (`.env`
 *      is one line per name; store the PATH to a `.pem`, not its contents).
 *   2. GITIGNORE FIRST, ALWAYS. If this ordering is ever reversed there is a
 *      window in which the secret is on disk and committable, and a window is
 *      all it takes -- a value cannot be un-leaked once it is in a commit.
 *   3. REFUSE AN ALREADY-TRACKED `.env`. Tracked is WORSE than un-ignored:
 *      `.gitignore` does not apply to a file git is already following, so the
 *      write would be committed on the next `git add`.
 *   4. Only then create the file, chmod 600, drop any prior line for the name,
 *      append, chmod 600 again.
 *
 * THE VALUE MAY ARRIVE ON STDIN, AND THAT IS THE FORM AN AGENT SHOULD USE. An
 * argument is not a private channel: it lands in shell history, in the agent
 * transcript, and in the JSON every PreToolUse hook is handed -- including
 * `block-secret-reads`, whose whole job is secrets. Passing it as argv still
 * works and still prints the NOTE telling the operator to scrub it.
 *
 * PK-13 (D-0085) IS LOAD-BEARING IN EVERY MATCH IN THIS FILE. `.env` files are
 * commonly written `export NAME=value` -- tools emit it, and `source .env`
 * needs it in some shells. Every match here is `^(export[[:space:]]+)?NAME=`,
 * and `list` strips the prefix before splitting or the name renders as
 * "export NAME". A bare `^NAME=` match would leave an export-prefixed line
 * invisible to all three verbs -- and the worst case is `set`: the old line
 * would not be dropped, the new one would be appended, and THE OLD SECRET
 * VALUE WOULD SURVIVE beside the new one. Matched character for character,
 * including the detail that `list` strips the literal `export` and then
 * exactly ONE following space, so a tab-separated `export\tNAME=` keeps its
 * tab in the rendered name.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFile } from '../util/fs-predicates.js';
import type { Cli } from '../cli/envelope.js';
import type { JsonValue } from '../journal/jqformat.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';

export const VERBS = ['set', 'list', 'remove'] as const;

const VERBS_TSV = `set\tstore a secret in this repo's .env (pipe the value on stdin)
list\tnames, sizes and fingerprints — never values
remove\tdrop one name from .env
`;

const USAGE = `scrumux secret — credentials for this repo's own code, stored never printed.

  printf %s '<value>' | scrumux secret set NAME
  scrumux secret set NAME VALUE       (discouraged — see below)
  scrumux secret list
  scrumux secret remove NAME

VALUE as an argument lands in shell history, in the agent transcript and
in the JSON every PreToolUse hook receives, so pipe it on stdin instead.

.env is gitignored BEFORE the value is written, chmod 600, and the write
is refused outright if git already tracks it.

There is no \`scrumux secret get\`. Nothing prints a value back.
`;

export interface SecretRow {
  name: string;
  bytes: number;
  sha256_prefix: string;
}

/**
 * Split a `.env` the way `while IFS= read -r line` does.
 *
 * A FINAL LINE WITH NO NEWLINE IS DROPPED, because `read` returns non-zero on
 * it and the `while` body never runs. That is not a bug worth fixing on this
 * side: `secret set` always appends a terminated line, so an unterminated
 * tail is a hand edit, and this does not list it either.
 */
export function envLines(text: string): string[] {
  const parts = text.split('\n');
  parts.pop();
  return parts;
}

/** The `list` parse, extracted so it is drivable without a filesystem. */
export function parseEnv(text: string): SecretRow[] {
  const out: SecretRow[] = [];
  for (let line of envLines(text)) {
    if (line === '' || line.startsWith('#')) continue;
    // `case "$line" in export[[:space:]]*)` -- the literal word followed by
    // one whitespace character, then anything.
    if (/^export[ \t\n\v\f\r]/.test(line)) line = line.slice('export'.length);
    // ...and this strip is UNCONDITIONAL, outside the case: one leading
    // space comes off any line, export-prefixed or not.
    if (line.startsWith(' ')) line = line.slice(1);
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    out.push({
      name: k,
      // BYTES, not UTF-16 code units: `wc -c` reports a true byte count;
      // `.length` would under-report any multi-byte value and the
      // operator-visible number would stop matching what .env holds.
      bytes: Buffer.byteLength(v, 'utf8'),
      sha256_prefix: createHash('sha256').update(Buffer.from(v, 'utf8')).digest('hex').slice(0, 8),
    });
  }
  return out;
}

function secretList(cli: Cli, ctx: NounContext): never {
  const envf = join(ctx.root, '.env');
  if (!isFile(envf)) {
    cli.say('no .env yet — nothing stored');
    cli.emit('');
  }
  cli.say('secrets in .env (names and fingerprints only — values are never printed):');
  const rows = parseEnv(readFileSync(envf, 'utf8'));
  for (const r of rows) {
    cli.say(`  ${r.name.padEnd(28)} ${r.bytes} bytes  sha256:${r.sha256_prefix}`);
  }
  cli.data({ secrets: rows as unknown as JsonValue });
  // `cli.finish()` emits the safety-net summary "scrumux secret list: ok."
  // -- that sentence belongs to the safety net, not this function, which is
  // why this calls finish() rather than hand-writing it here too.
  return cli.finish();
}

/** The names `secret set` will not store, because they are the read verb. */
const NOT_A_NAME = ['get', 'show', 'read', 'cat', 'print', 'reveal'] as const;

/**
 * `^(export[[:space:]]+)?NAME=` (PK-13).
 *
 * The name has ALREADY been validated to `[A-Za-z0-9_]` not starting with a
 * digit by the time any of these run, so there is nothing in it a regex
 * needs to escape. `[[:space:]]` inside a LINE is
 * space, tab, vertical tab, form feed and carriage return; a newline cannot
 * appear, because that is what separates the lines.
 */
function envMatcher(name: string): RegExp {
  return new RegExp(`^(export[ \\t\\v\\f\\r]+)?${name}=`);
}

/**
 * How `grep` sees a file: lines separated by `\n`, and a final line with NO
 * trailing newline still counts.
 *
 * DELIBERATELY NOT `envLines` above. That one is `while IFS= read -r line`,
 * which DROPS an unterminated final line; `grep` keeps it. The two differ AT
 * EXACTLY THIS FILE -- `list` would not show a hand-appended unterminated
 * line that `set` and `remove` would still act on -- and both behaviours
 * are deliberate, not reconciled.
 */
function grepLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Rewrite `.env` without the name's line.
 *
 * TRAILING BLANK LINES DO NOT SURVIVE: every trailing newline is stripped
 * and exactly one is put back. This is a real, observable difference in the
 * post-state of any `.env` that had trailing blank lines before a remove.
 */
export function envDropText(text: string, name: string): string {
  const re = envMatcher(name);
  const rest = grepLines(text).filter((l) => !re.test(l)).join('\n').replace(/\n+$/, '');
  return rest === '' ? '' : rest + '\n';
}

function envDrop(cli: Cli, file: string, name: string): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // An unreadable file drops to empty text, and the truncation below
    // still happens.
    text = '';
  }
  const out = envDropText(text, name);
  try {
    writeFileSync(file, '');
  } catch {
    cli.die(`secret: cannot rewrite ${file}`);
  }
  // A chmod failure here is deliberately ignored, not turned into a
  // refusal, on both of these unguarded calls.
  secure(file);
  if (out !== '') appendFileSync(file, out);
  secure(file);
}

/** `chmod 600`, best effort. */
function secure(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Deliberately ignored.
  }
}

/** `.gitignore` already covers `.env`? The three alternations, verbatim. */
export function gitignoreCoversEnv(text: string): boolean {
  return grepLines(text).some((l) => /^\.env$/.test(l) || /^\.env[ \t\v\f\r]*$/.test(l) || /^\/\.env$/.test(l));
}

/** `git -C ROOT ls-files --error-unmatch .env` -- is git already following it? */
function gitTracksEnv(root: string): boolean {
  const have = spawnSync('sh', ['-c', 'command -v git >/dev/null 2>&1'], { stdio: 'ignore' });
  if (have.status !== 0) return false;
  const inRepo = spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
  if (inRepo.status !== 0) return false;
  const tracked = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '.env'], { stdio: 'ignore' });
  return tracked.status === 0;
}

/**
 * `VAL=$(cat)` -- read stdin to EOF, with trailing newlines stripped by the
 * command substitution.
 *
 * ONLY REACHED WHEN STDIN IS NOT A TERMINAL, because the `[ -t 0 ]` guard
 * above it refuses first: an interactive `scrumux secret set NAME` with no
 * value would otherwise sit here waiting for an EOF the operator does not
 * know to send. A read that fails is the empty value, which the very next
 * check refuses by name.
 */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

/**
 * The shared shape of the two write verbs' argv: `NAME [VALUE]`.
 *
 * `set` DOES NOT ECHO THE OFFENDING ARGUMENT, and that is the whole of the
 * difference between the two arms below (RULINGS.md R-010, extending an
 * earlier secret-redaction ruling to the refusal text). `scrumux secret set
 * TOKEN -sup3r-s3cret` printed the credential straight back on stderr and into
 * the envelope's `summary` and `error.message` -- the identical leak the
 * `.argv` redaction closed, on the identical noun, reached by nothing more
 * exotic than a value that begins with a dash. A value is not required to look
 * like a value.
 *
 * WHY THE POSITION AND NOT THE TEXT. The seam cannot know which slot held the
 * secret without re-deciding what `secretSet` decides, and `redactArgv`
 * (`src/cli/argv.ts`) already made that call once: everything after the NAME is
 * treated as a value. The same reasoning applies harder here, because the
 * refusal fires BEFORE the parse has finished and the arm that fires on
 * argument 1 cannot tell a mistyped NAME from a value typed into the NAME slot.
 * So the operand never appears, in any position, and the ORDINAL says which
 * argument to look at -- enough to fix the command line, and nothing a
 * transcript can leak.
 *
 * `remove` IS UNCHANGED, deliberately. Its one operand is a NAME, there is no
 * value in its argv to leak, and its wording is pinned by
 * `test/unit/nouns-write-hardenE.test.ts`; redacting it would buy nothing
 * and cost a matched pair.
 */
function parsePositional(cli: Cli, action: string, args: readonly string[]): { name: string; val: string } {
  let name = '';
  let val = '';
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      if (action === 'set') {
        cli.dieUsage(
          `secret set: unknown flag in argument ${i + 1} (not echoed — on this noun an argument may be the secret itself) — usage: scrumux secret set NAME [VALUE] | scrumux secret list | scrumux secret remove NAME`,
        );
      }
      cli.dieUsage(
        `secret ${action}: unknown flag ${a} — usage: scrumux secret set NAME [VALUE] | scrumux secret list | scrumux secret remove NAME`,
      );
    }
    // The FIRST positional is the name and every later one overwrites the
    // value, so `secret set N a b` stores `b`. Reproduced.
    if (name === '') name = a;
    else val = a;
  }
  return { name, val };
}

/** The two name guards, shared by `set` and `remove`, checked in this order. */
function requireUsableName(cli: Cli, name: string): void {
  // `scrumux secret get NAME` is the first thing anyone tries. Without this it
  // stores a secret CALLED "get" whose value is the name they wanted to read
  // -- silently, and reported as success.
  if ((NOT_A_NAME as readonly string[]).includes(name)) {
    cli.die(
      `secret: there is no '${name}' — a stored value is never printed back, which is the point of storing it here. Names and fingerprints: scrumux secret list. The value is read by this repo's own code from .env at runtime.`,
    );
  }
  if (name === '') {
    cli.dieUsage(
      'secret: usage: scrumux secret set NAME [VALUE] — the value may be omitted and piped on stdin instead, which keeps it out of shell history and out of every hook that reads the command string',
    );
  }
  if (/[^A-Za-z0-9_]/.test(name) || /^[0-9]/.test(name)) {
    cli.die(
      `secret: '${name}' is not a usable environment variable name — letters, digits and underscore only, not starting with a digit. The name is what the repo's code will reference, so it is not normalised for you`,
    );
  }
}

function secretRemove(cli: Cli, ctx: NounContext, args: readonly string[]): never {
  const { name } = parsePositional(cli, 'remove', args);
  requireUsableName(cli, name);
  const envf = join(ctx.root, '.env');
  if (!isFile(envf)) cli.die(`secret: no .env to remove ${name} from`);
  const re = envMatcher(name);
  const text = safeRead(envf);
  if (!grepLines(text).some((l) => re.test(l))) {
    cli.die(`secret: ${name} is not in .env — nothing removed`);
  }
  envDrop(cli, envf, name);
  cli.data({ name, removed: true });
  return cli.emit(`${name} removed from .env`);
}

function secretSet(cli: Cli, ctx: NounContext, args: readonly string[]): never {
  // This verb can REFUSE after speaking, so the output must already be
  // visible by then. `Cli.say` writes through since User's 2026-09-01
  // ruling, so the local `sayNow` workaround that used to live here is
  // retired.
  const say = (s: string): void => cli.say(s);
  const { name, val: argvVal } = parsePositional(cli, 'set', args);
  requireUsableName(cli, name);

  const envf = join(ctx.root, '.env');
  const gi = join(ctx.root, '.gitignore');

  let val = argvVal;
  let fromArgv = true;
  if (val === '') {
    fromArgv = false;
    if (process.stdin.isTTY === true) {
      cli.die(
        `secret: no value given and stdin is a terminal — either 'scrumux secret set ${name} <value>' or pipe it: printf %s '<value>' | scrumux secret set ${name}`,
      );
    }
    val = readStdin();
  }
  if (val === '') {
    cli.die(
      `secret: the value for ${name} is empty — refusing to store a blank secret, which would read as 'configured' and fail at the call site`,
    );
  }
  if (val.includes('\n')) {
    cli.die(
      `secret: the value for ${name} contains a newline — .env is one line per name. Store the PATH to a multi-line credential (a .pem, a service-account json) rather than its contents`,
    );
  }

  // GITIGNORE FIRST, ALWAYS. See the header.
  if (!isFile(gi)) {
    try {
      writeFileSync(gi, '# secrets — never commit\n.env\n');
    } catch {
      cli.die(`secret: cannot create ${gi}`);
    }
    say('created .gitignore covering .env');
  } else if (!gitignoreCoversEnv(safeRead(gi))) {
    try {
      appendFileSync(gi, '\n# secrets — never commit\n.env\n');
    } catch {
      cli.die(`secret: cannot append to ${gi}`);
    }
    say('added .env to .gitignore');
  }

  if (gitTracksEnv(ctx.root)) {
    cli.die(
      'secret: .env is ALREADY TRACKED by git — .gitignore does not apply to a tracked file and this would be committed. Untrack it first: git rm --cached .env',
    );
  }

  // `[ -f "$ENVF" ] || : > "$ENVF"` has NO `|| die` of its own -- a failed
  // creation falls through to the chmod, which is what refuses.
  if (!isFile(envf)) {
    try {
      writeFileSync(envf, '');
    } catch {
      // deliberate: the chmod below is the guard
    }
  }
  try {
    chmodSync(envf, 0o600);
  } catch {
    cli.die(`secret: cannot secure ${envf} to mode 600`);
  }

  const re = envMatcher(name);
  let verb = 'stored';
  if (grepLines(safeRead(envf)).some((l) => re.test(l))) {
    envDrop(cli, envf, name);
    verb = 'replaced';
  }
  try {
    appendFileSync(envf, `${name}=${val}\n`);
  } catch {
    cli.die(`secret: cannot write to ${envf}`);
  }
  secure(envf);

  const fp = createHash('sha256').update(Buffer.from(val, 'utf8')).digest('hex').slice(0, 8);
  // `wc -c` -- a true BYTE count, so a multi-byte value is not measured in
  // UTF-16 code units.
  const len = Buffer.byteLength(val, 'utf8');
  say(`${name} ${verb} in .env (${len} bytes, sha256:${fp}) — mode 600, gitignored`);
  say(
    "the repo's code reads it from .env at runtime; nothing prints it back. Never echo it, never put it in a record, a log entry, a commit message or a notebook cell.",
  );
  if (fromArgv) {
    say(
      "NOTE: you passed the value as an argument, so it is in this shell's history and in any transcript of this call. Scrub it: history -d $(history 1 | awk '{print $1}')  — or pipe the value on stdin next time.",
    );
  }
  // Name, length and fingerprint only. There is no path from here to the
  // VALUE, in prose or in JSON -- that is the whole contract of this noun.
  cli.data({ name, action: verb, bytes: len, sha256_prefix: fp });
  return cli.emit('');
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx: DispatchContext, verb, args): never {
    switch (verb) {
      case 'list':
        if (args.length !== 0) cli.dieUsage('secret list takes no arguments');
        return secretList(cli, nounContext(ctx));
      case 'set':
        if (args.length === 0) {
          cli.dieUsage("secret set needs a NAME — printf %s '<value>' | scrumux secret set NAME");
        }
        return secretSet(cli, nounContext(ctx), args);
      case 'remove':
        if (args.length !== 1) cli.dieUsage('secret remove takes exactly one NAME');
        return secretRemove(cli, nounContext(ctx), args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun secret — verbs: set, list, remove. See: scrumux help secret`,
        );
    }
  },
};

