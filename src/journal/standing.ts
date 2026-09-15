/**
 * The STANDING of a decision or an exception resolution (D-S039, SX-020).
 *
 * `decide new` used to write `ratified_by: <free text>` and no authority, so
 * an agent could record a "ratified" decision in the operator's name (Rover
 * D-0010). D-S039: nothing refuses, but a record without a resolvable
 * authority is PROPOSED, not ratified, until a person ratifies, rejects or
 * acknowledges it (in the app, through the CLI).
 *
 * ONE READING FOR EVERY READER. A record written before this has no `status`
 * and no `authority`: it reads as `ratified` with authority `unknown` — never
 * "bad", because the fleet predates the rule. A record written since carries
 * both. This module is the only place that turns a row into that answer, so
 * the views, `status`, `records check` and `authorityGuard` cannot disagree.
 *
 * FIELD NAMES ARE A SHARED CONTRACT with scrumux-app (keep them exact):
 *   decisions.json:  status "proposed"|"ratified"|"rejected", authority
 *                    "direct"|"app:<session>"|"standing:D-XXXX"|"none",
 *                    recorded_by, ratified_by, rejected_by, acknowledged_by
 *   exceptions.json: resolution_status (same three values; `status` there is
 *                    the finding's own lifecycle), authority, recorded_by,
 *                    ratified_by, rejected_by, acknowledged_by
 *
 * Dependencies: jqformat (JsonValue), refusal (JournalRefusal).
 */
import type { JsonValue } from './jqformat.js';
import { JournalRefusal } from './refusal.js';

export type Standing = 'proposed' | 'ratified' | 'rejected';

/** The authority recorded when none was given or none resolved. */
export const AUTHORITY_NONE = 'none';
/** What a reader reports for a record that predates authorities. */
export const AUTHORITY_UNKNOWN = 'unknown';

export interface StandingView {
  status: Standing;
  /** The recorded authority, `none`, or `unknown` for a legacy record. */
  authority: string;
  /** True when the record carries no standing field at all (written before D-S039). */
  legacy: boolean;
  /** Who acknowledged it, or '' when nobody has. */
  acknowledgedBy: string;
}

function strField(row: JsonValue, key: string): string {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return '';
  const v = (row as { [k: string]: JsonValue })[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Read a row's standing. `statusKey` is `status` for decisions and
 * `resolution_status` for exceptions.
 *
 * Dependencies: none beyond the row.
 */
export function standingOf(row: JsonValue, statusKey = 'status'): StandingView {
  const raw = strField(row, statusKey);
  const status: Standing | null = raw === 'proposed' || raw === 'ratified' || raw === 'rejected' ? raw : null;
  const authority = strField(row, 'authority');
  return {
    status: status ?? 'ratified',
    authority: authority !== '' ? authority : AUTHORITY_UNKNOWN,
    legacy: status === null,
    acknowledgedBy: strField(row, 'acknowledged_by'),
  };
}

/** True when a person still has something to do about this record: proposed, or legacy with no known authority, and not acknowledged. */
export function isAuthorityVariance(v: StandingView): boolean {
  if (v.acknowledgedBy !== '') return false;
  if (v.status === 'proposed') return true;
  return v.status === 'ratified' && (v.authority === AUTHORITY_UNKNOWN || v.authority === AUTHORITY_NONE);
}

/**
 * The message `authorityGuard` would refuse with, or null when `value`
 * resolves. Lets a verb that must never refuse (`decide new`) ask the same
 * question the reserved acts ask.
 *
 * Dependencies: the caller's guard function.
 */
export function authorityProblem(guard: () => void): string | null {
  try {
    guard();
    return null;
  } catch (e) {
    if (e instanceof JournalRefusal) return e.message;
    throw e;
  }
}

/**
 * The decision this row supersedes, but only when the row itself BINDS: a
 * proposed or rejected decision that names `supersedes` retires nothing until
 * a person ratifies it (D-S039). Legacy rows bind, as they always did.
 *
 * Dependencies: standingOf.
 */
export function bindingSupersedes(row: JsonValue): string | null {
  const sup = strField(row, 'supersedes');
  if (sup === '') return null;
  return standingOf(row).status === 'ratified' ? sup : null;
}
