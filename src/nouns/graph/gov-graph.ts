/**
 * The GOVERNANCE graph.
 *
 * The journals already encode a graph: every record carries refs to other
 * records. Nothing traversed it, so provenance ("which decision governs this
 * task, which issue produced it") was reconstructed by hand every session and
 * the edges were only as good as whoever remembered to set them. D-0026 named
 * four issues as held in its decision TEXT while its `refs.issue` carried one,
 * so three re-listed as unruled for cycles; I-0023 was put to User at least
 * four times because no decision referenced it. Both are edge problems and
 * both are invisible without traversal.
 *
 * WHY THE BUILDER IS HERE, IN THE SAME FILE AS THE READERS -- UNLIKE THE CODE
 * GRAPH'S. They are not the same kind of thing. `graph code build` needs the
 * tree-sitter grammars, which is the one toolchain dependency in the whole
 * surface and the reason the reader/builder split exists at all there. This
 * builder is a traversal of JSON files with no toolchain dependency, and the
 * READ verbs cannot be separated from it, because three of them build:
 *
 *   - `gov index` rebuilds a stale index rather than reporting it (D-0043:
 *     work done through the proper channels shows green);
 *   - every reader SELF-HEALS a missing index (D-0043 again, plus I-0002:
 *     session-open Step 3 tells an agent to run `graph gov bearing`, and on a
 *     fresh deployment that failed on its first use, every time);
 *   - `loadGovIndexCurrent` rebuilds an index whose SHAPE predates the
 *     library (T-0153), which mtimes cannot see -- after a library change
 *     every journal is older than the index on disk.
 *
 * See `src/nouns/graph.ts` for the verb-level dispatch.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isFile } from '../../util/fs-predicates.js';
import { parsePreservingNumbers, RawNumber, type JsonValue } from '../../journal/jqformat.js';
import { pyDecodeMessage } from '../../schema/pyjson.js';

export class GovIndexUnreadable extends Error {}

/** the one home for "which journal owns which id prefix" (I-0031) */
export const PREFIX_JOURNAL: Readonly<Record<string, string>> = {
  E: 'design.json', F: 'design.json', S: 'design.json',
  T: 'tasks.json', SP: 'sprints.json', R: 'reviews.json',
  D: 'decisions.json', I: 'issues.json', L: 'log.json',
};

export const JOURNALS = ['design.json', 'tasks.json', 'sprints.json', 'reviews.json',
  'decisions.json', 'issues.json', 'log.json'] as const;

/** SP must be tried before S, or SP-0017 reads as a story. */
const ID_FULL = /^(?:SP|[EFSTRDIL])-\d{4}$/;

/**
 * `_ID.fullmatch(x)`, and the lookaround guards matter even under fullmatch:
 * `(?<![A-Za-z0-9-])` and `(?!\d)` can never fire at the ends of a full match,
 * so a total anchor on the same body is equivalent. Written out rather than
 * transliterated so the equivalence is checkable by reading.
 */
function isRecordId(s: string): boolean {
  return ID_FULL.test(s);
}

/**
 * Bumped whenever build() emits a SHAPE a previous index does not have.
 * Schema 2 added file nodes (T-0153) -- without this an agent asking
 * `bearing` the day the code landed would get an empty set and read it as "no
 * decision touches these files".
 */
export const GRAPH_SCHEMA = 2;

/** The two file edge kinds (T-0153, S-0064), named for the FIELD they came from. */
export const FILE_EDGE_KINDS = ['changes', 'reads'] as const;

/**
 * The phrasings an order-writer actually uses for "I am not editing this",
 * measured off the 143 distinct `expected_diff` values at HEAD rather than
 * guessed. Matched on the FIRST WORD only, so the gloss is free text.
 *
 * Deliberately NOT extended to scan the whole string for a negation: "verify_pack
 * untouched" and "two lines removed, the guard branch untouched" are real
 * edits, and a whole-string scan trades two quiet false positives for a class
 * of false NEGATIVES -- a missed change is the failure this closes.
 */
const NO_DIFF = /^(expected[\s-]+)?(none|no[\s-]+(change|changes|diff|edit|edits|new)|unchanged|untouched|read[\s-]?only|n\/?a|nil)\b/i;

export type GovGraph = { [k: string]: JsonValue };
export interface Edge { from: string; to: string; kind: string }

function obj(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RawNumber)
    ? (v as { [k: string]: JsonValue })
    : null;
}

function loadJournal(root: string, name: string): Array<{ [k: string]: JsonValue }> {
  const path = join(root, 'governance', name);
  if (!existsSync(path) || !isFile(path)) return [];
  // `json.loads(path.read_text())` -- NOT guarded. A journal that does not
  // parse raises here, and the caller (`build`) lets it out: `graph gov
  // <verb>`'s self-heal catches `Exception` and puts `str(exc)` into "no index
  // and it cannot be built — …", so the DECODER'S OWN MESSAGE is contract at
  // that surface and is reproduced rather than replaced with this parser's.
  const text = readFileSync(path, 'utf8');
  let doc: JsonValue;
  try {
    doc = parsePreservingNumbers(text);
  } catch {
    throw new Error(pyDecodeMessage(text));
  }
  const o = obj(doc);
  if (o === null) return [];
  const e = o['entries'];
  if (!Array.isArray(e)) return [];
  const out: Array<{ [k: string]: JsonValue }> = [];
  for (const row of e) {
    const r = obj(row);
    // Python keeps every element and would fail later on `.get`; every live
    // journal holds objects, and a non-object row has no id to make a node of.
    if (r !== null) out.push(r);
  }
  return out;
}

function kindOf(entry: { [k: string]: JsonValue }, journal: string): string {
  if (journal === 'design.json') {
    const k = entry['kind'];
    return typeof k === 'string' ? k : (k === undefined ? 'design' : String(k));
  }
  return {
    'tasks.json': 'task', 'sprints.json': 'sprint', 'reviews.json': 'review',
    'decisions.json': 'decision', 'issues.json': 'issue', 'log.json': 'log',
  }[journal]!;
}

/**
 * `diff_is_change` -- does this `expected_diff` describe an EDIT?
 *
 * ABSENT MEANS READ: `scrumux task order --file "path | why"` makes the third
 * pipe field optional, so most reading-list entries carry no `expected_diff`
 * at all, and the ones that do are overwhelmingly the ones the author meant
 * to change.
 */
export function diffIsChange(expectedDiff: JsonValue | undefined): boolean {
  if (typeof expectedDiff !== 'string') return false;
  // `.strip().strip("-—–:.").strip()` -- Python strips ANY of those characters
  // from both ends, repeatedly, not the sequence as a whole.
  const text = expectedDiff.trim().replace(/^[-—–:.]+/, '').replace(/[-—–:.]+$/, '').trim();
  if (text === '') return false;
  return !NO_DIFF.test(text);
}

/**
 * `order_paths` -- path -> 'changes' | 'reads' for one task entry's order.
 *
 * `expected_artifacts` wins over the reading list unconditionally: a path a
 * task will CREATE is changed by definition, and I-0064 records that those
 * paths often cannot appear in `context.files` at all because the file does
 * not exist when the order is written.
 */
export function orderPaths(entry: { [k: string]: JsonValue }): Map<string, string> {
  const order = obj(entry['task_order']) ?? {};
  const context = obj(order['context']) ?? {};
  const out = new Map<string, string>();
  const files = context['files'];
  if (Array.isArray(files)) {
    for (const f of files) {
      const fo = obj(f);
      if (fo === null) continue;
      const path = fo['path'];
      if (typeof path !== 'string' || path.trim() === '') continue;
      out.set(path.trim(), diffIsChange(fo['expected_diff']) ? 'changes' : 'reads');
    }
  }
  const artifacts = context['expected_artifacts'];
  if (Array.isArray(artifacts)) {
    for (const path of artifacts) {
      if (typeof path === 'string' && path.trim() !== '') out.set(path.trim(), 'changes');
    }
  }
  return out;
}

/** `build` -- nodes from every journal entry, edges from the refs they carry. */
export function build(root: string): GovGraph {
  const nodes = new Map<string, { [k: string]: JsonValue }>();
  const edges: Edge[] = [];
  const dangling: Edge[] = [];

  const loaded = new Map<string, Array<{ [k: string]: JsonValue }>>();
  const journalEntries = (name: string): Array<{ [k: string]: JsonValue }> => {
    let e = loaded.get(name);
    if (e === undefined) { e = loadJournal(root, name); loaded.set(name, e); }
    return e;
  };

  for (const journal of JOURNALS) {
    for (const entry of journalEntries(journal)) {
      const rid = entry['id'];
      if (typeof rid !== 'string' || rid === '') continue;
      nodes.set(rid, {
        id: rid, kind: kindOf(entry, journal), journal,
        // `or ""` -- Python's falsy chain, so an empty string or a null falls
        // through to the next field and finally to "".
        title: firstTruthy([entry['title'], entry['name'], entry['summary'], entry['narrative']]),
        status: entry['status'] === undefined ? null : entry['status'],
      });
    }
  }

  const edge = (src: string, dst: JsonValue | undefined, kind: string): void => {
    if (isFalsy(dst)) return;
    const targets = Array.isArray(dst) ? dst : [dst];
    for (const target of targets) {
      if (typeof target !== 'string' || !isRecordId(target)) continue;
      if (nodes.has(target)) edges.push({ from: src, to: target, kind });
      else dangling.push({ from: src, to: target, kind });
    }
  };

  for (const journal of JOURNALS) {
    for (const entry of journalEntries(journal)) {
      const rid = entry['id'];
      if (typeof rid !== 'string' || rid === '') continue;
      const refs = obj(entry['refs']) ?? {};
      edge(rid, refs['issue'], 'refs_issue');
      edge(rid, refs['task'], 'refs_task');
      edge(rid, entry['supersedes'], 'supersedes');
      edge(rid, entry['task'], 'on_task');
      edge(rid, entry['feature'], 'in_feature');
      edge(rid, entry['story'], 'for_story');
      edge(rid, entry['epic'], 'in_epic');
      edge(rid, entry['tasks'], 'carries');
      edge(rid, entry['features'], 'groups');
      edge(rid, entry['stories'], 'has_story');
      edge(rid, entry['dependencies'], 'depends_on');
      edge(rid, entry['source_issue'], 'from_issue');
      edge(rid, (obj(entry['validation']) ?? {})['duplicate_of'], 'duplicate_of');
    }
  }

  // --- file nodes and the two file edge kinds (T-0153) -----------------
  // Appended directly rather than through edge(): edge() guards the id regex,
  // which is what keeps a malformed ref from becoming a node, and loosening it
  // to let paths through would let typos through with them. A path that LOOKS
  // like a record id is skipped rather than collided into that record's node.
  for (const entry of journalEntries('tasks.json')) {
    const rid = entry['id'];
    if (typeof rid !== 'string' || rid === '') continue;
    for (const [path, relation] of [...orderPaths(entry).entries()].sort((a, b) => cmp(a[0], b[0]))) {
      if (isRecordId(path)) continue;
      if (!nodes.has(path)) {
        nodes.set(path, { id: path, kind: 'file', journal: null, title: '', status: null });
      }
      edges.push({ from: rid, to: path, kind: relation });
    }
  }

  const seen = new Set<string>();
  const unique: Edge[] = [];
  for (const e of edges) {
    const key = `${e.from}\0${e.to}\0${e.kind}`;
    if (!seen.has(key)) { seen.add(key); unique.push(e); }
  }
  unique.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind));

  const nodeObj: { [k: string]: JsonValue } = {};
  for (const [k, v] of nodes) nodeObj[k] = v;
  return {
    schema: GRAPH_SCHEMA,
    root,
    nodes: nodeObj,
    edges: unique.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    dangling: dangling.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
  };
}

/** Python's `a or b or c or ""` -- the first value that is not falsy. */
function firstTruthy(candidates: ReadonlyArray<JsonValue | undefined>): JsonValue {
  for (const c of candidates) {
    if (isFalsy(c)) continue;
    return c as JsonValue;
  }
  return '';
}

/** Python truthiness for the shapes a JSON value can take: None, False, "",
 *  0, [] and {} are all falsy, and every one of them can appear in a journal
 *  field that a `or` chain or an `if not dst` guard is reading. */
function isFalsy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false || v === '') return true;
  if (v instanceof RawNumber) return Number(v.text) === 0;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** Python's `sorted()` on str -- code-unit order, which agrees for record ids
 *  and repo-relative paths. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------------- storage ---

export function govIndexPath(root: string): string {
  return join(root, 'governance', 'governance-graph.json');
}

/**
 * `write_index` -- a DIRECT write, never through `write_json`'s jq path
 * (I-0058: a filter emitting no output truncates the target to zero bytes),
 * and it creates the directory it is about to write into, because a repo the
 * harness was just deployed into has no `governance/` yet (I-0111).
 *
 * The bytes are `json.dumps(graph, indent=2, ensure_ascii=False) + "\n"` and
 * NOT `jqFormat`, which is why `pyJsonDumps` below exists rather than
 * borrowing the journal serializer. See its own note for the difference.
 */
export function writeGovIndex(graph: GovGraph, path: string): void {
  const payload = pyJsonDumps(graph, 2) + '\n';
  if (payload.trim() === '') throw new Error('refusing to write an empty index');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload);
}

/**
 * `json.dumps(obj, indent=2, ensure_ascii=False)`.
 *
 * Reproduced rather than delegated to `jqFormat`, because the two differ on
 * exactly the bytes a governance record is most likely to carry: Python
 * escapes the control range as `\uXXXX` but leaves DEL (0x7f) RAW, while jq
 * escapes DEL -- and every record in this repo's journals is free text
 * written by a human. The index is not a journal, is not sealed, and is
 * rebuilt from the journals on demand, so its bytes answer to Python's
 * serializer and to nothing else.
 */
export function pyJsonDumps(value: JsonValue, indent: number, depth = 0): string {
  const pad = ' '.repeat(indent * (depth + 1));
  const padEnd = ' '.repeat(indent * depth);
  if (value === null || value === undefined) return 'null';
  if (value instanceof RawNumber) return value.text;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pyNumber(value);
  if (typeof value === 'string') return pyJsonString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[\n' + value.map((v) => pad + pyJsonDumps(v, indent, depth + 1)).join(',\n') + '\n' + padEnd + ']';
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return '{\n'
    + keys.map((k) => pad + pyJsonString(k) + ': ' + pyJsonDumps(value[k]!, indent, depth + 1)).join(',\n')
    + '\n' + padEnd + '}';
}

/**
 * How Python's encoder writes a number: `int.__repr__` or `float.__repr__`.
 * Every number this BUILDER emits is a small integer (`schema`), so
 * `String(n)` is exact; a float read back out of an index is re-emitted from
 * its RawNumber literal above and never reaches here.
 */
function pyNumber(n: number): string {
  return String(n);
}

/** Python's `json.encoder` with `ensure_ascii=False`: the short escapes, then
 *  `\uXXXX` for everything BELOW 0x20, and nothing else -- DEL stays raw. */
function pyJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') { out += '\\"'; continue; }
    if (ch === '\\') { out += '\\\\'; continue; }
    if (c === 0x08) { out += '\\b'; continue; }
    if (c === 0x09) { out += '\\t'; continue; }
    if (c === 0x0a) { out += '\\n'; continue; }
    if (c === 0x0c) { out += '\\f'; continue; }
    if (c === 0x0d) { out += '\\r'; continue; }
    if (c < 0x20) { out += '\\u' + c.toString(16).padStart(4, '0'); continue; }
    out += ch;
  }
  return out + '"';
}

/** `load_index` -- an instruction, never a traceback. */
export function loadGovIndex(path: string): GovGraph {
  let doc: JsonValue;
  const text = readFileSync(path, 'utf8');
  try {
    doc = parsePreservingNumbers(text);
  } catch {
    throw new GovIndexUnreadable(
      `${path} is not valid JSON (${pyDecodeMessage(text)}) — the index is corrupt or `
      + 'truncated; rebuild it: scrumux graph gov build',
    );
  }
  const o = obj(doc);
  if (o === null) {
    throw new GovIndexUnreadable(
      `${path} is valid JSON but not an index object — rebuild it: scrumux graph gov build`,
    );
  }
  return o;
}

/**
 * `load_index_current` -- load_index, but never hand back a graph of the wrong
 * SHAPE. Returns [graph, notice-or-null]; the notice belongs on stderr, since
 * stdout here is parsed.
 */
export function loadGovIndexCurrent(path: string, root: string): [GovGraph, string | null] {
  const doc = loadGovIndex(path);
  const schema = doc['schema'];
  const schemaNum = schema instanceof RawNumber ? Number(schema.text) : schema;
  if (schemaNum === GRAPH_SCHEMA) return [doc, null];
  const rebuilt = build(root);
  let where: string;
  try {
    writeGovIndex(rebuilt, path);
    where = 'rewritten';
  } catch {
    where = 'in memory only, the index on disk is not writable';
  }
  return [rebuilt, `index schema ${pyRepr(schema)} predates ${GRAPH_SCHEMA} — rebuilt (${where})`];
}

/** `%r` of the value read out of the index: Python's repr, for the shapes a
 *  JSON document can hold. `None` for an absent schema, a bare integer for a
 *  number, quoted for a string. */
export function pyRepr(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return 'None';
  if (v instanceof RawNumber) return v.text;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return JSON.stringify(v);
}

/** `is_stale` -- a stale governance graph answering confidently is worse than none. */
export function isStale(graphPath: string, root: string): [boolean, string] {
  if (!isFile(graphPath)) {
    return [true, `no index at ${graphPath} — run: scrumux graph gov build`];
  }
  // Shape before dates (T-0153). After a library change every journal is OLDER
  // than the index, so an mtime-only check calls a graph that cannot hold the
  // new answer "current" and the query returns an empty set that reads as
  // "nothing bears on these files".
  let onDisk: JsonValue | undefined;
  try {
    onDisk = obj(parsePreservingNumbers(readFileSync(graphPath, 'utf8')))?.['schema'];
  } catch {
    onDisk = undefined;
  }
  const onDiskNum = onDisk instanceof RawNumber ? Number(onDisk.text) : onDisk;
  if (onDiskNum !== GRAPH_SCHEMA) {
    return [true, `index schema ${pyRepr(onDisk)} predates ${GRAPH_SCHEMA} — run: scrumux graph gov build`];
  }
  const mtime = mtimeSeconds(graphPath);
  for (const name of JOURNALS) {
    const p = join(root, 'governance', name);
    if (!isFile(p)) continue;
    const m = mtimeSeconds(p);
    if (m !== null && mtime !== null && m > mtime) {
      return [true, `governance/${name} is newer than the index — run: scrumux graph gov build`];
    }
  }
  return [false, 'index is newer than every journal'];
}

function mtimeSeconds(path: string): number | null {
  try {
    return Number(statSync(path, { bigint: true }).mtimeNs) / 1e9;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- queries ---

export function edgesOf(graph: GovGraph): Edge[] {
  const e = graph['edges'];
  if (!Array.isArray(e)) return [];
  const out: Edge[] = [];
  for (const row of e) {
    const o = obj(row);
    if (o === null) continue;
    out.push({
      from: typeof o['from'] === 'string' ? o['from'] : '',
      to: typeof o['to'] === 'string' ? o['to'] : '',
      kind: typeof o['kind'] === 'string' ? o['kind'] : '',
    });
  }
  return out;
}

export function nodesOf(graph: GovGraph): { [k: string]: JsonValue } {
  return obj(graph['nodes']) ?? {};
}

export function nodeKind(graph: GovGraph, id: string): string | null {
  const n = obj(nodesOf(graph)[id]);
  if (n === null) return null;
  return typeof n['kind'] === 'string' ? n['kind'] : null;
}

export function outbound(graph: GovGraph, id: string): Edge[] {
  return edgesOf(graph).filter((e) => e.from === id);
}

export function inbound(graph: GovGraph, id: string): Edge[] {
  return edgesOf(graph).filter((e) => e.to === id);
}

const PROVENANCE_BUCKETS: Readonly<Record<string, string>> = {
  decision: 'decisions', issue: 'issues', review: 'reviews', story: 'stories',
  feature: 'features', sprint: 'sprints', log: 'log', file: 'files',
};

/**
 * `provenance` -- every decision, issue and review reachable from a task.
 * Reachability is both directions on purpose: a decision that REFERENCES a
 * task governs it just as surely as one the task points at, and it is the
 * referencing direction that carries most of this repo's rulings.
 */
export function provenance(graph: GovGraph, taskId: string): Record<string, string[]> {
  const touching = new Set<string>();
  for (const e of inbound(graph, taskId)) touching.add(e.from);
  for (const e of outbound(graph, taskId)) touching.add(e.to);
  const out: Record<string, string[]> = {
    decisions: [], issues: [], reviews: [], stories: [], features: [],
    sprints: [], log: [], files: [], other: [],
  };
  for (const rid of [...touching].sort(cmp)) {
    const kind = nodeKind(graph, rid) ?? '';
    out[PROVENANCE_BUCKETS[kind] ?? 'other']!.push(rid);
  }
  return out;
}

/**
 * `impact` -- records reachable within `depth` hops, both directions, grouped
 * by kind. File nodes are deliberately NOT walked through: every task touches
 * `.claude/scripts/scrumux`, so one hop out to a file and one back in reaches
 * nearly every task in the repo.
 */
export function impact(graph: GovGraph, nodeId: string, depth: number): {
  error?: string; reached: Record<string, string[]>; total: number; depth: number;
} {
  if (!Object.prototype.hasOwnProperty.call(nodesOf(graph), nodeId)) {
    return { error: 'unknown record id', reached: {}, total: 0, depth };
  }
  const seen = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  for (let i = 0; i < Math.max(0, depth); i += 1) {
    const next = new Set<string>();
    for (const rid of frontier) {
      for (const e of outbound(graph, rid)) next.add(e.to);
      for (const e of inbound(graph, rid)) next.add(e.from);
    }
    for (const r of [...next]) if (nodeKind(graph, r) === 'file') next.delete(r);
    for (const s of seen) next.delete(s);
    for (const s of next) seen.add(s);
    frontier = next;
    if (frontier.size === 0) break;
  }
  const grouped: Record<string, string[]> = {};
  for (const rid of [...seen].filter((r) => r !== nodeId).sort(cmp)) {
    const kind = nodeKind(graph, rid) ?? 'unknown';
    (grouped[kind] ??= []).push(rid);
  }
  return { reached: grouped, total: Object.values(grouped).reduce((a, v) => a + v.length, 0), depth };
}

/**
 * Kinds that are AUTHORED ROOTS: nothing is supposed to point at them, so
 * listing them as orphans is noise. Measured, not assumed -- before this
 * exclusion the query returned 184 "orphans" of which 88 were reviews and 40
 * decisions.
 */
const ROOT_KINDS = new Set(['epic', 'sprint', 'log', 'review', 'decision']);

/** An issue that names a task is OWNED even though nothing points at it. */
const OWNS_OUTWARD: Readonly<Record<string, ReadonlySet<string>>> = {
  issue: new Set(['refs_task']),
};

/** `orphans` -- records with no inbound governance edge (S-0044). */
export function orphans(graph: GovGraph, kinds: ReadonlySet<string> | null): {
  orphans: Array<[string, string[]]>; total: number;
} {
  const targeted = new Set(edgesOf(graph).map((e) => e.to));
  const out = new Map<string, string[]>();
  const nodes = nodesOf(graph);
  for (const rid of Object.keys(nodes)) {
    const kind = nodeKind(graph, rid) ?? '';
    if (ROOT_KINDS.has(kind)) continue;
    if (kinds !== null && !kinds.has(kind)) continue;
    if (targeted.has(rid)) continue;
    const owning = OWNS_OUTWARD[kind];
    if (owning !== undefined && outbound(graph, rid).some((e) => owning.has(e.kind))) continue;
    (out.get(kind) ?? out.set(kind, []).get(kind)!).push(rid);
  }
  const sorted: Array<[string, string[]]> = [...out.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([k, v]) => [k, [...v].sort(cmp)] as [string, string[]]);
  return { orphans: sorted, total: [...out.values()].reduce((a, v) => a + v.length, 0) };
}

// --- bearing: from a file set to the law that binds it (T-0153) ---------

/**
 * What bearing RETURNS. Stories, features and sprints are reachable from every
 * task and say nothing about a file; reviews and log entries are walked
 * THROUGH because they carry the decisions and issues raised while the file
 * was last worked, but they are not themselves law.
 */
const BEARING_KINDS = new Set(['decision', 'issue']);
const BEARING_RELAY = new Set(['review', 'log']);

/** Undirected neighbour map, built ONCE: `inbound`/`outbound` each scan the
 *  whole edge list, and bearing asks for a task's neighbours once per
 *  (path, task) pair -- a five-figure scan for an answer wanted in a second. */
function adjacency(graph: GovGraph): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of edgesOf(graph)) {
    (adj.get(e.from) ?? adj.set(e.from, new Set()).get(e.from)!).add(e.to);
    (adj.get(e.to) ?? adj.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  return adj;
}

/** Everything bearing on one task: what points at it and what it points at,
 *  plus one hop further through its reviews and log entries. */
function recordsAround(graph: GovGraph, taskId: string, adj: Map<string, Set<string>>): Set<string> {
  const first = new Set<string>();
  for (const r of adj.get(taskId) ?? []) if (nodeKind(graph, r) !== 'file') first.add(r);
  const reached = new Set(first);
  for (const rid of first) {
    if (!BEARING_RELAY.has(nodeKind(graph, rid) ?? '')) continue;
    for (const r of adj.get(rid) ?? []) if (nodeKind(graph, r) !== 'file') reached.add(r);
  }
  return reached;
}

export interface BearingPathRow { path: string; relation: string; tasks: string[] }
export interface BearingRecordRow { id: string; kind: string; path: string; relation: string; via: string }

/**
 * `bearing` -- the decisions and issues that bind a file set (S-0064).
 *
 * `task` scopes the answer to one order: that task is dropped as a SOURCE (its
 * own refs are what a caller is checking, so returning them would make the
 * check vacuous), and each path's relation is read from THAT order rather than
 * from whichever task changed it hardest. Without that, a file another task
 * edits would read as changed for an order that only lists it read-only --
 * I-0070, reintroduced.
 */
export function bearing(graph: GovGraph, paths: readonly string[], task: string | null): {
  paths: BearingPathRow[]; records: BearingRecordRow[]; total: number;
} {
  const adj = adjacency(graph);
  const byPath = new Map<string, Array<[string, string]>>();
  for (const e of edgesOf(graph)) {
    if (!(FILE_EDGE_KINDS as readonly string[]).includes(e.kind)) continue;
    (byPath.get(e.to) ?? byPath.set(e.to, []).get(e.to)!).push([e.from, e.kind]);
  }

  const pathRows: BearingPathRow[] = [];
  const found = new Map<string, BearingRecordRow>();
  for (const path of paths) {
    // `sorted(by_path.get(path, []))` sorts the (task, kind) TUPLES, so the
    // task id is the primary key and the edge kind breaks the tie.
    const touching = [...(byPath.get(path) ?? [])].sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
    let relation: string;
    if (task !== null && touching.some(([t]) => t === task)) {
      const mine = touching.filter(([t]) => t === task).map(([, k]) => k);
      relation = mine.includes('changes') ? 'changes' : 'reads';
    } else if (touching.length > 0) {
      relation = touching.some(([, k]) => k === 'changes') ? 'changes' : 'reads';
    } else {
      // not in the graph at all: no order has ever named it, so nothing is
      // known about it -- said plainly rather than reported as "no decisions
      // bear on this file"
      relation = 'absent';
    }
    pathRows.push({ path, relation, tasks: [...new Set(touching.map(([t]) => t))].sort(cmp) });
    for (const [src, kind] of touching) {
      if (task !== null && src === task) continue;
      const rel = task !== null ? relation : kind;
      for (const rid of recordsAround(graph, src, adj)) {
        const nodeK = nodeKind(graph, rid);
        if (nodeK === null || !BEARING_KINDS.has(nodeK)) continue;
        const prev = found.get(rid);
        // a record reached through a path this order CHANGES outranks the same
        // record reached through one it reads
        if (prev === undefined || (prev.relation !== 'changes' && rel === 'changes')) {
          found.set(rid, { id: rid, kind: nodeK, path, relation: rel, via: src });
        }
      }
    }
  }
  const records = [...found.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id));
  return { paths: pathRows, records, total: records.length };
}

export { isFile };
