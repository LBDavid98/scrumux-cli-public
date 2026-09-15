/**
 * The `.jsonl` writer — `jq -c`, not `jq .`.
 *
 * A SECOND FORMATTER, NOT THE SAME ONE WITH A FLAG. `attestations.jsonl` and
 * `.scrumux/events.jsonl` are compact single lines with a trailing newline
 * per row — same string escaping as the pretty printer, no indentation, no
 * space after the colon.
 *
 * THE `.jsonl` EXTENSION IS ITSELF LOAD-BEARING: `records check` globs
 * `governance/*.json` and jq-parses every match, so a line-delimited file has
 * to stay outside that glob or the sweep chokes on it.
 *
 * The escaping is jq's, reproduced here rather than imported from
 * `journal/jqformat.ts` for one reason worth stating: this module is bundled
 * into the four wall hooks, which run on the PreToolUse hot path of every Bash
 * call. Pulling in the literal-preserving number machinery for a row whose
 * only number is `1` would put the whole journal serializer in every wall.
 * Numbers here are integers this code wrote; there is no literal to preserve.
 */
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [k: string]: JsonValue };

const ESCAPES: Readonly<Record<string, string>> = {
  '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r',
  '"': '\\"', '\\': '\\\\',
};

/**
 * jq's string escaping. Two rules `JSON.stringify` gets differently:
 *   - DEL (0x7f) IS escaped by jq and is not by JSON.stringify;
 *   - `/` is NOT escaped by either, which is worth stating because most
 *     hand-rolled serialisers escape it.
 * Non-ASCII is emitted as raw UTF-8; jq only `\u`-escapes under `-a`.
 */
export function jqString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const esc = ESCAPES[ch];
    if (esc !== undefined) { out += esc; continue; }
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out + '"';
}

/** One compact line, exactly as `jq -c` renders it. No trailing newline. */
export function jqCompact(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return jqString(value);
  if (Array.isArray(value)) return '[' + value.map(jqCompact).join(',') + ']';
  return '{' + Object.entries(value).map(([k, v]) => `${jqString(k)}:${jqCompact(v)}`).join(',') + '}';
}
