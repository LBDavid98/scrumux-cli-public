/**
 * `task verify` -- runs the order's verification_command plus every
 * registered repo-health check, capturing evidence, and writes the receipt.
 * The exit code is the verdict, not the agent's impression.
 *
 * PASS-WITH-STUB IS DELIBERATE (D-0015/T-0038, P-05): a STUB(I-XXXX)-marked
 * boundary is the session close's to track; nothing here scans for markers.
 *
 * THE RECEIPT IS EVIDENCE, NEVER A VERDICT (P-15). `writeReceipt` is
 * guarded two ways because a governance write can be denied in a restricted
 * sandbox even when `test -w` reports it as writable (D-0007): an O_EXCL
 * mkdir probe against `governance/`, and a catch around the write so its
 * refusal cannot take this script's exit code with it. A failed receipt
 * write says so on stderr and the verdict above stands; `task accept` is
 * where a missing receipt bites.
 *
 * A RED `type=lint` HEALTH CHECK IS A TELL (T-0193/I-0117, P-04): it counts
 * in checks_run -- it ran -- and never in checks_failed, so a repo-wide
 * linter finding cannot route into accept's red-receipt refusal. ORDER IS
 * THE CONTRACT (D-0085/OQ-15): TIMEOUT is tested BEFORE the lint carve-out,
 * because a linter that burned its whole timeout produced no findings and
 * calling that TELL would assert it ran.
 *
 * EVIDENCE PRINTS ARE DIRECT -- the `tail -20` blocks land on stdout in BOTH
 * modes (see shared.ts). The health runner runs checks SERIALLY,
 * deliberately not concurrently: output order is the registry's, on the
 * principle that determinism is a contract, not cosmetics; only the wall
 * clock differs, and nothing prints it.
 */
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../../cli/envelope.js';
import type { Io } from '../../cli/exit.js';
import type { JsonValue } from '../../journal/jqformat.js';
import { runWithTimeout } from '../../journal/timeout.js';
import { writeJson } from '../../journal/write.js';
import type { DispatchContext, NounContext } from '../lib/context.js';
import { mapEntries } from '../lib/writers.js';
import { writeEvidence } from './evidence.js';
import { isAccepted, withPostAcceptanceCheck, withReceipt } from './receipt-freeze.js';
import { jqRaw, obj, rawOr, rows, tailOfCapture, tasksPath } from './shared.js';
import { coveredPaths, fileHashes } from './fingerprint.js';

/**
 * The ceiling on an order's own verification command, in seconds — for
 * `task verify` and for `task accept`'s re-run alike (SX-029), so acceptance
 * is never looser than the promise verify makes.
 */
export const VERIFY_TIMEOUT_SECONDS = 600;

export function taskVerify(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const io = ictx.io;
  const tasks = tasksPath(ctx);
  const health = join(ctx.gov, 'repo-health.json');
  const tid = args[0] ?? '';
  if (tid === '') cli.dieUsage('usage: scrumux task verify T-0001');
  if (!existsSync(tasks)) cli.die('no governance/tasks.json');

  const row = rows(tasks)
    .map((r) => obj(r))
    .find((o): o is { [k: string]: JsonValue } => o !== null && o['id'] === tid);
  const order = row === undefined ? null : obj(row['task_order']);
  const vc = order === null ? '' : rawOr(order['verification_command'], '');
  if (vc === '') {
    cli.die(`${tid} has no task_order.verification_command — task-breakdown skill first (scrumux task order ${tid} --verify ...)`);
  }

  // T-0187: the receipt's measured facts. The order's OWN command counts as
  // a check -- a deployed repo seeds no health checks, and counting only the
  // fleet would report checks_run=0 on every honest verify.
  let vcRc = 1;
  let checksRun = 0;
  let checksFailed = 0;

  let vcOutput = '';
  const runCheck = (label: string, command: string, timeoutSeconds = VERIFY_TIMEOUT_SECONDS): number => {
    cli.say(`--- ${label}`);
    cli.say(`$ ${command}`);
    // WORK_ROOT, not ROOT: the command proves the CODE (CLI-7).
    const r = runWithTimeout(timeoutSeconds, command, {
      cwd: ctx.workRoot,
      env: ctx.env,
      capture: true,
      combine: true,
    });
    // keep evidence bounded: last 20 lines are where verdicts live.
    for (const l of tailOfCapture(r.stdout, 20)) io.out(l + '\n');
    if (vcOutput === '') vcOutput = r.stdout;
    if (r.code === 0) {
      cli.say('RESULT: PASS (exit 0)');
      cli.pass(label, 'exit 0');
    } else if (r.code === 142) {
      cli.say(`RESULT: FAIL (TIMED OUT — declared timeout_seconds exceeded, T-0078: stopped after ${timeoutSeconds} s, with every process it started)`);
      cli.fail(label, `TIMED OUT — declared timeout_seconds exceeded (T-0078): stopped after ${timeoutSeconds} s, its whole process group with it (SX-029)`);
    } else {
      cli.say(`RESULT: FAIL (exit ${r.code})`);
      cli.fail(label, `exit ${r.code}`);
    }
    cli.say('');
    return r.code;
  };

  cli.say(`=== TASK VERIFY ${tid} (${ctx.today}) ===`);
  cli.say('');
  cli.say('EVIDENCE-BEGIN');
  vcRc = runCheck(`verification_command for ${tid}`, vc);
  checksRun += 1;
  if (vcRc !== 0) checksFailed += 1;

  if (existsSync(health)) {
    // T-0135: one runner owns execution and the recursion guard; this
    // formats what it captured.
    const results = runHealthChecks(ctx, health);
    for (const res of results) {
      cli.say(`--- repo-health: ${res.name}`);
      cli.say(`$ ${res.registeredCommands}`);
      printTailOfFile(io, res.out, 20);
      checksRun += 1;
      if (res.status === 'PASS') {
        cli.say('RESULT: PASS (exit 0)');
        cli.pass(`repo-health/${res.name}`, 'exit 0');
      } else if (res.status === 'TELL') {
        cli.say(`RESULT: TELL (advisory — type=lint check exited ${res.rc}; a red linter is a finding, not this task's failure: T-0144/D-0072 boundary 7. Not counted in checks_failed.)`);
        cli.tell(`repo-health/${res.name}`, `type=lint check exited ${res.rc} — a red linter is a finding, not this task's failure (T-0144/D-0072 boundary 7). Not counted in checks_failed.`);
      } else if (res.status === 'TIMEOUT') {
        cli.say('RESULT: FAIL (TIMED OUT — declared timeout_seconds exceeded, T-0078)');
        cli.fail(`repo-health/${res.name}`, 'TIMED OUT (T-0078)');
        checksFailed += 1;
      } else {
        cli.say(`RESULT: FAIL (exit ${res.rc})`);
        cli.fail(`repo-health/${res.name}`, `exit ${res.rc}`);
        checksFailed += 1;
      }
      cli.say('');
    }
  } else {
    cli.say('--- repo-health: none registered (scrumux health add --name ... --command ... — tracked as T-0016)');
    cli.say('');
  }
  cli.say('EVIDENCE-END');
  cli.say('');

  const covered = row === undefined ? [] : coveredPaths(row);
  const settled = writeReceipt(cli, ctx, tid, vc, vcRc, checksRun, checksFailed, io, vcOutput, covered);
  cli.data({
    id: tid,
    receipt: { command: vc, rc: vcRc, checks_run: checksRun, checks_failed: checksFailed },
  });

  const fails = cli.fails();
  // AN ACCEPTED TASK GETS AN ACCEPTED TASK'S NEXT STEP (SX-028): the run is a
  // post-acceptance check (D-S018), so "log it, move it to in_review, User
  // accepts" is wrong for it in both outcomes.
  if (settled) {
    if (fails > 0) {
      cli.emit(`VERDICT: ${fails} check(s) FAILED on accepted ${tid} — recorded as post-acceptance DRIFT (D-S018). The acceptance and its receipt are unchanged and no status change is needed. Look at what changed around it; if it matters, raise it: scrumux issue new --type defect --task ${tid} ... (scrumux-app shows the drift to the operator).`);
    }
    return cli.emit(`VERDICT: all checks pass — recorded as a post-acceptance check on accepted ${tid} (D-S018). The acceptance and its receipt are unchanged; no log entry or status change is needed.`);
  }
  if (fails > 0) {
    cli.emit(`VERDICT: ${fails} check(s) FAILED. The task stays in_progress (D-0006). If the cause is not obvious, dispatch the debugger agent — never patch around a failure you don't understand.`);
  }
  return cli.emit(`VERDICT: all checks pass. Log it (scrumux log new --task ${tid} --verified "<EVIDENCE block>"), then scrumux task status ${tid} in_review. Acceptance is User's and reads the receipt above (scrumux task accept ${tid} --by User --authority ...).`);
}

interface HealthResult {
  name: string;
  status: 'PASS' | 'TELL' | 'TIMEOUT' | 'FAIL';
  rc: number;
  out: string;
  /** Every registered `.command` under this name, newline-joined -- the
   *  `$ ...` line re-reads the registry and shows the ORIGINAL text. */
  registeredCommands: string;
}

/**
 * Collated in registry order. The HARNESS_IN_HEALTH_CHECKS marker closes
 * the I-0017 recursion cycle for every child this runs.
 */
function runHealthChecks(ctx: NounContext, healthPath: string): HealthResult[] {
  const entries = rows(healthPath);
  const results: HealthResult[] = [];
  const childEnv = { ...ctx.env, HARNESS_IN_HEALTH_CHECKS: '1' };
  // A nameless entry is skipped rather than named "null". The escaping
  // below (backslash, tab, newline, CR) is applied to what actually RUNS,
  // not just to what is displayed: a registered `printf 'ok\n'` runs as
  // `printf 'ok\\n'` and prints a literal backslash-n with no newline.
  // REPRODUCED-WITH-FLAG, not repaired: a health command containing a
  // backslash is silently rewritten before it runs, and that must not be
  // papered over silently. The `$ ...` display line re-reads the registry
  // and shows the ORIGINAL text, so the evidence block advertises a command
  // other than the one that ran.
  const tsvStr = (v: JsonValue | undefined): string =>
    v === undefined || v === null
      ? ''
      : jqRaw(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  for (const e of entries) {
    const o = obj(e);
    if (o === null) continue;
    const name = tsvStr(o['name']);
    if (name === '') continue;
    const command = tsvStr(o['command']);
    const to = numberOr(o['timeout_seconds'], 120);
    // `.type // "test"` happens BEFORE @tsv, so the default is never escaped
    // and a real value goes through the same escaping as the command.
    const type = o['type'] === undefined || o['type'] === null || o['type'] === false ? 'test' : tsvStr(o['type']);
    // checks run from $ROOT -- the records root, not the worktree.
    const r = runWithTimeout(to, command, { cwd: ctx.root, env: childEnv, capture: true, combine: true });
    // ORDER IS THE CONTRACT (D-0085/OQ-15): TIMEOUT before the lint carve-out.
    const status: HealthResult['status'] =
      r.code === 0 ? 'PASS' : r.code === 142 ? 'TIMEOUT' : type === 'lint' ? 'TELL' : 'FAIL';
    results.push({
      name,
      status,
      rc: r.code,
      out: r.stdout,
      registeredCommands: entries
        .map((x) => obj(x))
        .filter((x): x is { [k: string]: JsonValue } => x !== null && jqRaw(x['name']) === name)
        .map((x) => jqRaw(x['command']))
        .join('\n'),
    });
  }
  return results;
}

/** `.timeout_seconds // 120` -- null and false both take the default. */
function numberOr(v: JsonValue | undefined, dflt: number): number {
  if (v === undefined || v === null || v === false) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** `tail -20 <file>` over captured content: raw bytes of the last 20 lines. */
function printTailOfFile(io: Io, content: string, n: number): void {
  if (content === '') return;
  const endsWithNewline = content.endsWith('\n');
  const parts = content.split('\n');
  if (endsWithNewline) parts.pop();
  const tail = parts.slice(-n);
  for (let i = 0; i < tail.length; i++) {
    const last = i === tail.length - 1;
    io.out(tail[i]! + (last && !endsWithNewline ? '' : '\n'));
  }
}

/**
 * `write_receipt <rc> <checks_run> <checks_failed>` -- record what this run
 * measured ONTO the task, via the one sanctioned writer. Overwritten every
 * run WHILE THE TASK IS OPEN: the last receipt wins, because acceptance asks
 * "is the CURRENT state verified". Once ACCEPTED the receipt is frozen and the
 * run is appended to `post_acceptance_checks` instead (D-S018, SX-013). The
 * verification command's output tail goes to the evidence sidecar either way
 * (SX-003, `evidence.ts`).
 *
 * The open task also keeps the run in `receipt_history` (SX-034), and its
 * receipt carries `file_hashes` for the covered files (SX-024). Returns
 * whether the task is accepted, so the VERDICT can say the right next step.
 *
 * Depends on: `writeJson`, `mapEntries`, `rows`, `isAccepted`,
 * `withPostAcceptanceCheck`, `withReceipt`, `fileHashes`, `writeEvidence`.
 */
function writeReceipt(
  cli: Cli,
  ctx: NounContext,
  tid: string,
  vc: string,
  rc: number,
  checksRun: number,
  checksFailed: number,
  io: Io,
  output = '',
  covered: readonly string[] = [],
): boolean {
  // guard 1: the O_EXCL mkdir probe (the same mechanism journal_lock uses,
  // and the only reliable test under a syscall-level sandbox). It also skips
  // the lock's 100-try, ten-second retry loop.
  const probe = join(ctx.gov, `.receipt-probe.${process.pid}`);
  try {
    mkdirSync(probe);
  } catch {
    io.err(`task verify: could not record the receipt on ${tid} — governance/ is not writable (read-only agent sandbox?). The verdict above stands; re-run outside the sandbox to leave a receipt for scrumux task accept.\n`);
    return accepted(ctx, tid);
  }
  try {
    rmdirSync(probe);
  } catch {
    // `rmdir ... || :`
  }
  // guard 2: the subshell -- a refusal out of the writer must not take this
  // script's verdict with it, and its own output is suppressed
  // (`>/dev/null 2>&1`).
  const atEpoch = Math.floor(Date.now() / 1000);
  const run = { date: ctx.today, at_epoch: atEpoch, command: vc, rc, checks_run: checksRun, checks_failed: checksFailed };
  // D-S018: an ACCEPTED task's receipt is frozen; this run is a post-acceptance check.
  const settled = accepted(ctx, tid);
  writeEvidence(ctx.gov, tid, settled ? 'post-acceptance' : 'verify', { command: vc, rc, date: ctx.today, atEpoch }, output);
  // SX-024: the current receipt carries the content hash of every covered
  // file, so the close compares content rather than mtime. Only the live
  // receipt carries them; history and post-acceptance runs stay lean.
  const receipt = { ...run, file_hashes: fileHashes(ctx.workRoot, covered) };
  try {
    writeJson(
      tasksPath(ctx),
      (doc) =>
        mapEntries(doc, (r) =>
          r['id'] !== tid ? r : isAccepted(r) ? withPostAcceptanceCheck(r, run) : withReceipt(r, receipt, run),
        ),
      { gov: ctx.gov, today: ctx.today, env: ctx.env, err: () => {} },
    );
    if (settled) {
      const drift = rc !== 0 || checksFailed !== 0;
      cli.say(`RECEIPT: ${tid} is ACCEPTED, so its acceptance receipt is frozen (D-S018) and was not changed. This run is recorded as a post-acceptance check (rc=${rc}, checks_run=${checksRun}, checks_failed=${checksFailed})${drift ? ' — DRIFT: the accepted work does not pass its own command here now. That is drift to look into (what changed around it?), not a broken task; session check and scrumux-app surface it.' : '.'}`);
    } else {
      cli.say(`RECEIPT: recorded on ${tid} (rc=${rc}, checks_run=${checksRun}, checks_failed=${checksFailed})`);
    }
  } catch {
    io.err(`task verify: the receipt write on ${tid} FAILED — the verdict above stands, but scrumux task accept will refuse ${tid} until a receipt exists. Retry: .claude/scripts/scrumux task verify ${tid}\n`);
  }
  return settled;
}

/** Is the task accepted right now (D-S018)? False when the journal or row cannot be read. */
function accepted(ctx: NounContext, tid: string): boolean {
  const current = rows(tasksPath(ctx)).map((r) => obj(r)).find((o) => o !== null && o['id'] === tid) ?? null;
  return current !== null && isAccepted(current);
}
