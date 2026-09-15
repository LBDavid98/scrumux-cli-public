/**
 * `task lint` -- the order validator. Atomicity
 * (D-0006) and task-order completeness (D-0005), per task id or per
 * `--feature`, every finding a shared-tier row so the verdict lives in
 * exactly one place (P-01).
 *
 * THE LIGHT LANE (T-0189/D-0073) DEMOTES EXACTLY TWO FAILS TO TELLS -- no
 * story, and an empty `context.files` -- via `lightfail`, which chooses the
 * tier ONCE so both lanes print the SAME finding at different tiers rather
 * than differently-worded ones. Boundary 4 does not move with the lane: the
 * acceptance check and the one verification command stay FAILs in both.
 *
 * THE GRAPH DEGRADES TO A TELL, NEVER A FAIL (`:616-618`), and the zero-
 * decisions carve-out (I-0137) keeps a fresh deployment's first order from
 * being failed for citing decisions that do not exist to cite.
 *
 * THE SCOPE-TEXT SCAN (I-0130) IS RECALL-FIRST AND TELL-ONLY: it tokenizes
 * free prose and flags anything path-shaped the order does not list.
 * "Precision matters for authorisation, recall matters for linting" -- the
 * false positive costs one glance, and the check says so in its own text.
 * The `tr -c 'A-Za-z0-9_./-'` tokenization is ported as an explicit
 * character-class regex under the C-locale reading (cmd-task.md open
 * question 5): the harness treats text as bytes, and inheriting Node's
 * runtime locale would widen the class silently.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../../cli/envelope.js';
import type { JsonValue } from '../../journal/jqformat.js';
import { refExistsAny } from '../../journal/refs.js';
import { commandWorkDirs } from './command-paths.js';
import { isExecutable } from '../../util/fs-predicates.js';
import type { DispatchContext, NounContext } from '../lib/context.js';
import {
  arr,
  cliPath,
  bearingChangeIds,
  bearingChangedPaths,
  jqRaw,
  obj,
  rawOr,
  rows,
  runScrumux,
  stripTrailingNewlines,
  tasksPath,
} from './shared.js';
import { readerQuestion } from './reader.js';
import { unlistedScopePaths } from './scope-paths.js';

function needValue(cli: Cli, args: readonly string[], i: number): string {
  const v = args[i];
  if (v === undefined) cli.die(`task: ${args[i - 1]} needs a value — see: scrumux help task`);
  return v;
}

export function taskLint(cli: Cli, ctx: NounContext, _ictx: DispatchContext, args: readonly string[]): never {
  const tasks = tasksPath(ctx);
  if (!existsSync(tasks)) {
    cli.die('no governance/tasks.json — create tasks first: scrumux task new --title ... --check ...');
  }

  let hotfix = 0;
  // A space-joined accumulator: the emptiness test is over the WHOLE
  // string, so `--feature` matching nothing after an explicit id does not
  // refuse.
  let idsStr = '';
  for (let i = 0; i < args.length; ) {
    const a = args[i]!;
    if (a === '--hotfix') { hotfix = 1; i += 1; continue; }
    if (a === '--feature') {
      const fid = needValue(cli, args, i + 1);
      i += 2;
      const matched = rows(tasks)
        .map((r) => obj(r))
        .filter((o): o is { [k: string]: JsonValue } => o !== null && o['feature'] === fid)
        .map((o) => jqRaw(o['id']))
        .join(' ');
      idsStr = `${idsStr} ${matched}`;
      if (idsStr.replace(/ /g, '') === '') {
        cli.die(`no tasks for feature ${fid} — create them: scrumux task new --feature ${fid} ...`);
      }
      continue;
    }
    if (/^T-[0-9]{4}$/.test(a)) { idsStr = `${idsStr} ${a}`; i += 1; continue; }
    cli.dieUsage('usage: scrumux task lint T-0001 [T-0002 ...] | scrumux task lint --feature F-0001 [--hotfix]');
  }
  if (idsStr.replace(/ /g, '') === '') {
    cli.dieUsage('usage: scrumux task lint T-0001 [...] | scrumux task lint --feature F-0001');
  }

  const ids = idsStr.split(/\s+/).filter((s) => s !== '');
  for (const tid of ids) {
    // T-0144/T-0108: tell and warn are advisory; the shared layer owns the
    // verdict. The tier is chosen once per finding (see `lightfail`).
    const tell = (m: string): void => cli.tell(tid, m);
    const failRow = (m: string): void => cli.fail(tid, m);
    const warnRow = (m: string): void => cli.warn(tid, m);

    cli.say(`== ${tid} ==`);
    const row = rows(tasks)
      .map((r) => obj(r))
      .find((o): o is { [k: string]: JsonValue } => o !== null && o['id'] === tid);
    if (row === undefined) {
      failRow(`${tid} not found in tasks.json — scrumux task new first`);
      continue;
    }

    const check = rawOr(row['acceptance_check'], '');
    const storyRaw = rawOr(row['story'], '');
    const order = obj(row['task_order']);
    const hasOrder = row['task_order'] !== undefined && row['task_order'] !== null;
    // false for a plain order and for no order at all, so the plain lane
    // never reaches a demotion branch.
    const light = order !== null && order['light'] === true;
    const lightfail = (m: string): void => { if (light) tell(m); else failRow(m); };

    // the ratified check prints beside the order so plan-time divergence is
    // visible (I-0007).
    if (check !== '') cli.say(`  check: ${check}`);
    if (check === '') {
      failRow('no acceptance_check — stated before work starts (CLAUDE.MD); checks are immutable after task new: recreate the task with scrumux task new --check');
    }
    if (light) {
      cli.say('  lane: light (D-0073) — story and context-files findings are TELLs here; the acceptance check and the one verification command are not (boundary 4)');
    }
    if (hotfix === 0) {
      if (storyRaw === '' || storyRaw === 'null') {
        // a light order is minted from a message, not from the backlog; the
        // plain lane still FAILs.
        lightfail(`no story — atomicity needs exactly one user story (D-0006): scrumux task order ${tid} --story S-XXXX ...`);
      } else if (!refExistsAny(ctx.gov, storyRaw)) {
        // a story that is NAMED and does not exist is a broken record in
        // either lane.
        failRow(`story ${storyRaw} does not resolve in design.json — create it: scrumux story new --feature F-XXXX ...`);
      }
    }

    if (!hasOrder || order === null) {
      failRow(`no task_order (D-0005): scrumux task order ${tid} --scope ... --verify ... --file "path | why"`);
      continue;
    }

    const vc = rawOr(order['verification_command'], '');
    if (vc === '') failRow('empty verification_command — one command that proves the acceptance check (D-0006)');
    if (vc.includes(' && ') || vc.includes(' ; ') || vc.includes(' || ')) {
      failRow(`verification_command looks composite ('${vc}') — atomicity wants exactly ONE command; wrap multi-step verification in a script and point --verify at it`);
    }
    // T-0116/I-0060/D-0041: a STRING rule that deliberately never stats the
    // target -- an order depending on a file mode nobody set on purpose is
    // the defect, so a mode-aware check would bless that exact shape.
    if (vc.startsWith('tests/')) {
      tell(`verification_command '${vc}' names a suite without an interpreter — write 'sh ${vc}'. It may run today only because that file happens to be executable; 27 of 38 suites are not, and the order must state how to run its suite rather than depend on a mode nobody set deliberately (D-0041)`);
    }

    // §4b/§15h: the reader's question -- NOT a check; it moves no counter.
    // SX-003 (D-S016): guidance, never a gate. It names the three hollow greens
    // the Rover build shipped, and echoes the order's declared failure case.
    cli.note(tid, readerQuestion(vc, rawOr(order['fails_when'], '')));

    if (arr(order['out_of_scope']).length === 0) {
      tell('out_of_scope is empty — name what must NOT be touched (D-0005); at minimum the adjacent files you considered and excluded. GOOD --out "Any other exemption. Only build and OS artefacts — a file an agent wrote is still a file an order must own" (T-0217). GOOD --out "I-0112 read-side self-heal on staleness — a NEW capability, frozen out; the issue stays documented" (T-0213). Each entry names the thing AND why it is out, so a later reader can tell a deliberate exclusion from an oversight.');
    }

    const context = obj(order['context']);
    const files = context === null ? [] : arr(context['files']);
    if (files.length === 0) {
      lightfail('context.files empty — the reading list IS the anti-search mechanism (D-0005)');
    }

    // the tier prefix is chosen once, so the light lane prints the SAME
    // finding at the lower tier rather than a differently-worded one.
    for (const f of files) {
      const fo = obj(f);
      if (fo === null) continue;
      if (rawOr(fo['why'], '') === '') {
        const p = jqRaw(fo['path']);
        if (p === '') continue;
        lightfail(`context file ${p} has no why — every file needs its reason`);
      }
    }

    const refs = context === null ? [] : arr(context['refs']).map((r) => jqRaw(r));
    for (const ref of refs) {
      if (!refExistsAny(ctx.gov, ref)) {
        failRow(`ref ${ref} does not resolve in any journal — fix the id or create the record`);
      }
    }

    // --- a file the scope SENTENCE names and the order does not list ------
    // I-0130. TELL, and the imprecision is deliberate: recall over precision.
    // SX-011: URLs, routes, hosts and env-var routes are not files
    // (`scope-paths.ts`).
    const scopeText = rawOr(order['scope'], '');
    const arts = context === null ? [] : arr(context['expected_artifacts']).map((a) => jqRaw(a));
    const listedArr = [...files.map((f) => { const fo = obj(f); return fo === null ? '' : jqRaw(fo['path']); }), ...arts];
    // SX-027: a package-relative spelling of a listed path, or one under the
    // directory the verify command works in, is not unlisted.
    const workDirs = commandWorkDirs(rawOr(order['verification_command'], ''));
    const unlisted = unlistedScopePaths(scopeText, listedArr, ctx.workRoot, workDirs).map((t) => ` ${t}`).join('');
    if (unlisted !== '') {
      tell(`the scope text names path(s) the order does not list:${unlisted} — session-check's close reads context.files and expected_artifacts, never the prose, so a file authorised only in a sentence FAILs the close and costs a whole task cycle to legitimise (I-0130). Add each one: --file '<path> | <why>' if it exists (a file the session only READS is listed too: --file '<path> | read: <what to look for>'), --artifact <path> if this task will create it. Do not delete a path from the prose to clear this: the next session needs the pointer. URLs, HTTP routes, host strings and package-relative spellings of listed paths are not counted (SX-011, SX-027); some of these may still be prose rather than paths, which is the cost of catching the real ones.`);
    }

    // --- T-0153/S-0064: the law that binds the files this order CHANGES ---
    const bearing = isExecutable(cliPath(ctx))
      ? stripTrailingNewlines(runScrumux(ctx, ['graph', 'gov', 'bearing', '--task', tid]).stdout)
      : '';
    if (bearing === '') {
      tell(`graph gov bearing returned nothing for ${tid} — the governance graph is missing or unreadable, so the decisions binding this order's files were not checked. Rebuild it: .claude/scripts/scrumux graph gov build (it self-heals, D-0043)`);
    } else {
      const changed = bearingChangedPaths(bearing);
      const nref = refs.length;
      // I-0137: a fresh deployment has zero decisions by definition, so an
      // uncited CHANGES set cannot FAIL for citing nothing there is to cite.
      const ndec = rows(join(ctx.gov, 'decisions.json')).length;
      if (changed !== '' && nref === 0 && ndec === 0) {
        tell(`this order CHANGES ${changed} and cites no governance refs, and this repo has recorded no decisions yet — so there is nothing to cite and nothing to fix here. Cite one when one exists (D-0005)`);
      } else if (changed !== '' && nref === 0) {
        failRow(`this order CHANGES ${changed} and cites no governance refs — ${ndec} decision(s) exist and an order that names none leaves the implementer with whatever the writer happened to remember (D-0005). See what binds these files: .claude/scripts/scrumux graph gov bearing --task ${tid}, then re-issue the order with the ref added — task order REPLACES the order rather than amending it, so restate every flag it already carries (read them back: scrumux task brief ${tid}) plus --ref D-XXXX`);
      } else if (changed !== '') {
        let omitted = '';
        let nom = 0;
        for (const b of bearingChangeIds(bearing)) {
          if (refs.includes(b)) continue;
          nom += 1;
          if (nom <= 8) omitted = `${omitted} ${b}`;
        }
        if (nom > 0) {
          if (nom > 8) omitted = `${omitted} (+${nom - 8} more)`;
          warnRow(`${nom} record(s) bear on the files this order CHANGES and are not in its refs:${omitted} — read them (.claude/scripts/scrumux graph gov bearing --task ${tid}) and cite the ones that bind this work. Advisory: bearing is reachability, not relevance, and only you can say which of these rule this change`);
        }
      }
    }

    if ((context === null ? [] : arr(context['commands'])).length === 0) {
      warnRow('no ground-truth commands — fine for pure-doc tasks, wrong for code tasks');
    }

    cli.note(tid, 'MANUAL: one-sitting check — can this complete without pausing mid-state? If not, split it; never widen it.');
  }

  cli.say('');
  const fails = cli.fails();
  if (fails > 0) {
    cli.emit(`task lint: ${fails} failure(s) — fix each named item, then re-run. Proceed only on exit 0.`);
  }
  return cli.emit('task lint: all checks pass (manual one-sitting judgment still yours).');
}
