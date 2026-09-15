/**
 * `graph code build` -- the dispatch arm, and the child process that owns the
 * parse.
 *
 * --- WHY THERE IS A CHILD PROCESS ----------------------------------------
 *
 * The dispatcher is SYNCHRONOUS by ruling (src/nouns/registry.ts): that is
 * what keeps `ExitSignal` catchable at the entry point instead of becoming an
 * unhandled rejection, and no verb may make it async. `web-tree-sitter`'s
 * `Parser.init()` and `Language.load()` are both promises -- emscripten
 * instantiates its module asynchronously and Node has no way to drain a
 * microtask queue from inside a synchronous call.
 *
 * So the parse runs in a CHILD: this spawns THIS SAME BUNDLE with
 * `SCRUMUX_CODE_GRAPH_CHILD=1` and two roots in the environment
 * (`SCRUMUX_CODE_GRAPH_TREE_ROOT`/`SCRUMUX_CODE_GRAPH_DATA_ROOT`). The
 * parent's job is simple by design: relay the child's streams, read its
 * exit code, and turn that into a check row.
 *
 * The child is the one `run()` in this CLI that RETURNS rather than exiting.
 * `src/bin/scrumux.ts` already sets `process.exitCode` and returns so Node can
 * drain a piped stdout before exiting; the child rides that same drain, with
 * its exit code set from the promise's continuation. Nothing else in the
 * process is pending, so "drain and exit" is immediate.
 *
 * NOT VERIFIED: a Node SEA (single-executable binary) build would need an
 * argv-less self-spawn, since `process.argv[1]` is not a script path there
 * and this code assumes it is. Spike C measured wasm loading inside a SEA;
 * it did not measure a SEA re-invoking itself, so this gap is real and
 * unclosed.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve as resolvePath } from 'node:path';
import { isDir, isFile } from '../../util/fs-predicates.js';
import type { Cli } from '../../cli/envelope.js';
import type { Io } from '../../cli/exit.js';
import type { NounContext } from '../lib/context.js';
import { indexPath } from './code-index.js';
import {
  GrammarUnavailable, buildCodeGraph, grammarDir, runtimeDir, writeIndex,
  type CodeGraph,
} from './code-build.js';

/** The env the parent hands the child: two roots, one marker. */
const CHILD = 'SCRUMUX_CODE_GRAPH_CHILD';
const TREE_ROOT = 'SCRUMUX_CODE_GRAPH_TREE_ROOT';
const DATA_ROOT = 'SCRUMUX_CODE_GRAPH_DATA_ROOT';

/** Are we the child? Checked before anything else in the build arm. */
export function isBuildChild(env: NodeJS.ProcessEnv): boolean {
  return env[CHILD] === '1';
}

/**
 * Can a build actually be done from here?
 *
 * True only in a harness SOURCE checkout, where `tools/grammars` and the
 * `web-tree-sitter` devDependency are on disk. False in a DEPLOYED repo,
 * which is the whole point of the reader/builder split: no wasm blob ever
 * ships into a governed repo.
 */
export function canBuild(ctx: NounContext): boolean {
  return isDir(grammarDir(ctx.codeRoot))
    && isFile(join(runtimeDir(ctx.codeRoot), 'web-tree-sitter.js'))
    && selfBundle(ctx) !== null;
}

/**
 * The bundle to re-invoke. `process.argv[1]` for the same reason
 * `defaultScriptsDir` uses it rather than `import.meta.url`: it is the path
 * the caller actually ran, not the ESM loader's realpath of it.
 *
 * THE ENV OVERRIDE IS THE TEST SEAM and is named rather than hidden: run
 * unbundled (vitest) `argv[1]` is the test runner, so a unit test that wanted
 * the parent path would otherwise spawn vitest. The tests that matter drive
 * `buildCodeGraph` directly instead; this exists so the arm itself stays
 * reachable from one.
 */
function selfBundle(ctx: NounContext): string | null {
  const override = ctx.env['SCRUMUX_CODE_GRAPH_SELF'];
  if (override !== undefined && override !== '') return isFile(override) ? override : null;
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return null;
  return isFile(entry) ? entry : null;
}

// ------------------------------------------------------------ the child ---

/** What the child writes, and what the parent relays. */
export interface BuildRun {
  rc: number;
  stdout: string;
  stderr: string;
  /** `$(graph_code_build 2>&1)` -- the ONE stream `graph code index` reads. */
  combined: string;
}

/**
 * The child's whole program, including which line goes to which stream and
 * which failure exits 1.
 */
export async function runBuildChild(env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const treeRoot = env[TREE_ROOT] ?? '';
  const dataRoot = env[DATA_ROOT] ?? '';
  const path = indexPath(dataRoot);

  let g: CodeGraph;
  try {
    g = await buildCodeGraph(treeRoot, env['SCRUMUX_CODE_GRAPH_CODE_ROOT'] ?? treeRoot);
  } catch (e) {
    if (!(e instanceof GrammarUnavailable)) throw e;
    // The builder is the ONLY surface with a toolchain dependency, and the
    // refusal has to name where a builder does exist rather than stopping at
    // "not installed here".
    io.err(`graph code build: error: ${e.message}\n`
      + '  The BUILDER needs the grammars; readers do not — an existing index '
      + 'answers every query with no parser at all.\n'
      + `  Build from a harness checkout that has them:  scrumux graph code build --repo ${treeRoot}\n`
      + '  `scrumux harness deploy` does exactly this for every target it installs.\n');
    return 1;
  }

  try {
    writeIndex(g, path);
  } catch (e) {
    // One line naming the path and the cause. A traceback is never an answer
    // to an operator (I-0104).
    io.err(`graph code build: error: cannot write the index to ${path} — ${msgOf(e)}\n`);
    return 1;
  }

  const cov = g.coverage;
  io.out(`graph code: ${g.files.length} files, ${g.symbols.size} symbols, `
    + `${g.edges.length} edges -> ${path}\n`);
  io.out('  indexed: ' + [...cov.by_language.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([lang, n]) => `${lang}=${n}`).join(', ') + '\n');
  for (const s of cov.skipped) {
    io.out(`  NOT INDEXED: ${s.files} ${s.language} file(s) — ${s.reason}`
      + (s.examples.length > 0 ? ` (e.g. ${s.examples.join(', ')})` : '') + '\n');
  }
  io.out(`  other files: ${cov.not_source} (no language mapped)\n`);
  if (g.parse_errors.length > 0) {
    io.err('parse errors in: ' + g.parse_errors.slice(0, 5).join(', ') + '\n');
    return 1;
  }
  return 0;
}

/**
 * The child arm. Fire-and-forget on purpose -- see the header. The `never`
 * return type is honoured everywhere else in this CLI; here the process ends
 * by draining rather than by throwing, so the cast is the seam and not a
 * shortcut.
 */
export function codeBuildChildArm(io: Io, env: NodeJS.ProcessEnv): never {
  void runBuildChild(env, io).then(
    (rc) => { process.exitCode = rc; },
    (e: unknown) => {
      io.err(`graph code build: error: ${msgOf(e)}\n`);
      process.exitCode = 2;
    },
  );
  return undefined as unknown as never;
}

// ----------------------------------------------------------- the parent ---

/**
 * Spawn the child and collect all three streams. `spawnSync`, so the whole
 * call is synchronous from the dispatcher's point of view.
 */
export function buildViaChild(ctx: NounContext, treeRoot: string, dataRoot: string): BuildRun {
  const self = selfBundle(ctx);
  if (self === null) {
    return {
      rc: 1,
      stdout: '',
      stderr: 'graph code build: error: this build carries no bundle path to run the '
        + 'indexer in — the parse runs in a child process and there is nothing here to spawn.\n',
      combined: '',
    };
  }
  const r = spawnSync(process.execPath, [self, 'graph', 'code', 'build'], {
    cwd: ctx.cwd,
    env: {
      ...ctx.env,
      [CHILD]: '1',
      [TREE_ROOT]: treeRoot,
      [DATA_ROOT]: dataRoot,
      SCRUMUX_CODE_GRAPH_CODE_ROOT: ctx.codeRoot,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return {
    rc: r.status === null || r.status === undefined ? 2 : r.status,
    stdout,
    stderr,
    // STDERR FIRST in the combined stream, deliberately: `graph code index`
    // cuts this capture with `head -3`, so the join order decides which
    // three lines a failure names. Parse errors (stderr) come before the
    // summary report (stdout) here regardless of the order the child
    // actually wrote them in.
    combined: stderr + stdout,
  };
}

/**
 * argv, roots, and the spawn. Returns the run rather than emitting, because
 * `graph code index` needs the same call with its output CAPTURED.
 *
 * THE DEFAULT IS THE TREE THE SCRIPTS LIVE IN, not `ctx.root`. Code
 * location comes from where the CLI itself lives, data location from
 * `GOV_ROOT` -- and the index describes CODE. Under a `GOV_ROOT` sandbox
 * `ctx.root` is a directory with no source in it, so defaulting to it
 * would index nothing and report it as a fact. `--repo` overrides both
 * roots together, which is the case where they genuinely are the same
 * repo.
 */
export function codeBuild(cli: Cli, ctx: NounContext, args: readonly string[]): BuildRun {
  let repo = ctx.codeRoot;
  let data = ctx.root;
  for (let i = 0; i < args.length;) {
    const a = args[i]!;
    if (a === '--repo') {
      // An unruled shell-expansion divergence of the same class as
      // `repair journal ""` (src/nouns/repair.ts) -- a raw shell diagnostic
      // naming a source file and line number is not worth reproducing; this
      // refuses in the CLI's own vocabulary instead.
      const v = args[i + 1] ?? '';
      if (v === '') cli.die('--repo needs a path');
      repo = v;
      data = v;
      i += 2;
    } else {
      cli.dieUsage(`graph code build: unknown argument '${a}' — usage: `
        + 'scrumux graph code build [--repo <path>]');
    }
  }
  // The TEST is against the resolved path; the MESSAGE quotes the raw
  // argument, because that is what the caller typed and what they have to
  // correct.
  if (!isDir(resolvePath(ctx.cwd, repo))) {
    cli.die(`graph code build: ${repo} is not a directory`);
  }
  // `$(CDPATH='' cd -- "$X" && pwd)` -- LOGICAL, so a symlinked parent stays
  // as written and `path.resolve` is the same lexical answer.
  return buildViaChild(ctx, resolvePath(ctx.cwd, repo), resolvePath(ctx.cwd, data));
}

/**
 * The `build` dispatch arm.
 *
 * The child's streams go straight through: the report is on stdout in
 * BOTH modes, so `graph code build --json` prints the human lines and
 * then the one object. That is deliberate, not an oversight -- `cli.say`
 * would suppress it under `--json`.
 */
export function codeBuildArm(cli: Cli, ctx: NounContext, io: Io, args: readonly string[]): never {
  const r = codeBuild(cli, ctx, args);
  io.out(r.stdout);
  io.err(r.stderr);
  if (r.rc !== 0) {
    cli.fail('code-graph', `build failed (exit ${r.rc}) — see the message above`);
    cli.emit('graph code build: failed.');
  }
  cli.pass('code-graph', 'index rebuilt');
  cli.emit('');
}

// --------------------------------------------------------------- helpers ---

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
