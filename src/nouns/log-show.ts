/**
 * Reading the work log (SX-037): `log show` and the log entries a task
 * brief inlines.
 *
 * Knowledge an order depends on lived in old log entries — the Phylactery
 * export procedure in T-0003's L-0004 — and three later sessions hunted for
 * it although their orders cited it: nothing could resolve an `L-XXXX` id.
 *
 *   scrumux log show L-0004 [L-0017 ...]    those entries
 *   scrumux log show --task T-0003          every entry logged under a task
 *
 * `--json`: `data.entries` (the entries as recorded) and `data.missing` (ids
 * asked for that do not exist). An id that does not exist is reported, not
 * refused; nothing found at all exits 0 with a summary that says so.
 *
 * Dependencies: jqformat, jqlike (entriesOf, field, interp), node:fs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import type { NounContext } from './lib/context.js';
import { entriesOf, field, interp } from './lib/jqlike.js';

/** The log's rows, or [] when it is absent or does not parse. */
export function logRows(gov: string): JsonValue[] {
  try {
    return entriesOf(parsePreservingNumbers(readFileSync(join(gov, 'log.json'), 'utf8')));
  } catch {
    return [];
  }
}

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const text = (v: JsonValue | null): string => (typeof v === 'string' ? v : v === null ? '' : interp(v));

/**
 * One entry as indented lines: id, date, task, actor, title, then what was
 * done, the verification and pending items, each capped at `limit` characters
 * (0 = uncapped).
 *
 * Dependencies: field, text, cap.
 */
export function renderLogEntry(e: JsonValue, limit = 0): string[] {
  const c = (s: string): string => (limit > 0 ? cap(s, limit) : s);
  const task = text(field(e, 'task'));
  const lines = [`${text(field(e, 'id'))}  ${text(field(e, 'date'))}${task === '' ? '' : `  ${task}`}  ${text(field(e, 'actor'))}: ${text(field(e, 'title'))}`];
  const did = text(field(e, 'what_was_done'));
  if (did !== '') lines.push(`    did: ${c(did)}`);
  const ver = text(field(e, 'verification'));
  if (ver !== '') lines.push(`    verified: ${c(ver)}`);
  const pend = field(e, 'pending');
  if (Array.isArray(pend)) for (const p of pend) lines.push(`    pending: ${c(text(p))}`);
  return lines;
}

/**
 * The `L-XXXX` ids named anywhere in `texts`, each once, in order.
 *
 * Dependencies: none.
 */
export function citedLogIds(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of t.matchAll(/\bL-[0-9]{4}\b/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/**
 * `log show`. Refuses only a malformed command line.
 *
 * Dependencies: logRows, renderLogEntry.
 */
export function logShow(cli: Cli, ctx: NounContext, args: readonly string[]): never {
  const ids: string[] = [];
  let task = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--task') {
      const v = args[i + 1];
      if (v === undefined) return cli.die('log show: --task needs a value, e.g. --task T-0003');
      task = v;
      i++;
    } else if (/^L-[0-9]{4}$/.test(a)) {
      ids.push(a);
    } else {
      return cli.die(`log show: '${a}' is neither an entry id (L-0001) nor --task T-0001 — usage: scrumux log show L-0001 [L-0002 ...] | scrumux log show --task T-0001`);
    }
  }
  if (ids.length === 0 && task === '') return cli.die('log show: which entries? scrumux log show L-0001 [L-0002 ...] | scrumux log show --task T-0001');
  const rows = logRows(ctx.gov);
  const byId = (id: string): JsonValue | undefined => rows.find((e) => field(e, 'id') === id);
  const found: JsonValue[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const e = byId(id);
    if (e === undefined) missing.push(id); else found.push(e);
  }
  if (task !== '') for (const e of rows) if (field(e, 'task') === task && !found.includes(e)) found.push(e);
  for (const e of found) for (const l of renderLogEntry(e)) cli.say(l);
  if (missing.length > 0) cli.say(`not in governance/log.json: ${missing.join(', ')}`);
  cli.data({ entries: found, missing });
  return cli.emit(found.length === 0 ? `(no log entries${task === '' ? '' : ` for ${task}`})` : '');
}
