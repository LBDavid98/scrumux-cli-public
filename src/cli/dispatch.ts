/**
 * Dispatch.
 *
 * DELIBERATELY THIN: it does argv, `--json`, dispatch, and nothing else.
 * Every cross-cutting concern — the envelope, the exit rule, the error
 * shape, the result vocabulary — is written ONCE in `envelope.ts`. Nineteen
 * hand-rolled `--json` implementations is the D-0010 failure this repo
 * rejects everywhere else.
 *
 * ORDER IS THE CONTRACT HERE, not a convenience:
 *
 *   1. strip the global flags;
 *   2. resolve the noun (`NOUN=${1:-help}` — a bare `scrumux` is `help`);
 *   3. THE UNGOVERNED REFUSAL, before everything below it;
 *   4. `help` / `version`;
 *   5. the unknown noun;
 *   6. the noun with no verb;
 *   7. `<noun> help`;
 *   8. the noun module.
 *
 * Step 3 sits where it does on purpose: above the help case and above the
 * registry, so EVERY verb passes through it exactly once, with no way to
 * add a new noun that accidentally bypasses the guard.
 * `tests/ungoverned-repo-tests.sh` asserts this ordering.
 *
 * THE ENVELOPE REACHES THE EDGES (User's ruling, 2026-09-01). `help` and
 * `version` used to print prose under `--json` and the unknown noun used to
 * print prose and NO object at all, so the CLI's own claim — "Every verb takes
 * --json and emits exactly ONE object" — was false of the three commands a
 * machine consumer meets first. Human-mode output is unchanged for `help`
 * and `version`; the unknown noun gains the one refusal line every other
 * refusal in the CLI already prints, which is also what carries the
 * message into the object.
 */
import { Cli } from './envelope.js';
import { redactArgv, stripGlobalFlags } from './argv.js';
import { nounKnown, usageNoun, usageTop } from './usage.js';
import { processIo, type Io } from './exit.js';
import { findMarker, isAllowed, refusalMessage } from './ungoverned.js';
import { resolveRoots } from '../journal/paths.js';
import { loadNoun } from '../nouns/registry.js';
import type { JsonValue } from '../journal/jqformat.js';

/** The CLI contract version. Bumped only by a ruling, never incidentally. */
export const CLI_CONTRACT = 'scrumux.cli/1';

const HELPISH = ['help', '-h', '--help'];

/**
 * `date +%F`, in the LOCAL zone. `toISOString().slice(0, 10)` is UTC and is
 * therefore a different day for several hours out of every twenty-four —
 * enough to date a session brief wrong for no behavioural reason.
 */
export function todayLocal(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Where the CLI itself lives, for root resolution's two-up fallback. */
function selfScriptDir(): string {
  // The bundle is `<repo>/.claude/dist/scrumux.mjs` (or `.deploy-claude/dist/`
  // in the source tree), so two up is the repo root.
  try {
    return new URL('.', import.meta.url).pathname;
  } catch {
    return process.cwd();
  }
}

/**
 * The two pieces of ambient state root resolution reads. Injectable for the
 * same reason `io` is: the ungoverned guard's answer depends entirely on where
 * ROOT lands, and a guard whose only reachable configuration is "wherever the
 * test runner happens to be" is a guard no unit test can aim. Defaulted, so no
 * production call site knows they exist.
 */
export interface DispatchEnv {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Never returns: every path ends in `io.exit`, which throws, so nothing
 * after a refusal can run.
 */
export function dispatch(input: readonly string[], io: Io = processIo, opts: DispatchEnv = {}): never {
  const { argv, json } = stripGlobalFlags(input);

  // `NOUN=${1:-help}` -- a bare `scrumux` is `scrumux help`.
  const noun = argv.length > 0 ? argv[0]! : 'help';
  const rest = argv.slice(1);
  const verb = rest.length > 0 ? rest[0]! : '';
  const verbArgs = rest.slice(1);

  const roots = resolveRoots(opts.cwd ?? process.cwd(), selfScriptDir(), opts.env ?? process.env);

  // ---- the self-governance refusal -------------------------------------
  //
  // A repo carrying `.scrumux-ungoverned` at its root is OUTSIDE the harness
  // and this CLI refuses to govern it. The scan starts at ROOT -- the repo
  // whose RECORDS would be written, which is the repo the marker is a
  // statement about -- and walks to `/`. A non-repo cwd walks up and finds
  // nothing, which is the correct answer: no marker, no refusal.
  if (!isAllowed(noun, verb)) {
    const marker = findMarker(roots.root);
    if (marker !== null) {
      const command = verb === '' ? noun : `${noun} ${verb}`;
      const cli = new Cli(command, [], json, io);
      cli.die(refusalMessage(command, marker));
    }
  }

  // ---- help / version --------------------------------------------------
  //
  // Dispatcher-level, not nouns: they answer about the CLI itself and read no
  // journal. Under `--json` they now emit the standard object -- help's prose
  // under `.data.lines`, which is the established idiom for a command whose
  // whole output IS its prose (`capture_report`), and version's contract
  // string under `.data.contract`, because a caller pinning a version wants a
  // field and not a line to parse. Human mode is byte-for-byte what it was.
  if (HELPISH.includes(noun)) {
    const cli = new Cli('help', [], json, io);
    let text: string;
    if (rest.length > 0) {
      // The refusal for an unknown noun under `help` uses command "help"
      // and an EMPTY argv, not the noun that was asked about -- the `Cli`
      // object above is constructed before this check runs, so the refusal
      // predates argv capture, and the envelope reflects that.
      if (!nounKnown(verb)) {
        cli.dieUsage(`unknown noun '${verb}' — run: scrumux help`);
      }
      text = usageNoun(verb);
    } else {
      text = usageTop();
    }
    emitReport(cli, io, text);
  }

  if (noun === 'version' || noun === '--version') {
    const cli = new Cli('version', [], json, io);
    if (json) cli.data({ contract: CLI_CONTRACT });
    else io.out(CLI_CONTRACT + '\n');
    cli.emit('');
  }

  // ---- the unknown noun ------------------------------------------------
  //
  // The noun table goes to stderr first -- it is the answer to "then what IS
  // there" -- and the refusal line follows it, which is the same shape the
  // noun-with-no-verb path below has always had. It was prose and no object
  // in either mode until User's ruling; it is now the one refusal writer, so
  // `--json` gets the object every other refusal produces and the wording
  // exists in exactly one place.
  if (!nounKnown(noun)) {
    io.err(usageTop());
    const cli = new Cli(noun, [], json, io);
    cli.dieUsage(`unknown noun '${noun}' — run: scrumux help`);
  }

  // ---- a noun with no verb: its usage to STDERR, then refuse -----------
  if (verb === '') {
    io.err(usageNoun(noun));
    const cli = new Cli(noun, [], json, io);
    cli.dieUsage(
      `${noun} needs a verb — the usage above lists them. There are no default verbs: a command that guesses is a command that is sometimes wrong about what you asked for.`,
    );
  }

  if (HELPISH.includes(verb)) {
    io.out(usageNoun(noun));
    io.exit(0);
  }

  // ---- the noun modules ------------------------------------------------
  const mod = loadNoun(noun);
  // THE ENVELOPE'S ARGV, WHICH IS NOT ALWAYS THE MODULE'S. `redactArgv` sits
  // at exactly this point: after the noun and verb are resolved, at the one
  // line that hands the list to the envelope. `mod.run` below gets
  // `verbArgs` unchanged.
  const cli = new Cli(`${noun} ${verb}`, redactArgv(noun, verb, verbArgs), json, io);
  if (mod === null) {
    // UNREACHABLE IN A CORRECT BUILD, and kept as a loud refusal rather than
    // deleted: every noun `usageTop`/`nounKnown` know about is native now
    // (bash retired 2026-09-03), so a null module here means the registry
    // and the noun roster have drifted apart — a bug in this build, not an
    // unported verb.
    return cli.dieUsage(
      `${noun} ${verb} has no TypeScript module registered, though '${noun}' is a known noun — the registry (src/nouns/registry.ts) and the noun roster have drifted apart. This is a build bug: file it with scrumux issue new --type harness.`,
    );
  }
  return mod.run(cli, { roots, today: todayLocal(), io }, verb, verbArgs);
}

/**
 * A block of prose, disposed of the way every report verb disposes of one:
 * printed in human mode, filed under `.data.lines` with blank lines dropped
 * under `--json`. Written here rather than reached for from `capture.ts`
 * because `help` produces its text in one piece and has nothing to capture.
 */
function emitReport(cli: Cli, io: Io, text: string): never {
  if (cli.json) {
    const lines = text.split('\n').filter((l) => l.length > 0);
    cli.data({ lines: lines as unknown as JsonValue });
  } else {
    io.out(text);
  }
  cli.emit('');
}
