/**
 * jqformat -- reproduce `jq .` output byte-for-byte.
 *
 * WHY BYTE-FOR-BYTE IS THE CONTRACT, not a nicety: the bytes this produces
 * become the journal on disk and are then SHA-256 sealed (see seals.ts).
 * Journals already deployed across the fleet had their seals computed over
 * jq-shaped bytes. One space of formatting drift here makes `records check`
 * report an untouched journal as "changed outside scrumux" -- a false
 * accusation of tampering, pointing at nobody.
 *
 * These rules were verified empirically against jq 1.7.1, not derived from
 * its docs; see docs/port/spikes/A-jqformat.md for the evidence.
 *
 *  - 2-space indent per depth level; key separator is `": "`.
 *  - `{}` and `[]` render inline, with no inner newline.
 *  - `/` is NOT escaped.
 *  - Control chars < 0x20 use \b \t \n \f \r else \u00XX -- and DEL (0x7f)
 *    IS escaped, which `JSON.stringify` does not do.
 *  - Non-ASCII is emitted as raw UTF-8; jq only \u-escapes under `-a`.
 *  - Object key order is INSERTION order. Never sorted (that is `jq -S`).
 *  - Exactly one trailing newline, including for a top-level scalar.
 *
 * NUMBERS ARE THE ENTIRE RISK SURFACE. jq 1.7 preserves the literal digits
 * of a number it did not modify, so `1.10` stays `1.10` and a 20-digit
 * integer survives intact. `JSON.parse` cannot do that -- it produces a
 * double and the literal is gone. So the reader hands back a RawNumber and
 * this re-emits its source text instead of reformatting it.
 */

/** A number as it appeared in the source, so its literal survives a rewrite. */
export class RawNumber {
  constructor(readonly text: string) {}
  toJSON(): number {
    return Number(this.text);
  }
  valueOf(): number {
    return Number(this.text);
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | RawNumber
  | JsonValue[]
  | { [k: string]: JsonValue };

const ESC: Record<number, string> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

/** jq's string escaping. Note DEL, and note that `/` is left alone. */
export function jqString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const e = ESC[c];
    if (e !== undefined) {
      out += e;
      continue;
    }
    if (c < 0x20 || c === 0x7f) {
      out += '\\u' + c.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out + '"';
}

/**
 * decNumber's to-scientific-string, which is how jq renders a PRESERVED
 * literal. Uppercase `E`, always signed, no zero padding -- and only when
 * decNumber's rule calls for it (exponent > 0, or adjusted exponent < -6).
 */
export function canonNumber(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return text;
  const sign = m[1] ?? '';
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  const expPart = m[4] ? parseInt(m[4], 10) : 0;

  let digits = intPart + fracPart;
  const exp = expPart - fracPart.length;

  const stripped = digits.replace(/^0+/, '');
  const lead = digits.length - stripped.length;
  if (lead > 0) digits = digits.slice(Math.min(lead, digits.length - 1));

  const adjusted = exp + (digits.length - 1);

  if (exp <= 0 && adjusted >= -6) {
    if (exp === 0) return sign + digits;
    const pointPos = digits.length + exp;
    if (pointPos > 0) return sign + digits.slice(0, pointPos) + '.' + digits.slice(pointPos);
    return sign + '0.' + '0'.repeat(-pointPos) + digits;
  }
  const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits[0];
  const esign = adjusted < 0 ? '-' : '+';
  return sign + mant + 'E' + esign + Math.abs(adjusted);
}

/**
 * How jq renders a number the PROGRAM computed -- the decNumber literal is
 * gone and the value is a C double through jvp_dtoa_fmt. Lowercase `e`,
 * signed, zero-padded to two digits; exponential iff
 * `decpt <= -4 || decpt > ndigits + 15`.
 */
export function jqDouble(n: number): string {
  if (Number.isNaN(n)) return 'null';
  if (!Number.isFinite(n)) {
    return n > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308';
  }
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const [mant, ex] = a.toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0';
  const decpt = parseInt(ex, 10) + 1;
  const nd = digits.length;
  if (decpt <= -4 || decpt > nd + 15) {
    const mm = nd > 1 ? digits[0] + '.' + digits.slice(1) : digits[0];
    const e = decpt - 1;
    const es = e < 0 ? '-' : '+';
    const ea = Math.abs(e);
    return sign + mm + 'e' + es + (ea < 10 ? '0' + ea : String(ea));
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (decpt >= nd) return sign + digits + '0'.repeat(decpt - nd);
  return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
}

/** Serialise exactly as `jq .` would, including the single trailing newline. */
export function jqFormat(value: JsonValue): string {
  const buf: string[] = [];
  emit(value, 0, buf);
  buf.push('\n');
  return buf.join('');
}

function emit(v: JsonValue, depth: number, buf: string[]): void {
  if (v === null || v === undefined) {
    buf.push('null');
    return;
  }
  if (v instanceof RawNumber) {
    buf.push(canonNumber(v.text));
    return;
  }
  const t = typeof v;
  if (t === 'boolean') {
    buf.push(v ? 'true' : 'false');
    return;
  }
  if (t === 'number') {
    buf.push(jqDouble(v as number));
    return;
  }
  if (t === 'string') {
    buf.push(jqString(v as string));
    return;
  }
  const pad = '  '.repeat(depth);
  const padIn = '  '.repeat(depth + 1);
  if (Array.isArray(v)) {
    if (v.length === 0) {
      buf.push('[]');
      return;
    }
    buf.push('[\n');
    for (let i = 0; i < v.length; i++) {
      buf.push(padIn);
      emit(v[i]!, depth + 1, buf);
      buf.push(i === v.length - 1 ? '\n' : ',\n');
    }
    buf.push(pad, ']');
    return;
  }
  const obj = v as { [k: string]: JsonValue };
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    buf.push('{}');
    return;
  }
  buf.push('{\n');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    buf.push(padIn, jqString(k), ': ');
    emit(obj[k]!, depth + 1, buf);
    buf.push(i === keys.length - 1 ? '\n' : ',\n');
  }
  buf.push(pad, '}');
}

/**
 * Parse JSON keeping every number's source text.
 *
 * Hand-rolled because `JSON.parse` with a reviver is NOT sufficient: the
 * reviver receives the already-converted double, so the literal is gone
 * before we can see it.
 */
export function parsePreservingNumbers(src: string): JsonValue {
  let i = 0;
  const err = (m: string): never => {
    throw new SyntaxError(`${m} at ${i}`);
  };
  const ws = (): void => {
    while (i < src.length && ' \t\n\r'.includes(src[i]!)) i++;
  };

  function value(): JsonValue {
    ws();
    const c = src[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return str();
    if (c === 't') return expect('true', true);
    if (c === 'f') return expect('false', false);
    if (c === 'n') return expect('null', null);
    // APPROVED-DIVERGENCE: D-0089 -- `NaN` falls to num() and refuses, as does
    // `Infinity`; jq accepts both. See the note at num()'s refusal site.
    return num();
  }
  function expect<T>(word: string, val: T): T {
    if (src.startsWith(word, i)) {
      i += word.length;
      return val;
    }
    return err(`expected ${word}`);
  }
  function obj(): { [k: string]: JsonValue } {
    i++;
    ws();
    const o: { [k: string]: JsonValue } = {};
    if (src[i] === '}') {
      i++;
      return o;
    }
    for (;;) {
      ws();
      if (src[i] !== '"') err('expected key');
      const k = str();
      ws();
      if (src[i] !== ':') err('expected :');
      i++;
      // Last duplicate wins, which is jq's behaviour.
      o[k] = value();
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === '}') {
        i++;
        return o;
      }
      err('expected , or }');
    }
  }
  function arr(): JsonValue[] {
    i++;
    ws();
    const a: JsonValue[] = [];
    if (src[i] === ']') {
      i++;
      return a;
    }
    for (;;) {
      a.push(value());
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ']') {
        i++;
        return a;
      }
      err('expected , or ]');
    }
  }
  function str(): string {
    i++;
    let out = '';
    for (;;) {
      const c = src[i];
      if (c === undefined) err('unterminated string');
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        i++;
        const e = src[i++];
        if (e === 'u') {
          out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
          i += 4;
        } else if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '/') out += '/';
        else if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else err(`bad escape \\${String(e)}`);
        continue;
      }
      out += c;
      i++;
    }
  }
  function num(): RawNumber {
    const start = i;
    if (src[i] === '-') i++;
    while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i++;
    if (src[i] === '.') {
      i++;
      while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i++;
    }
    if (src[i] === 'e' || src[i] === 'E') {
      i++;
      if (src[i] === '+' || src[i] === '-') i++;
      while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i++;
    }
    // APPROVED-DIVERGENCE: D-0089 -- `+1`, `Infinity` and `NaN` are accepted
    // by jq and refused here. Unreachable from any CLI verb (every field
    // arrives via --arg, which cannot carry them) and absent from every live
    // journal, so this is stricter than bash on inputs no bash path can
    // produce. Pinned as ts-STRICTER rows in test/unit/jqformat-parser.test.ts
    // so the divergence cannot widen unnoticed. `+1` refuses here because a
    // leading `+` is not consumed above; `Infinity`/`NaN` refuse in value().
    if (i === start) err('bad value');
    return new RawNumber(src.slice(start, i));
  }

  const v = value();
  // NOTE: no `ws()` here. The loop below does its own, and consuming the
  // separator twice made the first gap look like no gap at all.
  // A TOP-LEVEL VALUE STREAM IS LEGAL INPUT, exactly as it is to jq
  // (D-0089): `jq . file` over a file holding two top-level values reads
  // both and exits 0. Journals already on disk were written under jq
  // semantics, so this reader must accept anything jq would have accepted --
  // refusing a value stream here would report a journal as unreadable that
  // read fine before.
  //
  // What this returns is the FIRST value, which is what every journal
  // reader wants and every caller already assumes. The stream is accepted,
  // not preserved -- a write-back would drop the trailing values. No verb
  // reaches that path today: every journal write goes through the shape
  // guard, which requires an object with an entries array (see write.ts).
  // A SEPARATOR IS REQUIRED between top-level values, and that is what keeps
  // this from being a general loosening. Without it `--1` parses as `-`
  // followed by `-1` and `1..2` as `1.` followed by `.2`, because num() is
  // deliberately permissive about a bare `-` and a trailing `.`; both are
  // inputs jq refuses, and accepting them would widen the parser well past
  // what D-0089 ruled. A real value stream separates its values, so requiring
  // that separation accepts exactly the stream case and nothing else.
  for (;;) {
    const before = i;
    ws();
    if (i >= src.length) break;
    if (i === before) err('trailing content');
    value();
  }
  return v;
}
