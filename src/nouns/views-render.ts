/**
 * The views-rendering engine.
 *
 * THE MD FILES ARE GENERATED VIEWS AND THEIR BYTES ARE THE CONTRACT. The
 * sources of truth are the JSON journals under `governance/` (D-0002); these
 * three files are projections and are never hand-edited. Byte-fidelity here
 * rests on this file's own test coverage. A single space of drift is still
 * a diff in every governed repo on the next render.
 *
 * WHY THE ENGINE IS ITS OWN FILE, SEPARATE FROM `views.ts`. It once ran on
 * every governance WRITE, not just on an explicit render. T-0187 took it off
 * the write paths (D-0076) -- every write was re-rendering three files and
 * rebuilding the whole graph, ~0.15s of a ~0.19s write, for views nobody
 * reads mid-session -- so today it has exactly one caller in this package.
 * It stays separable anyway: `sealBootstrap` below is a write concern this
 * file still carries, distinct from the render logic around it.
 *
 * THE GRAPH BUILD IS IN-PROCESS. `graph gov build` exists natively now, so
 * the graph is rebuilt here from the same traversal it uses, rather than
 * shelling out to it. The DISPOSITION of a failure is unchanged and is
 * still two-sided: non-fatal here (a stale graph must never abort a
 * transaction) and fatal in `views render` (an explicit request that
 * silently leaves the thing stale is a lie a report is not allowed to
 * tell) -- the same fact, two answers, both deliberate (P-14).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isExecutable } from '../util/fs-predicates.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { build as govBuild, govIndexPath, writeGovIndex } from './graph/gov-graph.js';
import type { NounContext } from './lib/context.js';
import { alt, asArray, entriesOf, field, interp, sortBy, truthy } from './lib/jqlike.js';
import { sealBootstrap } from '../journal/seals.js';
import { bindingSupersedes, standingOf } from '../journal/standing.js';

export interface RenderResult {
  /** T-0129: read by `views render`, which exits non-zero when it is set. */
  graphBuildFailed: boolean;
  /** Lines written to stderr as rendering proceeds, each already newline-terminated. */
  warnings: string[];
  /** The files actually written, relative to ROOT. */
  written: string[];
}

const AI_LOG_HEADER =
  '# AI_LOG.MD\n'
  + '<!-- GENERATED VIEW — source of truth: governance/log.json (append-only).\n'
  + '     Do not edit by hand; run: .claude/scripts/scrumux views render -->\n\n';

const DECISIONS_HEADER =
  '# DECISIONS.MD\n'
  + '<!-- GENERATED VIEW — source of truth: governance/decisions.json (append-only).\n'
  + '     Do not edit by hand; run: .claude/scripts/scrumux views render -->\n\n';

const BACKLOG_HEADER =
  '# BACKLOG.MD\n'
  + '<!-- GENERATED VIEW — sources of truth: governance/tasks.json, governance/sprints.json.\n'
  + '     Do not edit by hand; run: .claude/scripts/scrumux views render -->\n\n';

/** The seven status sections, in this fixed order. */
const STATUSES: readonly string[] = [
  'in_progress',
  'in_review',
  'blocked',
  'ready',
  'proposed',
  'accepted',
  'superseded',
];

/**
 * A journal read for RENDERING, which is not the guarded three-state read.
 *
 * An unparseable journal renders as an EMPTY view: the banner and nothing
 * else, rather than refusing to render at all.
 */
function readForRender(path: string): JsonValue | null {
  if (!existsSync(path)) return null;
  try {
    return parsePreservingNumbers(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// --- AI_LOG.MD ----------------------------------------------------------

export function renderAiLog(doc: JsonValue | null): string {
  let out = AI_LOG_HEADER;
  for (const e of entriesOf(doc ?? undefined)) {
    let s = `## ${interp(field(e, 'id'))} · ${interp(field(e, 'date'))} — ${interp(field(e, 'title'))}\n`
      + `Actor: ${interp(field(e, 'actor'))}.`;
    const task = field(e, 'task');
    if (truthy(task)) s += ` Task: ${interp(task)}.`;
    s += `\n${interp(field(e, 'what_was_done'))}`;
    const ver = alt(field(e, 'verification'), '');
    if (!(typeof ver === 'string' && ver === '')) {
      s += `\nVerified: ${interp(field(e, 'verification'))}`;
    }
    const pending = asArray(alt(field(e, 'pending'), []));
    if (pending !== null && pending.length > 0) {
      s += '\nPending:\n' + pending.map((p) => '- ' + interp(p)).join('\n');
    }
    // The trailing "\n" of the jq string, then the newline `jq -r` adds.
    out += s + '\n' + '\n';
  }
  return out;
}

// --- DECISIONS.MD -------------------------------------------------------

/**
 * The line under a decision's heading. A legacy record (no `status`) renders
 * exactly as it always did; a record with standing (D-S039) says it.
 *
 * Dependencies: standingOf, field, interp.
 */
function standingLine(e: JsonValue): string {
  const v = standingOf(e);
  if (v.legacy) return `Ratified by: ${interp(field(e, 'ratified_by'))}.`;
  const ack = v.acknowledgedBy === '' ? '' : ` Acknowledged by ${v.acknowledgedBy}.`;
  if (v.status === 'ratified') return `Ratified by: ${interp(field(e, 'ratified_by'))} (authority ${v.authority}).${ack}`;
  if (v.status === 'proposed') {
    return `PROPOSED — recorded by ${interp(field(e, 'recorded_by'))} with no authority; binds nothing until a person ratifies it.${ack}`;
  }
  return `REJECTED by ${interp(field(e, 'rejected_by'))}: ${interp(field(e, 'rejection_reason'))}`;
}

/**
 * BOTH DIRECTIONS. This read `.supersedes` only, so a ruling retired by a
 * decision that named it in its TEXT rather than in that field went on
 * rendering as current law. Twenty did: a 2026-08-27 audit found twenty-one
 * dead rulings in the live section, including D-0059, which an agent could
 * have read as binding for a week after it was contradicted. `superseded_by`
 * is stamped at write time now, so the archive is derived from whichever
 * direction is recorded.
 */
export function renderDecisions(doc: JsonValue | null): string {
  const entries = entriesOf(doc ?? undefined);

  const supby = new Map<string, JsonValue>();
  // `$fwd`, then `$back` over the top of it: `$fwd * $back` is a merge in
  // which the right-hand side wins, and `add` itself lets a later duplicate
  // key overwrite an earlier one.
  for (const e of entries) {
    // Only a BINDING decision retires its predecessor (D-S039): a proposed or
    // rejected one naming `supersedes` leaves the old ruling live.
    const s = bindingSupersedes(e);
    if (s !== null) supby.set(s, field(e, 'id'));
  }
  for (const e of entries) {
    const b = field(e, 'superseded_by');
    if (b !== null) supby.set(interp(field(e, 'id')), b);
  }
  const supersededBy = (e: JsonValue): JsonValue | null => {
    const id = field(e, 'id');
    const k = interp(id);
    return supby.has(k) ? (supby.get(k) as JsonValue) : null;
  };

  const render = (e: JsonValue): string => {
    let s = `## ${interp(field(e, 'id'))} · ${interp(field(e, 'date'))} — ${interp(field(e, 'title'))}\n`
      + standingLine(e);
    if (truthy(field(e, 'scope'))) s += ` Scope: ${interp(field(e, 'scope'))}.`;
    if (truthy(field(e, 'supersedes'))) s += ` Supersedes: ${interp(field(e, 'supersedes'))}.`;
    s += `\n${interp(field(e, 'decision'))}\nRationale: ${interp(field(e, 'rationale'))}\n`;
    return s;
  };

  const rejected = (e: JsonValue): boolean => standingOf(e).status === 'rejected';
  const live = entries.filter((e) => supersededBy(e) === null && !rejected(e));
  const dead = entries.filter((e) => supersededBy(e) !== null && !rejected(e));
  const refused = entries.filter(rejected);

  let body = live.map(render).join('\n');
  if (dead.length > 0) {
    body += '\n# Superseded (archive — NOT current law)\n\n'
      + dead.map((e) => `SUPERSEDED by ${interp(supersededBy(e))}:\n` + render(e)).join('\n');
  }
  if (refused.length > 0) {
    body += '\n# Rejected (NOT law — recorded, and refused by a person)\n\n' + refused.map(render).join('\n');
  }
  // `jq -r` prints the ONE assembled string, then one newline. An empty
  // journal therefore still contributes a bare newline after the banner.
  return DECISIONS_HEADER + body + '\n';
}

// --- BACKLOG.MD ---------------------------------------------------------

export function renderBacklog(tasks: JsonValue | null, sprints: JsonValue | null): string {
  let out = BACKLOG_HEADER;

  const sprintEntries = sprints === null ? [] : entriesOf(sprints);
  const live = sprintEntries.filter((e) => {
    const st = field(e, 'status');
    return st === 'proposed' || st === 'ratified';
  });
  if (sprints !== null && live.length > 0) {
    out += '## Sprints\n';
    for (const e of live) {
      let s = `- **${interp(field(e, 'id'))}** [${interp(field(e, 'status'))}]`;
      if (truthy(field(e, 'hotfix'))) {
        s += ` HOTFIX from ${interp(field(e, 'source_issue'))}`;
      } else {
        s += ` epic ${interp(field(e, 'epic'))}`;
      }
      const list = asArray(field(e, 'tasks')) ?? [];
      s += ' — tasks: ' + (list.length === 0 ? '(none yet)' : list.map(interp).join(', '));
      out += s + '\n';
    }
    out += '\n';
  }

  const taskEntries = tasks === null ? [] : entriesOf(tasks);
  if (tasks !== null && taskEntries.length > 0) {
    for (const st of STATUSES) {
      const rows = sortBy(
        taskEntries.filter((e) => field(e, 'status') === st),
        (e) => [alt(field(e, 'rank'), 9999), field(e, 'id')] as JsonValue,
      );
      if (rows.length === 0) continue;
      const lines = rows.map((e) => {
        let s = `- **${interp(field(e, 'id'))}**`;
        if (truthy(field(e, 'rank'))) s += ` (rank ${interp(field(e, 'rank'))})`;
        s += ` ${interp(field(e, 'title'))}`;
        if (truthy(field(e, 'feature'))) {
          s += ` (${interp(field(e, 'feature'))}`;
          if (truthy(field(e, 'story'))) s += `/${interp(field(e, 'story'))}`;
          s += ')';
        }
        s += `\n  - accept when: ${interp(field(e, 'acceptance_check'))}`;
        return s;
      });
      out += `## ${st}\n` + lines.join('\n') + '\n' + '\n';
    }
  } else {
    out += '_No tasks yet. Create one: `.claude/scripts/scrumux task new --title ... --check ...`_\n';
  }
  return out;
}

// --- the engine ---------------------------------------------------------

/**
 * Regenerate the three views and the governance graph, then bootstrap the
 * seal. Returns rather than exiting: the caller decides what a failed graph
 * build means, and the two callers disagree on purpose (P-14).
 */
export function renderViews(ctx: NounContext): RenderResult {
  const warnings: string[] = [];
  const written: string[] = [];

  const logPath = join(ctx.gov, 'log.json');
  if (existsSync(logPath)) {
    writeFileSync(join(ctx.root, 'AI_LOG.MD'), renderAiLog(readForRender(logPath)));
    written.push('AI_LOG.MD');
  }

  const decPath = join(ctx.gov, 'decisions.json');
  if (existsSync(decPath)) {
    writeFileSync(join(ctx.root, 'DECISIONS.MD'), renderDecisions(readForRender(decPath)));
    written.push('DECISIONS.MD');
  }

  const tasksPath = join(ctx.gov, 'tasks.json');
  const sprintsPath = join(ctx.gov, 'sprints.json');
  writeFileSync(
    join(ctx.root, 'BACKLOG.MD'),
    renderBacklog(
      existsSync(tasksPath) ? readForRender(tasksPath) : null,
      existsSync(sprintsPath) ? readForRender(sprintsPath) : null,
    ),
  );
  written.push('BACKLOG.MD');

  // T-0187: the graph writer writes $GOV/governance-graph.json and does NOT
  // create the directory, so `views render` on a repo that has never taken
  // a gov write would fail outright. Every other write path already does
  // this via its own mkdir; the views path was the one that did not.
  try {
    mkdirSync(ctx.gov, { recursive: true });
  } catch {
    // A failure here is not this command's to report.
  }

  let graphBuildFailed = false;
  const cliPath = join(ctx.scriptsDir, 'scrumux');
  if (isExecutable(cliPath)) {
    // THE GUARD STAYS, THE SUBPROCESS GOES. `isExecutable(cliPath)` answers
    // whether the repo has a working harness at all, so it is still asked
    // here and still answered the same way in the `else` below, even though
    // nothing is spawned anymore: `graph gov build` runs in this same
    // process now, from the same traversal the verb uses.
    try {
      const g = govBuild(ctx.root);
      writeGovIndex(g, govIndexPath(ctx.root));
    } catch {
      graphBuildFailed = true;
      warnings.push(
        'scrumux: warning: graph gov build failed — governance/governance-graph.json is now STALE.'
        + ' Run .claude/scripts/scrumux graph gov build to see why.\n',
      );
    }
  } else {
    graphBuildFailed = true;
    warnings.push(
      'scrumux: warning: .claude/scripts/scrumux is missing or not executable —'
      + ' governance/governance-graph.json is STALE and every query over it is answering from old data.\n',
    );
  }

  sealBootstrap(ctx.gov, ctx.today);

  return { graphBuildFailed, warnings, written };
}
