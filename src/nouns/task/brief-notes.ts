/**
 * What a task brief carries beyond the order itself (improvement cycle 2).
 * Guidance, never a gate: nothing here moves the brief's verdict.
 *
 *   `mustFailWhenLine` (SX-030/SX-031) — the declared failure case, with the
 *     forms Claude Code's allow-list can run. It matches command TEXT and
 *     strips only a few known-safe env assignments, so `VAR=bad cmd`, `env`,
 *     `export` and `bash -c` never match a rule, and a session that tries
 *     variants is probing.
 *   `WORKING_NOTES` — where to run the CLI from (SX-030), where scratch goes
 *     (D-S040, SX-026), what a refusal is (SX-031), what a nothing-remains
 *     check must do (SX-032), and background processes at close (SX-038).
 *   `citedLogBlock` (SX-037) — every `L-XXXX` the order names, inlined from
 *     the whole log (not only this task's entries), capped.
 *
 * Dependencies: log-show (logRows, renderLogEntry, citedLogIds), jqlike.
 */
import type { JsonValue } from '../../journal/jqformat.js';
import { field } from '../lib/jqlike.js';
import { citedLogIds, logRows, renderLogEntry } from '../log-show.js';

/**
 * The MUST FAIL WHEN line, or '' when the order declares none.
 *
 * Dependencies: none.
 */
export function mustFailWhenLine(failsWhen: string): string {
  if (failsWhen.trim() === '') return '';
  return `\nMUST FAIL WHEN: ${failsWhen} — prove this case turns the check red; a check that skips, cannot fail, or writes into real shared data is not evidence.`
    + '\n  Prove it in a form the allow-list runs: a test that sets the bad value itself, or a wrapper under scripts/ run as `bash scripts/<name>`.'
    + ' Never `VAR=value cmd`, `env …`, `export …` or `bash -c …` — no allow rule matches them.'
    + ' If no runnable form exists, say so in your log entry and stop: the operator proves it. Do not try variants.';
}

/** The standing notes every brief prints, one line each. */
export const WORKING_NOTES: readonly string[] = [
  'Run commands from the repo (or worktree) root and call the CLI as .claude/scripts/scrumux — `../.claude/scripts/scrumux` from a subdirectory matches no allow rule.',
  'Throwaway files go in .scratch/ at that root: it is gitignored, and `rm -rf .scratch/<name>` is allowed (D-S040). Do not create scratch anywhere else in the tree.',
  'A refused command is a stop, not a puzzle: record the exact command and refusal (scrumux issue new --type harness …) and set the task blocked with that reason. Trying `bash -n x`, then `/bin/bash -n x`, then `env bash -n x`, then `bash -c "echo hi"` to see what is gated IS probing.',
  'A "nothing remains" / cleanup check diffs the shared store against a snapshot taken BEFORE the run (and after an interrupted run) — it never enumerates the ids it expects to have removed. An assertion over an empty result proves nothing: assert the input was not empty first.',
  'Before you close, every background process you started has ended — a check still running after the session keeps writing shared data.',
];

/**
 * The texts an order cites log entries from: scope, fails_when, each file's
 * why, and its refs.
 *
 * Dependencies: field.
 */
export function orderTexts(order: JsonValue): string[] {
  const out: string[] = [];
  const push = (v: JsonValue | null): void => { if (typeof v === 'string') out.push(v); };
  push(field(order, 'scope'));
  push(field(order, 'fails_when'));
  const files = field(order, 'context', 'files');
  if (Array.isArray(files)) for (const f of files) { push(field(f, 'why')); push(field(f, 'path')); }
  const refs = field(order, 'context', 'refs');
  if (Array.isArray(refs)) for (const r of refs) push(r);
  return out;
}

/**
 * The lines of the "Log entries this order cites" block, or [] when the order
 * cites none. Each field of an entry is capped at 600 characters; an id with
 * no entry says so.
 *
 * Dependencies: orderTexts, citedLogIds, logRows, renderLogEntry.
 */
export function citedLogBlock(gov: string, order: JsonValue): string[] {
  const ids = citedLogIds(orderTexts(order));
  if (ids.length === 0) return [];
  const rows = logRows(gov);
  const lines: string[] = [];
  for (const id of ids) {
    const e = rows.find((r) => field(r, 'id') === id);
    if (e === undefined) {
      lines.push(`  ${id}: UNRESOLVED — no such entry in governance/log.json`);
      continue;
    }
    for (const l of renderLogEntry(e, 600)) lines.push(`  ${l}`);
  }
  lines.push('  (full text: scrumux log show <id>)');
  return lines;
}
