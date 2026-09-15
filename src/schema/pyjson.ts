/**
 * CPython's `json` module and CPython's `repr`, to the byte.
 *
 * WHY THIS EXISTS AT ALL. `records check`'s FAIL lines report violations as
 * Python's *values* rendered by Python's *formatter*: an enum mismatch reads
 * `f"{where}: {record!r} not one of {allowed}"`, a type mismatch names
 * `type(record).__name__`, and a journal that does not parse is reported as
 * `(JSONDecodeError: <CPython's own message>)`. Article 5 makes those strings
 * product surface, pinned by tests, so the schema checker has to render like
 * CPython, not merely validate like it. `JSON.parse` + `String(x)` reproduces
 * none of it: it loses int-vs-float (`1` and `1.0` are one type in JS and two
 * in Python, and `"type": "integer"` turns on exactly that difference), it
 * loses insertion order for keys that look like array indices, and it has no
 * repr.
 *
 * WHAT IT IS NOT. It is not a general Python emulator and it is not a second
 * JSON parser for the CLI -- `src/journal/jqformat.ts` owns the journal read
 * path and answers to jq. This answers to CPython, and the two must never be
 * merged: they are faithful to different programs.
 *
 * A SECOND CONSUMER, and why that is not scope creep. The graph verbs
 * (`code-index.ts`, `gov-graph.ts`) report an unreadable index as
 * `(<CPython's own JSONDecodeError message>)` too, so they call
 * `pyDecodeMessage` below rather than hand-cutting their own partial copy of
 * the same diagnostic. The question at both surfaces is "what would CPython
 * have printed", which is the only question this file answers.
 *
 * THE KNOWN LIMITS, stated rather than hidden (the same discipline
 * `src/nouns/graph/code-index.ts` applies to its one decode message):
 *
 *   - `repr()` of a non-ASCII string. Python asks `str.isprintable()`, which
 *     is a Unicode-category question; this treats every non-ASCII code point
 *     as printable, so a string carrying an unassigned or format character
 *     reprs raw here and as `\uXXXX` there.
 *   - `repr()` of a float outside the ordinary range. The `.0` suffix, the
 *     two-digit exponent and Python's 1e16/1e-4 switch to exponent notation
 *     are reproduced; the last-digit behaviour of a subnormal is not checked.
 *   - Python accepts `NaN`, `Infinity` and `-Infinity` as JSON. So does this,
 *     for fidelity, even though nothing in this repo can write one.
 */

/** A Python `int`. bigint, because `repr()` of a 30-digit id must be exact. */
export class PyInt {
  constructor(readonly v: bigint) {}
}

/** A Python `float`. Separate from PyInt because `"type": "integer"` is. */
export class PyFloat {
  constructor(readonly v: number) {}
}

/** A Python `dict`. A Map, so `{"1": …, "a": …}` keeps its INSERTION order --
 *  a plain object would hoist the integer-like key to the front, and the order
 *  is what `unexpected property` findings come out in. */
export type PyDict = Map<string, PyValue>;

export type PyValue = null | boolean | PyInt | PyFloat | string | PyValue[] | PyDict;

/** `json.JSONDecodeError`, carrying the message CPython would have printed. */
export class PyJsonDecodeError extends Error {}

// ------------------------------------------------------------- decoding ---

const WS = ' \t\n\r';

/**
 * `json.loads`.
 *
 * Transcribed from `json/decoder.py`'s scanner rather than invented, because
 * the ERROR POSITIONS are the part that is hard to guess and the part that
 * shows up in a finding. Measured against CPython 3 for the object, array,
 * value, delimiter and extra-data families; the four string diagnostics use
 * the C scanner's positions (the backslash, the `u`, the control character,
 * the opening quote), which is what ships in every stock build.
 *
 * @throws PyJsonDecodeError with CPython's `msg: line L column C (char N)`.
 */
export function pyLoads(text: string): PyValue {
  if (text.startsWith('﻿')) {
    throw decodeError(text, 'Unexpected UTF-8 BOM (decode using utf-8-sig)', 0);
  }
  let i = skipWs(text, 0);
  const [value, end] = scanOnce(text, i);
  i = skipWs(text, end);
  if (i !== text.length) throw decodeError(text, 'Extra data', i);
  return value;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.includes(s[i]!)) i += 1;
  return i;
}

/** `JSONDecodeError.__init__`: line and column are 1-based, char is not. */
function decodeError(doc: string, msg: string, pos: number): PyJsonDecodeError {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < pos && k < doc.length; k += 1) {
    if (doc[k] === '\n') { line += 1; lineStart = k + 1; }
  }
  const col = pos - lineStart + 1;
  return new PyJsonDecodeError(`${msg}: line ${line} column ${col} (char ${pos})`);
}

/**
 * `str(exc)` for the `json.JSONDecodeError` CPython would have raised on
 * `text` -- the one message the graph verbs quote inside their "not valid
 * JSON (…)" refusals.
 *
 * WHY IT RE-PARSES rather than being handed the failure. Its two callers
 * discovered the problem through `parsePreservingNumbers`, which answers to
 * jq, not to Python: it has no CPython positions to hand over and it refuses
 * three literals (`NaN`, `Infinity`, `+1`) that Python accepts (D-0089). The
 * decode is over a file that has already failed to parse once, so the second
 * pass costs a few microseconds on a path that is about to refuse anyway.
 *
 * THE FALLBACK IS NOT DEAD CODE. When the two parsers disagree -- text jq
 * rejects and Python accepts -- there is no CPython message to quote, and the
 * answer is the one the hand-cut copies always gave: `Expecting value` at the
 * first non-whitespace character. That is what the callers printed before this
 * function existed, so the divergence stays where D-0089 put it instead of
 * moving into an empty parenthesis.
 */
export function pyDecodeMessage(text: string): string {
  try {
    pyLoads(text);
  } catch (e) {
    if (e instanceof PyJsonDecodeError) return e.message;
  }
  return decodeError(text, 'Expecting value', skipWs(text, 0)).message;
}

/** CPython's NUMBER_RE, anchored. */
const NUMBER_RE = /^(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/;

/** `scan_once`. Returns [value, index-after]. A position with nothing
 *  scannable raises "Expecting value" AT THAT POSITION -- the StopIteration
 *  the callers translate. */
function scanOnce(s: string, idx: number): [PyValue, number] {
  const c = s[idx];
  if (c === undefined) throw decodeError(s, 'Expecting value', idx);
  if (c === '"') return scanString(s, idx + 1);
  if (c === '{') return scanObject(s, idx + 1);
  if (c === '[') return scanArray(s, idx + 1);
  if (s.startsWith('null', idx)) return [null, idx + 4];
  if (s.startsWith('true', idx)) return [true, idx + 4];
  if (s.startsWith('false', idx)) return [false, idx + 5];
  const m = NUMBER_RE.exec(s.slice(idx));
  if (m !== null && m[0] !== '') {
    const [whole, integer, frac, exp] = m;
    if (frac !== undefined || exp !== undefined) {
      return [new PyFloat(Number(whole)), idx + whole.length];
    }
    return [new PyInt(BigInt(integer!)), idx + whole.length];
  }
  // CPython's constant escapes, on by default. Nothing in this repo can write
  // one; reproduced because "the port refuses what CPython accepted" is a
  // divergence with no ruling behind it.
  if (s.startsWith('NaN', idx)) return [new PyFloat(NaN), idx + 3];
  if (s.startsWith('Infinity', idx)) return [new PyFloat(Infinity), idx + 8];
  if (s.startsWith('-Infinity', idx)) return [new PyFloat(-Infinity), idx + 9];
  throw decodeError(s, 'Expecting value', idx);
}

const ESCAPES: Record<string, string> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

/** `py_scanstring`, with the C scanner's diagnostic positions.
 *  @param end index of the first character INSIDE the quotes. */
function scanString(s: string, end: number): [string, number] {
  const begin = end - 1;
  let out = '';
  let i = end;
  for (;;) {
    if (i >= s.length) throw decodeError(s, 'Unterminated string starting at', begin);
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    if (ch === '"') return [out, i + 1];
    if (ch === '\\') {
      const esc = s[i + 1];
      if (esc === undefined) throw decodeError(s, 'Unterminated string starting at', begin);
      if (esc === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw decodeError(s, 'Invalid \\uXXXX escape', i + 1);
        let cp = parseInt(hex, 16);
        let consumed = 6;
        // The surrogate pair, exactly as CPython joins it.
        if (cp >= 0xd800 && cp <= 0xdbff && s.slice(i + 6, i + 8) === '\\u') {
          const hex2 = s.slice(i + 8, i + 12);
          if (/^[0-9a-fA-F]{4}$/.test(hex2)) {
            const lo = parseInt(hex2, 16);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              cp = 0x10000 + (((cp - 0xd800) << 10) | (lo - 0xdc00));
              consumed = 12;
            }
          }
        }
        out += String.fromCodePoint(cp);
        i += consumed;
        continue;
      }
      const rep = ESCAPES[esc];
      if (rep === undefined) throw decodeError(s, 'Invalid \\escape', i);
      out += rep;
      i += 2;
      continue;
    }
    if (code < 0x20) throw decodeError(s, 'Invalid control character at', i);
    out += ch;
    i += 1;
  }
}

/** `JSONObject`. @param end index just past the `{`. */
function scanObject(s: string, end: number): [PyDict, number] {
  const pairs: PyDict = new Map();
  let i = end;
  let nextchar = s[i];
  if (nextchar !== '"') {
    if (nextchar !== undefined && WS.includes(nextchar)) {
      i = skipWs(s, i);
      nextchar = s[i];
    }
    if (nextchar === '}') return [pairs, i + 1];
    if (nextchar !== '"') {
      throw decodeError(s, 'Expecting property name enclosed in double quotes', i);
    }
  }
  i += 1;
  for (;;) {
    const [key, afterKey] = scanString(s, i);
    i = afterKey;
    if (s[i] !== ':') {
      i = skipWs(s, i);
      if (s[i] !== ':') throw decodeError(s, "Expecting ':' delimiter", i);
    }
    i = skipWs(s, i + 1);
    const [value, afterValue] = scanOnce(s, i);
    pairs.set(key, value);
    i = skipWs(s, afterValue);
    nextchar = s[i] ?? '';
    i += 1;
    if (nextchar === '}') break;
    if (nextchar !== ',') throw decodeError(s, "Expecting ',' delimiter", i - 1);
    i = skipWs(s, i);
    nextchar = s[i] ?? '';
    i += 1;
    if (nextchar !== '"') {
      throw decodeError(s, 'Expecting property name enclosed in double quotes', i - 1);
    }
  }
  return [pairs, i];
}

/** `JSONArray`. @param end index just past the `[`. */
function scanArray(s: string, end: number): [PyValue[], number] {
  const values: PyValue[] = [];
  let i = skipWs(s, end);
  if (s[i] === ']') return [values, i + 1];
  for (;;) {
    const [value, afterValue] = scanOnce(s, i);
    values.push(value);
    i = skipWs(s, afterValue);
    const nextchar = s[i] ?? '';
    i += 1;
    if (nextchar === ']') break;
    if (nextchar !== ',') throw decodeError(s, "Expecting ',' delimiter", i - 1);
    i = skipWs(s, i);
  }
  return [values, i];
}

// ------------------------------------------------------------- the model ---

/** `type(v).__name__`, for the shapes `json.loads` can produce. */
export function pyTypeName(v: PyValue): string {
  if (v === null) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  if (v instanceof PyInt) return 'int';
  if (v instanceof PyFloat) return 'float';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/**
 * Python `==`.
 *
 * NOT `===`, and the difference is load-bearing for `enum`: in Python
 * `True == 1` and `1 == 1.0`, so a record holding `1` matches an enum listing
 * `1.0` and a record holding `true` matches an enum listing `1`. Reproducing
 * that is the point -- an enum check that is stricter than the reader it
 * replaces reports a violation the operator has never seen before.
 */
export function pyEq(a: PyValue, b: PyValue): boolean {
  const an = numericOf(a);
  const bn = numericOf(b);
  if (an !== null && bn !== null) return an === bn;
  if (an !== null || bn !== null) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]!));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k)) return false;
      if (!pyEq(v, b.get(k)!)) return false;
    }
    return true;
  }
  return false;
}

/** bool, int and float share one numeric tower in Python; str does not. */
function numericOf(v: PyValue): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof PyInt) return Number(v.v);
  if (v instanceof PyFloat) return v.v;
  return null;
}

// --------------------------------------------------------------- repr ------

/** `repr()`. */
export function pyRepr(v: PyValue): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return pyStrRepr(v);
  if (v instanceof PyInt) return v.v.toString();
  if (v instanceof PyFloat) return pyFloatRepr(v.v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  return '{' + [...v.entries()].map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`).join(', ') + '}';
}

/** `str()`. Identical to repr() except for str itself, which prints bare --
 *  which is what `f"{allowed}"` does to a schema's `enum` list. */
export function pyStr(v: PyValue): string {
  return typeof v === 'string' ? v : pyRepr(v);
}

/** Python's string repr: single quotes unless that forces an escape and
 *  double quotes would not. */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') { out += '\\' + ch; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    // The unprintable range Python escapes with \xNN. Non-ASCII is left raw:
    // see the known limit at the top of this file.
    if (c < 0x20 || c === 0x7f) { out += '\\x' + c.toString(16).padStart(2, '0'); continue; }
    out += ch;
  }
  return out + quote;
}

/**
 * `float.__repr__`. JS `String(n)` is the same shortest-roundtrip digits, and
 * differs in exactly three places: an integral float needs `.0`, the exponent
 * needs two digits, and Python switches to exponent notation at 1e16 and
 * 1e-4 where JS waits until 1e21 and 1e-7.
 */
function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  const mag = Math.abs(n);
  // `toExponential()` with no argument is the shortest mantissa that
  // round-trips -- the same digits `String(n)` would choose, in the notation
  // Python switches to earlier than JS does.
  const s = n !== 0 && (mag >= 1e16 || mag < 1e-4) ? n.toExponential() : String(n);
  const e = s.indexOf('e');
  if (e < 0) return s.includes('.') ? s : s + '.0';
  const mant = s.slice(0, e);
  const rest = s.slice(e + 1);
  const sign = rest.startsWith('-') ? '-' : '+';
  return `${mant}e${sign}${rest.replace(/^[-+]/, '').padStart(2, '0')}`;
}

// -------------------------------------------------------- small accessors --

/** `isinstance(v, dict)` as a narrowing. */
export function asDict(v: PyValue | undefined): PyDict | null {
  return v instanceof Map ? v : null;
}

/** `schema.get(key)` -- `undefined` where Python would say `None`, so an
 *  absent key and a `null` value stay distinguishable (they are in Python:
 *  `.get()` returns None for both, but every caller here tests identity). */
export function dget(d: PyDict, key: string): PyValue | undefined {
  return d.get(key);
}
