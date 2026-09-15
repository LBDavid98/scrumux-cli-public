/**
 * The noun registry.
 *
 * THE SEAM IS THREE PARTS: every module answers `verbs()`, `usage()` and
 * `run()`, and `cli-shape-tests.sh:42` asserts all three exist for every
 * noun on the roster. A TS module that exports fewer has broken the seam,
 * so `NounModule` names all three and the compiler enforces what the suite
 * greps for.
 *
 * VERB LISTS ARE NOT WRITTEN HERE. Each module answers `verbs()`, so the verbs
 * exist in exactly one place: the file that implements them. This table maps
 * noun -> module and nothing else, which is why adding a noun is one file plus
 * one line.
 *
 * WHY THE LOOKUP IS A THUNK, NOT A DIRECT REFERENCE. The observable property
 * that matters is that a request for noun X must never RUN noun Y's code,
 * and that is a property of the modules, not of the loader: every noun
 * module is a pure declaration (`export const MODULE`) with no top-level
 * side effect, so importing it does nothing and only `run()` acts. The
 * lookup being a thunk means a module that ever needs a genuine dynamic
 * `import()` can become one without changing a call site — but the
 * dispatcher stays SYNCHRONOUS, which is what keeps `ExitSignal` catchable
 * at the entry point instead of becoming an unhandled rejection.
 *
 * The roster of noun NAMES and their glosses is NOT duplicated here: it
 * lives in `src/cli/usage-text.ts`, and `nounKnown` in `src/cli/usage.ts`
 * reads it. One roster, one reader. This table answers a different
 * question — "which module implements this noun" — and the two rosters
 * agree entry for entry: every noun has a module here.
 */
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import type { Roots } from '../journal/paths.js';
import { MODULE as backlog } from './backlog.js';
import { MODULE as decide } from './decide.js';
import { MODULE as epic } from './epic.js';
import { MODULE as exception } from './exception.js';
import { MODULE as feature } from './feature.js';
import { MODULE as graph } from './graph.js';
import { MODULE as harness } from './harness.js';
import { MODULE as health } from './health.js';
import { MODULE as issue } from './issue.js';
import { MODULE as log } from './log.js';
import { MODULE as memory } from './memory.js';
import { MODULE as rank } from './rank.js';
import { MODULE as records } from './records.js';
import { MODULE as repair } from './repair.js';
import { MODULE as secret } from './secret.js';
import { MODULE as session } from './session.js';
import { MODULE as sprint } from './sprint.js';
import { MODULE as status } from './status.js';
import { MODULE as story } from './story.js';
import { MODULE as task } from './task.js';
import { MODULE as views } from './views.js';

/** What a noun module needs from the dispatcher, and nothing more. */
export interface NounContext {
  /** ROOT / GOV / WORK_ROOT, already resolved. */
  roots: Roots;
  /** `date +%F` — captured ONCE per invocation. */
  today: string;
  /**
   * The same streams `Cli` writes to. A report verb needs it directly because
   * human mode writes a report line through the moment it exists rather than
   * buffering it to `emit` — see src/cli/capture.ts for why that matters.
   */
  io: Io;
}

export interface NounModule {
  /**
   * One TAB-separated `verb<TAB>gloss` line per verb. Nothing in the CLI
   * consumes it today; it is the machine-readable half of the surface the
   * control plane reads, and cli-shape-tests asserts its existence per noun.
   */
  verbs(): string;
  /** The module's own usage block, verbatim. */
  usage(): string;
  /**
   * `run(verb, args...)`. Never returns: every path ends in `cli.emit` or
   * `cli.die*`, both of which throw, which is the reason nothing after a
   * refusal can run.
   */
  run(cli: Cli, ctx: NounContext, verb: string, args: readonly string[]): never;
}

/**
 * ------------------------------------------------------------------------
 * THE REGISTRY. One import plus one line per noun, in roster order. Every
 * noun on the roster (`src/cli/usage-text.ts`) has an entry here.
 *
 * ADDING A NOUN IS ONE LINE. Write `src/nouns/<noun>.ts` exporting
 * `MODULE: NounModule` and `VERBS: readonly string[]`, then add the import at
 * the top of this file and:
 *
 *     <noun>: () => <noun>,
 *
 * to the table below, in roster order. Nothing else in the dispatcher
 * changes: a noun's verbs are read from its own `VERBS` export, so there is
 * no second list to update anywhere.
 *
 * THE SHAPE FOR A VERB WHOSE MODULE IS DELIBERATELY INCOMPLETE: register the
 * noun, and refuse the missing verb BY NAME inside the module, because a
 * verb-level decision belongs where the verbs live, not in this table.
 * `secret` demonstrated this once, refusing `set`/`remove` until a
 * half-finished write path (gitignore, tracked-file refusal, double chmod)
 * was actually safe to expose; it is whole now, but the shape is the right
 * one for the next noun that needs it.
 * ------------------------------------------------------------------------
 */
const REGISTRY: Readonly<Record<string, () => NounModule>> = {
  backlog: () => backlog,
  decide: () => decide,
  epic: () => epic,
  exception: () => exception,
  feature: () => feature,
  graph: () => graph,
  harness: () => harness,
  health: () => health,
  issue: () => issue,
  log: () => log,
  memory: () => memory,
  rank: () => rank,
  records: () => records,
  repair: () => repair,
  secret: () => secret,
  session: () => session,
  sprint: () => sprint,
  status: () => status,
  story: () => story,
  task: () => task,
  views: () => views,
};

/** Does this noun have a registered module? */
export function hasModule(noun: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, noun);
}

/** The nouns with a registered module, in registry order. */
export function portedNouns(): readonly string[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolve exactly the ONE module this invocation needs.
 *
 * Returns null rather than throwing for a noun with no registered module:
 * that is not an error the loader is positioned to explain, so the
 * dispatcher is the one that says something specific about it. A noun name
 * that reaches here without a module would mean the roster
 * (`src/cli/usage-text.ts`) and this table have drifted apart — a broken
 * build, not a normal runtime state.
 */
export function loadNoun(noun: string): NounModule | null {
  const loader = REGISTRY[noun];
  return loader === undefined ? null : loader();
}
