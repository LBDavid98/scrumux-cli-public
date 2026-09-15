/**
 * The slice of jq semantics the READ verbs actually depend on -- the views,
 * the sweeps AND the prose reports.
 *
 * THE ONE FILE FOR THIS, DELIBERATELY. A duplicate implementation once
 * existed for `status` and `backlog`, written against `unknown` instead of
 * `JsonValue`, and it was WRONG in a way that only showed up on real data:
 * it had never heard of `RawNumber`, so every number a journal carries
 * reached its `rank()` as a bare object, sorted after every string, and
 * compared to its neighbours by `JSON.stringify`. Measured against jq 1.7:
 * `sort_by(.rank)` over ranks 1, 2 and 10 should give 1, 2, 10, and the
 * duplicate gave 1, 10, 2 -- `backlog tasks` reordered its own priority list
 * the moment a tenth item was ranked. `"\(.n)"` had the matching bug,
 * printing `1.1` for a journal holding `1.10`. A copy nothing exercises is
 * a copy that rots; one file is the fix.
 *
 * NOT A jq INTERPRETER, and deliberately not one. Every read verb this
 * supports renders output whose SHAPE is jq's -- the MD views become files,
 * the finding lines become row names and details -- so this has to agree
 * with jq about four things and only four:
 *
 *   1. TRUTHINESS. Only `null` and `false` are falsy. `0`, `""` and `[]` are
 *      all TRUE. `if .rank then " (rank \(.rank))"` therefore fires for rank
 *      0, and a JS `if (rank)` silently would not -- a task ranked first
 *      would lose its rank annotation in BACKLOG.MD.
 *   2. INTERPOLATION. `"\(x)"` is the string itself when x is a string, and
 *      the COMPACT JSON encoding otherwise, so a null renders `null` and not
 *      the empty string.
 *   3. THE TOTAL ORDER. `sort_by`/`unique` order across types is
 *      null < false < true < numbers < strings < arrays < objects, with
 *      strings by codepoint. BACKLOG.MD sorts on `[(.rank // 9999), .id]`,
 *      which is a mixed number/string key.
 *   4. `//`. The alternative operator takes the RIGHT side when the left is
 *      null OR false -- it swallows false, which is why it must never be
 *      used to read a boolean field.
 *
 * Numbers keep their source literal (RawNumber) all the way through, because
 * jq 1.7 re-emits the digits it was given and a round trip through a double
 * would turn `1.10` into `1.1` inside a rendered view.
 */
import { RawNumber, canonNumber, jqDouble, jqString, type JsonValue } from '../../journal/jqformat.js';

/** jq truthiness: everything except `null` and `false`. */
export function truthy(v: JsonValue | undefined): boolean {
  return v !== null && v !== undefined && v !== false;
}

/** jq's `//`: the right side when the left is null or false. */
export function alt(v: JsonValue | undefined, fallback: JsonValue): JsonValue {
  return truthy(v) ? (v as JsonValue) : fallback;
}

/** `jq -c` -- one line, no spaces. The encoding `"\(x)"` uses for a non-string. */
export function compact(v: JsonValue | undefined): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof RawNumber) return canonNumber(v.text);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return jqDouble(v);
  if (typeof v === 'string') return jqString(v);
  if (Array.isArray(v)) return '[' + v.map(compact).join(',') + ']';
  const o = v as { [k: string]: JsonValue };
  return '{' + Object.keys(o).map((k) => jqString(k) + ':' + compact(o[k]!)).join(',') + '}';
}

/** `"\(v)"` -- the string itself, or its compact JSON. */
export function interp(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : compact(v);
}

/** A number's numeric value, whatever carrier it arrived in. */
export function numberOf(v: JsonValue | undefined): number | null {
  if (v instanceof RawNumber) return Number(v.text);
  if (typeof v === 'number') return v;
  return null;
}

function rank(v: JsonValue | undefined): number {
  if (v === null || v === undefined) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  if (v instanceof RawNumber || typeof v === 'number') return 3;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 5;
  return 6;
}

/**
 * jq's total order. Strings compare by CODEPOINT, which is what
 * `String.prototype.localeCompare` would not do and what a plain `<` on a JS
 * string almost does -- almost, because `<` compares UTF-16 code units and
 * puts an astral character before U+E000..U+FFFF. Compared codepoint by
 * codepoint so the two agree everywhere.
 */
export function cmp(a: JsonValue | undefined, b: JsonValue | undefined): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0:
    case 1:
    case 2:
      return 0;
    case 3: {
      const x = numberOf(a)!;
      const y = numberOf(b)!;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 4:
      return cmpString(a as string, b as string);
    case 5: {
      const x = a as JsonValue[];
      const y = b as JsonValue[];
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const c = cmp(x[i]!, y[i]!);
        if (c !== 0) return c;
      }
      return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
    }
    default: {
      // Objects compare keys-then-values in jq; no consumer here sorts
      // objects, so this is the shape rather than a hot path.
      const x = a as { [k: string]: JsonValue };
      const y = b as { [k: string]: JsonValue };
      const kx = Object.keys(x).sort(cmpString);
      const ky = Object.keys(y).sort(cmpString);
      const c = cmp(kx as unknown as JsonValue, ky as unknown as JsonValue);
      if (c !== 0) return c;
      for (const k of kx) {
        const d = cmp(x[k]!, y[k]!);
        if (d !== 0) return d;
      }
      return 0;
    }
  }
}

export function cmpString(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
}

/** `sort_by(f)` -- stable, on jq's total order over the computed key. */
export function sortBy<T>(items: readonly T[], key: (t: T) => JsonValue): T[] {
  return items
    .map((v, i) => ({ v, i, k: key(v) }))
    .sort((a, b) => cmp(a.k, b.k) || a.i - b.i)
    .map((x) => x.v);
}

/** `unique` -- sorted AND deduplicated, which is jq's contract, not just dedup. */
export function unique(items: readonly JsonValue[]): JsonValue[] {
  const sorted = [...items].sort(cmp);
  const out: JsonValue[] = [];
  for (const v of sorted) {
    if (out.length === 0 || cmp(out[out.length - 1]!, v) !== 0) out.push(v);
  }
  return out;
}

// --- field access -------------------------------------------------------
// `.foo` on null is null in jq, not an error; on a non-object it IS an error.
// Reading through returns null instead of throwing, because a validator that
// crashes on a malformed record says nothing about the other 300 records.

export function asObject(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return null;
  if (Array.isArray(v)) return null;
  if (v instanceof RawNumber) return null;
  return v as { [k: string]: JsonValue };
}

export function field(v: JsonValue | undefined, ...path: string[]): JsonValue | null {
  let cur: JsonValue | null = v ?? null;
  for (const k of path) {
    const o = asObject(cur);
    if (o === null) return null;
    cur = Object.prototype.hasOwnProperty.call(o, k) ? o[k]! : null;
  }
  return cur;
}

export function asArray(v: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(v) ? v : null;
}

export function asString(v: JsonValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

/** `.entries[]` with the `?` guard: an absent or non-array `entries` is empty. */
export function entriesOf(doc: JsonValue | undefined): JsonValue[] {
  return asArray(field(doc, 'entries')) ?? [];
}

/** `(.x // "")` for a field that is meant to be a string. */
export function strOr(v: JsonValue | undefined, fallback = ''): string {
  const a = alt(v, fallback);
  return typeof a === 'string' ? a : interp(a);
}

/** An array-valued field, or `[]` -- the `(.x // [])` idiom over a list field. */
export function arrayOf(v: JsonValue | undefined, key: string): JsonValue[] {
  return asArray(field(v, key)) ?? [];
}

// --- text rules ---------------------------------------------------------
// The prose reports (`status`, `backlog`) are assembled from `jq -r`
// pipelines whose output IS the product surface (Article 5), so they need two
// more of jq's rules that a view renderer never touches.

/**
 * `join($sep)` -- and it is NOT `Array.join`. jq renders a null element as the
 * EMPTY string, a string element raw, and anything else as its JSON form. An
 * id list with a hole in it therefore joins to `"A "`, never to `"A null"`,
 * and a port that reaches for `Array.join` prints the word `null` into a
 * session brief.
 */
export function joinJq(xs: readonly (JsonValue | undefined)[], sep: string): string {
  return xs.map((v) => (v === null || v === undefined ? '' : interp(v))).join(sep);
}

/**
 * The codepoints of a string -- jq's unit for `length` and `.[a:b]`.
 *
 * `String.prototype.length` and `.slice` count UTF-16 code units, and the
 * 150-character description truncation and the 100-character summary
 * truncation both cut text that routinely carries an emoji. Half a surrogate
 * pair is not the same bytes as jq's answer.
 */
export function codepoints(s: string): string[] {
  return Array.from(s);
}

/** `$s | length` for a string. */
export function clength(s: string): number {
  return codepoints(s).length;
}

/** `$s | .[from:to]` -- a codepoint slice, never a UTF-16 one. */
export function cslice(s: string, from: number, to: number): string {
  return codepoints(s).slice(from, to).join('');
}
