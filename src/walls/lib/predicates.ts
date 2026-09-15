/**
 * "What can this command line actually DO?"
 *
 * A STRING IN A COMMAND IS ONLY EVIDENCE OF AN ACT IF THE COMMAND CAN PERFORM
 * IT. Three walls learned that separately, at a cost of five false blocks in
 * one session (I-0132, I-0134, I-0135 and two more). Every one was a wall
 * matching a literal that appeared in PROSE — a path inside a `--check`,
 * `.env` in a commit message, `api.openai.com` in a `--rationale` explaining
 * why an exemption was being declared — and treating it as the thing being
 * done. `scrumux decide new --rationale "...api.openai.com..."` makes no
 * request. `git commit -m "... .env ..."` reads no secret.
 *
 * So a wall asks what RUNS the segment before it asks what is IN it, and these
 * predicates are that question. The word lists are exact whole-word matches,
 * so a program named `catfish` does not answer for `cat`.
 */
import { cmdWords } from './cmd-words.js';
import { matchesAnyLine, ereOrThrow } from './ere.js';

/** Programs that can reach the network. Fixed list. */
const CALL_OUT = new Set([
  'curl', 'wget', 'http', 'https', 'httpie', 'nc', 'ncat', 'telnet', 'openssl',
  'ssh', 'scp', 'rsync', 'python', 'python3', 'node', 'nodejs', 'deno', 'bun',
  'ruby', 'perl', 'php', 'java', 'go', 'dotnet', 'npm', 'npx', 'pnpm', 'yarn',
  'pip', 'pip3', 'uv', 'poetry', 'docker', 'kubectl', 'aws', 'gcloud', 'az',
]);

/** Programs that can read a file's CONTENTS. Fixed list (D-0085/OQ-11). */
const READ_FILE = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'awk', 'sed', 'cut', 'sort', 'uniq', 'od', 'xxd', 'hexdump', 'strings',
  'base64', 'openssl', 'jq', 'yq', 'diff', 'cmp', 'tee', 'cp', 'mv', 'scp',
  'rsync', 'tar', 'zip', 'gzip', 'curl', 'wget', 'python', 'python3', 'node',
  'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'sh', 'bash', 'zsh',
  'source', '.', 'docker', 'dotenv', 'export',
  'dd', 'nl', 'tac', 'bat', 'vim', 'view', 'ex',
]);

export function canCallOut(command: string): boolean {
  return cmdWords(command).some((w) => CALL_OUT.has(w));
}

export function canReadFile(command: string): boolean {
  return cmdWords(command).some((w) => READ_FILE.has(w));
}

/**
 * Does this command line READ a file through the SHELL itself, rather than
 * through a program? (I-0142)
 *
 * The command-word classifier asks which PROGRAM runs, which is right for
 * `cat .env` and blind to every idiom where the shell does the opening and no
 * program ever sees a path:
 *
 *   read K < .env            the shell opens it, `read` gets a fd
 *   while ...; done < .env   same
 *   X=$(<.env)               a slurp, no program at all
 *   exec 3<> /dev/tcp/h/443  the shell opens a SOCKET
 *
 * NOT QUOTE-AWARE, deliberately. This and `shellDials` match the RAW command
 * string — the opposite discipline from `cmdWords`, whose whole reason for
 * existing is that a raw match over an unparsed string produces false
 * positives on quoted prose. That asymmetry is intentional: making these
 * quote-aware would LOOSEN two walls, and that is a ruling, not a refactor.
 */
/**
 * A POSIX ERE, VERBATIM, compiled by the shared translator, NOT hand-
 * rewritten into a JavaScript regex.
 *
 * `[[:space:]]` appears twice here -- once as a run and once NEGATED -- and
 * a hand-rewrite once used `[ \t]` for the first and `\s` for the second.
 * Those are three different sets: POSIX space is space/tab/newline/VT/FF/CR,
 * `[ \t]` is two of them, and JS `\s` adds U+00A0 and eleven other Unicode
 * spaces. The negated one is the one that bit: `cat <<NBSP>.env` is a shell
 * read on every real shell, and the hand-rewritten regex missed it, silently
 * allowing a read that should have been refused. Six more edges diverge the
 * same way (VT, FF, CR, em space). Keeping the source text and translating
 * it once, through the shared translator, is the only shape where that
 * cannot recur.
 */
const SHELL_READS = ereOrThrow('(^|[^0-9<>])<[[:space:]]*[^<&|[:space:]]|[$]\\([[:space:]]*<|<>');

export function shellReads(command: string): boolean {
  return matchesAnyLine(SHELL_READS, command);
}

const SHELL_DIALS = ereOrThrow('/dev/(tcp|udp)/');

/** Does it open a socket through the shell? /dev/tcp and /dev/udp involve no binary at all. */
export function shellDials(command: string): boolean {
  return matchesAnyLine(SHELL_DIALS, command);
}
