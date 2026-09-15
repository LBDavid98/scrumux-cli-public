/**
 * The recorded output of a verify run, kept beside the journals for review
 * (SX-003, D-S016: make the evidence visible; never a gate).
 *
 * WHY A SIDECAR, NOT THE RECEIPT. The receipt in `tasks.json` is committed and
 * pushed; a verification command's output can carry anything the command
 * prints. The same tail already goes to the session transcript (the
 * EVIDENCE block). So it is written, bounded, to
 * `governance/.evidence/<TID>.<kind>.txt` -- a local, gitignored file next to
 * the records -- where the operator's control plane reads it at acceptance.
 * Absent (a receipt written by an older harness, or an unwritable directory)
 * means "no recorded output", which the app shows as unknown, not as bad.
 *
 * SELF-IGNORING. The directory carries its own `.gitignore` (`*`), so a repo
 * deployed before this needs no `.gitignore` edit and a checkout stays clean
 * (a dirty checkout blocks delivery).
 *
 * NEVER FATAL. A failed write is silent: the verdict and the receipt stand.
 *
 * Depends on: node:fs, node:path.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVIDENCE_DIR = '.evidence';
/** Lines kept, and the per-line cap -- bounded evidence, like the transcript's tail. */
export const EVIDENCE_LINES = 40;
const LINE_CAP = 400;

export type EvidenceKind = 'verify' | 'post-acceptance';

/** Where one task's evidence of one kind lives. Depends on: node:path. */
export const evidencePath = (gov: string, tid: string, kind: EvidenceKind): string =>
  join(gov, EVIDENCE_DIR, `${tid}.${kind}.txt`);

/**
 * Write the header and the last `EVIDENCE_LINES` lines of `output`.
 *
 * Depends on: `evidencePath`, node:fs.
 */
export function writeEvidence(
  gov: string, tid: string, kind: EvidenceKind,
  run: { command: string; rc: number; date: string; atEpoch: number }, output: string,
): void {
  try {
    const dir = join(gov, EVIDENCE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n');
    const lines = output.replace(/\n+$/, '').split('\n').slice(-EVIDENCE_LINES)
      .map((l) => (l.length > LINE_CAP ? `${l.slice(0, LINE_CAP)}…` : l));
    const head = [
      `# scrumux task verify evidence (${kind}) — ${tid}`,
      `# command: ${run.command}`,
      `# rc: ${run.rc}`,
      `# date: ${run.date}`,
      `# at_epoch: ${run.atEpoch}`,
      `# output (last ${EVIDENCE_LINES} lines of the verification command):`,
    ];
    writeFileSync(evidencePath(gov, tid, kind), `${[...head, ...lines].join('\n')}\n`);
  } catch { /* evidence is for review; its absence is reported as unknown */ }
}
