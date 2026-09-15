/**
 * The shared hook runtime: read the payload, resolve the root, refuse or
 * allow. Everything the four walls do identically, written once.
 *
 * THE TWO EXIT CODES ARE A DIFFERENT NAMESPACE from the CLI's three-code
 * rule. Inside a Claude Code PreToolUse hook, exit 2 means BLOCK THE TOOL CALL
 * and exit 0 means allow it. Nothing here routes through the CLI dispatcher
 * and no hook reads a subcommand's verdict.
 *
 * FAIL CLOSED WHEN THE WALL CANNOT EVALUATE THE CALL (CLI-1). A prerequisite
 * that is absent is a refusal, never a pass: waving the call through would
 * silently turn this wall — and every sibling — into a no-op.
 * `src/util/node-version.ts` (via `refuseOldNode` below) refuses when node is
 * too old for the wall to trust its own evaluation.
 *
 * A MALFORMED PAYLOAD IS NOT A REFUSAL, and that is not the same question. An
 * unparseable payload yields an empty command, and every wall then exits 0 on
 * an empty command: the wall has nothing to judge, and inventing a refusal
 * there would block tool calls this harness has never blocked.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeVersionProblem } from '../../util/node-version.js';
import type { JsonValue } from './jsonl.js';

/**
 * THE VERSION FLOOR, CHECKED FROM INSIDE THE BUNDLE ITSELF.
 *
 * esbuild emits one file parsed in one go, so a runtime too old for the
 * bundle's syntax fails at PARSE time and never reaches this call at all —
 * nothing inside the hook can catch that case. What this catches is the
 * narrower, more dangerous one: a node new enough to PARSE the bundle but
 * older than the semantic floor the code assumes, which would otherwise run
 * and evaluate the call incorrectly rather than failing loudly.
 *
 * Exit 2, because in a PreToolUse hook that means BLOCK — the correct answer
 * to "this wall cannot evaluate the call" (CLI-1).
 */
export function refuseOldNode(wall: string, io: WallIo, version = process.version): void {
  const problem = nodeVersionProblem(version);
  if (problem === null) return;
  refuse(io,
    'BLOCKED by ' + wall + ': Node ' + version + ' is too old — this wall needs Node >=22.11 '
    + 'and cannot evaluate the tool call. Refusing rather than waving it through '
    + '(fail-closed, CLI-1). Install a newer Node and retry; nothing was read or written.');
}

/**
 * WHERE A WALL'S INPUT AND OUTPUT COME FROM — injectable, for the same reason
 * `src/cli/exit.ts` exists.
 *
 * A wall's whole product is a verdict and a SENTENCE. Article 5 makes that
 * sentence product surface held to the same review standard as code, and a
 * sentence reachable only through a subprocess is a sentence v8 coverage
 * cannot see and a unit test cannot assert. So stdin, stderr and the exit are
 * a seam: the bundle passes the real one, a test passes a captured one, and
 * `exit` THROWS in both so nothing after a refusal ever runs.
 */
export interface WallIo {
  /** The raw hook payload. */
  input: string;
  err(s: string): void;
  /**
   * STDOUT, AND ONLY ONE HOOK IN THIS REPO HAS EVER NEEDED IT.
   *
   * The four PreToolUse walls speak entirely through stderr and an exit code,
   * because that is the whole PreToolUse contract: 2 blocks, 0 allows, and
   * stdout on a blocked call goes to the debug log where nobody reads it. The
   * SessionStart guard is the exception and cannot avoid being one — that
   * event cannot block on an exit code at all, so its refusal has to travel as
   * a JSON object on stdout (`continue: false`). Adding it to the shared seam
   * rather than reaching for `process.stdout` inside that one file keeps the
   * property every wall test depends on: a wall's ENTIRE output is capturable
   * without owning a file descriptor.
   */
  out(s: string): void;
  exit(code: number): never;
}

export class WallExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'WallExit';
  }
}

/** The real one. The throw is unwound by the entry guard at the bottom of each wall. */
export function processWallIo(): WallIo {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    // No stdin at all. Same disposition as an unparseable payload: nothing to judge.
  }
  return {
    input,
    err: (s) => { process.stderr.write(s); },
    out: (s) => { process.stdout.write(s); },
    exit: (code) => { throw new WallExit(code); },
  };
}

export interface CapturedWallIo extends WallIo { stderr: string; stdout: string }

/** For tests: the same interface, collecting stderr and stdout. */
export function captureWallIo(input: string): CapturedWallIo {
  const io: CapturedWallIo = {
    input,
    stderr: '',
    stdout: '',
    err(s) { io.stderr += s; },
    out(s) { io.stdout += s; },
    exit(code) { throw new WallExit(code); },
  };
  return io;
}

/** Run a wall's main() and report the exit code it asked for. */
export function wallExitCode(fn: () => void): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof WallExit) return e.code;
    throw e;
  }
  throw new Error('a wall returned without exiting — every path must end in io.exit');
}

export interface HookInput {
  /** The parsed payload, or `{}` when it could not be read. */
  payload: Record<string, JsonValue>;
  /** `.tool_input.command`, or ''. */
  command: string;
  /** `.tool_input.file_path`, or ''. */
  filePath: string;
  /** `.tool_input.notebook_path`, or ''. NotebookEdit does not send file_path. */
  notebookPath: string;
  /** GOV_ROOT when set, else two levels up from the hook. */
  root: string;
  /**
   * The tree the session's code is in: WORK_ROOT when set, else two levels up
   * from the hook — the checkout (or worktree) whose `.claude/dist` runs it. A
   * dispatched session's GOV_ROOT points at the main checkout while its hooks
   * run from its worktree, so this is NOT `root` (D-S040's `.scratch/`).
   */
  workRoot: string;
  /** The payload's `cwd` (the shell's working directory), or ''. */
  cwd: string;
}

function str(o: unknown, k: string): string {
  if (o === null || typeof o !== 'object') return '';
  const v = (o as Record<string, unknown>)[k];
  return typeof v === 'string' ? v : '';
}

/**
 * @param hookDir  the directory the wall bundle lives in, for the two-up
 *                 fallback. GOV_ROOT moves the DATA root and nothing else —
 *                 the same resolution every sibling uses, and the same
 *                 ROOT/WORK_ROOT separation `src/journal/paths.ts` uses.
 */
export function readHookInput(hookDir: string, io: WallIo, env: NodeJS.ProcessEnv = process.env): HookInput {
  const raw = io.input;
  let payload: Record<string, JsonValue> = {};
  try {
    const p: unknown = JSON.parse(raw);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
      payload = p as Record<string, JsonValue>;
    }
  } catch {
    // Deliberately silent: the payload could not be parsed, so every wall
    // exits 0 on the empty command that follows.
  }
  const toolInput = payload['tool_input'];
  const govRoot = env['GOV_ROOT'];
  const workRoot = env['WORK_ROOT'];
  return {
    payload,
    command: str(toolInput, 'command'),
    filePath: str(toolInput, 'file_path'),
    notebookPath: str(toolInput, 'notebook_path'),
    root: govRoot !== undefined && govRoot !== '' ? govRoot : `${hookDir}/../..`,
    workRoot: workRoot !== undefined && workRoot !== '' ? resolve(workRoot) : resolve(hookDir, '..', '..'),
    cwd: str(payload, 'cwd'),
  };
}

/** Two paths naming the same file, `..` and symlinks resolved where possible. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const abs = resolve(p);
    try {
      return realpathSync(abs);
    } catch {
      // A path that does not exist cannot be realpath'd, and that is a normal
      // state in a test. `resolve` has already collapsed the `..`, which is
      // the part that actually bit.
      return abs;
    }
  };
  return norm(a) === norm(b);
}

/**
 * The entry guard, written ONCE.
 *
 * Two jobs, and both are easy to get subtly wrong four times. It runs `main`
 * only when this module is the PROCESS ENTRY — without that, importing a wall
 * to unit-test one of its predicates executes it, reads stdin and exits. And
 * it turns the `WallExit` every path throws back into a real exit code.
 *
 * THE CATCH-ALL REFUSES. An unhandled error inside a wall is not a reason to
 * wave the tool call through: exit 2 means block, and "this wall could not
 * evaluate the call" is precisely the fail-closed case (CLI-1). A wall that
 * crashed open would be the silent no-op the jq guard exists to prevent.
 */
export function runAsEntry(
  wall: string,
  moduleUrl: string,
  main: () => never,
  argv: string[] = process.argv,
  exit: (code: number) => void = process.exit,
  err: (s: string) => void = (s) => { process.stderr.write(s); },
): void {
  const entry = argv[1];
  if (entry === undefined) return;
  // COMPARE RESOLVED PATHS, NEVER URL STRINGS. `argv[1]` can differ textually
  // from `import.meta.url` even when both name the same file -- a `..`
  // component, a symlink, a different working directory at invocation time.
  // `pathToFileURL` does not normalise a `..`, while `import.meta.url` is
  // already the real path. A raw string comparison can therefore fail even
  // when the paths ARE the same file: the guard declines to run, and the
  // wall exits 0 having evaluated NOTHING. That is a wall silently open,
  // which is the worst failure available here.
  if (!samePath(fileURLToPath(moduleUrl), entry)) return;
  try {
    main();
  } catch (e) {
    if (e instanceof WallExit) { exit(e.code); return; }
    err(`BLOCKED by ${wall}: this wall failed while evaluating the tool call `
      + `(${e instanceof Error ? e.message : String(e)}). `
      + `Refusing rather than waving it through (fail-closed, CLI-1).\n`);
    exit(2);
  }
}

/** Allow the tool call. */
export function allow(io: WallIo): never {
  return io.exit(0);
}

/** Block it: the message is what the agent reads, and it IS the instruction set. */
export function refuse(io: WallIo, message: string): never {
  io.err(message + '\n');
  return io.exit(2);
}
