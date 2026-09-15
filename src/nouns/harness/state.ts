/**
 * The per-invocation state the two harness verbs share: the target root,
 * the payload's source locations, the `item()` inventory and the `check()`
 * adapter, gathered into one object rather than module globals so state
 * from one invocation cannot leak into the next inside a single process.
 */
import type { Cli } from '../../cli/envelope.js';
import type { Io } from '../../cli/exit.js';
import type { JsonValue } from '../../journal/jqformat.js';
import type { NounContext } from '../lib/context.js';

export interface HarnessItem {
  path: string;
  status: string;
  detail: string;
}

export interface HarnessRun {
  cli: Cli;
  ctx: NounContext;
  io: Io;
  /** Absolute, `cd && pwd`-resolved target root. */
  target: string;
  /**
   * Code location, never data location. SRC_CLAUDE is the
   * payload directory of the repo this harness runs from — `.deploy-claude/`
   * in the source repo, `.claude/` in a deployment — derived from where the
   * CLI itself lives, so nothing here needs to know which name it carries.
   */
  srcClaude: string;
  /** The repo the payload ships with — `$SCRIPTS/../..`. */
  srcRoot: string;
  /** The payload inventory `item()` builds; emitted under `.items`. */
  items: HarnessItem[];
  /** `cli_rows` — how many check rows this run recorded. */
  rows: number;
  /**
   * Paths deploy wrote that no inventory row names (the preserved
   * `CLAUDE.pre-harness.md`). Folded into `commit_paths` by `commitPaths`.
   */
  wrote?: string[];
}

/** The inventory statuses that mean deploy put bytes on disk, or took them away. */
const WRITTEN = new Set(['CREATED', 'UPDATED', 'SEEDED', 'REMOVED']);

/**
 * WHAT A DEPLOY LEAVES FOR THE REPO'S HISTORY (D-S029, SX-017, R-020).
 *
 * Every path this run created, changed or removed that belongs in a commit:
 * payload files, the manifest, the seeded journals and templates, settings,
 * the constitution and `.gitignore` — read off the inventory, so the list is
 * what deploy DID, never a guess about what it might have done. Generated
 * artefacts (the code graph, rendered views) are not inventory rows and so
 * are never listed: they are derived, and the `.gitignore` lane exists to
 * keep them out of the way. A caller that commits on the operator's behalf
 * (scrumux-app's first deploy) stages exactly this list. Sorted, unique.
 */
export function commitPaths(h: HarnessRun): string[] {
  const out = new Set<string>(h.wrote ?? []);
  for (const it of h.items) if (WRITTEN.has(it.status)) out.add(it.path);
  return [...out].sort();
}

/**
 * Records one payload-inventory row: CREATED, UPDATED, UNCHANGED, REMOVED or
 * KEPT. Not a check: an item says what deploy DID, a check says whether the
 * result holds.
 */
export function item(h: HarnessRun, path: string, status: string, detail = ''): void {
  h.items.push({ path, status, detail });
  if (detail !== '') h.cli.say(`  ${status.padEnd(9)} ${path} — ${detail}`);
  else h.cli.say(`  ${status.padEnd(9)} ${path}`);
}

/** The thin adapter onto the check rows. */
export function check(h: HarnessRun, name: string, ok: boolean, detail: string): void {
  h.rows += 1;
  if (ok) h.cli.pass(name, detail);
  else h.cli.fail(name, detail);
}

/**
 * An ADVISORY row. Deliberately not routed through `check`, and `h.rows` is
 * deliberately not incremented: a warn is not a check, and `harness verify`
 * phrases "N/N checks pass" off that count. The one warn this verb emits
 * (session-topology) fires on a property of the OPERATOR's terminal, so
 * counting it would make the denominator move between a plain shell and a
 * Claude Code session while nothing about the target moved — and the README
 * states that number.
 *
 * P-01: it prints, it lands in `.checks` with ok:true and tier "warn", and it
 * is invisible to the verdict.
 */
export function warn(h: HarnessRun, name: string, detail: string): void {
  h.cli.warn(name, detail);
}

/**
 * The one envelope object both harness verbs emit. `target` and `items` are
 * harness-specific top-level fields; everything else is the standard
 * envelope.
 */
export function harnessEmit(
  h: HarnessRun,
  summary: string,
  extra2?: Record<string, JsonValue>,
): never {
  h.cli.extra({ target: h.target, items: h.items as unknown as JsonValue });
  if (extra2 !== undefined) h.cli.extra(extra2);
  h.cli.say('');
  return h.cli.emit(summary);
}
