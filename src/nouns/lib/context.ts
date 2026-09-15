/**
 * What a noun module needs BEYOND what the dispatcher hands it.
 *
 * `src/nouns/registry.ts` publishes the seam: a module answers `verbs()`,
 * `usage()` and `run(cli, ctx, verb, args)`, and `ctx` carries the resolved
 * roots, `today` and the output streams. That is everything `status` and
 * `backlog` need, because they read journals under `GOV` and nothing else.
 *
 * A FEW VERBS NEED MORE, each a value not carried by the registry's context:
 *
 *   $SCRIPTS      `views render` shells out to `<harness>/scripts/scrumux
 *                 graph gov build`. A bundle derives this from its own
 *                 location: it sits at `<harness>/dist/scrumux.mjs`, and its
 *                 sibling is `<harness>/scripts`.
 *   $HARNESS_DIR  `records check`'s rules chain and roster sweeps walk
 *                 `$ROOT/$HARNESS_DIR/{rules,skills,agents,scripts}`, and the
 *                 name is `.claude` in a deployed repo and `.deploy-claude`
 *                 in the harness source repo.
 *   the env       `session check` reads `SCRUMUX_TASK` (D-0084).
 *   the cwd       the graph builder's child process runs where the caller
 *                 is.
 *
 * SO THEY ARE DERIVED, NOT REQUIRED. `nounContext` fills all four from the
 * process, and each is an OPTIONAL override on the incoming context so a
 * test can point one at a fixture without mutating the process. That keeps
 * the registry wiring a one-line table entry per noun -- no adapter, no
 * second context type to construct -- while leaving every one of these
 * reachable from a unit test.
 */
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from '../../cli/exit.js';
import type { Roots } from '../../journal/paths.js';

/**
 * The context the dispatcher passes down (registry.ts's `NounContext`), plus
 * the optional overrides above. Structural, deliberately: this file does not
 * import the registry, so a module here compiles and tests whether or not the
 * registry has been wired to it yet.
 */
export interface DispatchContext {
  /** ROOT / GOV / WORK_ROOT, already resolved. */
  roots: Roots;
  /** `date +%F` -- captured ONCE per invocation. */
  today: string;
  /** The same streams `Cli` writes to. */
  io: Io;
  /** `$SCRIPTS`. Defaults to the running bundle's sibling. */
  scriptsDir?: string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
}

/** The three parts every noun module publishes, in the registry's shape. */
export interface NounModule {
  /** One TAB-separated `verb<TAB>gloss` line per verb. */
  verbs(): string;
  /** The module's own usage block, verbatim. */
  usage(): string;
  /**
   * NEVER RETURNS. `Cli.emit`/`Cli.refuse` both throw, so nothing after
   * them runs; a `run` that returned would let the code after a refusal
   * execute -- which is exactly the shape of `views render`'s branch.
   */
  run(cli: import('../../cli/envelope.js').Cli, ctx: DispatchContext, verb: string, args: readonly string[]): never;
}

/** Everything a noun module reads, with nothing left ambient. */
export interface NounContext {
  /** Where the RECORDS live. Follows GOV_ROOT. (`$ROOT`) */
  root: string;
  /** `<root>/governance`. (`$GOV`) */
  gov: string;
  /** The tree the CODE is in, where a verification command runs. (`$WORK_ROOT`) */
  workRoot: string;
  /** Where the harness's scripts live: `<harness>/scripts`. (`$SCRIPTS`) */
  scriptsDir: string;
  /** `$SCRIPTS/../..` -- the repo the harness code ships with. */
  codeRoot: string;
  /** `.claude` in a deployed repo, `.deploy-claude` in the source repo. */
  harnessDir: string;
  /** `date +%F`. (`$TODAY`) */
  today: string;
  env: NodeJS.ProcessEnv;
  /** The CALLER's working directory. */
  cwd: string;
}

/**
 * `.claude` in every repo the harness is deployed into; `.deploy-claude` in
 * the harness SOURCE repo, whose payload is named that so Claude Code does not
 * auto-discover the deployment cargo as live session config. A repo never
 * holds both, so probing is unambiguous, and `.claude` is the default when
 * neither is present -- a fresh target about to be deployed into must not
 * resolve to the source name.
 */
export function harnessDirOf(root: string): string {
  if (existsSync(resolve(root, '.claude'))) return '.claude';
  if (existsSync(resolve(root, '.deploy-claude'))) return '.deploy-claude';
  return '.claude';
}

/** `date +%F` -- LOCAL date, which is what the shell builtin gives. */
export function todayStamp(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** `<harness>/scripts` for a bundle that lives at `<harness>/dist/<file>`. */
export function scriptsDirFromBundle(bundleDir: string): string {
  return resolve(bundleDir, '..', 'scripts');
}

/**
 * Resolve a SYMLINKED FILE, then take the directory LOGICALLY -- the
 * algorithm a `cd -L`/`pwd -L` shell prologue uses to resolve `$0` (R-007),
 * reproduced here as a loop over `lstatSync`/`readlinkSync` rather than a
 * filesystem `cd`.
 *
 * TWO PROPERTIES MATTER, and the second is the one that bit before this
 * existed. It follows a symlink whose FINAL COMPONENT is a link, one hop at
 * a time; and it canonicalises the result LEXICALLY -- dot-dot is removed
 * with the component before it, and an intermediate directory that is
 * itself a symlink is left exactly as written, never resolved.
 *
 * WHY NOT `import.meta.url`. Node's ESM loader realpaths the module it
 * loads, so `import.meta.url` is the PHYSICAL path. On macOS `/var` is a
 * symlink to `/private/var`, so a harness deployed under `mktemp -d` can
 * show `/private/var/folders/.../.venv` in a refusal for a deploy that was
 * actually made to `/var/folders/...` -- the same place on disk, but a path
 * an operator does not recognise as the one they typed (R-007;
 * `records check`'s no-python3 FAIL, src/nouns/records.ts, is where this
 * was found). `process.argv[1]` is NOT realpathed by Node, so it is used as
 * the entry path here, never `import.meta.url`.
 *
 * THE LOOP IS BOUNDED. A symlink cycle would spin forever in a naive
 * follow; here it stops after 40 hops (the usual kernel ELOOP limit) and
 * answers with whatever it reached. A CLI that hangs is worse than one
 * that answers, and no other behaviour is observable, but the difference is
 * stated rather than left to be discovered.
 */
export function logicalDirOf(entry: string, cwd: string = process.cwd()): string {
  // `path.resolve` is the lexical half of `cd -L`: absolute-ise against the
  // caller's cwd, collapse `.` and `..` textually, touch the filesystem never.
  let p = resolve(cwd, entry);
  for (let hop = 0; hop < 40; hop++) {
    let link: string;
    try {
      if (!lstatSync(p).isSymbolicLink()) break;
      link = readlinkSync(p);
    } catch {
      // `[ -L ]` on a path that cannot be stat'd is false. Same answer.
      break;
    }
    p = isAbsolute(link) ? link : resolve(dirname(p), link);
  }
  return dirname(p);
}

/**
 * `$SCRIPTS`, from where this code is actually running.
 *
 * The bundle is one file at `<harness>/dist/scrumux.mjs`, so its sibling
 * `scripts` directory is `$SCRIPTS`. The bundle's own path comes from
 * `process.argv[1]`, resolved logically (see `logicalDirOf`), NEVER from
 * `import.meta.url`, which the ESM loader has already realpathed.
 *
 * Running UNBUNDLED (vitest, importing the TypeScript directly) `argv[1]` is
 * the test runner and not this CLI at all, so the fallback keeps the old
 * answer -- a path inside `src/`. That was already wrong for a fixture, which
 * is why every test passes `scriptsDir` explicitly: a fixture's harness is
 * not this checkout's.
 */
export function defaultScriptsDir(argv: readonly string[] = process.argv): string {
  const entry = argv[1];
  if (entry !== undefined && entry !== '') return scriptsDirFromBundle(logicalDirOf(entry));
  return scriptsDirFromBundle(dirname(fileURLToPath(import.meta.url)));
}

/** Fill the four derived values, honouring any the caller pinned. */
export function nounContext(ctx: DispatchContext): NounContext {
  const scriptsDir = ctx.scriptsDir ?? defaultScriptsDir();
  return {
    root: ctx.roots.root,
    gov: ctx.roots.gov,
    workRoot: ctx.roots.workRoot,
    scriptsDir,
    codeRoot: resolve(scriptsDir, '..', '..'),
    harnessDir: harnessDirOf(ctx.roots.root),
    today: ctx.today,
    env: ctx.env ?? process.env,
    cwd: ctx.cwd ?? process.cwd(),
  };
}
