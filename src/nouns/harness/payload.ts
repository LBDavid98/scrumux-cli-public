/**
 * The payload roster: `PAYLOAD_DIRS`, `payload-exclude.list` handling,
 * `payloadFiles`, `SHIPPED_MODULE_FILES`, `MACHINERY_DOCS`,
 * `allPayloadFiles`, `srcPathOf` — plus the constant tables the two verbs
 * share.
 *
 * THE ROSTER IS TARGET-RELATIVE, AND THE SOURCE IS NOT ALWAYS LAID OUT THE
 * SAME WAY. Every path enumerated here is written as `.claude/...` because
 * that is where the file LANDS: a deployed repo's harness directory is
 * `.claude/`, always. The harness SOURCE repo is the one place that is not
 * true of — its payload directory is named `.deploy-claude/` so Claude Code
 * does not auto-discover the deployment cargo as live session config.
 * `srcPathOf` is the ONE mapping seam: a roster entry joins onto the source
 * tree through it and nowhere else.
 *
 * WALK ORDER IS CONTRACT, NOT CONVENIENCE. This walk mimics BSD
 * `/usr/bin/find` (fts, no comparator), which yields RAW readdir order — on
 * APFS that is B-tree hash order, not alphabetical — descending into a
 * directory AT THE POINT it is encountered (depth-first, pre-order). The
 * manifest's key order and deploy's item lines are both derived from this
 * walk, so it must reproduce that order byte-for-byte. Node's `readdirSync`
 * CANNOT: libuv sorts scandir results with strcmp. `opendirSync` streams the
 * raw readdir order, so the walk below uses it. Verified against
 * `/usr/bin/find` on this repo's payload (test/unit/harness-wave4h.test.ts
 * holds the comparison) — and verification matters here: comparing against a
 * shell whose `find` was silently a bfs wrapper once produced a different
 * (files-before-dirs) order entirely.
 *
 * THE DOT-FILE EXCLUSION IS PER-BASENAME, NOT A DIRECTORY PRUNE. `find …
 * ! -name '.*'` tests the entry's own name only, so the walk still DESCENDS
 * into a dot-named directory and a regular file inside one ships (module
 * brief, open item 7). A prune-based walk would silently narrow the roster.
 */
import { opendirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { isDir, isFile } from '../../util/fs-predicates.js';

/**
 * The directories that make up the payload.
 *
 * `dist` is the one entry that is a BUILD ARTIFACT rather than a source
 * file. `.deploy-claude/dist/` is gitignored here and produced by
 * `npm run build`; it lands in a target as `.claude/dist/` and carries the
 * five bundles plus `BUILD.json`.
 *
 * It is LAST in the list on purpose: the walk order below is the manifest's
 * key order and deploy's item order, and appending keeps every existing
 * ordering assertion true.
 *
 * AN UNBUILT CHECKOUT SHIPS NO BUNDLES AND DEMANDS NONE FROM THIS ROSTER.
 * `payloadFiles` returns [] for a directory that does not exist, so a clone
 * that has never run `npm run build` deploys a target with no `.claude/
 * dist/` at all. `settings.json` is copied verbatim regardless and still
 * points at those bundle paths, so it is `harness verify`'s hook-commands
 * check that catches the resulting dangling hook path — this roster does
 * not adjust for it. Roster, manifest and verify all agree by construction
 * because all three read this one walk.
 */
export const PAYLOAD_DIRS = ['scripts', 'schemas', 'rules', 'skills', 'agents', 'dist'] as const;

/**
 * THE PAYLOAD'S CONSTITUTION, UNDER A NAME DISCOVERY DOES NOT RECOGNISE.
 *
 * It lands in a target as `CLAUDE.md` at the repo root and always has. In the
 * SOURCE it is `CLAUDE.md.payload`, because Claude Code's directory discovery
 * injects a `CLAUDE.md` found in the ancestors of any file a session reads —
 * matching the FILE's name, not the directory's. Naming the payload
 * directory `.deploy-claude/` does not stop the cargo from being injected on
 * its own: grepping any file under the payload dir is enough to put a
 * DEPLOYED repo's constitution into a supervising session's context as
 * though it were instruction to that session -- which is the only reason
 * this file has an awkward name instead of `CLAUDE.md`.
 *
 * It is a CONSTANT and not a literal at the one use site, so the two
 * implementations cannot drift on it and a reader looking for "where does the
 * target's CLAUDE.md come from" finds the answer next to the roster rather
 * than buried in deploy's item lane.
 */
export const PAYLOAD_CLAUDE_MD = 'CLAUDE.md.payload';

/**
 * The journal skeletons, with the exact templates scrumux's `ensure_file`
 * calls pass. Every one is `{"entries": []}` (T-0157/I-0035).
 */
export const JOURNALS = [
  'log.json', 'decisions.json', 'issues.json', 'exceptions.json',
  'tasks.json', 'design.json', 'sprints.json', 'repo-health.json',
] as const;

/**
 * The hook chains. Names are the chain identity used in every message; the
 * COUNT is derived from this list everywhere it is printed — it used to be
 * written out by hand in five places and three of them said "five" while the
 * roster held four (T-0202).
 */
/**
 * THE SHELL CHAIN NAMES BOTH SHELL TOOLS. On Windows without Git Bash, Claude
 * Code does not register the Bash tool at ALL and routes every shell command
 * through the PowerShell tool, so a chain matched `"Bash"` alone never fires
 * there: four walls declared and dead, with nothing in the transcript to say
 * so. `missingChains` requires the declared matcher to cover BOTH names, and
 * this roster is where the requirement is spelled.
 */
export const HOOK_CHAINS = [
  'PreToolUse:Bash|PowerShell', 'PreToolUse:Read', 'PreToolUse:Edit|Write|NotebookEdit', 'SessionStart',
] as const;
export const HOOK_CHAIN_COUNT = HOOK_CHAINS.length;

/**
 * Files outside the payload directory that ship with it. EMPTY, on purpose:
 * the five `agents/lib/*.py` modules that once needed this are gone — every
 * one of them answers natively in TypeScript now (R-004), so a deployment
 * needs nothing but node.
 *
 * The mechanism stays, rather than being deleted along with them:
 * re-admitting a file outside the payload directory is one entry here, and
 * `allPayloadFiles` already skips what is not on disk.
 */
export const SHIPPED_MODULE_FILES: readonly string[] = [];

/**
 * Documents that ship like the payload rather than being seeded like a
 * skeleton. EMPTY, on purpose: `governance/enforcement-posture.md` stopped
 * shipping this way (2026-09-01), and existing targets keep their copy via
 * the deploy lane's `seeded()` declaration — stop-shipping is not the same
 * act as reclaiming.
 *
 * The mechanism stays, so re-admitting a document is one entry here.
 */
export const MACHINERY_DOCS: readonly string[] = [];

/** One surface probe row: the argv is target-relative, as installed. */
export interface SurfaceProbe {
  name: string;
  argv: string;
  /** The declared refusal (ERE), or '' when the no-op must exit 0. */
  refusal: string;
}

/**
 * The surface probes (T-0174 / I-0104). verify EXECUTES every command surface
 * it ships: presence checks can only confirm the copy happened. The argv must
 * be the CHEAPEST BOUNDED NON-MUTATING no-op that still reaches the surface's
 * real code path.
 */
export const SURFACE_PROBES: readonly SurfaceProbe[] = [
  { name: 'scrumux-help', argv: '.claude/scripts/scrumux help', refusal: '' },
  { name: 'backlog', argv: '.claude/scripts/scrumux backlog tasks', refusal: '' },
  { name: 'decide', argv: '.claude/scripts/scrumux decide help', refusal: '' },
  { name: 'epic', argv: '.claude/scripts/scrumux epic help', refusal: '' },
  { name: 'feature', argv: '.claude/scripts/scrumux feature help', refusal: '' },
  { name: 'graph-code', argv: '.claude/scripts/scrumux graph code stats', refusal: 'graph code: error: no index at' },
  { name: 'graph-gov', argv: '.claude/scripts/scrumux graph gov stats', refusal: '' },
  { name: 'harness', argv: '.claude/scripts/scrumux harness help', refusal: '' },
  { name: 'health', argv: '.claude/scripts/scrumux health help', refusal: '' },
  { name: 'issue', argv: '.claude/scripts/scrumux issue help', refusal: '' },
  { name: 'log', argv: '.claude/scripts/scrumux log help', refusal: '' },
  { name: 'memory', argv: '.claude/scripts/scrumux memory help', refusal: '' },
  { name: 'rank', argv: '.claude/scripts/scrumux rank help', refusal: '' },
  { name: 'records', argv: '.claude/scripts/scrumux records help', refusal: '' },
  { name: 'repair', argv: '.claude/scripts/scrumux repair help', refusal: '' },
  { name: 'secret', argv: '.claude/scripts/scrumux secret list', refusal: '' },
  { name: 'session', argv: '.claude/scripts/scrumux session help', refusal: '' },
  { name: 'sprint', argv: '.claude/scripts/scrumux sprint help', refusal: '' },
  { name: 'status', argv: '.claude/scripts/scrumux status session', refusal: '' },
  { name: 'story', argv: '.claude/scripts/scrumux story help', refusal: '' },
  { name: 'task-usage', argv: '.claude/scripts/scrumux task', refusal: 'scrumux task: error: task needs a verb' },
  { name: 'task-lint', argv: '.claude/scripts/scrumux task lint', refusal: 'scrumux task lint: error: usage:' },
  { name: 'task-verify', argv: '.claude/scripts/scrumux task verify', refusal: 'scrumux task verify: error: usage:' },
  { name: 'task-brief', argv: '.claude/scripts/scrumux task brief', refusal: 'scrumux task brief: error: usage:' },
  { name: 'views', argv: '.claude/scripts/scrumux views help', refusal: '' },
];

/**
 * A payload script with no bounded non-mutating no-op is declared EXEMPT with
 * its reason, and the check prints both — an exemption is a hand-wave, and a
 * hand-wave has to be visible in the JSON the app reads. An entry ending `/`
 * exempts a DIRECTORY.
 */
export const SURFACE_EXEMPT: readonly { path: string; reason: string }[] = [];

export const PROBE_TIMEOUT = 30;

/**
 * Map one roster path back onto the source tree; anything outside the
 * payload directory (`SHIPPED_MODULE_FILES`, `MACHINERY_DOCS`) has the same
 * relpath on both sides and passes through untouched.
 */
export function srcPathOf(rel: string, srcClaude: string, srcRoot: string): string {
  if (rel.startsWith('.claude/')) return `${srcClaude}/${rel.slice('.claude/'.length)}`;
  return `${srcRoot}/${rel}`;
}

/** Raw readdir order — deliberately NOT `readdirSync`, which libuv sorts. */
function rawEntries(dir: string): Dirent[] {
  const out: Dirent[] = [];
  const d = opendirSync(dir);
  try {
    let e: Dirent | null;
    while ((e = d.readSync()) !== null) out.push(e);
  } finally {
    d.closeSync();
  }
  return out;
}

/**
 * Every regular file under `base`, in BSD `/usr/bin/find -type f` order: raw
 * readdir order, descending into each directory at the point it is
 * encountered. Symlinks are neither emitted (`-type f` is the link itself
 * under find's default -P) nor followed.
 */
export function walkLikeFind(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = rawEntries(dir);
    } catch {
      return; // find prints an error and moves on; the roster sees nothing
    }
    for (const e of entries) {
      if (e.isFile()) out.push(join(dir, e.name));
      else if (e.isDirectory()) walk(join(dir, e.name));
    }
  };
  walk(base);
  return out;
}

/** One parsed line of `payload-exclude.list`. */
interface ExcludeRule {
  kind: 'exact' | 'prefix';
  path: string;
}

/**
 * Parse the exclusion list exactly as `payload_excluded` reads it: leading
 * whitespace stripped, `#` lines and blanks dropped, the line cut at the
 * first space or tab (an indented path still means what it looks like it
 * means, and a trailing comment is absorbed rather than turning the line
 * into a path that matches nothing). A line ending `/` excludes the prefix.
 */
export function parseExcludeList(text: string): ExcludeRule[] {
  const rules: ExcludeRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[ \t]+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const cutAt = line.search(/[ \t]/);
    const path = cutAt === -1 ? line : line.slice(0, cutAt);
    if (path === '') continue;
    rules.push(path.endsWith('/') ? { kind: 'prefix', path } : { kind: 'exact', path });
  }
  return rules;
}

/** `payload_excluded <repo-relative-path>` — true when the list claims it. */
export function payloadExcluded(rel: string, rules: readonly ExcludeRule[]): boolean {
  return rules.some((r) => (r.kind === 'prefix' ? rel.startsWith(r.path) : r.path === rel));
}

/** Read and parse `<srcClaude>/payload-exclude.list`; absent list = no rules. */
export function loadExcludeRules(srcClaude: string): ExcludeRule[] {
  let text: string;
  try {
    text = readFileSync(join(srcClaude, 'payload-exclude.list'), 'utf8');
  } catch {
    return [];
  }
  return parseExcludeList(text);
}

/**
 * `payload_files <dir-under-the-payload-dir>` — target-relative roster
 * entries. Dot-prefixed BASENAMES are excluded (T-0137: short-lived probe
 * scripts under a concurrent health run), `*.pyc`, `.DS_Store` and any path
 * containing `__pycache__` likewise, and the exclusion list is applied HERE,
 * inside the one walk, and nowhere else — deploy installs from this roster,
 * verify requires it, and the I-0143 prune spares only what it still names,
 * so a path excluded here is absent from all three by construction.
 */
export function payloadFiles(dir: string, srcClaude: string, rules: readonly ExcludeRule[]): string[] {
  const base = join(srcClaude, dir);
  if (!isDir(base)) return [];
  const out: string[] = [];
  for (const abs of walkLikeFind(base)) {
    const name = abs.slice(abs.lastIndexOf('/') + 1);
    if (name.endsWith('.pyc') || name === '.DS_Store' || name.startsWith('.')) continue;
    if (abs.includes('__pycache__')) continue;
    const rel = `.claude/${dir}/${abs.slice(base.length + 1)}`;
    if (payloadExcluded(rel, rules)) continue;
    out.push(rel);
  }
  return out;
}

/** `all_payload_files` — the one roster both verbs read. */
export function allPayloadFiles(srcClaude: string, srcRoot: string): string[] {
  const rules = loadExcludeRules(srcClaude);
  const out: string[] = [];
  for (const d of PAYLOAD_DIRS) out.push(...payloadFiles(d, srcClaude, rules));
  for (const m of SHIPPED_MODULE_FILES) {
    if (isFile(join(srcRoot, m))) out.push(m);
  }
  for (const m of MACHINERY_DOCS) {
    if (isFile(join(srcRoot, m))) out.push(m);
  }
  return out;
}
