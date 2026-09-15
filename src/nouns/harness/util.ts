/**
 * Shell-pipeline-faithful text and process helpers for the harness verbs.
 *
 * A shell pipeline has exact, non-obvious byte behavior — `$( )` strips
 * trailing newlines, `head -N` cuts at the Nth newline, `tr '\n' ';'` maps
 * EVERY newline including a terminal one — and every deploy/verify message
 * that embeds command output is built to that same contract. Each helper
 * here is one such pipeline stage, reproduced precisely, so a check detail
 * cannot drift by a trailing separator.
 */
import { spawnSync } from 'node:child_process';
import { isFile } from '../../util/fs-predicates.js';
import { sealOf } from '../../journal/seals.js';

/** `$( … )` — command substitution strips ALL trailing newlines. */
export function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

/**
 * `printf '%s' "$s" | head -N` — everything up to and including the Nth
 * newline, or the whole (unterminated) string when it has fewer.
 */
export function shHead(s: string, n: number): string {
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const nl = s.indexOf('\n', idx);
    if (nl === -1) return s;
    idx = nl + 1;
  }
  return s.slice(0, idx);
}

/** `tr '\n' <ch>` — every newline, the terminal one included. */
export function trNewlines(s: string, ch: string): string {
  return s.split('\n').join(ch);
}

/** `head -1 | cut -c1-<n>` over a newline-terminated print of `s`. */
export function firstLineCut(s: string, n: number): string {
  const line = s.split('\n', 1)[0] ?? '';
  return [...line].slice(0, n).join('');
}

/**
 * `grep -E <re> | head -3 | tr '\n' ';'` — grep newline-terminates every
 * match it prints, so three-or-fewer matches all carry a trailing `;`.
 */
export function grepHead3Semis(s: string, re: RegExp): string {
  const hits = s.split('\n').filter((l) => re.test(l)).slice(0, 3);
  return hits.map((l) => l + ';').join('');
}

export interface SpawnOut {
  /** rc, with 127 (the POSIX shell convention) for a spawn that could not start. */
  rc: number;
  /** stdout then stderr, as `2>&1` collects for these sequential writers. */
  combined: string;
}

/**
 * The same collection, with the interpreter named. `spawnCombined` is this
 * with `sh`; deploy's two post-install checks run this with `process.execPath`
 * and this bundle's own path (`selfBundle`, below).
 *
 * `maxBuffer` IS NOT RAISED HERE, and that is deliberate rather than an
 * oversight. Node truncates at 1 MiB and sets `error` to ENOBUFS while leaving
 * `status` alone, so an oversized child comes back with a cut `combined` and
 * an intact verdict. Raising it — however much of an improvement it looks —
 * would be a runtime change reaching every caller of this function at once
 * (`harness verify`'s schema sweep as well as deploy's two children), made
 * in a commit that is about neither. It wants its own change with its own
 * reasoning. The self-spawn lane passes its own `maxBuffer` at the call
 * site, where the argument for it is local.
 */
export function spawnCombinedWith(
  bin: string,
  argv: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number },
): SpawnOut {
  const r = spawnSync(bin, [...argv], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === null || r.status === undefined) {
    return { rc: 127, combined: (r.stdout ?? '') + (r.stderr ?? '') };
  }
  return { rc: r.status, combined: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * This bundle's own path, so a verb can be re-invoked on the TypeScript side.
 *
 * `process.argv[1]` for the same reason `defaultScriptsDir` and
 * `graph/code-build-arm.ts` use it rather than `import.meta.url`: it is the
 * path the caller actually ran, not the ESM loader's realpath of it.
 *
 * THE ENV OVERRIDE IS THE TEST SEAM and is named rather than hidden: run
 * unbundled (vitest) `argv[1]` is the test runner, so a test exercising the
 * shell-less lane would otherwise spawn vitest with a scrumux argv. Same
 * shape, and same reasoning, as `SCRUMUX_CODE_GRAPH_SELF`.
 */
export function selfBundle(env: NodeJS.ProcessEnv): string | null {
  const override = env['SCRUMUX_SELF'];
  if (override !== undefined && override !== '') return isFile(override) ? override : null;
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return null;
  return isFile(entry) ? entry : null;
}

/** `git -C <cwd> <args>` — trimmed stdout, or null when git fails. */
export function gitOut(cwd: string, args: readonly string[]): string | null {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.replace(/\n+$/, '');
  } catch {
    return null;
  }
}

// `isFile`, `isDirectory` and `isExecutableFile` LIVED HERE and now live in
// `src/util/fs-predicates.ts`. They were three of sixteen copies of
// the same shell file tests; this module's header promises text and process
// helpers, and a `statSync` wrapper is neither. Call sites import them from
// the shared home directly — `isDirectory` is spelled `isDir` there, which is
// the name the other thirteen call sites already used.

/** POSIX single-quote escaping, for the one sh -c the schema sweep builds. */
export function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/**
 * A DELIBERATE NO-THROW WRAPPER (module brief, open question 3): an
 * unreadable file must not throw here, it must yield the EMPTY STRING --
 * silently recorded in a manifest, and never equal to a real hash in a
 * drift comparison. `sealOf` itself throws; this wrapper swallows that and
 * restores the empty-string contract deliberately, rather than "helpfully"
 * letting the throw propagate before a ruling exists on whether it should.
 * Reachable only when a file passes an existence check and then cannot be
 * read (a TOCTOU race, or a stat-able file without read permission).
 */
export function sealQuiet(p: string): string {
  try {
    return sealOf(p);
  } catch {
    return '';
  }
}
