/**
 * Tasks added to a sprint AFTER it was ratified (D-S017, SX-012).
 *
 * THE RULING. `sprint add` on a ratified sprint is allowed; it records the
 * addition as awaiting ratification, the added task is not dispatched until the
 * addition is ratified (`task brief` fails its sprint gate for it), and the
 * tasks that were already ratified are unaffected. Before this, the add
 * succeeded silently: `ratified` still named the person who ratified [T-0007]
 * while the sprint now carried [T-0007, T-0008] (Rover SP-0003).
 *
 * THE RECORD. A sprint row gains `additions: [{task, date, ratified}]`, where
 * `ratified` is null until `sprint ratify` ratifies the addition, then
 * `{by, date, authority}`. The sprint's own `ratified` block is never rewritten
 * by an addition's ratification: it stays the record of what was said yes to
 * first.
 *
 * BACKWARDS COMPATIBLE. A sprint with no `additions` field -- every journal
 * written before this, including tasks added to ratified sprints in the past --
 * has no pending additions, so nothing that dispatched yesterday refuses today.
 * Descoping an addition removes it from `tasks`; its `additions` entry stays as
 * history and no longer counts as pending.
 *
 * Depends on: `journal/jqformat.js` (JsonValue). Pure.
 */
import type { JsonValue } from '../journal/jqformat.js';

type Row = { [k: string]: JsonValue };

const asRow = (v: JsonValue | undefined): Row | null =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;

const tasksOf = (row: Row): JsonValue[] => (Array.isArray(row['tasks']) ? row['tasks'] : []);

/**
 * The task ids added to this sprint after ratification and not yet ratified,
 * restricted to tasks the sprint still carries.
 *
 * Depends on: nothing.
 */
export function pendingAdditions(row: Row): string[] {
  const adds = Array.isArray(row['additions']) ? row['additions'] : [];
  const carried = new Set(tasksOf(row).filter((t): t is string => typeof t === 'string'));
  const out: string[] = [];
  for (const a of adds) {
    const o = asRow(a);
    if (o === null || typeof o['task'] !== 'string') continue;
    if (o['ratified'] !== null && o['ratified'] !== undefined) continue;
    if (carried.has(o['task']) && !out.includes(o['task'])) out.push(o['task']);
  }
  return out;
}

/**
 * The row after adding `tid`. On a RATIFIED sprint that does not already carry
 * the task, the addition is also recorded as awaiting ratification.
 *
 * `sortUnique` is the caller's jq-`unique` port, so the tasks array keeps the
 * sort-and-dedupe contract `sprint add` has always had.
 *
 * Depends on: nothing.
 */
export function withAddition(
  row: Row, tid: string, today: string, sortUnique: (xs: JsonValue[]) => JsonValue[],
): { row: Row; awaitsRatification: boolean } {
  const base = tasksOf(row);
  const already = base.includes(tid);
  const next: Row = { ...row, tasks: sortUnique([...base, tid]), updated_at: today };
  if (row['status'] !== 'ratified' || already) return { row: next, awaitsRatification: false };
  const prior = Array.isArray(row['additions']) ? row['additions'] : [];
  next['additions'] = [...prior, { task: tid, date: today, ratified: null }];
  return { row: next, awaitsRatification: true };
}

/**
 * The row after ratifying every pending addition, or null when it has none.
 *
 * Depends on: `pendingAdditions`.
 */
export function withAdditionsRatified(row: Row, by: string, date: string, authority: string): Row | null {
  const pending = new Set(pendingAdditions(row));
  if (pending.size === 0) return null;
  const adds = Array.isArray(row['additions']) ? row['additions'] : [];
  const ratified = adds.map((a) => {
    const o = asRow(a);
    if (o === null || typeof o['task'] !== 'string' || !pending.has(o['task'])) return a;
    if (o['ratified'] !== null && o['ratified'] !== undefined) return a;
    return { ...o, ratified: { by, date, authority } };
  });
  return { ...row, additions: ratified, updated_at: date };
}

/**
 * The sprint a task is an unratified addition to, or '' when it is none.
 *
 * Depends on: `pendingAdditions`.
 */
export function unratifiedAdditionSprint(rows: readonly JsonValue[], tid: string): string {
  for (const r of rows) {
    const o = asRow(r);
    if (o === null || o['status'] !== 'ratified') continue;
    if (pendingAdditions(o).includes(tid)) return typeof o['id'] === 'string' ? o['id'] : '';
  }
  return '';
}
