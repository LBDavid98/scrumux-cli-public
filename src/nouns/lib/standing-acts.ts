/**
 * The three acts a PERSON takes on a recorded decision or exception
 * resolution (D-S039): ratify, reject, acknowledge. Shared by `decide`
 * (decide-acts.ts) and `exception` (exception-acts.ts), so the two journals
 * answer the same act with the same fields and the same refusals.
 *
 *   ratify       --by WHO --authority direct|app:<session>|standing:D-XXXX
 *                status → ratified, authority, ratified_by, ratified_at
 *   reject       --by WHO --reason TEXT
 *                status → rejected, rejected_by, rejected_at, rejection_reason
 *   acknowledge  --by WHO [--note TEXT]
 *                status unchanged; acknowledged_by, acknowledged_at,
 *                acknowledgement_note — "seen, kept as it is"
 *
 * These ARE reserved acts, so ratify refuses an authority that does not
 * resolve (the same `authorityGuard` accept and sprint ratify use). What
 * D-S039 made non-refusing is RECORDING (`decide new`, `exception resolve`),
 * not ratifying.
 *
 * Dependencies: journal/standing (standingOf, StandingView), jqformat.
 */
import type { JsonValue } from '../../journal/jqformat.js';
import { standingOf, AUTHORITY_UNKNOWN, AUTHORITY_NONE, type StandingView } from '../../journal/standing.js';

export type ActVerb = 'ratify' | 'reject' | 'acknowledge';

export interface ActFlags { id: string; by: string; authority: string; reason: string; note: string }

/**
 * Parse `<ID> --by WHO [--authority A] [--reason T] [--note T]`. Returns the
 * refusal text instead of throwing, so the caller refuses through its own Cli.
 *
 * Dependencies: none.
 */
export function parseActFlags(noun: string, verb: ActVerb, args: readonly string[]): ActFlags | string {
  const f: ActFlags = { id: args[0] ?? '', by: '', authority: '', reason: '', note: '' };
  if (f.id === '' || f.id.startsWith('--')) return `${noun} ${verb}: which record? ${actUsage(noun, verb)}`;
  const allowed: Record<ActVerb, string[]> = {
    ratify: ['--by', '--authority'], reject: ['--by', '--reason'], acknowledge: ['--by', '--note'],
  };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    const v = args[i + 1];
    if (!allowed[verb].includes(flag)) return `${noun} ${verb}: unknown flag ${flag} — ${actUsage(noun, verb)}`;
    if (v === undefined) return `${noun} ${verb}: ${flag} needs a value — ${actUsage(noun, verb)}`;
    if (flag === '--by') f.by = v;
    else if (flag === '--authority') f.authority = v;
    else if (flag === '--reason') f.reason = v;
    else f.note = v;
  }
  if (f.by === '') return `${noun} ${verb}: --by is required — the person taking this act. ${actUsage(noun, verb)}`;
  if (verb === 'reject' && f.reason === '') {
    return `${noun} reject: --reason is required — what is wrong with it, so whoever records the next one knows. ${actUsage(noun, verb)}`;
  }
  return f;
}

/** The one usage line per verb. */
export function actUsage(noun: string, verb: ActVerb): string {
  const x = noun === 'decide' ? 'D-0001' : 'X-0001';
  if (verb === 'ratify') return `usage: scrumux ${noun} ratify ${x} --by WHO --authority direct|app:<session>|standing:D-XXXX`;
  if (verb === 'reject') return `usage: scrumux ${noun} reject ${x} --by WHO --reason TEXT`;
  return `usage: scrumux ${noun} acknowledge ${x} --by WHO [--note TEXT]`;
}

/**
 * Why this act cannot be taken on a record with this standing, or null.
 *
 *   ratify       proposed or legacy; not one already ratified with an
 *                authority, not a rejected one
 *   reject       proposed or legacy; a ratified-with-authority record is
 *                changed by a successor, not rejected
 *   acknowledge  proposed, or legacy/none authority; not rejected, not
 *                already acknowledged, not one that carries an authority
 *
 * Dependencies: none.
 */
export function actRefusal(noun: string, verb: ActVerb, id: string, v: StandingView): string | null {
  const known = v.authority !== AUTHORITY_UNKNOWN && v.authority !== AUTHORITY_NONE;
  if (v.status === 'rejected') {
    return `${noun} ${verb}: ${id} was rejected — a rejected record is not revived; record a new one`;
  }
  if (verb === 'ratify' || verb === 'reject') {
    if (v.status === 'ratified' && !v.legacy && known) {
      return `${noun} ${verb}: ${id} is already ratified (authority ${v.authority}) — ${noun === 'decide'
        ? 'a ratified decision changes only by a new one that supersedes it (scrumux decide new --supersedes)'
        : 'a ratified resolution stands; file a new finding if it was wrong'}`;
    }
    return null;
  }
  if (v.acknowledgedBy !== '') return `${noun} acknowledge: ${id} was already acknowledged by ${v.acknowledgedBy}`;
  if (v.status === 'ratified' && known) {
    return `${noun} acknowledge: ${id} carries authority ${v.authority} — there is no variance to acknowledge`;
  }
  return null;
}

/**
 * The row after the act. `statusKey` is `status` (decisions) or
 * `resolution_status` (exceptions). A legacy `ratified_by` that a ratify
 * replaces is kept as `prior_ratified_by`, so the original claim survives.
 *
 * Dependencies: none (pure).
 */
export function applyAct(
  row: { [k: string]: JsonValue }, verb: ActVerb, f: ActFlags, today: string, statusKey: string,
): { [k: string]: JsonValue } {
  if (verb === 'ratify') {
    const out: { [k: string]: JsonValue } = { ...row };
    const prior = row['ratified_by'];
    if (typeof prior === 'string' && prior !== '' && prior !== f.by) out['prior_ratified_by'] = prior;
    return { ...out, [statusKey]: 'ratified', authority: f.authority, ratified_by: f.by, ratified_at: today };
  }
  if (verb === 'reject') {
    return { ...row, [statusKey]: 'rejected', rejected_by: f.by, rejected_at: today, rejection_reason: f.reason };
  }
  return {
    ...row, acknowledged_by: f.by, acknowledged_at: today, ...(f.note === '' ? {} : { acknowledgement_note: f.note }),
  };
}

/** The standing view of a row by id in an entries array, or null when absent. */
export function rowById(entries: readonly JsonValue[], id: string): { [k: string]: JsonValue } | null {
  for (const r of entries) {
    if (r !== null && typeof r === 'object' && !Array.isArray(r) && (r as { [k: string]: JsonValue })['id'] === id) {
      return r as { [k: string]: JsonValue };
    }
  }
  return null;
}

/** The standing fields an act or a re-resolve writes — cleared before a re-resolve writes its own. */
export const STANDING_FIELDS = [
  'ratified_by', 'ratified_at', 'rejected_by', 'rejected_at', 'rejection_reason',
  'acknowledged_by', 'acknowledged_at', 'acknowledgement_note', 'authority_claimed',
] as const;

/** A copy of `row` without `keys`. */
export function withoutKeys(row: { [k: string]: JsonValue }, keys: readonly string[]): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
}

export { standingOf };
