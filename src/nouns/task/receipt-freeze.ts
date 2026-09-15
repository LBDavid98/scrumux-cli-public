/**
 * An accepted task's acceptance receipt is FROZEN (D-S018, SX-013).
 *
 * THE DEFECT. `task verify` overwrote `receipt` on every run, whatever the
 * task's state -- so a later session's `task verify T-0001` on work accepted
 * days earlier (a container-name collision, nothing to do with T-0001) turned
 * the accepted task's receipt red, and every later `session check` failed
 * "receipt green" on work nobody had touched (Rover I-0005/I-0008, three
 * near-identical issues filed by three sessions).
 *
 * THE RULING. After acceptance the receipt that acceptance relied on is not
 * rewritten. `task accept` copies it into `acceptance.receipt`; a later
 * `task verify` leaves `receipt` alone and appends the run to
 * `post_acceptance_checks` (newest last, the last `POST_ACCEPTANCE_KEEP`
 * kept). A red post-acceptance check is DRIFT -- surfaced by `session check`
 * as a WARN and by scrumux-app -- never a broken task.
 *
 * BACKWARDS COMPATIBLE. An accepted row written before this has no
 * `acceptance.receipt`; its live `receipt` is the frozen one (it is simply no
 * longer overwritten). A row with no `post_acceptance_checks` has no drift.
 *
 * Depends on: `journal/jqformat.js` (JsonValue, RawNumber). Pure.
 */
import { RawNumber, type JsonValue } from '../../journal/jqformat.js';

type Row = { [k: string]: JsonValue };

/** How many post-acceptance checks a task keeps. Bounded: this is a journal, not a log. */
export const POST_ACCEPTANCE_KEEP = 10;

const asRow = (v: JsonValue | undefined): Row | null =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;

/**
 * True when the row records an acceptance that stands (`acceptance.accepted === true`,
 * strictly boolean, as the write-once probe reads it).
 *
 * Depends on: nothing.
 */
export function isAccepted(row: Row): boolean {
  return asRow(row['acceptance'])?.['accepted'] === true;
}

/**
 * The receipt acceptance relied on: `acceptance.receipt`, else (older rows)
 * the live `receipt`. Null when there is none.
 *
 * Depends on: `asRow`.
 */
export function frozenReceipt(row: Row): Row | null {
  return asRow(asRow(row['acceptance'])?.['receipt']) ?? asRow(row['receipt']);
}

/**
 * The row after recording one post-acceptance verify run, keeping the newest
 * `POST_ACCEPTANCE_KEEP`. `receipt` and `acceptance` are left exactly as they were.
 *
 * Depends on: nothing.
 */
export function withPostAcceptanceCheck(row: Row, check: Row): Row {
  const prior = Array.isArray(row['post_acceptance_checks']) ? row['post_acceptance_checks'] : [];
  return { ...row, post_acceptance_checks: [...prior, check].slice(-POST_ACCEPTANCE_KEEP) };
}

/** How many pre-acceptance verify runs a task keeps in `receipt_history` (SX-034). */
export const RECEIPT_HISTORY_KEEP = 10;

/**
 * The row after recording one PRE-acceptance verify run (SX-034): the run
 * becomes `receipt` (the last receipt still wins — acceptance asks whether the
 * current state is verified) and is appended to `receipt_history`, newest
 * last, the newest `RECEIPT_HISTORY_KEEP` kept. A red run followed by a green
 * one no longer disappears: T-0014's failed check leaked vault items and only
 * the green rerun was on record. `history` is the run without per-file hashes
 * (they belong to the current receipt alone).
 *
 * Depends on: nothing.
 */
export function withReceipt(row: Row, receipt: Row, history: Row): Row {
  const prior = Array.isArray(row['receipt_history']) ? row['receipt_history'] : [];
  return { ...row, receipt, receipt_history: [...prior, history].slice(-RECEIPT_HISTORY_KEEP) };
}

/**
 * The newest post-acceptance check when it is red (rc or checks_failed non-zero),
 * else null. Only the newest counts: a later green run means the drift cleared.
 *
 * Depends on: nothing.
 */
export function redDrift(row: Row): Row | null {
  const checks = Array.isArray(row['post_acceptance_checks']) ? row['post_acceptance_checks'] : [];
  const last = asRow(checks[checks.length - 1]);
  if (last === null) return null;
  const n = (v: JsonValue | undefined): number => (v instanceof RawNumber ? Number(v.text) : Number(v ?? 0));
  return n(last['rc']) !== 0 || n(last['checks_failed']) !== 0 ? last : null;
}
