/**
 * The `sprint` noun. Brief: docs/port/modules/session-sprint-repair.md.
 *
 * A SPRINT IS THE UNIT USER RATIFIES, and every refusal in this file follows
 * from that one fact:
 *
 *   `new --parallel N`     the admission cap is DECLARED AT PLANNING, so it is
 *                          visible in the plan he approved rather than in a
 *                          setting somewhere else (D-0084).
 *   `new --hotfix`         one issue promoted to one task, so there is never a
 *                          second slot. A `--parallel` other than 1 is REFUSED
 *                          rather than silently forced -- a cap the operator
 *                          asked for and did not get is the quiet disagreement
 *                          this CLI exists to stop.
 *   `update --parallel`    the ONE field that changes after opening, and only
 *                          while the sprint is still `proposed`. Changing how
 *                          much work a RATIFIED plan runs at once changes the
 *                          thing User said yes to: that is a re-ratification,
 *                          not an edit, and the CLI will not blur the two.
 *   `ratify --by/--authority`  both required. `--by` used to default to the
 *                          literal `User`, which wrote his name onto acts he
 *                          did not take -- nothing here verifies who is
 *                          calling (P-21), so it records the basis and refuses
 *                          to guess the actor.
 *   `descope --reason`     required, and a task with log entries is TOLD about
 *                          and descoped anyway (T-0144). The old message named
 *                          both alternatives and refused to act on either.
 *
 * THE HOTFIX GATE IS THE PROMOTION GATE, and it reads TWO disjoint fields
 * (I-0010): `.validation.verdict` in {reproduced, evidenced} opens it, and
 * User's `.authorization` opens it for a verdict of `none`. `invalidated` and
 * `duplicate` each get their own refusal naming the command that closes the
 * issue rather than fixes it. ANY OTHER VERDICT STRING -- and a `.validation`
 * carrying no verdict at all -- is REFUSED: a filter with no explicit default
 * arm would silently open the lane for anything it does not recognize. See
 * the note on `hotfixGate`.
 *
 * `sprint add` SORTS. The filter is `(.tasks // []) + [$t] | unique`, and jq's
 * `unique` is sort-and-dedupe, not dedupe: adding T-0002 to a sprint holding
 * T-0009 reorders the array. That is observable in `BACKLOG.MD` and in the
 * post-state, so it is the contract.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import { authorityGuard, parallelGuard } from '../journal/guards.js';
import { parsePreservingNumbers, RawNumber, type JsonValue } from '../journal/jqformat.js';
import { refExists, requireTaskRef } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { ensureFile } from '../journal/write.js';
import { unique } from './lib/jqlike.js';
import { pendingAdditions, withAddition, withAdditionsRatified } from './sprint-additions.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';
import { appendEntry, flagValue, guardedAppend, guardedWrite, idStream, mapEntries } from './lib/writers.js';

export const VERBS = ['new', 'add', 'update', 'descope', 'ratify', 'status'] as const;

const VERBS_TSV = `new\topen a sprint against an epic, or a hotfix sprint from an issue
add\tput a task in the sprint (it needs a complete order first)
update\tchange how many tasks the sprint runs at once, while it is still proposed
descope\tremove UNWORKED work from a ratified plan
ratify\tUser's word turns a proposal into a plan
status\tcomplete or abandon a sprint
`;

const SEED = '{"entries": []}';

const sprintsPath = (ctx: NounContext): string => join(ctx.gov, 'sprints.json');
const issuesPath = (ctx: NounContext): string => join(ctx.gov, 'issues.json');
const tasksPath = (ctx: NounContext): string => join(ctx.gov, 'tasks.json');

/** A tolerant read: `jq -r` on an unreadable journal hands back nothing. */
function rows(path: string): JsonValue[] {
  if (!existsSync(path)) return [];
  try {
    const doc = parsePreservingNumbers(readFileSync(path, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
    const e = (doc as { [k: string]: JsonValue })['entries'];
    return Array.isArray(e) ? e : [];
  } catch {
    return [];
  }
}

/**
 * `.x` as an object, or null.
 *
 * `RawNumber` IS EXCLUDED, and the day it was not cost this file a fail-open.
 * `parsePreservingNumbers` boxes every number so jq's byte-exact output can be
 * reproduced, and the box is a JavaScript object -- so a journal holding
 * `"validation": 42` handed `hotfixGate` an "object" with no `verdict` key and
 * the refusal quoted jq's `null` instead of the number. The correct predicate
 * already exists in `src/nouns/task/shared.ts:43`; this was the un-updated
 * copy. Same fix, same reasoning.
 */
function obj(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v) || v instanceof RawNumber) {
    return null;
  }
  return v as { [k: string]: JsonValue };
}

function rowById(path: string, id: string): { [k: string]: JsonValue } | null {
  for (const r of rows(path)) {
    const o = obj(r);
    if (o !== null && o['id'] === id) return o;
  }
  return null;
}

// ---------------------------------------------------------------------- new
function sprintNew(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  let epic = '';
  let hotfix = 0;
  let issue = '';
  let parallel = '';

  for (let i = 0; i < args.length; ) {
    const f = args[i]!;
    if (f === '--epic') { epic = flagValue(cli, args, i + 1, 'sprint new'); i += 2; continue; }
    // A BARE FLAG: it consumes one token, not two.
    if (f === '--hotfix') { hotfix = 1; i += 1; continue; }
    if (f === '--issue') { issue = flagValue(cli, args, i + 1, 'sprint new'); i += 2; continue; }
    if (f === '--parallel') { parallel = flagValue(cli, args, i + 1, 'sprint new'); i += 2; continue; }
    cli.die(`sprint new: unknown flag ${f} — see: scrumux help sprint`);
  }

  refusing(cli, () => parallelGuard(parallel, 'sprint new'));

  if (hotfix === 1) {
    if (!(parallel === '' || parallel === '1')) {
      cli.die(
        'sprint new: a hotfix sprint runs one task — it is one issue promoted to one task, so there is no second slot to declare (D-0084). Drop --parallel, or open an epic-lane sprint.',
      );
    }
    parallel = '1';
    if (issue === '') {
      cli.die(
        'sprint new: hotfix sprints need --issue I-0001 (the issue being promoted, per D-0004) — scrumux sprint new --hotfix --issue I-XXXX',
      );
    }
    if (!refExists(issuesPath(ctx), issue)) {
      cli.die(`sprint new: issue ${issue} not found in issues.json`);
    }
    if (epic !== '') cli.die('sprint new: --hotfix and --epic are mutually exclusive');
    hotfixGate(cli, ctx, issue);
  } else {
    if (epic === '') {
      cli.die(
        'sprint new: --epic E-0001 is required (sprints are epic-bounded, D-0004) — or use --hotfix --issue I-0001 for the fast lane',
      );
    }
    // `design.json` is POLYMORPHIC, so the stream selects on `.kind` too.
    const found = refExists(join(ctx.gov, 'design.json'), epic, (r) => {
      const o = obj(r);
      return o !== null && o['kind'] === 'epic' ? o['id'] : undefined;
    });
    if (!found) {
      cli.die(`sprint new: epic ${epic} not found — add it first: scrumux epic new --name ... --desc ...`);
    }
  }

  const path = sprintsPath(ctx);
  refusing(cli, () => ensureFile(path, SEED));
  const d = ctx.today;
  // `--argjson p "${PARALLEL:-1}"`. The default is an EXPLICIT 1, never null
  // (scrumux-tests.sh:966), and the value is a NUMBER because jq parsed it as
  // JSON -- which is also why `--parallel 007` records `7`: `parallel_guard`
  // admits any run of digits and jq's own parse canonicalises it.
  const p = parallel === '' ? 1 : Number(parallel);
  const r = guardedAppend(cli, ctx, ictx.io, path, idStream, 'SP', (doc, id) =>
    appendEntry(doc, {
      id,
      epic: epic === '' ? null : epic,
      hotfix: hotfix === 1,
      source_issue: issue === '' ? null : issue,
      tasks: [],
      status: 'proposed',
      parallel: p,
      created_at: d,
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return emitted(cli, r.id);
}

/**
 * The promotion gate.
 *
 * THE `case` HAS A DEFAULT ARM (User's ruling, on the PK-1 precedent).
 * Without one, a `.validation.verdict` holding anything unrecognized -- a
 * hand-written journal, an older vocabulary, or a `.validation` object with
 * no `verdict` key at all (`jq -r` prints the four letters `null` for that,
 * and `null` matches no arm either) -- would fall through and OPEN the
 * hotfix sprint. `{"validation":{"verdict":"anything"}}` would promote an
 * issue nobody had validated.
 *
 * It refuses rather than guessing, because guessing has no safe default:
 * reading an unknown verdict as "validated" ships an unvalidated fix, and
 * reading it as "invalidated" tells the operator to close an issue nobody
 * disproved.
 */
function hotfixGate(cli: Cli, ctx: NounContext, issue: string): void {
  const row = rowById(issuesPath(ctx), issue);
  const validation = row === null ? null : obj(row['validation']);
  // APPROVED-DIVERGENCE: R-011. A NON-OBJECT `.validation` -- a string, a
  // number, a boolean, an array -- still renders here: the refusal below
  // quotes whatever was actually read rather than staying silent about it.
  //
  // BOTH PATHS THROUGH THIS FUNCTION FAIL CLOSED -- exit 2, same sentence --
  // which is the whole of what makes this ratifiable. See the note on
  // `jqRaw` for the one place that guarantee once broke.
  //
  // Same class as R-009: the disposition is identical and only the words
  // differ. Pinned in `test/unit/rulings-hardenE.test.ts`.
  //
  // `if .validation == null then "none" else .validation.verdict end`, then
  // `jq -r`: a string prints raw and anything else prints its JSON text.
  const vstate =
    row === null || row['validation'] === undefined || row['validation'] === null
      ? 'none'
      : validation === null
        ? jqRaw(row['validation'])
        : jqRaw(validation['verdict']);
  const authed = row !== null && row['authorization'] !== undefined && row['authorization'] !== null;

  if (vstate === 'reproduced' || vstate === 'evidenced') return;
  if (vstate === 'none') {
    // User's authorization is its own gate-pass; it is never a validation
    // (I-0010).
    if (!authed) {
      cli.die(
        `sprint new: ${issue} has neither validation nor authorization — validate it (scrumux issue validate ${issue} --verdict ... --evidence '<what you saw>') or record User's word (scrumux issue authorize ${issue} --by User)`,
      );
    }
    return;
  }
  if (vstate === 'invalidated') {
    cli.die(
      `sprint new: ${issue} was invalidated — close it instead of fixing it: scrumux issue update ${issue} --status rejected (the disproof is already recorded, D-0011)`,
    );
  }
  if (vstate === 'duplicate') {
    const dupRaw = validation === null ? undefined : validation['duplicate_of'];
    // `.validation.duplicate_of // "?"` -- null and false both become "?".
    const dup = dupRaw === undefined || dupRaw === null || dupRaw === false ? '?' : jqRaw(dupRaw);
    cli.die(
      `sprint new: ${issue} is a duplicate of ${dup} — work the original; attach and close this one: scrumux issue update ${issue} --task <T-XXXX> --status rejected`,
    );
  }
  // APPROVED-DIVERGENCE: R-011, marked here too. This is the refusal the
  // ruling is actually about -- `(verdict: ${vstate})` -- and it sits far
  // enough below the `vstate` computation above that a reader arriving at
  // this refusal directly should not have to scroll up to find the ruling.
  cli.die(
    `sprint new: ${issue} carries a validation verdict this gate does not recognise (verdict: ${vstate}) — the hotfix lane opens only on reproduced or evidenced, and closes on invalidated or duplicate. A verdict outside that vocabulary, or a validation carrying none at all, is refused rather than promoted: a verdict the gate cannot read is not a validation. Re-validate it: scrumux issue validate ${issue} --verdict reproduced|evidenced|invalidated|duplicate --evidence '<what you saw>'`,
  );
}

/**
 * `jq -r` of one value: a string raw, anything else as its JSON text.
 *
 * MUST NOT BE `String(v)`. `String(['reproduced'])` is the bare word
 * `reproduced`, so an issue whose `.validation` was the ARRAY
 * `["reproduced"]` would read as the passing verdict and open the hotfix
 * gate -- and the same one-element trick would get past `sprintUpdate`'s
 * `status !== 'proposed'` guard via `["proposed"]`, widening a ratified
 * sprint's parallelism. Rendering as JSON text instead closes both: an
 * array never equals the bare string a gate is checking for.
 *
 * `src/nouns/task/shared.ts:24-31` carries the same predicate; keep them in
 * sync.
 *
 * `RawNumber` unboxes to its own text rather than going through
 * `JSON.stringify`, because the box exists precisely to hold digits jq would
 * print and JavaScript would round.
 */
function jqRaw(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof RawNumber) return v.text;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------- add
function sprintAdd(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  // A third positional argument is silently ignored: args[0]/args[1] are
  // read directly, nothing shifts or consumes argv.
  const sid = args[0] ?? '';
  const tid = args[1] ?? '';
  if (sid === '' || tid === '') cli.die('usage: scrumux sprint add SP-0001 T-0001');
  if (!refExists(sprintsPath(ctx), sid)) {
    cli.die(`sprint add: ${sid} not found in sprints.json — create it first: scrumux sprint new --epic E-XXXX`);
  }
  refusing(cli, () => requireTaskRef(ctx.gov, tid));

  const task = rowById(tasksPath(ctx), tid);
  const order = task === null ? undefined : task['task_order'];
  if (order === undefined || order === null) {
    cli.die(
      `task order first: ${tid} has no task_order — complete it before it can enter a sprint (D-0005): scrumux task order ${tid} --scope ... --verify ... --file "path | why"`,
    );
  }

  const sprint = rowById(sprintsPath(ctx), sid);
  const hot = sprint === null ? 'null' : jqRaw(sprint['hotfix']);
  // T-0189/D-0073: the light lane is the SECOND storyless lane. The
  // relaxation is carried by the ORDER, not by the sprint, so a plain order in
  // the same sprint is still refused below.
  const orderObj = obj(order);
  const lit = orderObj !== null && orderObj['light'] === true ? 'true' : 'false';
  if (hot !== 'true' && lit !== 'true') {
    const story = task === null ? undefined : task['story'];
    if (story === undefined || story === null) {
      cli.die(
        `one user story per task: ${tid} has no story — set it via scrumux task order ${tid} --story S-XXXX ... (hotfix sprints and light orders are the storyless lanes; mint a light one with scrumux task order ${tid} --light ...)`,
      );
    }
  }

  const d = ctx.today;
  // D-S017: on a RATIFIED sprint the addition is allowed and recorded as
  // awaiting ratification (`sprint-additions.ts`); `unique` stays jq's
  // sort-and-dedupe, so the tasks array is reordered as it always was.
  let awaits = false;
  guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== sid) return row;
      const r = withAddition(row, tid, d, (xs) => unique(xs));
      awaits = r.awaitsRatification;
      return r.row;
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  if (awaits) {
    cli.tell('addition-awaits-ratification', `${sid} is already ratified, so ${tid} was added as an ADDITION awaiting ratification (D-S017): it is not dispatched until the addition is ratified (scrumux sprint ratify ${sid} --by WHO --authority direct|app|standing:D-XXXX — in scrumux-app, the ratify gate for ${sid}). The tasks already ratified are unaffected.`);
    return cli.emit(`${tid} added to ${sid} — awaiting ratification of the addition`);
  }
  return cli.emit(`${tid} added to ${sid}`);
}

// ------------------------------------------------------------------ descope
function sprintDescope(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const sid = args[0] ?? '';
  const tid = args[1] ?? '';
  // WITH FEWER THAN TWO ARGUMENTS, rest stays UNCHANGED (the whole args
  // array), so `sprint descope SP-0001` hands "SP-0001" to the flag loop
  // below and refuses as an unknown flag -- the usage refusal two lines
  // below is unreachable for that shape.
  const rest = args.length >= 2 ? args.slice(2) : args;

  let reason = '';
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--reason') { reason = flagValue(cli, rest, i + 1, 'sprint descope'); i += 2; continue; }
    cli.die(`sprint descope: unknown flag ${f} — usage: scrumux sprint descope SP-0001 T-0001 --reason TEXT`);
  }
  if (sid === '' || tid === '') cli.die('usage: scrumux sprint descope SP-0001 T-0001 --reason TEXT');
  if (reason === '') {
    cli.die(
      'sprint descope: --reason is required — a descope with no recorded reason is indistinguishable from a task that vanished. Name what changed and where the work went. GOOD "I-0112 read-side self-heal on staleness is a NEW capability and the freeze holds; the issue stays documented and nothing here depends on it landing this sprint". GOOD "Superseded by T-0217, which covers the same session-check exemption and adds the negative case; this one would land the weaker half of it". BAD "out of scope" — the plan already said what was in scope, so that only restates the act.',
    );
  }
  if (!refExists(sprintsPath(ctx), sid)) cli.die(`sprint descope: ${sid} not found in sprints.json`);
  refusing(cli, () => requireTaskRef(ctx.gov, tid));

  const sprint = rowById(sprintsPath(ctx), sid);
  const carried = sprint !== null && (() => {
    const t = sprint['tasks'];
    return Array.isArray(t) && t.some((x) => x === tid);
  })();
  if (!carried) {
    cli.die(`sprint descope: ${tid} is not carried by ${sid} — see the plan: .claude/scripts/scrumux status --sprint`);
  }

  // T-0144: TELL and perform the descope. Removing worked work from a plan is
  // a User call, and the log entries it names are not erased by it.
  // Computed only when `log.json` EXISTS -- a repo that has never logged is
  // silent rather than told, which is the same silence as zero matches.
  const logPath = join(ctx.gov, 'log.json');
  if (existsSync(logPath)) {
    const worked = rows(logPath).filter((r) => {
      const o = obj(r);
      return o !== null && o['task'] === tid;
    }).length;
    if (worked !== 0) {
      // Written through, not buffered: the write below can still refuse, and
      // this line must already be visible by then. `Cli.say` writes through
      // since User's 2026-09-01 ruling, so the local workaround this line
      // carried (`sayNow`) is retired.
      cli.say(
        `TELL: ${tid} has ${worked} log entry/entries — it was worked, and descoping does not erase them. Descoping anyway; retire it instead with scrumux task status ${tid} superseded --reason ... if that is what you meant.`,
      );
    }
  }

  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== sid) return row;
      const cur = row['tasks'];
      const kept = (Array.isArray(cur) ? cur : []).filter((x) => x !== tid);
      const prior = row['descoped'];
      const descoped = [...(Array.isArray(prior) ? prior : []), { task: tid, reason, date: d }];
      return { ...row, tasks: kept, descoped, updated_at: d };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${tid} descoped from ${sid}`);
}

// ------------------------------------------------------------------- update
function sprintUpdate(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const sid = args[0] ?? '';
  const rest = args.slice(1);
  let parallel = '';
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--parallel') { parallel = flagValue(cli, rest, i + 1, 'sprint update'); i += 2; continue; }
    cli.die(
      `sprint update: unknown flag ${f} — the only field this verb changes is --parallel N; tasks, status and ratification have their own verbs (scrumux help sprint)`,
    );
  }
  if (sid === '') cli.die('usage: scrumux sprint update SP-0001 --parallel N');
  if (parallel === '') {
    cli.die('sprint update: nothing to update — the only field this verb changes is --parallel N (D-0084)');
  }
  refusing(cli, () => parallelGuard(parallel, 'sprint update'));
  if (!refExists(sprintsPath(ctx), sid)) {
    cli.die(
      `sprint update: ${sid} not found in sprints.json — see BACKLOG.MD Sprints section, or open it first: scrumux sprint new --epic E-XXXX --parallel N`,
    );
  }
  const row = rowById(sprintsPath(ctx), sid);
  const spst = row === null ? 'null' : jqRaw(row['status']);
  const sphot = row === null ? 'null' : jqRaw(row['hotfix']);
  if (sphot === 'true') {
    cli.die(`sprint update: ${sid} is a hotfix sprint — one issue, one task, one slot; there is nothing to widen (D-0084)`);
  }
  // THE REFUSAL THAT MATTERS.
  if (spst !== 'proposed') {
    cli.die(
      `sprint update: ${sid} is ${spst} — changing how many tasks a RATIFIED plan runs at once is a re-ratification, not an edit (D-0084). Open a new sprint for the extra work, or have User ratify the changed plan again.`,
    );
  }

  const d = ctx.today;
  const p = Number(parallel);
  guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
    mapEntries(doc, (row2) => (row2['id'] === sid ? { ...row2, parallel: p, updated_at: d } : row2)),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${sid} updated — up to ${parallel} task(s) in flight once it is ratified`);
}

// ------------------------------------------------------------------- ratify
function sprintRatify(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const sid = args[0] ?? '';
  const rest = args.slice(1);
  let by = '';
  let authority = '';
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--by') { by = flagValue(cli, rest, i + 1, 'sprint ratify'); i += 2; continue; }
    if (f === '--authority') { authority = flagValue(cli, rest, i + 1, 'sprint ratify'); i += 2; continue; }
    cli.die(`sprint ratify: unknown flag ${f} — see: scrumux help sprint`);
  }
  if (sid === '') {
    cli.die('usage: scrumux sprint ratify SP-0001 --by WHO --authority direct|app:<session>|standing:D-0001');
  }
  if (by === '') {
    cli.die(
      "sprint ratify: --by is required — name who is ratifying. It used to default to 'User', which wrote his name onto acts he did not take. Use --by User when he ratifies, or the agent's own id when it does.",
    );
  }
  refusing(cli, () => authorityGuard(ctx.gov, authority, 'sprint ratify'));
  if (!refExists(sprintsPath(ctx), sid)) {
    cli.die(`sprint ratify: ${sid} not found — see BACKLOG.MD Sprints section or create: scrumux sprint new`);
  }
  const row = rowById(sprintsPath(ctx), sid);
  // `.tasks | length` -- jq's `length` on null is 0, so an absent array is
  // "no tasks" rather than an error.
  const tasks = row === null ? null : row['tasks'];
  const n = Array.isArray(tasks) ? tasks.length : 0;
  if (n < 1) {
    cli.die(
      `sprint ratify: ${sid} has no tasks — a sprint plan is a collection of 1 or more tasks; add them first (scrumux sprint add ${sid} T-XXXX)`,
    );
  }

  const d = ctx.today;
  // D-S017: a ratified sprint with additions awaiting ratification ratifies
  // THOSE, and leaves the sprint's own `ratified` record as it was.
  const pending = row !== null && row['status'] === 'ratified' ? pendingAdditions(row) : [];
  if (pending.length > 0) {
    guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
      mapEntries(doc, (row2) => (row2['id'] === sid ? (withAdditionsRatified(row2, by, d, authority) ?? row2) : row2)),
    );
    sealBootstrap(ctx.gov, ctx.today);
    cli.data({ id: sid, additions_ratified: pending });
    return cli.emit(`${sid} addition(s) ratified: ${pending.join(', ')} — the sprint's original ratification is unchanged`);
  }
  guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
    mapEntries(doc, (row2) =>
      row2['id'] === sid
        ? { ...row2, status: 'ratified', ratified: { by, date: d, authority }, updated_at: d }
        : row2,
    ),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${sid} ratified`);
}

// ------------------------------------------------------------------- status
function sprintStatus(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const sid = args[0] ?? '';
  const st = args[1] ?? '';
  if (sid === '' || st === '') cli.die('usage: scrumux sprint status SP-0001 complete|abandoned');
  if (st !== 'complete' && st !== 'abandoned') {
    cli.die('sprint status: only complete|abandoned here (ratification has its own command: scrumux sprint ratify)');
  }
  if (!refExists(sprintsPath(ctx), sid)) cli.die(`sprint status: ${sid} not found`);

  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, sprintsPath(ctx), (doc) =>
    mapEntries(doc, (row) => (row['id'] === sid ? { ...row, status: st, updated_at: d } : row)),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${sid} -> ${st}`);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => NOUN_USAGE['sprint'] ?? '',
  run(cli, ictx, verb, args): never {
    const ctx = nounContext(ictx);
    switch (verb) {
      case 'new': return sprintNew(cli, ctx, ictx, args);
      case 'add': return sprintAdd(cli, ctx, ictx, args);
      case 'update': return sprintUpdate(cli, ctx, ictx, args);
      case 'descope': return sprintDescope(cli, ctx, ictx, args);
      case 'ratify': return sprintRatify(cli, ctx, ictx, args);
      case 'status': return sprintStatus(cli, ctx, ictx, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun sprint — verbs: new, add, update, descope, ratify, status. See: scrumux help sprint`,
        );
    }
  },
};
