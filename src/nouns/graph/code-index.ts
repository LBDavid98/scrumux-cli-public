/**
 * The CODE-graph READER.
 *
 * THE READER/BUILDER SPLIT IS THE WHOLE POINT OF THIS FILE, and it is why the
 * builder is absent from it rather than merely unfinished. The queries are
 * pure functions over a JSON file: this module reads
 * `governance/code-graph.json` and answers from it, and it has no parser, no
 * grammar registry and no way to write an index.
 *
 * WHAT MUST STAY EXACT, and is therefore commented where it is surprising
 * rather than where it is ordinary:
 *
 *   - `languageOf` names a language whether or not a grammar exists for it,
 *     and decides an EXTENSIONLESS file by shebang. That is what lets the
 *     index say "2 php files, no grammar loaded" instead of dropping them.
 *   - "The text after the last dot" is NOT a file's suffix: `.gitignore`
 *     has no suffix at all, so it takes the shebang path. A naive
 *     `split('.').pop()` would call it a `gitignore` file and skip it.
 *   - The walk is pre-order, with the directory list and filenames both
 *     sorted, yielding a directory's own files before descending.
 *     `isStaleGraph` stops at the FIRST FIVE changed files, so the order
 *     decides which five a refusal names.
 *   - `isStaleGraph` compares mtimes against `built_at_epoch`, a FLOAT.
 *     Truncating to whole seconds made every index look stale the moment it
 *     was built, which is why the stamp is a float and why this reads it with
 *     nanosecond `stat` rather than millisecond `mtimeMs`.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parsePreservingNumbers, RawNumber, type JsonValue } from '../../journal/jqformat.js';
import { pyDecodeMessage } from '../../schema/pyjson.js';

/** A corrupt or unreadable index. `load_index`'s ValueError, with its text. */
export class IndexUnreadable extends Error {}

/**
 * mirrors context_builder's INVENTORY_SKIP so the two agree on what the repo
 * IS; a file excluded from the inventory must not appear in the graph.
 */
const SKIP_DIRS = new Set(['.git', '.venv', 'node_modules', '__pycache__', 'dist', 'build']);

/** file extension -> language name (`EXTENSION_LANGUAGE`). */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.py': 'python',
  '.sh': 'bash', '.bash': 'bash',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.cs': 'c_sharp',
};

/**
 * `SHEBANG_LANGUAGE`, in order. A shell script is often extensionless here,
 * so the `#!` line is the only reliable signal. Matched against the first 128
 * BYTES, decoded latin1 so one char is one byte and `.` cannot straddle a
 * multi-byte sequence -- the Python patterns are bytes patterns.
 */
const SHEBANG_LANGUAGE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^#!.*\b(ba|da|z|k)?sh\b/, 'bash'],
  [/^#!.*\bpython[0-9.]*\b/, 'python'],
  [/^#!.*\bnode\b/, 'javascript'],
  [/^#!.*\bruby\b/, 'ruby'],
  [/^#!.*\bphp\b/, 'php'],
];

/**
 * `pathlib.PurePath.suffix`, which is not what a `split('.')` produces.
 * CPython: the suffix is `name[i:]` for `i = name.rfind('.')` only when
 * `0 < i < len(name) - 1` -- so `.gitignore` (dot at 0) and `foo.` (dot last)
 * both have NO suffix, and an extensionless file is exactly the case the
 * shebang probe exists for.
 */
export function pySuffix(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

/**
 * `languageOf` -- the registry lookup, then the shebang, then null.
 *
 * `basename`, NOT `slice(lastIndexOf('/') + 1)`, and the difference is a
 * WIN32 DEFECT rather than a style preference. `walkTree` builds every path it
 * yields with `join()`, which answers in the HOST separator, so on Windows the
 * paths arriving here are `\`-joined and `lastIndexOf('/')` returned -1: `name`
 * became the ENTIRE ABSOLUTE PATH. `pySuffix` then took the last `.` in that
 * whole string, which for an EXTENSIONLESS file under a dotted ancestor --
 * `.claude\scripts\scrumux` -- is the dot in `.claude`. A non-empty suffix
 * that is in no registry returns null before the shebang probe, and the
 * shebang probe is the ONLY way an extensionless script is ever classified.
 * So a shell entry point the harness installs into every governed repo was
 * silently dropped from the index on Windows, and `coverage` undercounted
 * without saying so.
 *
 * `basename` is separator-aware PER PLATFORM, which is what keeps this a fix
 * and not a second bug: on POSIX a literal backslash in a FILENAME stays part
 * of the name, exactly as a POSIX shell reads it. A blanket
 * `replaceAll('\\', '/')` -- the shape `relativePosix` uses below on a value
 * that is already a host-separated PATH -- would corrupt that name here.
 *
 * NOT VERIFIED ON WINDOWS: no win32 host was available. What is verified is
 * the mechanism (`join` yields `\` on win32; `lastIndexOf('/')` is -1 in that
 * string; `pySuffix` then finds the ancestor's dot) and that `basename` gives
 * the same answer as the old expression on POSIX for every path in the corpus.
 */
export function languageOf(path: string): string | null {
  const name = basename(path);
  const suffix = pySuffix(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EXTENSION_LANGUAGE, suffix)) {
    return EXTENSION_LANGUAGE[suffix]!;
  }
  if (suffix !== '') return null;
  let head: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = readSync(fd, buf, 0, 128, 0);
      head = buf.subarray(0, n).toString('latin1');
    } finally {
      closeSync(fd);
    }
  } catch {
    // `except OSError: return None` -- an unreadable file is not a source file.
    return null;
  }
  for (const [pattern, lang] of SHEBANG_LANGUAGE) {
    if (pattern.test(head)) return lang;
  }
  return null;
}

/**
 * `_walk` -- `os.walk` with `dirnames[:] = sorted(...)` and `sorted(filenames)`.
 *
 * Pre-order: a directory's own files (sorted) come before any subdirectory's,
 * and the subdirectories are visited in sorted order. Reproduced literally
 * because `is_stale_graph` truncates at five names and the walk decides which.
 */
export function* walkTree(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // os.walk's default onerror swallows a listdir failure and yields nothing.
      continue;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    files.sort();
    for (const name of files) yield join(dir, name);
    dirs.sort();
    // Pushed in reverse so the LIFO stack pops them in sorted order.
    for (let i = dirs.length - 1; i >= 0; i -= 1) {
      const d = dirs[i]!;
      if (SKIP_DIRS.has(d)) continue;
      stack.push(join(dir, d));
    }
  }
}

// ---------------------------------------------------------------- shapes ---

export type Graph = { [k: string]: JsonValue };

function obj(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RawNumber)
    ? (v as { [k: string]: JsonValue })
    : null;
}

function str(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

function num(v: JsonValue | undefined): number | null {
  if (v instanceof RawNumber) return Number(v.text);
  if (typeof v === 'number') return v;
  return null;
}

// ------------------------------------------------------------------ git ---

/**
 * `_git` -- stdout when the command succeeded, the empty string otherwise.
 * A tree that is not a checkout is not an error here; it is one of the
 * answers, and `_short()` below renders it as "no git commit".
 */
export function git(root: string, ...args: string[]): string {
  try {
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 15000,
    });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

// -------------------------------------------------------------- loading ---

// Python's `json.JSONDecodeError` message comes from `src/schema/pyjson.ts`
// (`pyDecodeMessage`), which is CPython's scanner transcribed. It used to be a
// hand-cut copy here that reproduced only the "Expecting value" family -- the
// shape a zero-byte truncation produces (I-0058, and the reason `write_index`
// refuses to write an empty payload) -- and carried a KNOWN LIMIT note saying
// the other seven diagnostics ("Expecting ',' delimiter", "Unterminated string
// starting at", …) were missing. The limit is closed by the move, not papered
// over: the same function the schema sweep quotes now answers here.

/** `load_index` -- an instruction, never a traceback. */
export function loadIndex(path: string): Graph {
  const text = readFileSync(path, 'utf8');
  let doc: JsonValue;
  try {
    doc = parsePreservingNumbers(text);
  } catch {
    throw new IndexUnreadable(
      `${path} is not valid JSON (${pyDecodeMessage(text)}) — the index is corrupt or `
      + 'truncated; rebuild it: scrumux graph code build',
    );
  }
  const o = obj(doc);
  if (o === null) {
    throw new IndexUnreadable(
      `${path} is valid JSON but not an index object — rebuild it: scrumux graph code build`,
    );
  }
  return o;
}

/** `index_path(data_root)`. */
export function indexPath(dataRoot: string): string {
  return join(dataRoot, 'governance', 'code-graph.json');
}

// ------------------------------------------------------- age / staleness ---

export interface IndexAge {
  built_at: string;
  built_from_commit: string;
  head_commit: string;
  commits_behind: number | null;
  built_from_dirty_tree: JsonValue;
  stale: boolean;
  reason: string;
}

/** `stat().st_mtime` as Python computes it: seconds, with the ns tail. */
function mtimeSeconds(path: string): number | null {
  try {
    const s = statSync(path, { bigint: true });
    return Number(s.mtimeNs) / 1e9;
  } catch {
    return null;
  }
}

/** `is_stale_graph` -- staleness against a LOADED index, with no parser. */
export function isStaleGraph(graph: Graph, root: string): [boolean, string] {
  const prov = obj(graph['provenance']) ?? {};
  const at = num(prov['built_at_epoch']);
  const changed: string[] = [];
  for (const path of walkTree(root)) {
    let isFile = false;
    try { isFile = statSync(path).isFile(); } catch { isFile = false; }
    if (!isFile || languageOf(path) === null) continue;
    const m = mtimeSeconds(path);
    // `if at and path.stat().st_mtime > at` -- a zero or absent stamp is
    // falsy in Python, so the whole comparison is skipped and the "no build
    // stamp" arm below is what answers.
    if (at !== null && at !== 0 && m !== null && m > at) {
      changed.push(relative(root, path));
      if (changed.length >= 5) break;
    }
  }
  const filesList = Array.isArray(graph['files']) ? graph['files'] : [];
  const gone: string[] = [];
  for (const rel of filesList) {
    if (typeof rel !== 'string') continue;
    let ok = false;
    try { ok = statSync(join(root, rel)).isFile(); } catch { ok = false; }
    if (!ok) gone.push(rel);
    if (gone.length >= 5) break;
  }
  if (changed.length > 0 && gone.length > 0) {
    return [true, `${changed.length}+ source file(s) changed since the build (e.g. ${changed.join(', ')}) and `
      + `${gone.length} indexed file(s) are gone (e.g. ${gone.join(', ')})`];
  }
  if (changed.length > 0) return [true, 'source file(s) changed since the build: ' + changed.join(', ')];
  // A DELETION moves no surviving mtime (I-0085), so the walk above can never
  // see one and the index keeps answering with a phantom symbol from a file
  // that is gone. The index's own inventory is the missing half.
  if (gone.length > 0) return [true, 'indexed file(s) no longer on disk: ' + gone.join(', ')];
  if (at === null || at === 0) return [true, 'this index carries no build stamp, so its age cannot be judged'];
  return [false, 'index is newer than every source file'];
}

/** `index_age` -- answered for EVERY query, because a reader never rebuilds. */
export function indexAge(graph: Graph, root: string): IndexAge {
  const prov = obj(graph['provenance']) ?? {};
  const builtCommit = str(prov['commit']);
  const head = git(root, 'rev-parse', 'HEAD');
  let behind: number | null = null;
  if (builtCommit !== '' && head !== '' && !builtCommit.startsWith('unknown')) {
    if (builtCommit === head) behind = 0;
    else {
      const count = git(root, 'rev-list', '--count', `${builtCommit}..${head}`);
      behind = /^\d+$/.test(count) ? parseInt(count, 10) : null;
    }
  }
  const [stale, reason] = isStaleGraph(graph, root);
  return {
    built_at: typeof prov['built_at'] === 'string' ? prov['built_at'] : 'unknown',
    built_from_commit: builtCommit === '' ? 'unknown' : builtCommit,
    head_commit: head === '' ? 'unknown' : head,
    commits_behind: behind,
    // `prov.get("dirty")` -- ABSENT stays absent (null), it does not become
    // false. An index built before the field existed says "unknown", and the
    // provenance line's `if age["built_from_dirty_tree"]` reads null as false
    // without claiming the tree was clean.
    built_from_dirty_tree: prov['dirty'] === undefined ? null : prov['dirty'],
    stale,
    reason,
  };
}

// ---------------------------------------------------------------queries ---
// All pure functions of a built graph. No LLM, no I/O beyond the index.

function edgesOf(graph: Graph): Array<{ [k: string]: JsonValue }> {
  const e = graph['edges'];
  if (!Array.isArray(e)) return [];
  const out: Array<{ [k: string]: JsonValue }> = [];
  for (const row of e) {
    const o = obj(row);
    if (o !== null) out.push(o);
  }
  return out;
}

function symbolsOf(graph: Graph): { [k: string]: JsonValue } {
  return obj(graph['symbols']) ?? {};
}

/** Python's `sorted()` over str: by UTF-16 code unit here, by code point
 *  there. The two agree for every id this index holds (ASCII paths and
 *  identifiers); a non-BMP symbol name would be the one divergence, and it
 *  cannot be produced by any grammar in the registry. */
function sortedUnique(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}

export function callersOf(graph: Graph, target: string): string[] {
  return sortedUnique(edgesOf(graph).filter((e) => e['to'] === target).map((e) => str(e['from'])));
}

export function calleesOf(graph: Graph, source: string): string[] {
  return sortedUnique(edgesOf(graph).filter((e) => e['from'] === source).map((e) => str(e['to'])));
}

export function symbolsIn(graph: Graph, file: string): string[] {
  const syms = symbolsOf(graph);
  return Object.keys(syms).filter((s) => str(obj(syms[s])?.['file']) === file).sort();
}

export function findSymbol(graph: Graph, name: string): string[] {
  const syms = symbolsOf(graph);
  return Object.keys(syms).filter((s) => str(obj(syms[s])?.['name']) === name).sort();
}

export function neighbourhood(graph: Graph, target: string, depth: number): { symbols: string[]; files: string[] } {
  const seen = new Set<string>([target]);
  let frontier = new Set<string>([target]);
  for (let i = 0; i < Math.max(0, depth); i += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      for (const c of callersOf(graph, node)) next.add(c);
      for (const c of calleesOf(graph, node)) next.add(c);
    }
    for (const s of seen) next.delete(s);
    for (const s of next) seen.add(s);
    frontier = next;
    if (frontier.size === 0) break;
  }
  const syms = symbolsOf(graph);
  const symbolIds = [...seen].filter((s) => Object.prototype.hasOwnProperty.call(syms, s)).sort();
  const fileSet = new Set<string>();
  for (const s of symbolIds) fileSet.add(str(obj(syms[s])?.['file']));
  const files = Array.isArray(graph['files']) ? graph['files'] : [];
  const fileIds = new Set<string>(files.filter((f): f is string => typeof f === 'string'));
  for (const s of seen) if (fileIds.has(s)) fileSet.add(s);
  return { symbols: symbolIds, files: [...fileSet].sort() };
}
