/**
 * The `session` noun.
 *
 * Six deterministic checks, all computable from the journals, the receipts
 * and git. No judgment, no model, no prose. They are the ways a green receipt
 * can lie, plus the two irreversible states.
 *
 * WHAT THIS DOES NOT DO, DELIBERATELY. It does not check bookkeeping --
 * unlisted files, stale views, record inconsistency and drift are harness
 * problems, not task problems, they are User-inspection data
 * (`scrumux records check`), and four of six acceptance runs died on that
 * class and prevented nothing. It does not tell the agent to take a
 * governance action: a message here states what is wrong and stops.
 *
 * TWO ROOTS, AND THIS MODULE IS WHERE THE DIFFERENCE BITES. Checks 3 and 5
 * and the stub scan all ask `WORK_ROOT`, never `ROOT`: those are CODE paths,
 * and a dispatched session's code is in its worktree while its records are on
 * main. Collapsing the two here is the measured cross-worktree failure
 * `src/journal/paths.ts` documents, in the one command whose whole job is to
 * notice that the code and the receipt disagree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { asArray, asString, entriesOf, field, interp, unique } from './lib/jqlike.js';
import { isAccepted, redDrift } from './task/receipt-freeze.js';
import { acceptedWithOpenIssue, receiptFreshness } from './session-fresh.js';

export const VERBS = ['check'] as const;

const VERBS_TSV = 'check\tthe close: six deterministic checks over receipts, journals and git\n';

const USAGE = `scrumux session — the session close.

  scrumux session check

Exit 1 if any check FAILS. WARNs print and never change the exit code.

The six checks are the ways a green receipt can lie, plus the two
irreversible states:
  1. every task claiming done carries a receipt
  2. the receipt ran the command the order names
  3. the receipt covers the code as it is now (content hashes; an
     accepted task's changed file is drift, a WARN)
  4. the receipt actually ran something
  5. no secret-shaped file in the working tree
  6. nothing left in_progress

Sprint discipline and live stubs print as WARNs: worth seeing, not worth
stopping for.
`;

/** The prune list and the three generated views, verbatim from the `find`. */
const PRUNE = ['.git', 'governance', 'tests', 'node_modules', '.venv', 'venv', 'dist', 'build'];
const NOT_NAMED = ['AI_LOG.MD', 'DECISIONS.MD', 'BACKLOG.MD'];

/**
 * The parsed document, or null when the file is absent OR does not parse.
 *
 * Both states collapse to the SAME return value here: the VALUE a caller
 * gets is empty either way, and every caller of this function supplies a
 * default that renders the same as no rows. Deliberately one state, with
 * the difference noted rather than invented away.
 */
function readDoc(path: string): JsonValue | null {
  if (!existsSync(path)) return null;
  try {
    return parsePreservingNumbers(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The one entry with this id, or null -- `.[0]` over a filtered array. */
function byId(entries: readonly JsonValue[], id: string): JsonValue | null {
  for (const e of entries) if (field(e, 'id') === id) return e;
  return null;
}

/** `X // empty` rendered the way a `$( )` capture sees it: '' for nothing. */
function orEmpty(v: JsonValue | null): string {
  return v === null || v === false ? '' : interp(v);
}

/** `stat -f %m` / `stat -c %Y` -- whole seconds, or 0 when it cannot be had. */
export function mtimeOf(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

/**
 * The `find | while read | grep -onE` stub scan, in process.
 *
 * IDENTICAL PRUNE SET AND IDENTICAL TRAVERSAL ORDER. `find` prunes only the
 * eight paths spelled `./X` -- top level, never a nested `node_modules` --
 * and walks each directory in readdir order, pre-order. The output order is
 * part of the WARN's text (`LIVEIDS` and `BADSITES` are accumulated in scan
 * order), so a "tidier" sorted walk changes a row detail.
 *
 * Returns `path:lineno:STUB(I-NNNN)` per match, which is what
 * `grep -onE` piped through `sed "s|^|$f:|"` produces -- one line per MATCH,
 * not per line, so two markers on one line are two rows.
 */
export function stubScan(workRoot: string): string[] {
  const out: string[] = [];
  const marker = /STUB\(I-[0-9]{4}\)/g;

  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // `2>/dev/null`: find prints to stderr and carries on, silently
      // omitting whatever subtree it could not read. Reproduced -- a
      // completeness check here would be a tightening nobody ruled on.
      return;
    }
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (rel === '' && PRUNE.includes(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, childRel);
        continue;
      }
      if (!st.isFile()) continue;
      if (NOT_NAMED.includes(name)) continue;
      let text: string;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      // A trailing "" from a terminated file is not a line grep sees.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (let i = 0; i < lines.length; i++) {
        marker.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = marker.exec(lines[i]!)) !== null) {
          out.push(`${childRel}:${i + 1}:${m[0]}`);
        }
      }
    }
  };
  walk(workRoot, '');
  return out;
}

function sessionCheck(cli: Cli, ctx: NounContext): never {
  const tasksDoc = readDoc(join(ctx.gov, 'tasks.json'));
  const sprintsDoc = readDoc(join(ctx.gov, 'sprints.json'));
  const issuesDoc = readDoc(join(ctx.gov, 'issues.json'));
  const tasks = entriesOf(tasksDoc ?? undefined);
  const today = ctx.today;

  cli.say(`=== SESSION CHECK (${today}) ===`);
  cli.say('');

  // CLAIMED: this session's claims of done -- anything awaiting User
  // (in_review) plus anything accepted in THIS session. Scoped two ways on
  // purpose: not "everything touched today", because a task whose metadata
  // moved is not a task that was worked (I-0006); and not every accepted task
  // in history, because an acceptance is settled and re-judging one User
  // already signed is post-hoc record policing.
  const claimed = tasks
    .filter((e) => {
      const st = field(e, 'status');
      return st === 'in_review' || (st === 'accepted' && field(e, 'updated_at') === today);
    })
    .map((e) => interp(field(e, 'id')))
    // An id that is empty or contains a space does not survive as one
    // token here.
    .join(' ')
    .split(/\s+/)
    .filter((s) => s !== '');

  // --- 1. Every claimed task carries a green receipt --------------------
  let noReceipt = '';
  let redReceipt = '';
  for (const t of claimed) {
    const e = byId(tasks, t);
    const receipt = e === null ? null : field(e, 'receipt');
    const rc = receipt === null ? '' : orEmpty(field(receipt, 'rc'));
    if (rc === '') noReceipt += ` ${t}`;
    else if (rc !== '0') redReceipt += ` ${t}(rc=${rc})`;
  }
  if (noReceipt !== '') {
    cli.fail('receipt present', `claimed done with no receipt:${noReceipt} — nothing ran to prove it`);
  }
  if (redReceipt !== '') {
    cli.fail('receipt green', `claimed done on a red receipt:${redReceipt} — the command it named did not pass`);
  }
  if (noReceipt === '' && redReceipt === '') {
    cli.pass('receipt green', 'every task claiming done carries a green receipt');
  }

  // --- 1b. Post-acceptance drift (D-S018, SX-013) -------------------------
  // An accepted task's acceptance receipt is frozen; a later verify run that
  // went red is DRIFT to look into, never a failed close. WARN, so the close
  // still exits on the work this session did.
  const drifted: string[] = [];
  for (const e of tasks) {
    const row = e !== null && typeof e === 'object' && !Array.isArray(e) ? (e as { [k: string]: JsonValue }) : null;
    if (row === null || !isAccepted(row)) continue;
    const red = redDrift(row);
    if (red !== null) drifted.push(`${interp(field(e, 'id'))}(rc=${orEmpty(field(red, 'rc'))}, ${orEmpty(field(red, 'date'))})`);
  }
  if (drifted.length > 0) {
    cli.warn('post-acceptance drift', `accepted work no longer passes its own command when re-verified: ${drifted.join(' ')} — its acceptance receipt is frozen and unchanged (D-S018). This is drift, not this session's failure: look at what changed around it, and raise an issue if it matters; do not re-litigate the acceptance.`);
  }

  // --- 2. The receipt's command is the order's command ------------------
  let mismatch = '';
  for (const t of claimed) {
    const e = byId(tasks, t);
    if (e === null) continue;
    const rcmd = orEmpty(field(e, 'receipt', 'command'));
    const ocmd = orEmpty(field(e, 'task_order', 'verification_command'));
    if (rcmd === '' || ocmd === '') continue;
    if (rcmd !== ocmd) mismatch += ` ${t}`;
  }
  if (mismatch === '') {
    cli.pass('command match', 'each receipt ran the command its order names');
  } else {
    cli.fail('command match', `receipt ran a different command than the order names:${mismatch}`);
  }

  // --- 3. The receipt covers the code as it is now ----------------------
  // CONTENT, NOT MTIME, WHERE THE RECEIPT CAN SAY (SX-024). A receipt written
  // since carries `file_hashes`; a covered file whose sha256 differs, or that
  // exists now and was not hashed, has changed. mtime moved on a worktree
  // checkout, a merge or a break-and-restore with no change at all, and failed
  // seven Rover closes. An older receipt with no hashes keeps the mtime test.
  //
  // AN ACCEPTED TASK'S CHANGED FILE IS DRIFT, NOT THIS CLOSE'S FAILURE (D-S018).
  // A later task legitimately editing files an accepted task covers (Rover
  // I-0020) is reported as a WARN beside post-acceptance drift; only a task
  // still awaiting acceptance FAILs, because its receipt is what acceptance
  // will read.
  const fresh = receiptFreshness(tasks, claimed, ctx.workRoot);
  if (fresh.stale !== '') {
    cli.fail('receipt fresh', `files changed after the receipt was written:${fresh.stale} — the receipt no longer covers the code`);
  } else if (fresh.unstamped !== '') {
    cli.warn('receipt fresh', `receipt predates the freshness stamp, cannot be judged:${fresh.unstamped}`);
  } else {
    cli.pass('receipt fresh', 'no covered file changed after its receipt');
  }
  if (fresh.drift !== '') {
    cli.warn('post-acceptance drift', `files an ACCEPTED task covers changed after its acceptance receipt:${fresh.drift} — expected when later work touches them; its acceptance stands (D-S018). Not this session's failure; re-verify that task if the change could break it.`);
  }

  // --- 4. The receipt actually ran something ----------------------------
  let zero = '';
  for (const t of claimed) {
    const e = byId(tasks, t);
    if (e === null) continue;
    const n = orEmpty(field(e, 'receipt', 'checks_run'));
    if (n === '') continue;
    if (Number(n) === 0) zero += ` ${t}`;
  }
  if (zero === '') {
    cli.pass('checks ran', 'every receipt ran at least one check');
  } else {
    cli.fail('checks ran', `receipt reports zero checks run:${zero} — a green that proved nothing`);
  }

  // --- 5. No secret-shaped file in the tree -----------------------------
  // ASK GIT, DO NOT STAT .git (D-0085/PK-3). In a git WORKTREE `.git` is a
  // FILE holding a `gitdir:` pointer, so `[ -d .git ]` was false and this
  // reported "not a git repo" instead of looking -- turning OFF the one
  // irreversible check in the close in exactly the configuration D-0084's
  // parallel dispatch builds by design.
  if (isGitRepo(ctx.workRoot)) {
    const porcelain = spawnSync('git', ['status', '--porcelain'], {
      cwd: ctx.workRoot,
      encoding: 'utf8',
    });
    const stray = (porcelain.stdout ?? '')
      .split('\n')
      .filter((l) => l !== '')
      // `awk '{print $2}'`: leading blanks skipped, whitespace-run separated.
      .map((l) => l.trim().split(/[ \t]+/)[1] ?? '')
      .filter((p) => /\.tmp\.|\.env$|id_rsa|\.pem$|\.key$/.test(p))
      .join('\n');
    if (stray === '') {
      cli.pass('strays/secrets', 'no temp or secret-pattern files in the working tree');
    } else {
      cli.fail('strays/secrets', `secret-shaped files in the working tree: ${stray}`);
    }
  } else {
    cli.warn('strays/secrets', 'not a git repo — stray check unavailable');
  }

  // --- 6. No task left mid-flight ---------------------------------------
  const inProgress = tasks.filter((e) => field(e, 'status') === 'in_progress');
  if (inProgress.length === 0) {
    cli.pass('nothing mid-flight', 'no task left in_progress');
  } else {
    const ids = inProgress.map((e) => interp(field(e, 'id')));
    // D-0084. With more than one task admitted per sprint, "nothing is
    // in_progress" stopped being a fact about THIS SESSION and became a fact
    // about the repo -- so a second agent still working would have failed the
    // first one's close, over work it neither started nor can move.
    const mine = ctx.env['SCRUMUX_TASK'] ?? '';
    if (mine !== '') {
      const mineIp = inProgress.filter((e) => field(e, 'id') === mine).map((e) => interp(field(e, 'id'))).join(',');
      const otherIp = inProgress.filter((e) => field(e, 'id') !== mine).map((e) => interp(field(e, 'id'))).join(',');
      if (mineIp !== '') {
        const also = otherIp !== '' ? `; also in flight, and not this session's to move: ${otherIp}` : '';
        cli.fail('nothing mid-flight', `still in_progress at close: ${mineIp} — this session was dispatched under it${also}`);
      } else {
        cli.warn(
          'nothing mid-flight',
          `this session's task (${mine}) is not in flight; another session's is: ${otherIp} — named, not failed (D-0084)`,
        );
      }
    } else {
      cli.fail('nothing mid-flight', `still in_progress at close: ${ids.join(',')}`);
    }
  }

  // --- Issues an accepted task was created to fix (D-S041) ---------------
  // The link is recorded by `task new --issue`; resolving is a person's act.
  const openFixed = acceptedWithOpenIssue(tasks, entriesOf(issuesDoc ?? undefined));
  if (openFixed.length > 0) {
    cli.warn('fixed issue open', `accepted task(s) whose issue is still open: ${openFixed.map((p) => `${p.task}->${p.issue}`).join(' ')} — if the fix is complete, a person resolves it: scrumux issue update ${openFixed[0]!.issue} --status resolved (in scrumux-app, the accept flow offers it). Never a failure.`);
  }

  // --- Prints. These never change the exit code. ------------------------
  const worked = tasks
    .filter((e) => {
      const st = field(e, 'status');
      return (field(e, 'updated_at') === today && st !== 'superseded') || st === 'in_progress' || st === 'in_review';
    })
    .map((e) => interp(field(e, 'id')))
    .join(' ')
    .split(/\s+/)
    .filter((s) => s !== '');

  const inSprintList = unique(
    entriesOf(sprintsDoc ?? undefined)
      .filter((e) => {
        const st = field(e, 'status');
        return st === 'ratified' || st === 'complete';
      })
      .flatMap((e) => asArray(field(e, 'tasks')) ?? []),
  ).map(interp);
  const inSprint = new Set(inSprintList.join(' ').split(/\s+/).filter((s) => s !== ''));

  let outside = '';
  for (const t of worked) {
    if (inSprint.has(t)) continue;
    outside += ` ${t}`;
  }
  if (outside.replace(/ /g, '') === '') {
    cli.pass('sprint discipline', 'every worked task belongs to a ratified sprint');
  } else {
    cli.warn('sprint discipline', `worked outside any ratified sprint:${outside}`);
  }

  // Live stubs (D-0015): parked debt is visible, never a block. A marker
  // pointing at a closed or missing issue is a bookkeeping mismatch, which is
  // User's to look at, so it warns like the rest.
  const issues = entriesOf(issuesDoc ?? undefined);
  let liveN = 0;
  let liveIds = '';
  let badSites = '';
  for (const m of stubScan(ctx.workRoot)) {
    const parts = m.split(':');
    const site = parts.slice(0, 2).join(':');
    const idm = /STUB\((I-[0-9]{4})\)/.exec(m);
    const id = idm === null ? '' : idm[1]!;
    const e = byId(issues, id);
    const st = e === null ? 'unknown' : (asString(field(e, 'status')) ?? interp(field(e, 'status')));
    if (st === 'open' || st === 'accepted') {
      liveN += 1;
      liveIds += ` ${id}`;
    } else {
      badSites += ` ${site}->${id}(${st})`;
    }
  }
  if (badSites !== '') {
    cli.warn('live stubs', `stub marker(s) whose issue is resolved/rejected/unknown:${badSites}`);
  }
  if (liveN > 0) {
    cli.warn('live stubs', `${liveN} live stub(s) parked on open issue(s):${liveIds}`);
  } else if (badSites === '') {
    cli.pass('live stubs', 'no stub markers in live code');
  }

  cli.say('');
  const fails = cli.fails();
  const rows = cli.build('').checks.length;
  cli.say(`SUMMARY: ${fails} fail(s) of ${rows} check(s)`);
  if (fails > 0) {
    cli.emit('VERDICT: session NOT clean — each FAIL above names work that is not finished.');
  }
  cli.emit("VERDICT: clean. Push is User's call.");
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'check':
        if (args.length !== 0) cli.dieUsage('session check takes no arguments');
        return sessionCheck(cli, nounContext(ctx));
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun session — the only verb is 'check'. See: scrumux help session`,
        );
    }
  },
};

function isGitRepo(dir: string): boolean {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
  return r.status === 0;
}
