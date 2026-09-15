/**
 * One `wall` event into `.scrumux/events.jsonl`.
 *
 * IT CANNOT FAIL THE CALLER. Every path returns; nothing throws. No writable
 * directory, no parseable payload, an unwritable file — all of them end the
 * same way, and the wall then refuses exactly as it always did. Recording
 * never changes WHETHER a wall blocks, only whether anyone can later count it
 * (P-08; this function is that entry's cited origin): *a wall that fails
 * because its bookkeeping failed would be worse than the write it
 * prevented.*
 *
 * WHY IT EXISTS. Without a record, a refusal leaves no trace at all —
 * stderr, exit 2, gone — so there is no data behind "which rules are
 * working, and which are being broken all the time?", and a rule nobody can
 * follow stays invisible instead of becoming visible enough to fix or drop.
 *
 * THE SUBJECT MUST ALREADY BE SAFE. Callers pass a path or a program name,
 * never a raw command line: a command line can carry a secret in a flag, and a
 * secret must never reach the event stream. The truncations below are a SECOND
 * line of defence, not the first.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { jqCompact, type JsonValue } from './jsonl.js';

export interface RecordArgs {
  /** Repo root — GOV_ROOT when set, as everywhere else in the harness. */
  root: string;
  /** Which wall refused. */
  wall: string;
  /** A path or a program word. NEVER a raw command line. */
  subject: string;
  reason: string;
  /** The hook's raw stdin payload, already parsed. Absent is normal. */
  payload?: Record<string, JsonValue> | null;
  /** Injected so a test does not need a clock or a pid. */
  now?: Date;
  pid?: number;
}

export function wallsRecord(args: RecordArgs): void {
  try {
    const dir = `${args.root}/.scrumux`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const p = args.payload ?? {};
    const at = (args.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const pid = String(args.pid ?? process.pid);

    const row: Record<string, JsonValue> = {
      v: 1,
      id: `${pid}-${Math.floor((args.now ?? new Date()).getTime() / 1000)}`,
      // NULL, NEVER A MADE-UP ID. A wall fires whenever a protected path is
      // touched -- including from a plain CLI run with no agent anywhere near
      // it -- and "unknown" was being grouped by scrumux-app into a SESSION
      // named unknown that showed as running for ever with no close event.
      // Same defect class as --by defaulting to User.
      sessionId: (p['session_id'] as JsonValue) ?? null,
      // AND WHO INSIDE THAT SESSION WAS REFUSED (I-0154). A Task-tool
      // sub-agent fires this hook under the PARENT session id, so sessionId
      // above is right and stays right -- the session owns the tree and
      // answers for what runs in it. What it cannot say alone is that the
      // refused act was a SUB-AGENT act, which left a wall record claiming the
      // session itself did something it never did. agent_id is present only on
      // a sub-agent call, so null here means the session itself was refused.
      subAgent: (p['agent_id'] as JsonValue) ?? null,
      repoPath: args.root,
      at,
      kind: 'wall',
      wall: args.wall,
      refused: args.subject.slice(0, 200),
      reason: args.reason.slice(0, 400),
      sanctionedPath: null,
    };

    appendFileSync(`${dir}/events.jsonl`, jqCompact(row) + '\n');
  } catch {
    // Deliberately empty. See the header: a failed record must never become a
    // failed tool call, and there is nowhere safe to complain to -- stderr
    // here is spliced into the refusal message the agent reads.
  }
}
