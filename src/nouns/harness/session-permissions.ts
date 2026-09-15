/**
 * The passive report `harness deploy` and `harness verify` both print about
 * whether a session in the target will be ABLE to work (SX-008, D-S019):
 * Claude Code trust on the repo root, and Edit/Write in the allow-list.
 *
 * ADVISORY ROWS ONLY (D-S016; the global "new requirements fail passively"):
 * a WARN when the answer is known-bad, a NOTE when it is fine or unknown.
 * Neither touches `h.rows`, so "N/N checks pass" and the exit code are exactly
 * what they were before this report existed. Each WARN names its fix.
 *
 * Depends on: `trust.ts`, `permissions.ts`, `state.ts`.
 */
import { isFile } from '../../util/fs-predicates.js';
import { missingWriteTools } from './permissions.js';
import type { HarnessRun } from './state.js';
import { warn } from './state.js';
import { trustOf } from './trust.js';

/**
 * Print the `session-trust` and `session-write-tools` advisory rows.
 *
 * Depends on: `trustOf`, `missingWriteTools`, `warn`, `HarnessRun.cli.note`.
 */
export function reportSessionPermissions(h: HarnessRun, tset: string): void {
  const t = trustOf(h.target, h.ctx.env);
  if (t.state === 'untrusted') warn(h, 'session-trust', t.detail);
  else h.cli.note('session-trust', t.detail);

  if (!isFile(tset)) return;
  const missing = missingWriteTools(tset);
  if (missing === null) {
    h.cli.note('session-write-tools', `not checked — ${tset} does not parse, so whether a session may Edit or Write is unknown`);
  } else if (missing.length > 0) {
    warn(h, 'session-write-tools', `${tset} permissions.allow has no ${missing.join(' or ')}, so a dispatched headless session cannot change a file (nobody is there to approve it). Add ${missing.map((m) => `"${m}"`).join(' and ')} to permissions.allow — harness deploy seeds them from the current canon on its next run`);
  } else {
    h.cli.note('session-write-tools', 'permissions.allow lets a session Edit and Write');
  }
}
