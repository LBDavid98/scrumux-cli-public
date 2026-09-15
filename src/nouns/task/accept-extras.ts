/**
 * What `task accept` does beyond recording the acceptance (cycle 2):
 *
 *   `rerunVerification` (SX-029) — acceptance re-runs the order's command
 *     under the same ceiling `task verify` gives it (`VERIFY_TIMEOUT_SECONDS`),
 *     through `runWithTimeout`, which stops the whole process group. A
 *     timeout is reported in words and nothing is accepted. It was the one
 *     unbounded `spawnSync` in the CLI: a hand-run accept could hang forever
 *     and a killed one left the check's children running.
 *   `checkFingerprint` (D-S045, SX-041) — recorded on the acceptance.
 *   `issueTell` (D-S041, SX-036) — a task created with `--issue` names its
 *     issue; acceptance TELLs the link and the command that resolves it. It
 *     never writes the issue: resolving is a person's judgement (a task can
 *     fix part of an issue).
 *
 * Dependencies: journal/timeout, fingerprint, verify (VERIFY_TIMEOUT_SECONDS),
 * shared (rows, obj, rawOr, stripTrailingNewlines).
 */
import { join } from 'node:path';
import type { Cli } from '../../cli/envelope.js';
import type { JsonValue } from '../../journal/jqformat.js';
import { runWithTimeout } from '../../journal/timeout.js';
import type { NounContext } from '../lib/context.js';
import { checkFingerprint, type CheckFingerprint } from './fingerprint.js';
import { obj, rawOr, rows, stripTrailingNewlines } from './shared.js';
import { VERIFY_TIMEOUT_SECONDS } from './verify.js';

const SHELL_SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
};

/**
 * Re-run `command` for acceptance; refuses (exit 2) on a timeout or a
 * non-zero exit, in words. Returns only when it passed.
 *
 * Dependencies: runWithTimeout, VERIFY_TIMEOUT_SECONDS.
 */
export function rerunVerification(cli: Cli, ctx: NounContext, tid: string, command: string, seconds = VERIFY_TIMEOUT_SECONDS): void {
  const started = Date.now();
  const r = runWithTimeout(seconds, command, { cwd: ctx.workRoot, env: ctx.env, capture: true, combine: true });
  const out = stripTrailingNewlines(r.stdout);
  const tail5 = out.split('\n').slice(-5).join('\n');
  if (r.timedOut) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    cli.die(`accept: ${tid}'s verification re-run was STOPPED after ${elapsed} s — it passed the ${seconds} s ceiling task verify gives an order's command, so acceptance stopped it and every process it started (SIGTERM, then SIGKILL). Nothing was accepted.\n  command: ${command}\n  output:  ${tail5}\nA check that needs longer than that cannot be accepted as it stands: make it finish inside the ceiling (split it, or move the slow part to a deployed check the operator runs), or find out why it hung.`);
  }
  // `$?` after a plain `sh -c`: 128 + the signal for the eight signals a
  // shell names, 128 for any other — the re-run's reading since I-0139.
  const code = r.signal === null ? r.code : 128 + (SHELL_SIGNALS[r.signal] ?? 0);
  if (code !== 0) {
    cli.die(`accept: ${tid}'s own verification command FAILED when re-run just now (exit ${code}), even though its receipt is green.\n  command: ${command}\n  output:  ${tail5}\nAcceptance re-runs rather than trusting a receipt, because a receipt records what happened when the agent ran it and cannot record whether the command still proves what the order asked. Either the tree changed since the receipt, or the command does not do what the receipt implies. Neither is something to accept.`);
  }
}

/**
 * The fingerprint of the files the accepted check references.
 *
 * Dependencies: checkFingerprint.
 */
export function acceptedFingerprint(ctx: NounContext, command: string): CheckFingerprint {
  return checkFingerprint(ctx.workRoot, command);
}

/**
 * TELL the issue an accepted task was created to fix, when that issue is not
 * already resolved or rejected. Silent for a task with no `issue`.
 *
 * Dependencies: rows, obj, rawOr.
 */
export function issueTell(cli: Cli, ctx: NounContext, task: { [k: string]: JsonValue } | null, tid: string): void {
  const iid = task === null || typeof task['issue'] !== 'string' ? '' : task['issue'];
  if (iid === '') return;
  const row = rows(join(ctx.gov, 'issues.json')).map((r) => obj(r)).find((o) => o !== null && o['id'] === iid) ?? null;
  const status = row === null ? 'unknown' : rawOr(row['status'], 'unknown');
  cli.data({ issue: iid, issue_status: status });
  if (status === 'resolved' || status === 'rejected') return;
  cli.tell('fixes issue', `${tid} fixes ${iid} — resolve it with scrumux issue update ${iid} --status resolved (a person's call: nothing was written to the issue, because a task can fix part of one)`);
}
