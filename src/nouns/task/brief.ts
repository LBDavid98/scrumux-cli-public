/**
 * `task brief` -- the implement-sop skill's opening move: the full frame for
 * one task. Gate preconditions, the rejection notice, scope, reading list,
 * the two graph blocks, resolved refs, ground truth, history.
 *
 * TWO OUTPUT CHANNELS, DELIBERATELY. `say` lines are suppressed under
 * `--json`; the Title, rejected-notice, scope, reading list, ground truth
 * and history blocks write to stdout UNCONDITIONALLY, so under `--json`
 * they precede the one object. This is deliberate, not repaired -- see
 * `shared.ts`'s header.
 *
 * THE GATES ARE TELLS, NOT BLOCKS (T-0144), except the one that matters: a
 * task with NO ORDER fails the brief at exit 1 -- an assertion that did not
 * hold, not a bespoke exit 2.
 *
 * THE CODE-GRAPH BLOCK DEGRADES LOUDLY. "Silence here would read as 'nothing
 * calls this file', which is the most dangerous wrong answer this block could
 * give" (`:826-828`) -- so a missing CLI, an empty CHANGES set and an
 * unavailable index each say so in their own words, and the three messages
 * stay three messages.
 *
 * THE REJECTED-TASK NOTICE avoids `.acceptance.accepted // "none"` because
 * jq's `//` yields its right side for false -- the exact value under test
 * (`:697-701`; cmd-task.md open question 2, ported as the same explicit
 * check).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../../cli/envelope.js';
import { parsePreservingNumbers, type JsonValue } from '../../journal/jqformat.js';
import { refResolve } from '../../journal/refs.js';
import { citedLogBlock, mustFailWhenLine, WORKING_NOTES } from './brief-notes.js';
import { admissionState } from '../../journal/guards.js';
import { refusing } from '../../journal/refusal.js';
import { isExecutable } from '../../util/fs-predicates.js';
import type { DispatchContext, NounContext } from '../lib/context.js';
import {
  arr,
  cliPath,
  bearingChangedPaths,
  bearingRecordLines,
  directOut,
  interp,
  jqRaw,
  obj,
  rawOr,
  rows,
  runScrumux,
  sprintsPath,
  stripTrailingNewlines,
  tasksPath,
} from './shared.js';
import { unratifiedAdditionSprint } from '../sprint-additions.js';

export function taskBrief(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const out = directOut(ictx.io);
  const tasks = tasksPath(ctx);
  let tid = '';
  let allow = 0;
  for (const a of args) {
    if (a === '--allow-unsprinted') { allow = 1; continue; }
    if (/^T-[0-9]{4}$/.test(a)) { tid = a; continue; }
    cli.dieUsage('usage: scrumux task brief T-0001 [--allow-unsprinted]');
  }
  if (tid === '') cli.dieUsage('usage: scrumux task brief T-0001 [--allow-unsprinted]');
  if (!existsSync(tasks)) cli.die('no governance/tasks.json');

  const row = rows(tasks)
    .map((r) => obj(r))
    .find((o): o is { [k: string]: JsonValue } => o !== null && o['id'] === tid);
  if (row === undefined) cli.die(`${tid} not found in governance/tasks.json — check the task id`);

  cli.say(`=== TASK BRIEF ${tid} (${ctx.today}) ===`);
  out(`Title:  ${interp(row['title'])}\nStatus: ${interp(row['status'])}\nStory:  ${rawOr(row['story'], 'NONE')}\nFeature: ${rawOr(row['feature'], 'NONE')}\nAcceptance check: ${interp(row['acceptance_check'])}`);

  // --- Sent back --------------------------------------------------------
  // Observed on T-0005 in scrumux-agents: a task User returned arrived
  // looking exactly like new work, with the reason sitting in tasks.json the
  // whole time. `tostring`, never `//`: "false" when rejected, "null" when
  // there is no acceptance record.
  const acc = obj(row['acceptance']);
  const accepted = acc === null ? undefined : acc['accepted'];
  // `tostring` renders boolean false AND the string "false" the same way,
  // and `jq -r` is how the comparison sees it.
  if (accepted !== undefined && accepted !== null && jqRaw(accepted) === 'false') {
    cli.say('');
    cli.say('--- THIS TASK WAS REJECTED AND SENT BACK ---');
    out(`by:     ${acc === null ? 'unknown' : rawOr(acc['by'], 'unknown')}\ndate:   ${acc === null ? 'unknown' : rawOr(acc['date'], 'unknown')}\nreason: ${acc === null ? '(none recorded)' : rawOr(acc['reason'], '(none recorded)')}`);
    cli.say('');
    cli.say('This is NOT new work. Fix what the reason names. The acceptance check has');
    cli.say('not changed, so passing it the same way it was passed before will be');
    cli.say('rejected the same way -- and acceptance RE-RUNS the verification command');
    cli.say('rather than trusting the receipt, so a command that only passes where you');
    cli.say('happen to be sitting will fail when someone else runs it.');
  }

  // --- Gates ------------------------------------------------------------
  let gateFail = 0;
  const sprint = ratifiedSprintCarrying(sprintsPath(ctx), tid);
  // D-S017: an addition to a ratified sprint waits for its own ratification.
  const pendingIn = unratifiedAdditionSprint(rows(sprintsPath(ctx)), tid);
  cli.say('');
  cli.say('--- Gates ---');
  if (pendingIn !== '') {
    cli.fail(`${tid}/sprint`, `${tid} was added to ${pendingIn} after ${pendingIn} was ratified, and the addition is not ratified yet (D-S017). It is not dispatched until it is: scrumux sprint ratify ${pendingIn} --by WHO --authority direct|app|standing:D-XXXX (in scrumux-app, the ratify gate for ${pendingIn}). The tasks ratified with the sprint are unaffected.`);
    gateFail = 1;
  } else if (sprint !== '') {
    cli.say(`sprint: ${tid} is in ratified sprint ${sprint} — OK (D-0004)`);
  } else if (allow === 1) {
    cli.say('sprint: NOT in a ratified sprint — proceeding on --allow-unsprinted (User-directed bootstrap only; session-check will flag it)');
  } else {
    // T-0144: TELL, not a block -- session-check section 1 backstops it at
    // close, with a waiver path (I-0074 records the old block's cost).
    cli.say(`sprint: TELL — ${tid} is not in any ratified sprint (D-0004). Fix: session-open skill, or scrumux sprint add SP-XXXX ${tid} + User's ratification. Proceeding; session-check will name it at close.`);
  }
  // D-0084: the SAME computation the writer refuses on, reported as a TELL.
  const as = refusing(cli, () => admissionState(ctx.gov, tid));
  if (as.home === '') {
    const busy = as.elsewhereIds.join(', ');
    if (busy !== '') {
      cli.say(`parallel: TELL — ${tid} is in no ratified sprint, so it is one task at a time and ${busy} already in_progress. Finish or move it first (scrumux task status ${busy} in_review|blocked). Proceeding; scrumux will refuse the status transition until you do.`);
    } else {
      cli.say('parallel: OK (1 of 1 slot — this task is in no ratified sprint)');
    }
  } else if (as.elsewhere.length > 0) {
    cli.say(`parallel: TELL — one sprint at a time: ${as.elsewhere.join(', ')}. Finish or move it first (scrumux task status <id> in_review|blocked). Proceeding; scrumux will refuse the status transition until you do.`);
  } else if (as.same.length >= as.cap) {
    cli.say(`parallel: TELL — ${as.home} allows ${as.cap} in flight: ${as.same.join(', ')} already in_progress. Finish or move one (scrumux task status <id> in_review|blocked). Proceeding; scrumux will refuse the status transition until you do.`);
  } else {
    cli.say(`parallel: OK (${as.same.length + 1} of ${as.cap} slots)`);
  }
  const order = obj(row['task_order']);
  const hasOrder = row['task_order'] !== undefined && row['task_order'] !== null;
  if (!hasOrder) {
    // Exit 1, not the old bespoke exit 2: a failed gate is an assertion that
    // did not hold (CLI-CONSOLIDATION.md §4).
    cli.fail(`${tid}/order`, `${tid} has no order. There is nothing to work from.`);
    gateFail = 1;
  }

  if (hasOrder && order !== null) {
    const context = obj(order['context']);
    const files = context === null ? [] : arr(context['files']);
    const refs = context === null ? [] : arr(context['refs']).map((r) => jqRaw(r));

    cli.say('');
    cli.say('--- Scope ---');
    // SX-003: the declared failure case travels with the order into the session.
    // SX-030/SX-031: and the forms the allow-list can run it in.
    const failsWhen = mustFailWhenLine(typeof order['fails_when'] === 'string' ? order['fails_when'] : '');
    const scopeLines = [`IN:  ${interp(order['scope'])}\nVERIFY WITH: ${interp(order['verification_command'])}${failsWhen}\nOUT (do not touch):`];
    for (const o of arr(order['out_of_scope'])) scopeLines.push(`  - ${interp(o)}`);
    for (const l of scopeLines) out(l);
    cli.say('');
    cli.say('--- Reading list (open these, for these reasons — do not search) ---');
    for (const f of files) {
      const fo = obj(f);
      const path = fo === null ? 'null' : interp(fo['path']);
      const why = fo === null ? 'null' : interp(fo['why']);
      const diff = fo === null ? undefined : fo['expected_diff'];
      const suffix = diff !== undefined && diff !== null && diff !== false ? `\n    expected diff: ${interp(diff)}` : '';
      out(`  ${path}\n    why: ${why}${suffix}`);
    }

    // --- T-0153/S-0064: the law that binds this file set, mechanically ---
    // Graph traversal over recorded refs (D-0001); a record already in
    // context.refs is NOT repeated here -- it renders in full below.
    cli.say('');
    cli.say(`--- Also bearing on these files (scrumux graph gov bearing --task ${tid}) ---`);
    let changes = '';
    const bearing = isExecutable(cliPath(ctx))
      ? stripTrailingNewlines(runScrumux(ctx, ['graph', 'gov', 'bearing', '--task', tid]).stdout)
      : '';
    if (bearing === '') {
      cli.say('  (no answer — the governance graph is missing or unreadable; run: .claude/scripts/scrumux graph gov build. It self-heals, D-0043)');
    } else {
      changes = bearingChangedPaths(bearing);
      if (changes !== '') {
        cli.say(`  this order CHANGES: ${changes}`);
      } else {
        cli.say("  this order changes nothing it lists — every path is read-only, so task-lint's bearing checks stay silent (I-0070)");
      }
      let seen = 0;
      let dup = 0;
      for (const line of bearing.split('\n')) {
        const m = /^([DI]-[0-9]{4}) /.exec(line);
        if (m === null) continue;
        seen += 1;
        if (refs.includes(m[1]!)) dup += 1;
      }
      for (const line of bearingRecordLines(bearing)) {
        const id = line.split(' ')[0]!;
        if (refs.includes(id)) continue;
        cli.say(`  ${line}`);
      }
      cli.say(`  ${seen} bearing record(s) over this file set; ${dup} already in this order's refs and resolved below.`);
    }

    // --- T-0189/D-0073: the CODE neighbourhood of what this order changes ---
    // The block above answers "what law binds these files"; this one answers
    // "what code breaks if I change them". DEGRADE LOUDLY (see header).
    cli.say('');
    cli.say('--- Code graph: what changing these files touches ---');
    if (changes === '') {
      // Re-derived from the order's own expected_diff and expected_artifacts
      // -- the identical rule -- when the graph could not answer. `unique` is
      // jq's: sort-and-dedupe.
      const derived = [
        ...files
          .map((f) => obj(f))
          .filter((fo): fo is { [k: string]: JsonValue } => fo !== null && rawOr(fo['expected_diff'], '') !== '')
          .map((fo) => jqRaw(fo['path'])),
        ...(context === null ? [] : arr(context['expected_artifacts']).map((a) => jqRaw(a))),
      ];
      changes = [...new Set(derived)].sort().join(' ');
    }
    if (!isExecutable(cliPath(ctx))) {
      cli.say("  (no .claude/scripts/scrumux — the code graph is unavailable, so nothing below was checked; this is NOT 'nothing calls these files')");
    } else if (changes === '') {
      cli.say('  this order changes no file it lists — nothing to trace (I-0070)');
    } else {
      let cgn = 0;
      for (const f of changes.split(/\s+/).filter((s) => s !== '')) {
        cgn += 1;
        if (cgn > 8) {
          cli.say('  (+ more changed paths not traced — an order changing more than 8 files is a task-size problem, not a brief-length one)');
          break;
        }
        cli.say(`  ${f}`);
        for (const rel of ['callers', 'callees']) {
          const r = runScrumux(ctx, ['graph', 'code', rel, f]);
          // THE ANSWER IS STDOUT. `graph code` writes its PROVENANCE BANNER --
          // and the NOT INDEXED notices, and the staleness line -- to stderr on
          // every query, by design (P-20: a reader never withholds an answer,
          // it stamps it). Merging the two streams here made that banner
          // indistinguishable from an answer line: the emptiness check below
          // could never be true, so `none in the index` was UNREACHABLE and a
          // file with no callers rendered as
          // `callers: graph code: index built from 47591175 ...` -- a wrong
          // answer, in the one section implement-sop says to read before the
          // first edit. Read literally it named the banner as a caller.
          //
          // The banner still reaches the operator: it goes to the brief's OWN
          // stderr, which is where `graph code` put it. What changes is that it
          // is no longer counted as content. The bearing block above has always
          // read `.stdout` alone; this is the same rule, applied here.
          if (r.stderr !== '') ictx.io.err(r.stderr);
          if (r.rc !== 0) {
            // The refusal itself is on stderr (`cli.sayAlways`), so the head
            // line is taken from both streams in the original order -- stdout
            // is empty on this path and the first non-blank line is the
            // diagnostic, exactly as it was when the two were merged.
            const head1 = stripTrailingNewlines(r.stdout + r.stderr).split('\n')[0] ?? '';
            cli.say(`    ${rel}: UNAVAILABLE — ${head1}. Nothing was traced for this file. Rebuild: .claude/scripts/scrumux graph code build`);
            continue;
          }
          // the self-heal notice is not an answer line and must not be
          // counted as one.
          const lines = stripTrailingNewlines(r.stdout)
            .split('\n')
            .filter((l) => !l.startsWith('graph code: rebuilt'))
            .filter((l) => !/^\s*$/.test(l));
          if (lines.length === 0) {
            cli.say(`    ${rel}: none in the index`);
          } else {
            for (const l of lines.slice(0, 12)) cli.say(`    ${rel}: ${l}`);
            if (lines.length > 12) cli.say(`    ${rel}: (+${lines.length - 12} more)`);
          }
        }
      }
    }

    cli.say('');
    cli.say('--- Governance refs resolved ---');
    for (const ref of refs) {
      // one prefix->journal map + supersession-aware text (T-0082).
      let txt = refResolve(ctx.gov, ref);
      if (txt === null) txt = 'UNKNOWN PREFIX';
      if (txt === '') txt = 'UNRESOLVED — fix the id or create the record';
      cli.say(`  ${ref}: ${txt}`);
    }
    cli.say('');
    cli.say('--- Ground truth (run these before assuming) ---');
    const commands = context === null ? [] : arr(context['commands']);
    for (const c of commands) out(`  ${interp(c)}`);
    if (commands.length === 0) out('  (none declared)');
    const ifaces = context === null ? [] : arr(context['interfaces']);
    if (ifaces.length > 0) {
      out('Interfaces to honor:');
      for (const i of ifaces) out(`  - ${interp(i)}`);
    }
    const shapes = context === null ? [] : arr(context['data_shapes']);
    if (shapes.length > 0) {
      out('Data shapes:');
      for (const s of shapes) out(`  - ${interp(s)}`);
    }

    // SX-037: the log entries the order cites, from the whole log.
    const cited = citedLogBlock(ctx.gov, order);
    if (cited.length > 0) {
      cli.say('');
      cli.say('--- Log entries this order cites ---');
      for (const l of cited) out(l);
    }
  }

  cli.say('');
  cli.say('--- Working here ---');
  for (const n of WORKING_NOTES) out(`  - ${n}`);

  cli.say('');
  cli.say(`--- History for ${tid} ---`);
  historyBlock(out, join(ctx.gov, 'log.json'), tid);

  cli.say('');
  if (gateFail === 1) {
    cli.emit('VERDICT: gates FAILED — fix the named items before implementing. Do not start.');
  }
  return cli.emit(`VERDICT: gates pass. Set in_progress (scrumux task status ${tid} in_progress) and implement within scope.`);
}

/**
 * `[.entries[] | select(.status=="ratified" and (.tasks | index($t)))] |
 *  if length>0 then .[0].id else "" end` -- jq truthiness on `index`: a
 * position of 0 is TRUTHY, only null is not. Tolerant of a missing or
 * unreadable sprints.json (`|| printf ''`).
 */
function ratifiedSprintCarrying(path: string, tid: string): string {
  for (const r of rows(path)) {
    const o = obj(r);
    if (o === null || o['status'] !== 'ratified') continue;
    const tasks = o['tasks'];
    if (Array.isArray(tasks) ? tasks.indexOf(tid) !== -1 : typeof tasks === 'string' && tasks.includes(tid)) {
      return jqRaw(o['id']);
    }
  }
  return '';
}

/** `jget "$GOV/log.json" '...' "  (no log.json)"` -- a DIRECT print. */
function historyBlock(out: (l: string) => void, logPath: string, tid: string): void {
  if (!existsSync(logPath)) {
    out('  (no log.json)');
    return;
  }
  let doc: JsonValue;
  try {
    doc = parsePreservingNumbers(readFileSync(logPath, 'utf8'));
  } catch {
    // A corrupt log.json prints nothing to stdout and adds no stderr of
    // its own (found-not-fixed: a raw parse error is not product surface).
    return;
  }
  const o = obj(doc);
  const entriesRaw = o === null ? undefined : o['entries'];
  if (!Array.isArray(entriesRaw)) {
    // A document with no entries array prints nothing to stdout.
    return;
  }
  const entries = entriesRaw;
  const mine = entries.filter((e) => {
    const eo = obj(e);
    return eo !== null && eo['task'] === tid;
  });
  if (mine.length === 0) {
    out('  (no log entries yet)');
    return;
  }
  for (const e of mine) {
    const eo = obj(e);
    out(`  ${eo === null ? 'null' : interp(eo['id'])} ${eo === null ? 'null' : interp(eo['title'])}`);
  }
}
