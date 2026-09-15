/**
 * The journal schema sweep.
 *
 * `.claude/schemas` declares `additionalProperties: false`, full `enum` lists
 * and `required` sets across nine files, and for a long time was read by
 * NOTHING: the only two mentions of `schemas/` in the repo were a comment and
 * a path glob, while `records check` re-implemented every contract as
 * hardcoded jq. A documented contract nothing checks is the shape D-0010
 * rejects, and the jq copy was free to drift from it -- the task status enum
 * lived in four places, and widening it meant editing each by hand.
 *
 * THE SUBSET IS DELIBERATE. `type, properties, required, additionalProperties,
 * enum, items, description, $schema, title` is exactly what the nine files
 * use; a full JSON-Schema implementation would be a dependency and this is
 * none. An unsupported keyword is REPORTED (see `unsupportedKeywords`), never
 * silently ignored, because a schema author must not believe an unenforced
 * keyword is enforced.
 *
 * FOUR NON-OBVIOUS THINGS THIS SWEEP MUST GET RIGHT, beyond the schema rules
 * themselves:
 *
 * 1. THE RENDERER. Every violation line is a Python f-string over Python
 *    values -- `{record!r}`, `type(record).__name__`, `{allowed}` -- and those
 *    lines reach an operator through `records check`'s FAIL text, which
 *    Article 5 makes product surface. `src/schema/pyjson.ts` exists for that
 *    half and for nothing else.
 *
 * 2. int VS float. `"type": "integer"` is the one rule that cannot be written
 *    against `JSON.parse`: `1` and `1.0` are one type in JavaScript and two in
 *    Python, and a `rank` of `2.0` conforms in the first reading and does not
 *    in the second. Python's reading is the contract.
 *
 * 3. KEY ORDER. `unexpected property` findings come out in the order the
 *    record's keys were parsed. A plain JS object hoists integer-like keys to
 *    the front; the Map in pyjson.ts does not.
 *
 * 4. A BROKEN SCHEMA OR JOURNAL IS LOUD. This sweep's per-pair `try`/`catch`
 *    turns a crash into a printed finding rather than a traceback, and the exception
 *    TEXT is part of the line. The families a governed repo actually produces
 *    -- a journal that does not parse, a schema file that is gone -- are
 *    reproduced exactly; see `describeException` for the ones that are not.
 *
 * WHERE IT STOPS BEING FAITHFUL, stated rather than discovered later. Each of
 * these needs a SHIPPED SCHEMA FILE to hold something no schema file holds,
 * which `harness verify`'s hash check reports before this sweep is reached:
 *
 *   - `"type"` as a mapping. Python's `list(expected or [])` would take its
 *     KEYS as the wanted type names; this reads no types at all and the value
 *     conforms.
 *   - `"enum"` as anything but a list. Python's `in` would do a substring test
 *     on a string and a key test on a mapping; this reports a violation.
 *   - `"type"` as a list mixing strings with non-strings. Python's
 *     `'|'.join` raises TypeError; this renders the non-string with `str()`.
 *
 * No LLM anywhere in this path (D-0001): a record either conforms or it does
 * not, and that is not a judgement call.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDir, isFile } from '../util/fs-predicates.js';
import {
  PyFloat, PyInt, PyJsonDecodeError, pyEq, pyLoads, pyRepr, pyStr, pyTypeName,
  type PyDict, type PyValue,
} from './pyjson.js';

/** `_TYPES` -- the JSON-Schema type names this reader understands. */
const TYPE_NAMES = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

/**
 * `_KNOWN`. Anything else in a schema would be a silent no-op, which is how a
 * contract rots -- so it is reported instead.
 */
export const KNOWN = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'items',
  'description', '$schema', 'title',
]);

/**
 * `PAIRS` -- journal file to schema file, in the order the sweep prints them.
 *
 * The order is the output order and therefore contract: the findings rows
 * `records check` emits follow it, and `harness verify` shows the first three
 * lines of it. `exceptions.json` sits between issues and decisions because
 * process findings on a session are distinct from issues by User's ruling
 * (2026-08-27): an issue is a CODE-level discovery, an exception is about
 * whether the work followed the rules.
 *
 * `repo-health.json` is here because of T-0157/I-0035 -- it could not be
 * listed before that migration, since `checkJournal` reports "no entries
 * array" for anything else, so its schema existed and was read by nothing.
 */
export const PAIRS: readonly (readonly [string, string])[] = [
  ['tasks.json', 'task.schema.json'],
  ['issues.json', 'issue.schema.json'],
  ['exceptions.json', 'exception.schema.json'],
  ['decisions.json', 'decision.schema.json'],
  ['log.json', 'log-entry.schema.json'],
  ['sprints.json', 'sprint.schema.json'],
  ['repo-health.json', 'repo-health.schema.json'],
];

/**
 * `schema_dir` -- the schemas directory, under whichever harness dir this repo
 * has.
 *
 * The Python module ships INTO governed repos at the same relpath it occupies
 * in the source tree, so it is the one file that has to read both layouts. A
 * deployed repo keeps the harness in `.claude/`; the harness SOURCE repo names
 * its payload `.deploy-claude/` so Claude Code does not auto-discover the
 * deployment cargo as live session config while that cargo is being built. A
 * repo never holds both.
 *
 * `.claude` stays the default when neither is present, so the error a caller
 * sees names the path a governed repo was actually expected to have.
 */
export function schemaDir(root: string): string {
  const claude = join(root, '.claude', 'schemas');
  if (isDir(claude)) return claude;
  const deploy = join(root, '.deploy-claude', 'schemas');
  if (isDir(deploy)) return deploy;
  return claude;
}

/**
 * `unsupported_keywords` -- keywords present in the schema that this reader
 * ignores. D-0085/OQ-2: it existed in the Python since the commit that added
 * it and NOTHING called it, so an unsupported keyword was silently ignored --
 * the exact outcome the module exists to prevent.
 */
export function unsupportedKeywords(schema: PyDict, where = ''): string[] {
  const out: string[] = [];
  for (const key of schema.keys()) {
    if (!KNOWN.has(key)) out.push(`${where === '' ? '<root>' : where}: unsupported keyword '${key}'`);
  }
  const props = dictOrEmpty(schema.get('properties'));
  for (const [name, sub] of props) {
    if (sub instanceof Map) out.push(...unsupportedKeywords(sub, where === '' ? name : `${where}.${name}`));
  }
  const items = schema.get('items');
  if (items instanceof Map) out.push(...unsupportedKeywords(items, where === '' ? '[]' : `${where}[]`));
  return out;
}

/**
 * `validate` -- a list of human-readable violations. Empty means conforming.
 *
 * The three shapes that are easy to get wrong and are reproduced exactly:
 *
 *  - A UNION TYPE (`["string", "null"]`) is common here for a field that is
 *    optional-by-null rather than optional-by-absence, and a type mismatch
 *    RETURNS immediately: one line, and no cascade of child findings about a
 *    value whose shape was already wrong.
 *  - `bool` is an `int` in Python, so a boolean where a number is wanted
 *    passes `isinstance` and is caught by a second test. Silently accepting it
 *    is how contracts drift.
 *  - `enum` is checked LAST and unconditionally -- after the type and after
 *    the recursion, and whatever the type says.
 */
export function validate(record: PyValue, schema: PyDict, where = ''): string[] {
  const errs: string[] = [];
  const at = where === '' ? '<root>' : where;
  const declared = schema.get('type');
  const wanted = typeof declared === 'string'
    ? [declared]
    : (Array.isArray(declared) ? declared : []);
  const known = wanted.filter((w): w is string => typeof w === 'string' && TYPE_NAMES.has(w));
  if (known.length > 0) {
    let ok = known.some((w) => isInstance(record, w));
    if (ok && typeof record === 'boolean' && !known.includes('boolean')) ok = false;
    if (!ok) {
      return [`${at}: expected ${wanted.map((w) => pyStr(w)).join('|')}, got ${pyTypeName(record)}`];
    }
  }
  // When `type` is absent the Python infers the KIND from the value, so an
  // untyped subschema still gets its `properties` and `items` walked.
  const kind = typeof declared === 'string'
    ? declared
    : (record instanceof Map ? 'object' : (Array.isArray(record) ? 'array' : ''));

  if (kind === 'object' && record instanceof Map) {
    const props = dictOrEmpty(schema.get('properties'));
    const required = schema.get('required');
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === 'string' && !record.has(name)) {
          errs.push(`${at}: missing required '${name}'`);
        }
      }
    }
    if (schema.get('additionalProperties') === false) {
      for (const name of record.keys()) {
        if (!props.has(name)) errs.push(`${at}: unexpected property '${name}'`);
      }
    }
    for (const [name, value] of record) {
      const sub = props.get(name);
      if (sub instanceof Map) errs.push(...validate(value, sub, where === '' ? name : `${where}.${name}`));
    }
  }

  if (kind === 'array' && Array.isArray(record)) {
    const sub = schema.get('items');
    if (sub instanceof Map) {
      record.forEach((value, i) => { errs.push(...validate(value, sub, `${where}[${i}]`)); });
    }
  }

  const allowed = schema.get('enum');
  if (allowed !== undefined && allowed !== null) {
    const members = Array.isArray(allowed) ? allowed : [];
    if (!members.some((m) => pyEq(record, m))) {
      errs.push(`${at}: ${pyRepr(record)} not one of ${pyStr(allowed)}`);
    }
  }

  return errs;
}

/** `isinstance(record, _TYPES[w])`, including Python's bool-is-an-int. */
function isInstance(record: PyValue, want: string): boolean {
  switch (want) {
    case 'object': return record instanceof Map;
    case 'array': return Array.isArray(record);
    case 'string': return typeof record === 'string';
    case 'number': return record instanceof PyInt || record instanceof PyFloat || typeof record === 'boolean';
    case 'integer': return record instanceof PyInt || typeof record === 'boolean';
    case 'boolean': return typeof record === 'boolean';
    case 'null': return record === null;
    default: return false;
  }
}

/**
 * `load_schema`. Throws the way Python's `open`/`json.loads` would.
 *
 * It does NOT assert that the file holds an object, because WHERE that
 * assertion fails is observable: a schema file that parses to a list reaches
 * `validate` as `schema.get(...)` and dies with an AttributeError naming
 * `'get'`, while the coverage summary reaches it as `schema.items()` and dies
 * naming `'items'`. Checking here would produce one message for both, and the
 * first is a caught per-journal finding while the second is not caught at all.
 */
export function loadSchema(name: string, schemaRoot: string): PyValue {
  const path = join(schemaDir(schemaRoot), name);
  return pyLoads(readText(path));
}

/**
 * `check_journal` -- validate every entry of an entries-shaped journal.
 *
 * P-16/P-35, the tri-state: an ABSENT journal is not a violation. A fresh repo
 * is in that state, and reporting it here would put a finding on every repo
 * that has not yet taken its first write of that kind.
 */
export function checkJournal(journalPath: string, schemaName: string, schemaRoot: string): string[] {
  const base = basename(journalPath);
  if (!isFile(journalPath)) return [];
  const schema = loadSchema(schemaName, schemaRoot);
  const doc = pyLoads(readText(journalPath));
  if (!(doc instanceof Map)) throw attributeError(doc, 'get');
  const entries = doc.get('entries');
  if (!Array.isArray(entries)) return [`${base}: no entries array`];
  const out: string[] = [];
  for (const entry of entries) {
    // The schema is only ever DEREFERENCED here, so a journal with no entries
    // never notices that its schema is the wrong shape -- as in the Python.
    if (!(schema instanceof Map)) throw attributeError(schema, 'get');
    const rid = entry instanceof Map ? pyStr(entry.get('id') ?? '?') : '?';
    for (const err of validate(entry, schema)) out.push(`${base} ${rid} ${err}`);
  }
  return out;
}

/** What `main()` printed, and the exit code it would have returned. */
export interface SweepResult {
  /** stdout, one line per element, in the order Python printed them. */
  lines: string[];
  /** `return 1 if found else 0`. */
  rc: number;
  /**
   * Set only when the coverage loop dies the way CPython would (see
   * `sweep`). There is no real traceback to report here, so callers get the
   * exception message instead of a fabricated "Traceback (most recent call
   * last):" line. NAMED as a limitation rather than faked: the state needs
   * a shipped schema file replaced by a JSON array, which `harness
   * verify`'s hash check reports before this sweep is ever reached.
   */
  failure?: string;
}

/**
 * One violation per line, exit 1 when any is found.
 *
 * The schemas ship with the CODE (`schemaRoot`), the journals follow the DATA
 * root (`GOV_ROOT`) -- the same split every governance script makes, so a
 * sandboxed run validates the sandbox's journals against the harness's
 * contracts.
 */
export function sweep(govDir: string, schemaRoot: string): SweepResult {
  const lines: string[] = [];
  let found = 0;
  for (const [journal, schema] of PAIRS) {
    try {
      for (const err of checkJournal(join(govDir, journal), schema, schemaRoot)) {
        lines.push(err);
        found += 1;
      }
    } catch (e) {
      // A broken schema must be loud.
      lines.push(`${journal}: schema check failed (${describeException(e)})`);
      found += 1;
    }
  }
  try {
    lines.push(...unsupportedSummary(schemaRoot));
  } catch (e) {
    // THIS DELIBERATELY DIES HERE, RATHER THAN SWALLOWING THE ERROR. A
    // schema file that parses to something other than a mapping causes
    // `unsupportedSummary` to throw uncaught. What an operator sees is:
    // every finding printed so far, NO coverage line, and exit 1 -- which
    // `records check` reads as "findings" and reports without comment.
    // Swallowing this and printing the coverage line anyway would assert a
    // coverage fact this sweep did not actually compute.
    return { lines, rc: 1, failure: describeException(e) };
  }
  return { lines, rc: found > 0 ? 1 : 0 };
}

/**
 * The ONE aggregate line, never one per keyword.
 *
 * Measured when this was wired: 82 across 7 schemas. A detector that fires 82
 * times on a clean repo teaches the operator to ignore it, which is the same
 * reasoning `records check` already applies to the authority-less acceptances.
 *
 * It does NOT move the exit code: an unenforced keyword is a fact about this
 * reader's coverage, not a defect in any record. The subset is deliberate (it
 * adds no dependency); what was wrong was that nobody was told which half of
 * the contract is real.
 */
function unsupportedSummary(schemaRoot: string): string[] {
  const kinds = new Set<string>();
  let nKw = 0;
  let nSchema = 0;
  for (const [, schemaName] of PAIRS) {
    let schema: PyValue;
    try {
      schema = loadSchema(schemaName, schemaRoot);
    } catch {
      continue;
    }
    // OUTSIDE the try, as in the Python. See the catch in `sweep`.
    if (!(schema instanceof Map)) throw attributeError(schema, 'items');
    const found = unsupportedKeywords(schema);
    if (found.length === 0) continue;
    nSchema += 1;
    nKw += found.length;
    for (const line of found) {
      // `line.rsplit("'", 2)[-2]` -- the keyword between the last two quotes.
      const parts = rsplit(line, "'", 2);
      if (parts.length >= 2) kinds.add(parts[parts.length - 2]!);
    }
  }
  if (nKw === 0) return [];
  return [
    `UNSUPPORTED ${nKw} keyword(s) across ${nSchema} schema(s) declared but NOT enforced by this reader: `
    + [...kinds].sort().join(', '),
  ];
}

/**
 * `--unsupported`: the per-keyword detail the coverage warning tells an
 * operator how to print. `scrumux records check --unsupported`
 * (src/nouns/records.ts) is the CLI surface that routes here now that the
 * Python module (`python3 -m agents.lib.schema_check --unsupported`) is
 * gone; the ported behaviour is a REPORT, not an assertion, so that surface
 * exits 0 regardless of what it finds.
 */
export function unsupportedReport(schemaRoot: string): string[] {
  const out: string[] = [];
  for (const [, schemaName] of PAIRS) {
    let schema: PyValue;
    try {
      schema = loadSchema(schemaName, schemaRoot);
    } catch (e) {
      out.push(`${schemaName}: could not load (${describeException(e)})`);
      continue;
    }
    if (!(schema instanceof Map)) throw attributeError(schema, 'items');
    for (const line of unsupportedKeywords(schema)) out.push(`${schemaName}: ${line}`);
  }
  return out;
}

// ------------------------------------------------------- CPython's errors --

/**
 * `f"{exc.__class__.__name__}: {exc}"`, for the exceptions this sweep can
 * actually raise.
 *
 * REPRODUCED: `JSONDecodeError` (pyjson.ts carries CPython's own message),
 * `FileNotFoundError` and `NotADirectoryError` from a missing schema file, and
 * the `AttributeError` a document that is valid JSON but not an object
 * produces at `doc.get("entries")`.
 *
 * NOT REPRODUCED, and named rather than approximated: `UnicodeDecodeError`
 * from a journal that is not UTF-8 (Node substitutes U+FFFD where CPython
 * raises), `PermissionError`, and the `TypeError` a schema whose `required` is
 * a string rather than a list would produce -- none of which this repo has
 * produced, and each of which would need a guess at a CPython message. Those
 * surface as the Node error's own text, which is visibly not a Python
 * diagnostic rather than a convincing forgery of one.
 */
function describeException(e: unknown): string {
  if (e instanceof PyJsonDecodeError) return `JSONDecodeError: ${e.message}`;
  if (e instanceof PyAttributeError) return `AttributeError: ${e.message}`;
  if (isErrno(e, 'ENOENT')) {
    return `FileNotFoundError: [Errno 2] No such file or directory: '${errnoPath(e)}'`;
  }
  if (isErrno(e, 'ENOTDIR')) {
    return `NotADirectoryError: [Errno 20] Not a directory: '${errnoPath(e)}'`;
  }
  if (isErrno(e, 'EISDIR')) {
    return `IsADirectoryError: [Errno 21] Is a directory: '${errnoPath(e)}'`;
  }
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

class PyAttributeError extends Error {}

function attributeError(v: PyValue, attr: string): PyAttributeError {
  return new PyAttributeError(`'${pyTypeName(v)}' object has no attribute '${attr}'`);
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

function errnoPath(e: unknown): string {
  const p = (e as { path?: unknown }).path;
  return typeof p === 'string' ? p : '';
}

// ------------------------------------------------------------- plumbing ---

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function dictOrEmpty(v: PyValue | undefined): PyDict {
  // `schema.get("properties") or {}` -- Python's `or`, so a null, an empty
  // dict and an absent key all collapse to the same empty mapping.
  return v instanceof Map ? v : new Map<string, PyValue>();
}

/** Python's `str.rsplit(sep, maxsplit)`. */
function rsplit(s: string, sep: string, maxsplit: number): string[] {
  const parts: string[] = [];
  let rest = s;
  for (let n = 0; n < maxsplit; n += 1) {
    const i = rest.lastIndexOf(sep);
    if (i < 0) break;
    parts.unshift(rest.slice(i + sep.length));
    rest = rest.slice(0, i);
  }
  parts.unshift(rest);
  return parts;
}
