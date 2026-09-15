/**
 * The `task` noun. Brief: docs/port/modules/cmd-task.md.
 *
 * THE LARGEST VERB SURFACE IN THE CLI, deliberately: it absorbed five former
 * top-level scripts plus the old `scrumux accept`/`scrumux reject`, because
 * they were all verbs about one thing. Nine verbs: `new`, `order`, `status`,
 * `update` here; `lint`, `brief`, `verify` in `./task/`; `accept`, `reject`
 * here (they share the acceptance-target guard).
 *
 * WHAT THIS FILE HOLDS TO, in order of how expensive a miss would be:
 *
 *   - ACCEPTANCE IS WRITE-ONCE AND IMMUTABLE (I-0042/I-0147, and the
 *     2026-08-27 ruling closing `task update` as the last route around it).
 *     Four verbs refuse an accepted task four different ways, and each
 *     refusal names `repair journal` as the record's correction path.
 *   - `.acceptance.accepted == true`, NEVER `// true` -- jq's `//` swallows
 *     `false`, and a REJECTED task carries `accepted:false` and must stay
 *     acceptable after rework (cmd-task.md open question 2: ported as the
 *     same explicit three-way check, not "simplified" to `??`).
 *   - ACCEPT RE-RUNS THE VERIFICATION from `$WORK_ROOT`, never `$ROOT`
 *     (CLI-7): a dispatched session's code is in its worktree while its
 *     records are on main, and re-verifying the records root proved the
 *     wrong tree. Progress chatter goes to stderr so the machine-readable
 *     first line of stdout is not displaced.
 *   - THE D-0084 ADMISSION ARITHMETIC is computed once (`admissionState`)
 *     and consumed three ways: the `in_progress` writer refuses on it, the
 *     brief reports it as TELL, and `reject` reports it as TELL while
 *     recording anyway (T-0144).
 *
 * The `${2?}` truncated-flag idiom refuses in this CLI's own vocabulary --
 * `task: <flag> needs a value — see: scrumux help task` at exit 2 (cmd-task.md
 * open question 1): reproducing a raw shell parameter-expansion diagnostic
 * would pin a rough edge as contract.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { attested, beat, emitted } from '../journal/beat.js';
import { admissionState, authorityGuard } from '../journal/guards.js';
import { acceptedFingerprint, issueTell, rerunVerification } from './task/accept-extras.js';
import type { JsonValue } from '../journal/jqformat.js';
import { refExists, requireTaskRef } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { ensureFile } from '../journal/write.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';
import { appendEntry, guardedAppend, guardedWrite, idStream, mapEntries } from './lib/writers.js';
import { taskLint } from './task/lint.js';
import { taskBrief } from './task/brief.js';
import { taskVerify } from './task/verify.js';
import {
  arr,
  jqRaw,
  obj,
  rawOr,
  rowById,
  rows,
  sprintsPath,
  tasksPath,
} from './task/shared.js';

export const VERBS = ['new', 'order', 'status', 'update', 'lint', 'brief', 'verify', 'accept', 'reject'] as const;

const VERBS_TSV = `new\tcreate a task; the acceptance check is stated BEFORE work starts
order\tattach the task order — scope, one verification command, reading list
status\tmove it through proposed|ready|in_progress|in_review|blocked|accepted|superseded
update\tchange its feature, story or title
lint\tcheck the order against atomicity (D-0006) and completeness (D-0005)
brief\tthe full frame for implementing it: gates, scope, reading list, refs
verify\trun its verification command plus every repo-health check; write the receipt
accept\trecord final-authority acceptance ON THE TASK (D-0076). Re-runs first.
reject\trecord final-authority rejection; the task returns to in_progress
`;

/** The `${2?}` seam, in this CLI's vocabulary (see the header). */
function need(cli: Cli, args: readonly string[], i: number): string {
  const v = args[i];
  if (v === undefined) cli.die(`task: ${args[i - 1]} needs a value — see: scrumux help task`);
  return v;
}

// ----------------------------------------------------------------- new ----
function taskNew(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  let title = '';
  let check = '';
  let feat = '';
  let story = '';
  let desc = '';
  let fromIssue = '';
  for (let i = 0; i < args.length; ) {
    const f = args[i]!;
    if (f === '--title') { title = need(cli, args, i + 1); i += 2; continue; }
    if (f === '--desc') { desc = need(cli, args, i + 1); i += 2; continue; }
    if (f === '--issue') { fromIssue = need(cli, args, i + 1); i += 2; continue; }
    if (f === '--check') { check = need(cli, args, i + 1); i += 2; continue; }
    if (f === '--feature') { feat = need(cli, args, i + 1); i += 2; continue; }
    if (f === '--story') { story = need(cli, args, i + 1); i += 2; continue; }
    cli.die(`task new: unknown flag ${f} — see: scrumux help task`);
  }
  if (title === '') {
    cli.die('task new: --title is required — a sentence naming the state that will be true when the work is done, not a noun phrase and not an id. GOOD (build) "The graph does not crash on a repo it has never seen" (T-0213). GOOD (defect) "The close is not blocked by bytecode" (T-0217). GOOD (governance) "Rulings whose machinery was deleted are retired" (D-0081). BAD "fix session-check" — it names a file and a verb, so a later session reading the backlog cannot tell what was wrong or how it would know it no longer is.');
  }
  if (check === '') {
    cli.die('task new: --check is required (the acceptance check, stated BEFORE work starts) — a command-verifiable sentence naming what must be observably true AND the suite that shows it. GOOD (build) "graph gov build succeeds on a GOV_ROOT whose governance directory does not exist yet, and tests/graph-cli-tests.sh exits 0" (T-0213). GOOD (defect) "A tree containing __pycache__ or .pyc files closes session-check exit 0 when everything else traces to a worked task, an unauthorised source file still FAILs by name, and tests/session-check-tests.sh exits 0" (T-0217). GOOD (governance) "No rule or skill in the deploy payload instructs an agent to create harness work, and tests/deployed-surface-tests.sh asserts it against the payload roster, exiting 0" (T-0214). BAD "works", "tests pass", "the fix is applied" — none of them names what would have to be false for the check to fail.');
  }
  // T-0113/I-0056: sprint-plan Step 1b promotes a validated issue to a task,
  // and that lane was entirely ungated. Same gate as the hotfix lane, the
  // other lane.
  if (fromIssue !== '') {
    const issuesPath = join(ctx.gov, 'issues.json');
    if (!refExists(issuesPath, fromIssue)) {
      cli.die(`task new: issue ${fromIssue} not found in issues.json`);
    }
    const row = rowById(issuesPath, fromIssue);
    const validation = row === null ? undefined : row['validation'];
    // `.validation.verdict // ""` -- null AND false both land on "".
    const vo = obj(validation);
    const iv = vo === null ? '' : rawOr(vo['verdict'], '');
    if (iv === 'reproduced' || iv === 'evidenced') {
      // the gate opens
    } else if (iv === 'invalidated') {
      cli.die(`task new: ${fromIssue} was invalidated — close it instead of building on it (scrumux issue update ${fromIssue} --status rejected); the disproof is the deliverable (D-0011)`);
    } else if (iv === 'duplicate') {
      cli.die(`task new: ${fromIssue} is a duplicate — attach it to the task that owns the fix rather than creating another`);
    } else {
      cli.die(`task new: ${fromIssue} has no validation verdict — an unvalidated issue is not backlog work. Dispatch a read-only agent whose identity is NOT the source that raised ${fromIssue} (any read-only definition in .claude/agents — issue-validator, debugger, context-gatherer — minus that source) and record its verdict (scrumux issue validate ${fromIssue} --verdict ... --by <that agent>), then promote it.`);
    }
  }
  if (feat !== '') {
    const found = refExists(designPathOf(ctx), feat, kindPick('feature'));
    if (!found) cli.die(`task new: feature ${feat} not found in design.json — add it: scrumux feature new --name ... --desc ...`);
  }
  if (story !== '') {
    const found = refExists(designPathOf(ctx), story, kindPick('story'));
    if (!found) cli.die(`task new: story ${story} not found in design.json — add it: scrumux story new --feature ... --narrative ... --criterion ...`);
  }
  const path = tasksPath(ctx);
  refusing(cli, () => ensureFile(path, '{"entries": []}'));
  // A new task is deliberately left UNRANKED (I-0040/T-0092, P-44).
  const d = ctx.today;
  const r = guardedAppend(cli, ctx, ictx.io, path, idStream, 'T', (doc, id) =>
    appendEntry(doc, {
      id,
      title,
      acceptance_check: check,
      status: 'proposed',
      created_at: d,
      feature: feat === '' ? null : feat,
      story: story === '' ? null : story,
      ...(desc === '' ? {} : { description: desc }),
      // D-S041 (SX-036): the issue this task was promoted from, kept, so
      // acceptance can name it and the close can see it is still open.
      ...(fromIssue === '' ? {} : { issue: fromIssue }),
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return emitted(cli, r.id);
}

function designPathOf(ctx: NounContext): string {
  return join(ctx.gov, 'design.json');
}

/** `design.json` is polymorphic: the stream selects on `.kind` too. */
function kindPick(kind: string): (r: JsonValue) => JsonValue | undefined {
  return (r) => {
    const o = obj(r);
    return o !== null && o['kind'] === kind ? o['id'] : undefined;
  };
}

// -------------------------------------------------------------- status ----
const STATUSES = ['proposed', 'ready', 'in_progress', 'in_review', 'blocked', 'accepted', 'superseded'];

function taskStatus(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const tid = args[0] ?? '';
  const st = args[1] ?? '';
  if (tid === '' || st === '') {
    cli.die('usage: scrumux task status T-0001 <proposed|ready|in_progress|in_review|blocked|accepted|superseded> [--reason TEXT] [--by T-0002]');
  }
  if (!STATUSES.includes(st)) {
    cli.die(`task status: invalid status '${st}' — one of proposed|ready|in_progress|in_review|blocked|accepted|superseded`);
  }
  // An ACCEPTED task cannot be moved by a status change (I-0147). Read
  // TOLERANTLY: a missing or corrupt tasks.json answers "not accepted"
  // here and refuses later, at the task-ref check, which is where a
  // missing or corrupt journal is actually this command's problem to
  // report.
  if (acceptedTrue(tasksPath(ctx), tid) && st !== 'accepted' && st !== 'superseded') {
    cli.die(`task status: ${tid} is ACCEPTED and cannot be moved to '${st}' by a status change. Acceptance is a final-authority ruling; a status change carries no authority to undo one, and moving it would leave acceptance.accepted=true on a task whose status disagrees — a contradiction nothing downstream reads (I-0147). There is NO command that reverses an acceptance: scrumux task reject refuses an already-accepted task by design. If the RECORD is wrong, correct it with scrumux repair journal tasks.json --why '<reason>', which forces the reason onto the record. If the WORK needs more doing, that is a NEW task, not a reopened one.`);
  }
  // T-0115/I-0059: superseded needs a recorded reason.
  let supReason = '';
  let supBy = '';
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--reason') { supReason = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--by') { supBy = need(cli, rest, i + 1); i += 2; continue; }
    cli.die(`task status: unknown flag ${f} — only --reason (superseded, blocked) and --by (superseded)`);
  }
  if (st === 'superseded') {
    if (supReason === '') {
      cli.die('task status: superseded needs --reason TEXT — a task retired without a recorded reason is indistinguishable from one that vanished (I-0059). Name what disproved the premise, and what now owns the ground. GOOD "D-0084 replaced the one-task-at-a-time rule this task was written to enforce, so its acceptance check advertises behaviour that no longer exists". GOOD "Duplicated by T-0217, which covers the same session-check exemption and carries the negative case as well". BAD "no longer needed" — the next reader cannot tell whether that was a ruling or a shrug.');
    }
    if (supBy !== '') refusing(cli, () => requireTaskRef(ctx.gov, supBy));
  } else if (st === 'blocked') {
    // SX-006/SX-010: a block carries its reason (optional), so the operator
    // sees WHAT it waits on -- a deploy the session cannot run, a permission
    // it cannot grant itself. `--by` stays superseded's alone.
    if (supBy !== '') cli.die('task status: --by belongs to superseded only (--reason is allowed with blocked)');
  } else if (supReason !== '' || supBy !== '') {
    cli.die('task status: --reason belongs to superseded and blocked, --by to superseded only');
  }
  refusing(cli, () => requireTaskRef(ctx.gov, tid));
  if (st === 'in_progress') {
    // D-0084: ADMISSION IS PER RATIFIED SPRINT. Two refusals for two
    // different problems with two different repairs; a task in NO ratified
    // sprint keeps D-0006's original rule, unchanged.
    const as = refusing(cli, () => admissionState(ctx.gov, tid));
    if (as.home === '') {
      const busy = as.elsewhereIds.join(', ');
      if (busy !== '') {
        cli.die(`one task at a time: ${busy} is already in_progress — finish or move it first (scrumux task status ${busy} in_review|blocked)`);
      }
    } else {
      const elsew = as.elsewhere.join(', ');
      if (elsew !== '') {
        cli.die(`one sprint at a time: ${elsew} — finish or move that work first (scrumux task status <id> in_review|blocked), or run this task under the sprint that is already in flight (D-0084)`);
      }
      if (!(as.same.length < as.cap)) {
        cli.die(`${as.home} allows ${as.cap} in flight: ${as.same.join(', ')} already in_progress — finish or move one (scrumux task status <id> in_review|blocked). The cap is the plan's, so widening it is a re-ratification, not an edit (D-0084)`);
      }
    }
  }
  if (st === 'accepted') {
    // T-0187/D-0076: this path only catches a HAND-driven transition --
    // `task accept` sets the status itself. NOTE the different probe from the
    // I-0147 guard above: `jq -e '.acceptance.accepted == true'` is STRICTLY
    // boolean, while the guard's `// empty | first` admits any truthy value.
    if (!acceptedStrictly(tasksPath(ctx), tid)) {
      cli.die(`acceptance is User's: ${tid} has no recorded acceptance — record it (scrumux task accept ${tid} --by User --authority direct|standing:D-XXXX), which sets this status itself`);
    }
  }
  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, tasksPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== tid) return row;
      // `.updated_at=$d + (if $why=="" then "" else "" end)` -- jq binds the
      // `+` tighter than the `=`, so both arms concatenate the empty string:
      // a no-op branch, reproduced as none (cmd-task.md Simplify/perf).
      const base: { [k: string]: JsonValue } = { ...row, status: st, updated_at: d };
      // A block's reason lives only while the task is blocked (SX-006).
      if (st !== 'blocked') delete base['blocked'];
      if (st === 'blocked') return supReason === '' ? base : { ...base, blocked: { reason: supReason, date: d } };
      if (supReason === '') return base;
      return {
        ...base,
        superseded: { reason: supReason, ...(supBy === '' ? {} : { by: supBy }) },
      };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  cli.data({ id: tid, status: st });
  // BEFORE emit, and only in human mode -- these are prose lines on stdout,
  // and --json promises exactly one object there.
  if (!cli.json) {
    if (st === 'in_review') {
      attested(cli, tid, "report it to whoever accepts; acceptance re-runs the order's verification command");
    } else if (st === 'in_progress') {
      beat(cli, `${tid} is the work in flight. Its acceptance check is the one thing that settles it.`, `scrumux task order ${tid} names the single command that proves it`);
    } else if (st === 'blocked') {
      beat(cli, `${tid} is blocked and the sprint knows it.`, 'capture what blocks it with scrumux issue; do not work around it');
    }
  }
  return cli.emit(`${tid} -> ${st}`);
}

/**
 * `[.entries[] | select(.id==$id) | .acceptance.accepted // empty] | first`
 * then `[ "$_accpt" = "true" ]` -- `// empty` drops null AND false, so only a
 * truthy `accepted` survives, and the string compare then admits boolean
 * `true` AND the string `"true"`, exactly as `jq -r` renders both.
 */
function acceptedTrue(path: string, tid: string): boolean {
  for (const r of rows(path)) {
    const o = obj(r);
    if (o === null || o['id'] !== tid) continue;
    const acc = obj(o['acceptance']);
    if (acc === null) continue;
    const v = acc['accepted'];
    if (v === undefined || v === null || v === false) continue;
    return jqRaw(v) === 'true';
  }
  return false;
}

/** `jq -e '[.entries[] | select(.id==$t and (.acceptance.accepted == true))] | length > 0'`. */
function acceptedStrictly(path: string, tid: string): boolean {
  return rows(path).some((r) => {
    const o = obj(r);
    if (o === null || o['id'] !== tid) return false;
    const acc = obj(o['acceptance']);
    return acc !== null && acc['accepted'] === true;
  });
}

// --------------------------------------------------------------- order ----
interface OrderFile { path: string; why: string; expected_diff?: string }

function taskOrder(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const tid = args[0] ?? '';
  if (tid === '') {
    cli.die('usage: scrumux task order T-0001 --scope ... --verify ... --file "path | why [| expected diff]" ...');
  }
  refusing(cli, () => requireTaskRef(ctx.gov, tid));
  let scope = '';
  let verify = '';
  let story = '';
  let failsWhen = '';
  let light = 0;
  const out: string[] = [];
  const files: OrderFile[] = [];
  const refs: string[] = [];
  const cmds: string[] = [];
  const ifaces: string[] = [];
  const shapes: string[] = [];
  const arts: string[] = [];
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--scope') { scope = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--verify') { verify = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--story') { story = need(cli, rest, i + 1); i += 2; continue; }
    // D-0073's standalone lane. It marks the order, nothing more — the
    // tiering lives in task-lint and in sprint add. Boundary 4 is untouched.
    if (f === '--light') { light = 1; i += 1; continue; }
    // SX-003 (D-S016): the broken state this check must catch, stated by the
    // order writer. Guidance and evidence only -- lint echoes it, the brief
    // prints it, the app shows it at acceptance. Nothing refuses without it.
    if (f === '--fails-when') { failsWhen = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--out') { out.push(need(cli, rest, i + 1)); i += 2; continue; }
    if (f === '--file') {
      // `split(" | ") | {path: .[0], why: (.[1] // "")}` plus the optional
      // third segment. A fourth segment is silently ignored, as jq's is.
      const parts = need(cli, rest, i + 1).split(' | ');
      const entry: OrderFile = { path: parts[0] ?? '', why: parts[1] ?? '' };
      if ((parts[2] ?? '') !== '') entry.expected_diff = parts[2]!;
      files.push(entry);
      i += 2;
      continue;
    }
    if (f === '--ref') { refs.push(need(cli, rest, i + 1)); i += 2; continue; }
    if (f === '--command') { cmds.push(need(cli, rest, i + 1)); i += 2; continue; }
    if (f === '--interface') { ifaces.push(need(cli, rest, i + 1)); i += 2; continue; }
    if (f === '--shape') { shapes.push(need(cli, rest, i + 1)); i += 2; continue; }
    // I-0064: an order can name the files an implementer must READ, but not
    // the files that do not exist yet.
    if (f === '--artifact') { arts.push(need(cli, rest, i + 1)); i += 2; continue; }
    cli.die(`task order: unknown flag ${f} — see: scrumux help task`);
  }
  if (scope === '') {
    cli.die('task order: --scope is required (what this task changes) — name the change, the site it lands at, and the evidence it rests on, so the implementer does not have to search for any of the three. GOOD (build) "Create the governance directory before writing into it, on every graph write path, so a freshly deployed repo can build its own governance graph without a traceback" (T-0213). GOOD (defect) "Add build and OS artefacts to the session-check scope exemption at :202, alongside governance/*, *.MD and .claude/*: any path under __pycache__, any *.pyc, .pytest_cache, .DS_Store. Reproduced in canon acceptance run 4 — the close FAILed on agents/__pycache__/*.pyc" (T-0217). GOOD (governance) "Retire the seventeen rulings whose named script, journal, hook, schema or agent no longer exists, as one supersession with the per-decision evidence in the audit report" (D-0081). BAD "fix the graph" — it names neither the site nor what makes the change right.');
  }
  if (verify === '') {
    cli.die('task order: --verify is required (the command that proves the acceptance check passes) — exactly ONE runnable command, stating how to run it. GOOD "sh tests/session-check-tests.sh" (T-0217). GOOD "sh tests/graph-cli-tests.sh" (T-0213). GOOD ".venv/bin/python -m unittest discover -s service/tests -t ." for a Python suite. BAD "tests/session-check-tests.sh" — 27 of the 38 suites are mode 644 and exit 126 when invoked bare (D-0041). BAD "sh tests/a.sh && sh tests/b.sh" — composite; wrap multi-step verification in a script and point --verify at that.');
  }
  if (files.length === 0) {
    cli.die('task order: at least one --file "path | why" is required — context is assembled, not searched (D-0005). GOOD --file ".claude/scripts/session-check | :202, the exemption case" (T-0217). GOOD --file "agents/lib/governance_graph.py | the writer I-0111 traces to" (T-0213). GOOD --file "tests/graph-cli-tests.sh | gains its own GOV_ROOT so it stops racing the live indexes" (T-0213). A file the task will CREATE goes on --artifact, not here.');
  }
  if (files.some((x) => x.why === '')) {
    cli.die('task order: every --file needs a why — format: --file "path | why this file matters [| expected diff]". The why is what the implementer is meant to look FOR in that file, never what the file is. GOOD "path | :202, the exemption case". GOOD "path | the writer I-0111 traces to". GOOD "path | gains its own GOV_ROOT so it stops racing the live indexes". BAD "path | the session check script" — a restatement of the filename tells the reader nothing they did not have.');
  }
  if (story !== '') {
    const found = refExists(designPathOf(ctx), story, kindPick('story'));
    if (!found) cli.die(`task order: story ${story} not found in design.json`);
  }
  // L- joined the list (SX-037): an order may cite a log entry, and the brief
  // inlines it.
  const badRefs = refs.filter((r) => !/^(D|I|C|S|F|E|L)-[0-9]{4}$/.test(r)).join(', ');
  if (badRefs !== '') {
    cli.die(`task order: --ref must be a governance id (D-/I-/C-/S-/F-/E-/L-NNNN), got: ${badRefs}`);
  }
  // ALLOWED in session-check is a space-joined string, so a path containing
  // whitespace could never match and would read as an undeclared change.
  const badArts = arts.filter((a) => /\s/.test(a)).join(', ');
  if (badArts !== '') {
    cli.die(`task order: --artifact paths cannot contain whitespace (session-check matches them as space-separated words), got: ${badArts}`);
  }
  // A REPLACE that looks like an amend. `task order` restates the whole order,
  // so a flag left off empties its field -- and task lint used to print
  // `task order T-XXXX --ref D-XXXX` as the fix for a missing ref, which, once
  // its guards were satisfied, silently wiped out_of_scope, files, commands and
  // dropped expected_artifacts, the key gov-graph reads to classify changes.
  // Following the harness's own instruction destroyed the order the instruction
  // was fixing. No new gate: the replace is legitimate, it was only invisible.
  // '' = no prior order, 'none' = replaced but nothing shrank, else the losses.
  const loss = orderLoss(rowById(tasksPath(ctx), tid), {
    out_of_scope: out.length,
    files: files.length,
    refs: refs.length,
    commands: cmds.length,
    interfaces: ifaces.length,
    data_shapes: shapes.length,
    expected_artifacts: arts.length,
  });

  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, tasksPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== tid) return row;
      const withStory = story === '' ? row : { ...row, story };
      return {
        ...withStory,
        task_order: {
          ...(light === 1 ? { light: true } : {}),
          scope,
          out_of_scope: out,
          verification_command: verify,
          ...(failsWhen.trim() === '' ? {} : { fails_when: failsWhen }),
          context: {
            files: files as unknown as JsonValue,
            refs,
            commands: cmds,
            interfaces: ifaces,
            data_shapes: shapes,
            ...(arts.length === 0 ? {} : { expected_artifacts: arts }),
          },
        },
        updated_at: d,
      };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  if (loss === 'none') {
    cli.tell('order-replaced', `${tid} already carried an order and this REPLACED it; no field shrank. task order restates the whole order rather than amending it.`);
  } else if (loss !== '') {
    cli.tell('order-replaced', `${tid} already carried an order and this REPLACED it: ${loss}. task order restates the whole order rather than amending it, so a flag left off is a field emptied — re-issue with every flag the order carried if that was not intended (read them back: scrumux task brief ${tid}).`);
  }
  cli.data({ id: tid, ordered: true });
  return cli.emit(`${tid} order set`);
}

// -------------------------------------------------------------- update ----
function taskUpdate(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const tid = args[0] ?? '';
  if (tid === '') cli.die('usage: scrumux task update T-0001 [--feature F-0001] [--story S-0001] [--title TEXT]');
  refusing(cli, () => requireTaskRef(ctx.gov, tid));
  // ACCEPTANCE IS IMMUTABLE, and this was the one route around it. Ruled
  // 2026-08-27: guard it, and send a genuine correction through `repair
  // journal`, which forces the reason onto the record.
  if (acceptedTrue(tasksPath(ctx), tid)) {
    cli.die(`task update: ${tid} is ACCEPTED and its record is closed. Acceptance is a final-authority ruling, and every other path already refuses to move one — this was the last route around it. If the RECORD is wrong, correct it with scrumux repair journal tasks.json --apply '<jq>' --why '<reason>', which forces the reason onto the record. If the WORK needs more doing, that is a NEW task.`);
  }
  let feat = '';
  let story = '';
  let title = '';
  let desc = '';
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--feature') { feat = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--story') { story = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--title') { title = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--desc') { desc = need(cli, rest, i + 1); i += 2; continue; }
    cli.die(`task update: unknown flag ${f} — see: scrumux help task`);
  }
  if (feat === '' && story === '' && title === '' && desc === '') {
    cli.die('task update: nothing to update — pass at least one of --feature/--story/--title/--desc');
  }
  if (feat !== '') {
    const found = refExists(designPathOf(ctx), feat, kindPick('feature'));
    if (!found) cli.die(`task update: feature ${feat} not found in design.json — add it: scrumux feature new --name ... --desc ...`);
  }
  if (story !== '') {
    const found = refExists(designPathOf(ctx), story, kindPick('story'));
    if (!found) cli.die(`task update: story ${story} not found in design.json — add it: scrumux story new --feature ... --narrative ... --criterion ...`);
  }
  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, tasksPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== tid) return row;
      let r = row;
      if (desc !== '') r = { ...r, description: desc };
      if (feat !== '') r = { ...r, feature: feat };
      if (story !== '') r = { ...r, story };
      if (title !== '') r = { ...r, title };
      return { ...r, updated_at: d };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  cli.data({ id: tid, updated: true });
  return cli.emit(`${tid} updated`);
}

// ------------------------------------------- acceptance and rejection ----
/**
 * `acceptance_target_guard <id> <verb>` -- the ONE pointer for an R- target.
 * Backward compatibility is a refusal, never a second code path.
 */
function acceptanceTargetGuard(cli: Cli, id: string, verb: string): void {
  if (id.startsWith('R-')) {
    cli.die(`acceptance targets the task now: scrumux ${verb} T-XXXX --by User --authority direct|standing:D-XXXX (D-0076 — the review panel is gone; documented approval IS the review)`);
  }
}

function taskAccept(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const tid = args[0] ?? '';
  // --by IS REQUIRED. It defaulted to the literal 'User', which wrote his
  // name onto acceptances he never took.
  let by = '';
  let authority = '';
  const rest = args.length >= 1 ? args.slice(1) : args;
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--by') { by = need(cli, rest, i + 1); i += 2; continue; }
    if (f === '--authority') { authority = need(cli, rest, i + 1); i += 2; continue; }
    cli.die(`accept: unknown flag ${f} — see: scrumux help`);
  }
  if (tid === '') {
    cli.die('usage: scrumux task accept T-0001 --by WHO --authority direct|app:<session>|standing:D-0001 — records final-authority acceptance ON THE TASK.');
  }
  if (by === '') {
    cli.die("accept: --by is required — name who is accepting. It used to default to 'User', which put his name on acts he did not take. Use --by User when he accepts, or the agent's own id when it does.");
  }
  acceptanceTargetGuard(cli, tid, 'accept');
  refusing(cli, () => requireTaskRef(ctx.gov, tid));
  // Boundary 2: acceptance records its authority (shared with sprint ratify).
  refusing(cli, () => authorityGuard(ctx.gov, authority, 'accept'));
  // write-once (T-0095/I-0042). NB: `.acceptance.accepted == true`, never
  // `// true` — a REJECTED task carries accepted:false and must stay
  // acceptable after rework.
  const prior = priorAcceptance(tasksPath(ctx), tid);
  if (prior !== '') {
    cli.die(`${tid} was already accepted by ${prior} — an acceptance is write-once and re-accepting would rewrite that date and restamp updated_at (I-0042). To reverse it: scrumux task reject ${tid} --by User --reason '...'`);
  }
  // the receipt gate (CLAUDE.MD boundary 5, I-0091): a test that reports but
  // does not gate is not a gate.
  const task = rowById(tasksPath(ctx), tid);
  const receipt = task === null ? undefined : task['receipt'];
  const rcpt = obj(receipt);
  // `.receipt // empty` -- a null OR FALSE receipt is "no receipt" here.
  if (receipt === undefined || receipt === null || receipt === false) {
    cli.die(`accept: ${tid} has no task-verify receipt — acceptance refuses work that was never verified (CLAUDE.MD boundary 5). Run: .claude/scripts/scrumux task verify ${tid}`);
  }
  const rrc = rcpt === null ? '1' : rawOr(rcpt['rc'], '1');
  const rcf = rcpt === null ? '0' : rawOr(rcpt['checks_failed'], '0');
  if (rrc !== '0' || rcf !== '0') {
    const rdate = rcpt === null ? '?' : rawOr(rcpt['date'], '?');
    cli.die(`accept: ${tid}'s last task-verify receipt is RED (rc=${rrc}, checks_failed=${rcf}, dated ${rdate}) — acceptance refuses a red receipt (CLAUDE.MD boundary 5). Fix the failure, re-run .claude/scripts/scrumux task verify ${tid}, then accept.`);
  }
  // RE-RUN THE VERIFICATION, do not read the receipt and believe it (I-0139).
  // No command, no acceptance -- never a quiet pass.
  const order = task === null ? null : obj(task['task_order']);
  const averify = order === null ? '' : rawOr(order['verification_command'], '');
  if (averify === '') {
    cli.die(`accept: ${tid} has no verification_command in its task order, so there is nothing for acceptance to re-run. Acceptance re-runs rather than reading a receipt (I-0139); a task with no command to re-run cannot be accepted. Give it one: scrumux task order ${tid} --verify '<the single command that proves the check>'`);
  }
  // stderr, not stdout: the first line of stdout is the machine-readable
  // answer and progress chatter must not displace it.
  ictx.io.err(`re-running ${tid}'s verification before accepting: ${averify}\n`);
  // WORK_ROOT, not ROOT (CLI-7): acceptance re-runs the command to prove the
  // delivered CODE, and a dispatched session's code is in its worktree while
  // its records are on main. Matches task verify's run_check and session
  // check. For a CLI-only run WORK_ROOT == ROOT, so nothing changes there.
  // BOUNDED, and its whole process group stopped on a timeout (SX-029).
  rerunVerification(cli, ctx, tid, averify);
  ictx.io.err('  re-run passed (exit 0)\n');
  // D-S045: what the accepted check references, so a later change to the
  // check itself is visible beside its post-acceptance runs.
  const fingerprint = acceptedFingerprint(ctx, averify);

  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, tasksPath(ctx), (doc) =>
    mapEntries(doc, (row) =>
      row['id'] === tid
        // D-S018: the receipt acceptance gated on is copied in and frozen.
        ? { ...row, acceptance: { accepted: true, by, date: d, authority, reverified: true, ...(rcpt === null ? {} : { receipt: rcpt }), check_fingerprint: fingerprint as unknown as JsonValue }, status: 'accepted', updated_at: d }
        : row,
    ),
  );
  cli.data({ id: tid, accepted: true, by, authority });
  cli.say(`${tid} accepted`);
  beat(cli, 'VERIFIED — its command was re-run by the acceptor, not read off the receipt.', 'the attested claim is now confirmed by something that is not its author');
  issueTell(cli, ctx, task, tid);
  // cascade: sprint -> complete when this was the last unaccepted task
  // (T-0054). Only its trigger moved from the review record to the task.
  const asprint = sprintCarrying(sprintsPath(ctx), tid);
  if (asprint !== '') {
    const sp = rowById(sprintsPath(ctx), asprint);
    const spTasks = sp === null ? [] : arr(sp['tasks']);
    let allDone = true;
    for (const stRef of spTasks) {
      const t = rowById(tasksPath(ctx), jqRaw(stRef));
      const stst = t === null ? '' : jqRaw(t['status']);
      if (stst !== 'accepted') { allDone = false; break; }
    }
    if (allDone) {
      guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
        mapEntries(doc, (row) => (row['id'] === asprint ? { ...row, status: 'complete' } : row)),
      );
      cli.say(`${asprint} -> complete`);
      cli.data({ sprint_completed: asprint });
    }
  }
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit('');
}

/**
 * The write-once probe: `select(.id==$id and (.acceptance.accepted == true))`
 * -- STRICTLY boolean `true`, unlike the two `// empty` guards above -- then
 * `"\(.by) on \(.date) (authority: \(.authority // "unrecorded"))"`, or ''.
 */
function priorAcceptance(path: string, tid: string): string {
  for (const r of rows(path)) {
    const o = obj(r);
    if (o === null || o['id'] !== tid) continue;
    const acc = obj(o['acceptance']);
    if (acc === null || acc['accepted'] !== true) continue;
    return `${jqRaw(acc['by'])} on ${jqRaw(acc['date'])} (authority: ${rawOr(acc['authority'], 'unrecorded')})`;
  }
  return '';
}

/** The FIRST ratified sprint listing the id, else ''. Tolerant of a missing file. */
function sprintCarrying(path: string, tid: string): string {
  for (const r of rows(path)) {
    const o = obj(r);
    if (o === null || jqRaw(o['status']) !== 'ratified') continue;
    if (arr(o['tasks']).some((t) => t === tid)) return jqRaw(o['id']);
  }
  return '';
}

function taskReject(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  // --by IS REQUIRED, for the same reason as accept: the default asserted
  // that User rejected work he may never have seen.
  let tid = '';
  let by = '';
  let reason = '';
  for (let i = 0; i < args.length; ) {
    const f = args[i]!;
    if (f === '--by') { by = need(cli, args, i + 1); i += 2; continue; }
    if (f === '--reason') { reason = need(cli, args, i + 1); i += 2; continue; }
    if (f.startsWith('-')) cli.die(`reject: unknown flag ${f} — see: scrumux help`);
    tid = f;
    i += 1;
  }
  if (tid === '') {
    cli.die('usage: scrumux task reject T-0001 --by WHO --reason TEXT — records final-authority rejection ON THE TASK; it returns to in_progress.');
  }
  if (by === '') {
    cli.die("reject: --by is required — name who is rejecting. It used to default to 'User', which put his name on a ruling he may not have made.");
  }
  acceptanceTargetGuard(cli, tid, 'reject');
  refusing(cli, () => requireTaskRef(ctx.gov, tid));
  if (reason === '') {
    cli.die('reject: --reason TEXT is required — a rejection with no recorded reason sends the task back with nothing to fix. Name what is wrong and what would settle it. GOOD "The receipt is green but its command is \'sh tests/graph-cli-tests.sh\' while the order says \'sh tests/session-check-tests.sh\' — re-verify against the order\'s own command". GOOD "The exemption at :202 also swallows an unauthorised source file; add the negative case to tests/session-check-tests.sh before this comes back". BAD "not done" — it names neither the defect nor the bar.');
  }
  // NB: not `.acceptance.accepted // "none"` — jq's // swallows false too.
  // `tostring` has no such opinion: "false" when rejected, "null" when the
  // acceptance object carries no accepted at all, "none" when there is no
  // acceptance record (cmd-task.md open question 2 — kept as the explicit
  // three-way check, deliberately not `??`).
  const prior = rejectPrior(tasksPath(ctx), tid);
  if (prior === 'true') {
    cli.die(`reject: ${tid} is already accepted — rejection would overwrite a recorded final-authority ruling; that needs User's explicit reversal, not this command`);
  }
  // T-0144: TELL and proceed. D-0084: the same arithmetic the writer refuses
  // on, reported rather than enforced.
  const as = refusing(cli, () => admissionState(ctx.gov, tid));
  const relse = as.elsewhere.join(', ');
  if (relse !== '') {
    cli.say(`TELL: rejected work resumes immediately, but one sprint at a time — ${relse}. Move it (scrumux task status <id> in_review|blocked). Recording the rejection anyway.`);
  } else if (as.home !== '' && as.same.length >= as.cap) {
    cli.say(`TELL: rejected work resumes immediately, but ${as.home} allows ${as.cap} in flight: ${as.same.join(', ')} already in_progress. Move one (scrumux task status <id> in_review|blocked). Recording the rejection anyway.`);
  }
  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, tasksPath(ctx), (doc) =>
    mapEntries(doc, (row) =>
      row['id'] === tid
        ? { ...row, acceptance: { accepted: false, by, date: d, reason }, status: 'in_progress', updated_at: d }
        : row,
    ),
  );
  sealBootstrap(ctx.gov, ctx.today);
  cli.data({ id: tid, rejected: true, by });
  return cli.emit(`${tid} rejected -> in_progress`);
}

/** `if .acceptance == null then "none" else (.acceptance.accepted | tostring) end`. */
function rejectPrior(path: string, tid: string): string {
  const lines: string[] = [];
  for (const r of rows(path)) {
    const o = obj(r);
    if (o === null || o['id'] !== tid) continue;
    const acc = o['acceptance'];
    if (acc === undefined || acc === null) {
      lines.push('none');
      continue;
    }
    const accObj = obj(acc);
    const v = accObj === null ? undefined : accObj['accepted'];
    lines.push(v === undefined || v === null ? 'null' : jqRaw(v));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ dispatch ----
export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => NOUN_USAGE['task'] ?? '',
  run(cli, ictx, verb, args): never {
    const ctx = nounContext(ictx);
    switch (verb) {
      case 'new': return taskNew(cli, ctx, ictx, args);
      case 'order': return taskOrder(cli, ctx, ictx, args);
      case 'status': return taskStatus(cli, ctx, ictx, args);
      case 'update': return taskUpdate(cli, ctx, ictx, args);
      case 'lint': return taskLint(cli, ctx, ictx, args);
      case 'brief': return taskBrief(cli, ctx, ictx, args);
      case 'verify': return taskVerify(cli, ctx, ictx, args);
      case 'accept': return taskAccept(cli, ctx, ictx, args);
      case 'reject': return taskReject(cli, ctx, ictx, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun task — verbs: new, order, status, update, lint, brief, verify, accept, reject. See: scrumux help task`,
        );
    }
  },
};

/**
 * What `task order` is about to take away, phrased the way the guard
 * itself renders it.
 *
 * The jq that renders this walks a FIXED field list in a fixed order and keeps
 * only the entries whose new count is strictly lower, so the two sides agree on
 * the wording, the order and the arithmetic. `expected_artifacts` is compared
 * through `// []` on both sides because its ABSENCE is the interesting case:
 * the key is omitted entirely when the list is empty, which is how a set of
 * artifacts disappears without any field appearing to change.
 *
 * Returns '' when there was no prior order (nothing was replaced), 'none' when
 * one was replaced and no field shrank, else the comma-joined losses.
 */
function orderLoss(
  prior: { [k: string]: JsonValue } | null,
  next: { [k: string]: number },
): string {
  const p = prior === null ? null : obj(prior['task_order']);
  if (p === null) return '';
  const c = obj(p['context']) ?? {};
  const before: [string, number][] = [
    ['out_of_scope', arr(p['out_of_scope']).length],
    ['files', arr(c['files']).length],
    ['refs', arr(c['refs']).length],
    ['commands', arr(c['commands']).length],
    ['interfaces', arr(c['interfaces']).length],
    ['data_shapes', arr(c['data_shapes']).length],
    ['expected_artifacts', arr(c['expected_artifacts']).length],
  ];
  const lost: string[] = [];
  for (const [k, b] of before) {
    const a = next[k] ?? 0;
    if (a < b) lost.push(`${k} ${b} -> ${a}`);
  }
  return lost.length === 0 ? 'none' : lost.join(', ');
}

// Re-exported for the noun's own unit tests; nothing else imports these.
export { acceptedTrue as _acceptedTrue, rejectPrior as _rejectPrior };
