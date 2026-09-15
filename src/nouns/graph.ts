/**
 * The `graph` noun, READ SIDE.
 *
 * `graph code` answers "what calls what" over the source tree; `graph gov`
 * traverses the governance journals as a graph. The two LIBRARIES stay
 * separate -- they answer different questions over different inputs -- but
 * there is no reason for an agent to learn two CLIs, which is why one noun
 * carries both and why the domain (`code` / `gov`) occupies the verb slot.
 *
 * --- THE READER / BUILDER SPLIT ------------------------------------------
 *
 * READERS answer from the on-disk index with no parser and no rebuild; the
 * BUILDER is the one surface with a toolchain dependency; the freshness
 * CHECK is where the two policies meet. That split is why a deployed repo
 * -- which has no grammars and never will -- can still answer every
 * `graph code` query.
 *
 * `graph code build` runs on web-tree-sitter with the twelve grammars
 * vendored as wasm under `tools/grammars/`. The builder still needs a
 * toolchain and still travels with the harness SOURCE checkout only: the
 * toolchain is a committed blob rather than a pip install, so it needs no
 * compiler on the target machine (D-0085's spike C).
 *
 * `graph gov build` never needed grammars: its traversal is the same one
 * every gov reader already depends on -- `govIndex` rebuilds a stale index,
 * every gov reader self-heals a missing one, and `loadGovIndexCurrent`
 * rebuilds one whose shape predates the library.
 *
 * --- FOUR NON-OBVIOUS INVARIANTS THIS FILE DEPENDS ON --------------------
 *
 * 1. STALENESS IS AN EXACT COMPARISON, not a truthiness test. `age.stale`
 *    must be checked as `=== false`, never `!age.stale`: a half-read index
 *    can carry an empty or null flag, and a check named "index current"
 *    that only tested truthiness would report a corrupt index green -- CLI-8.
 *
 * 2. A code-graph reader's failure exits 2 under `--json` and 1 in human mode
 *    for the identical condition. That asymmetry is OQ-cg-2, open and
 *    unruled, and it is deliberate: "this would be more correct" is exactly
 *    the drift that would certify itself.
 *
 * 3. `bearing` renders through `refResolve`, the ONE supersession-aware
 *    renderer (T-0082). A superseded decision reaching an implementer as live
 *    law is the failure the whole command exists to stop, and re-deriving
 *    supersession here would be a second encoding of what T-0082 collapsed
 *    into one. `test/unit/graph-hardenE.test.ts` asserts the render path, not
 *    the query path, resolved it.
 *
 * 4. `bearing`'s unknown-flag refusal (I-0118) has EXACTLY ONE enforcement
 *    site, and it is in the query, not the dispatch arm: `graph gov bearing`
 *    passes its argv straight through. A second pre-filter "for defence in
 *    depth" would invent a check this system does not have.
 */
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { RawNumber, type JsonValue } from '../journal/jqformat.js';
import { refResolve } from '../journal/refs.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { shHead, stripTrailingNewlines, trNewlines } from './harness/util.js';
import {
  IndexUnreadable, calleesOf, callersOf, findSymbol, indexAge, indexPath, loadIndex,
  neighbourhood, symbolsIn, type Graph, type IndexAge,
} from './graph/code-index.js';
import {
  canBuild, codeBuild, codeBuildArm, codeBuildChildArm, isBuildChild,
} from './graph/code-build-arm.js';
import {
  FILE_EDGE_KINDS, bearing as govBearing, build as govBuild, edgesOf, govIndexPath,
  impact as govImpact, isFile, isStale, loadGovIndexCurrent, nodesOf, orphans as govOrphans,
  outbound as govOutbound, provenance as govProvenance, writeGovIndex, type GovGraph,
} from './graph/gov-graph.js';

/** The full verb roster for both domains, `code` and `gov`. */
export const VERBS = [
  'code build', 'code index', 'code callers', 'code callees', 'code symbols',
  'code find', 'code near', 'code stats',
  'gov build', 'gov index', 'gov provenance', 'gov inbound', 'gov outbound',
  'gov impact', 'gov orphans', 'gov dangling', 'gov stats', 'gov bearing',
] as const;

/**
 * LITERAL, pipe-joined: `tests/graph-wiring-tests.sh` reads these two lines
 * out of the source, so they must be readable by something that is not a
 * shell. `fresh` is gone from both -- D-0044 named `index`, and the
 * consolidation ships no aliases.
 */
const CODE_CMDS = 'build|index|callers|callees|symbols|find|near|stats';
const GOV_CMDS = 'build|index|provenance|inbound|outbound|impact|orphans|dangling|stats|bearing';

const VERBS_TSV = 'code\twhat calls what, over the source tree\n'
  + 'gov\tthe governance journals traversed as a graph\n';

const USAGE = `scrumux graph — the two derived graphs. No LLM in either path (D-0001):
both are repo fact, and a fact a model guessed at is not a fact.

  scrumux graph code build [--repo <path>]   (re)build the code index
  scrumux graph code index                   the freshness check
  scrumux graph code callers <id>            who calls this symbol or file
  scrumux graph code callees <id>            what this calls
  scrumux graph code symbols <file>          symbols defined in a file
  scrumux graph code find <name>             symbol ids matching a bare name
  scrumux graph code near <id> [n]           within n call-hops, both ways
  scrumux graph code stats                   counts, coverage, provenance

  scrumux graph gov build                    (re)build the governance index
  scrumux graph gov index                    exit 0 if current, rebuild if stale
  scrumux graph gov provenance <id>          what bears on a task, both directions
  scrumux graph gov inbound|outbound <id>    records pointing at / pointed at
  scrumux graph gov impact <id> [n]          what changing this touches
  scrumux graph gov orphans [kind]           records nothing points at
  scrumux graph gov dangling                 refs naming a record that is gone
  scrumux graph gov stats                    node and edge counts by kind
  scrumux graph gov bearing [--task T-0001] [--file <path>] [<path>...]
                                             the decisions and issues that
                                             BIND a file set (T-0153)

READER / BUILDER. Every \`graph code\` query answers from
governance/code-graph.json with NO tree-sitter and NO rebuild, stamped
with the commit it was built from and how far behind HEAD that is now.
Only \`build\` needs the grammars, it takes an explicit --repo, and
\`scrumux harness deploy\` runs it into every target it installs — so a
deployed repo has a working code graph without ever carrying a parser.

Nothing here depends on the scrumux-app. The app is one more optional
refresher and reader of the same on-disk file.

LANGUAGE-AGNOSTIC. The grammar set is a registry in
src/nouns/graph/code-build.ts, not a branch. A file whose language has no
installed grammar is COUNTED AND NAMED by \`stats\` and by \`build\` — never
skipped in silence, because a silently skipped file looks exactly like a
file with nothing in it.

A code symbol id is "<path>::<name>"; a code file id is the repo-relative
path. A governance id is a record id.
`;

// ------------------------------------------------------ graph code read ---

interface ReadOk { ok: true; lines: string[]; provenance: IndexAge; coverage: JsonValue }
interface ReadFail { ok: false; code: 1 | 2 }
type ReadResult = ReadOk | ReadFail;

/**
 * `graph_code_read` -- the reader's Python program, in TypeScript.
 *
 * The stderr it writes is written HERE, as it is written there: the
 * provenance line and the NOT-INDEXED notices land on stderr in human mode
 * and are folded into the payload under `--json`, and the refusals land on
 * stderr in BOTH modes because the caller redirects only stdout.
 */
function codeRead(cli: Cli, ctx: NounContext, json: boolean, cmd: string, args: readonly string[]): ReadResult {
  const dataRoot = ctx.root;
  const treeRoot = ctx.codeRoot;
  const path = indexPath(dataRoot);

  if (!isFile(path)) {
    // NOT a bare refusal. Name who can build one -- the builder travels with
    // any harness checkout that has the grammars, and it takes an explicit
    // target, so this is always fixable from somewhere.
    cli.sayAlways(
      `graph code: error: no index at ${path}, so there is nothing to read.\n`
      + '  Build it here (needs the tree-sitter grammars):  scrumux graph code build\n'
      + `  Or from a harness checkout that has them:        scrumux graph code build --repo ${treeRoot}\n`
      + '  `scrumux harness deploy` builds one into every target it installs, so a\n'
      + '  deployed repo normally has one without ever needing a parser.',
    );
    return { ok: false, code: 1 };
  }

  let g: Graph;
  try {
    g = loadIndex(path);
  } catch (e) {
    if (!(e instanceof IndexUnreadable)) throw e;
    cli.sayAlways(`graph code: error: ${e.message}`);
    return { ok: false, code: 1 };
  }

  // PROVENANCE, on every answer. A reader never rebuilds, so the one thing it
  // owes its caller is how old its answer is and against what.
  const age = indexAge(g, treeRoot);
  const short = (c: string): string =>
    // "unknown — the indexed tree is not a git checkout" truncated to 8
    // characters reads as a commit hash that happens to say "unknown".
    (c !== '' && !c.startsWith('unknown')) ? c.slice(0, 8) : 'no git commit';

  let provLine = `graph code: index built from ${short(age.built_from_commit)} at ${age.built_at}`
    + `; HEAD is ${short(age.head_commit)}`;
  if (age.commits_behind !== null) provLine += ` — ${age.commits_behind} commit(s) behind`;
  if (truthy(age.built_from_dirty_tree)) provLine += '; built from a DIRTY tree';
  // THE REFRESH MUST NAME A COMMAND THIS REPO CAN RUN. `scrumux graph code
  // build` needs the tree-sitter grammars, and a DEPLOYED repo structurally
  // does not have them -- that is the builder/reader split this whole module
  // is built on (P-20). Naming it unconditionally sent the operator at a
  // command whose only possible answer is the refusal fifty lines above, once
  // per query: `task brief` printed the unreachable instruction eight times in
  // the section implement-sop says to read first. `graph code index` has
  // branched on the builder since D-0044; the per-query banner now says the
  // same thing in the same words. Exit semantics are untouched -- stale still
  // answers, still at rc 0 (P-20).
  if (age.stale) {
    provLine += `. STALE: ${age.reason}. `;
    provLine += canBuild(ctx)
      ? 'Refresh: scrumux graph code build'
      // `treeRoot`, not `ctx.root`: the tree is what gets indexed, and it is
      // the root the no-index refusal above already names in this sentence.
      : `Refresh from a harness checkout: scrumux graph code build --repo ${treeRoot}`;
  } else provLine += '. Current.';

  const cov = objOf(g['coverage']) ?? {};
  const skipped = Array.isArray(cov['skipped']) ? cov['skipped'] : [];

  if (!json) {
    cli.sayAlways(provLine);
    for (const s of skipped) {
      const so = objOf(s) ?? {};
      cli.sayAlways(`graph code: NOT INDEXED — ${intOf(so['files'])} ${strOf(so['language'])} file(s): ${strOf(so['reason'])}`);
    }
  }

  const lines: string[] = [];
  if (cmd === 'stats') {
    const symbols = objOf(g['symbols']) ?? {};
    const langs = new Map<string, number>();
    for (const s of Object.values(symbols)) {
      const lang = strOf((objOf(s) ?? {})['lang']);
      langs.set(lang, (langs.get(lang) ?? 0) + 1);
    }
    const files = Array.isArray(g['files']) ? g['files'] : [];
    const edges = Array.isArray(g['edges']) ? g['edges'] : [];
    const parseErrors = Array.isArray(g['parse_errors']) ? g['parse_errors'] : [];
    lines.push(`files   ${files.length} indexed`);
    lines.push(`symbols ${Object.keys(symbols).length}  `
      + [...langs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(' '));
    lines.push(`edges   ${edges.length}`);
    // Coverage is printed as part of the answer, not as an aside. "31 files, 0
    // parse errors" over a tree containing PHP is a true sentence and a false
    // impression.
    for (const s of skipped) {
      const so = objOf(s) ?? {};
      lines.push(`NOT INDEXED  ${intOf(so['files'])} ${strOf(so['language'])} file(s) — ${strOf(so['reason'])}`);
    }
    if (skipped.length === 0) {
      lines.push('NOT INDEXED  none — every source language in this tree has a grammar');
    }
    lines.push(`other files  ${intOf(cov['not_source'])} (no language mapped: docs, data, binaries)`);
    if (parseErrors.length > 0) {
      lines.push(`parse errors ${parseErrors.length}: ${parseErrors.slice(0, 5).map((p) => strOf(p)).join(', ')}`);
    }
  } else if (args.length === 0) {
    cli.sayAlways(`graph code: error: ${cmd} needs an argument`);
    return { ok: false, code: 2 };
  } else if (cmd === 'callers') {
    lines.push(...callersOf(g, args[0]!));
  } else if (cmd === 'callees') {
    lines.push(...calleesOf(g, args[0]!));
  } else if (cmd === 'symbols') {
    lines.push(...symbolsIn(g, args[0]!));
  } else if (cmd === 'find') {
    lines.push(...findSymbol(g, args[0]!));
  } else if (cmd === 'near') {
    const depth = args.length > 1 ? parseInt(args[1]!, 10) : 1;
    const n = neighbourhood(g, args[0]!, Number.isNaN(depth) ? 1 : depth);
    lines.push(...n.files, ...n.symbols);
  } else {
    cli.sayAlways(`graph code: error: unknown reader ${cmd}`);
    return { ok: false, code: 2 };
  }

  return { ok: true, lines, provenance: age, coverage: cov as JsonValue };
}

/** The `callers|callees|symbols|find|near|stats` dispatch arm (`:623-631`). */
function codeReaderArm(cli: Cli, ctx: NounContext, cmd: string, args: readonly string[]): never {
  if (cli.json) {
    const r = codeRead(cli, ctx, true, cmd, args);
    if (!r.ok) {
      // OQ-cg-2: `die` here and `row_fail` one line away in human mode, for
      // the identical condition. Open, unruled, reproduced.
      cli.die(`graph code ${cmd}: the reader could not answer — see stderr`);
    }
    cli.data({
      provenance: r.provenance as unknown as JsonValue,
      coverage: r.coverage,
      lines: r.lines as unknown as JsonValue,
    });
    cli.emit('');
  }
  const r = codeRead(cli, ctx, false, cmd, args);
  if (!r.ok) {
    cli.fail('code-graph', 'the reader could not answer — see the message above');
    cli.emit('');
  }
  for (const l of r.lines) cli.say(l);
  cli.emit('');
}

// ----------------------------------------------------- graph code index ---

/**
 * `graph_code_index` -- D-0043 preserved: work done through the proper
 * channels shows green. A check that is red after every legitimate edit trains
 * people to ignore checks. What changed is that a repo with no builder is no
 * longer forced red for a fact it cannot act on.
 *
 * THE FOUR OUTCOMES, and only one of them fails: current (pass), stale with a
 * builder (rebuild, pass), stale with none (TELL -- every reader still answers
 * and every answer carries its own provenance), and no index with no builder,
 * which is the one state where a reader genuinely has no answer.
 *
 * THE REBUILD HAPPENS HERE, through the same `codeBuild` the `build` verb
 * runs. Its output is CAPTURED and re-said rather than streamed, which is
 * why it is suppressed under `--json` here even though the bare `build`
 * verb prints it in both modes -- a rebuild triggered as a side effect of
 * `index` is not itself the thing being asked for.
 */
function codeIndex(cli: Cli, ctx: NounContext): never {
  const builder = canBuild(ctx);
  const idx = join(ctx.gov, 'code-graph.json');

  if (!isFile(idx)) {
    if (builder) {
      const r = codeBuild(cli, ctx, []);
      const out = stripTrailingNewlines(r.combined);
      if (r.rc !== 0) {
        cli.fail('code-graph', `no index, and the build failed: ${trNewlines(shHead(out, 3), ' ')}`);
        cli.emit('graph code index: no index and the rebuild failed.');
      }
      cli.say(out);
      cli.pass('code-graph', 'no index existed; built one');
      cli.emit('graph code index: built.');
    }
    // No index AND no builder is the one state where a reader genuinely has
    // no answer, so it is the one state that fails.
    cli.fail('code-graph',
      'no index at governance/code-graph.json and no tree-sitter grammars here to build one.'
      + ` Build it from a harness checkout that has them: scrumux graph code build --repo ${ctx.root}.`
      + ' (scrumux harness deploy installs an index into every target, so a deployed repo normally has one.)');
    cli.emit('graph code index: no index, and nothing here can build one.');
  }

  const age = readAgeQuietly(ctx);

  // An index that exists but whose provenance cannot be read is corrupt, and a
  // check named "index current" must not report it green (CLI-8). Per D-0044 a
  // derived index that cannot answer for itself is a real defect, so this is a
  // FAIL, caught BEFORE the pass arm below.
  if (age === null) {
    cli.fail('code-graph',
      'index exists but its provenance is unreadable (corrupt) — a real defect (D-0044).'
      + ` Rebuild from a harness checkout: scrumux graph code build --repo ${ctx.root}`);
    cli.emit('graph code index: provenance unreadable — the index is corrupt.');
  }

  // Only a DEFINITIVELY-fresh index passes: stale must be exactly false. The
  // prior `!= true` passed anything that was not literally "true" — including
  // an empty or null stale flag from a half-read index (CLI-8).
  if (age.stale === false) {
    cli.pass('code-graph', `index current — ${age.reason}`);
    cli.emit('graph code index: current.');
  }

  if (builder) {
    const r = codeBuild(cli, ctx, []);
    const out = stripTrailingNewlines(r.combined);
    if (r.rc !== 0) {
      cli.fail('code-graph',
        `index is stale (${age.reason}) and the rebuild failed: ${trNewlines(shHead(out, 3), ' ')}`);
      cli.emit('graph code index: stale, and the rebuild failed.');
    }
    cli.say(out);
    cli.pass('code-graph', `was stale (${age.reason}) — rebuilt (D-0043)`);
    cli.emit('graph code index: rebuilt.');
  }

  // Stale with no builder is a TELL, never a FAIL. Every reader still answers,
  // and every answer already carries its own provenance, so the fact is
  // reported at the point of use rather than turning a repo red over a
  // toolchain it was never meant to carry.
  cli.tell('code-graph',
    `index is stale (${age.reason}) and there are no tree-sitter grammars here to rebuild it.`
    + ' Every query still answers, stamped with how far behind it is.'
    + ` Refresh from a harness checkout: scrumux graph code build --repo ${ctx.root}`);
  cli.emit('graph code index: stale, reported; readers still answer with provenance.');
}

/**
 * Reads the index's provenance/age, quietly.
 *
 * WHAT MUST SURVIVE IS THE EMPTINESS: any failure here -- an unreadable
 * index, a missing file, a malformed provenance block -- returns null
 * rather than throwing, so the caller always gets a clean two-way branch
 * (has an age / does not) instead of needing a try/catch of its own.
 */
function readAgeQuietly(ctx: NounContext): IndexAge | null {
  try {
    const path = indexPath(ctx.root);
    if (!isFile(path)) return null;
    return indexAge(loadIndex(path), ctx.codeRoot);
  } catch {
    return null;
  }
}

// ------------------------------------------------------- graph gov read ---

interface GovOk { ok: true; lines: string[] }
interface GovFail { ok: false }
type GovResult = GovOk | GovFail;

/**
 * `graph_gov_py` -- the gov side's Python program, in TypeScript.
 *
 * @param quiet the `2>/dev/null` the `--json` dispatch arm installs on every
 *              gov verb except `bearing` (OQ-cg-3: the two arms disagree with
 *              each other, and the difference is reproduced, not tidied).
 */
function govRun(cli: Cli, ctx: NounContext, quiet: boolean, cmd: string, args: readonly string[]): GovResult {
  const err = (line: string): void => { if (!quiet) cli.sayAlways(line); };

  const root = ctx.root;
  const path = govIndexPath(root);
  const out: string[] = [];

  if (cmd === 'build') {
    // THE BUILDER. It needs no grammars and no interpreter: the traversal is
    // the same one every gov reader already depends on (`govIndex` rebuilds
    // a stale index, every gov reader self-heals a missing one, and
    // `loadGovIndexCurrent` rebuilds one whose shape predates the library).
    //
    // THE FAILURE PATH PRINTS ONE NAMED EXCEPTION, NEVER A TRACEBACK
    // (APPROVED-DIVERGENCE: R-006 -- this is the site RULINGS.md's R-006
    // entry pins). A JS stack trace would have to be a fabrication here, and
    // inventing plausible frames would be a worse failure than a stated gap.
    // One line naming the exception is what stands in for it; the
    // alternative considered and rejected was printing nothing, which leaves
    // the fail row's "see the message above" pointing at nothing at all.
    let g: GovGraph;
    try {
      g = govBuild(root);
      writeGovIndex(g, path);
    } catch (e) {
      err(`graph gov: error: build failed — ${msgOf(e)}`);
      return { ok: false };
    }
    const dangling = Array.isArray(g['dangling']) ? g['dangling'] : [];
    if (dangling.length > 0) {
      // stderr, so a caller parsing stdout is unaffected by it.
      err(`dangling refs: ${dangling.length} (scrumux graph gov dangling)`);
    }
    return {
      ok: true,
      lines: [`graph gov: ${Object.keys(nodesOf(g)).length} nodes, ${edgesOf(g).length} edges -> ${path}`],
    };
  }

  if (cmd === 'index') {
    // D-0043: self-heals. `scrumux views render` already maintains this index
    // (I-0063), so a stale one here means a journal was written outside
    // scrumux — which the rebuild absorbs, and which I-0047's seal is the
    // right tool to detect.
    const [stale, why] = isStale(path, root);
    if (!stale) return { ok: true, lines: [`graph gov: index current — ${why}`] };
    let g: GovGraph;
    try {
      g = govBuild(root);
      writeGovIndex(g, path);
    } catch (e) {
      err(`graph gov: error: index is stale and cannot be rebuilt — ${msgOf(e)}`);
      return { ok: false };
    }
    const dangling = Array.isArray(g['dangling']) ? g['dangling'] : [];
    return {
      ok: true,
      lines: [`graph gov: rebuilt — ${Object.keys(nodesOf(g)).length} nodes, ${edgesOf(g).length} edges`
        + (dangling.length > 0 ? `, ${dangling.length} dangling` : '')],
    };
  }

  if (!isFile(path)) {
    // SELF-HEAL rather than refuse (D-0043, and I-0002). session-open Step 3
    // tells an agent to run `scrumux graph gov bearing` on the files a task
    // names; on a FRESH deployment there is no index yet, so following the
    // skill literally failed on its first use, every time, and the agent
    // learned the prerequisite by hitting the error. A tool that can build
    // what it needs should build it.
    try {
      const g = govBuild(root);
      writeGovIndex(g, path);
      err(`graph gov: no index — built one (${Object.keys(nodesOf(g)).length} nodes, `
        + `${edgesOf(g).length} edges)`);
    } catch (e) {
      err(`graph gov: error: no index and it cannot be built — ${msgOf(e)}\n`
        + '  the governance journals are the source; check they parse: '
        + 'scrumux records check');
      return { ok: false };
    }
  }

  // T-0153: date staleness is still scrumux's job (I-0063), but a SHAPE older
  // than this library cannot hold the answer, and mtimes cannot see that.
  let g: GovGraph;
  let notice: string | null;
  try {
    [g, notice] = loadGovIndexCurrent(path, root);
  } catch (e) {
    err(`graph gov: error: ${msgOf(e)}`);
    return { ok: false };
  }
  if (notice !== null) err(`graph gov: ${notice}`);

  const nodes = nodesOf(g);
  const edges = edgesOf(g);

  if (cmd === 'stats') {
    const kinds = new Map<string, number>();
    for (const n of Object.values(nodes)) {
      const k = strOf((objOf(n) ?? {})['kind']);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const ekinds = new Map<string, number>();
    for (const e of edges) ekinds.set(e.kind, (ekinds.get(e.kind) ?? 0) + 1);
    const dangling = Array.isArray(g['dangling']) ? g['dangling'] : [];
    out.push(`nodes ${Object.keys(nodes).length}: ` + counts(kinds));
    out.push(`edges ${edges.length}: ` + counts(ekinds));
    out.push(`dangling ${dangling.length}`);
    return { ok: true, lines: out };
  }

  if (cmd === 'orphans') {
    const o = govOrphans(g, args.length > 0 ? new Set([args[0]!]) : null);
    for (const [kind, ids] of o.orphans) {
      // status matters: an orphaned RESOLVED issue is history, an orphaned
      // OPEN one is the I-0023 shape happening again
      const shown = ids.map((i) => {
        const st = (objOf(nodes[i]) ?? {})['status'];
        return truthy(st) ? `${i}[${pyStr(st)}]` : i;
      });
      out.push(`${kind} (${ids.length}): ` + shown.join(' '));
    }
    out.push(`total ${o.total} — epics, sprints, log entries, reviews and decisions are authored roots, not orphans; a homed issue is owned outward`);
    return { ok: true, lines: out };
  }

  if (cmd === 'bearing') return govBearingRun(ctx, g, args, err);

  if (cmd === 'dangling') {
    const dangling = Array.isArray(g['dangling']) ? g['dangling'] : [];
    for (const e of dangling) {
      const o = objOf(e) ?? {};
      out.push(`${strOf(o['from'])} --${strOf(o['kind'])}--> ${strOf(o['to'])}  (target does not exist)`);
    }
    return { ok: true, lines: out };
  }

  if (args.length === 0) {
    err(`graph gov: error: ${cmd} needs a record id`);
    return { ok: false };
  }
  const rid = args[0]!;

  if (cmd === 'impact') {
    const depth = args.length > 1 ? parseInt(args[1]!, 10) : 2;
    const r = govImpact(g, rid, Number.isNaN(depth) ? 2 : depth);
    if (r.error !== undefined) {
      err(`graph gov: error: ${rid} — ${r.error}`);
      return { ok: false };
    }
    for (const kind of Object.keys(r.reached).sort()) {
      out.push(`${kind} (${r.reached[kind]!.length}): ` + r.reached[kind]!.join(' '));
    }
    out.push(`total ${r.total} records within ${r.depth} hops`);
    return { ok: true, lines: out };
  }

  if (cmd === 'provenance') {
    const p = govProvenance(g, rid);
    // The print order is a LITERAL tuple, and `files` is deliberately not in
    // it: a task's file set is `bearing`'s question, not provenance's.
    for (const key of ['decisions', 'issues', 'reviews', 'stories', 'features', 'sprints', 'log', 'other']) {
      if ((p[key] ?? []).length > 0) out.push(`${key}: ` + p[key]!.join(' '));
    }
    return { ok: true, lines: out };
  }

  if (cmd === 'inbound') {
    for (const e of edges.filter((x) => x.to === rid)) out.push(`${e.from} --${e.kind}--> ${rid}`);
    return { ok: true, lines: out };
  }
  if (cmd === 'outbound') {
    for (const e of edges.filter((x) => x.from === rid)) out.push(`${rid} --${e.kind}--> ${e.to}`);
    return { ok: true, lines: out };
  }
  err(`graph gov: error: unknown subcommand ${cmd}`);
  return { ok: false };
}

function counts(m: Map<string, number>): string {
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

/**
 * `bearing`'s argv loop and query, then the render.
 *
 * THE RENDERED LINE FORMATS ARE THE CONTRACT
 * (`test/unit/graph-hardenE.test.ts`) and are exact, including the two
 * spaces before `also` and the "UNRESOLVED — the record named by an edge is
 * gone" fallback.
 */
function govBearingRun(
  ctx: NounContext, g: GovGraph, args: readonly string[], err: (l: string) => void,
): GovResult {
  // I-0118: every token that was not --task used to be appended to paths,
  // flags included. `bearing --file X` therefore asked the graph about a path
  // literally named "--file", answered "path absent --file" above the real
  // record set, and counted one path too many. Four order-drafters wrote
  // --file, so it is accepted as a synonym for a bare path; any OTHER
  // leading-dash token is refused rather than silently reinterpreted.
  let task: string | null = null;
  const paths: string[] = [];
  const rest = [...args];
  while (rest.length > 0) {
    const a = rest.shift()!;
    if (a === '--task' || a === '--file') {
      if (rest.length === 0) {
        err(`graph gov: error: bearing ${a} needs ${a === '--task' ? 'a task id' : 'a path'}`);
        return { ok: false };
      }
      if (a === '--task') task = rest.shift()!;
      else paths.push(rest.shift()!);
    } else if (a.startsWith('-') && a !== '-') {
      err(`graph gov: error: bearing: unknown flag ${a} — usage: `
        + 'scrumux graph gov bearing [--task T-XXXX] [--file <path>] [<path>...]');
      return { ok: false };
    } else {
      paths.push(a);
    }
  }
  if (task !== null && !Object.prototype.hasOwnProperty.call(nodesOf(g), task)) {
    err(`graph gov: error: ${task} is not a task in the graph`);
    return { ok: false };
  }
  let want = paths;
  if (want.length === 0) {
    if (task === null) {
      err('graph gov: error: bearing needs one or more paths, or '
        + '--task T-XXXX to take them from that order');
      return { ok: false };
    }
    // the order's own file set: its changes/reads edges, which is
    // context.files plus expected_artifacts and nothing else
    want = [...new Set(govOutbound(g, task)
      .filter((e) => (FILE_EDGE_KINDS as readonly string[]).includes(e.kind))
      .map((e) => e.to))].sort();
  }

  const b = govBearing(g, want, task);
  const lines: string[] = [];
  for (const row of b.paths) {
    // `.claude/scripts/scrumux` is named by 58 orders. Printing all 58 ids on
    // one line is the same technically-complete-and-useless answer the orphans
    // query was cut back from — the count is the signal, the ids are a sample.
    const others = row.tasks.filter((t) => t !== task);
    let shown = others.slice(0, 6).join(' ');
    if (others.length > 6) shown += ` (+${others.length - 6} more)`;
    lines.push(shown !== ''
      ? `path ${row.relation} ${row.path}  also ${shown}`
      : `path ${row.relation} ${row.path}`);
  }
  for (const r of b.records) {
    // ref_resolve, the ONE supersession-aware renderer (T-0082). A superseded
    // decision reaching an implementer as live law is the failure this command
    // exists to stop.
    const resolved = refResolve(ctx.gov, r.id);
    const text = resolved === null
      ? 'UNKNOWN PREFIX'
      : (resolved === '' ? 'UNRESOLVED — the record named by an edge is gone' : resolved);
    lines.push(`${r.id} [${r.relation} ${r.path} via ${r.via}] ${text}`);
  }
  lines.push(`bearing: ${b.total} decision(s)/issue(s) over ${b.paths.length} path(s)`);
  return { ok: true, lines };
}

/** The `build|index|…|stats` dispatch arm (`:664-672`). */
function govArm(cli: Cli, ctx: NounContext, cmd: string, args: readonly string[]): never {
  if (cli.json) {
    const r = govRun(cli, ctx, true, cmd, args);
    if (!r.ok) {
      cli.fail('gov-graph', `graph gov ${cmd} could not answer`);
      cli.emit('');
    }
    cli.data({ lines: r.lines.filter((l) => l.length > 0) as unknown as JsonValue });
    cli.emit('');
  }
  const r = govRun(cli, ctx, false, cmd, args);
  if (!r.ok) {
    cli.fail('gov-graph', `graph gov ${cmd} could not answer — see the message above`);
    cli.emit('');
  }
  for (const l of r.lines) cli.say(l);
  cli.emit('');
}

/** The `bearing)` dispatch arm (`:641-663`) -- stderr is NOT suppressed here. */
function bearingArm(cli: Cli, ctx: NounContext, args: readonly string[]): never {
  const r = govRun(cli, ctx, false, 'bearing', args);
  if (!r.ok) {
    cli.fail('gov-graph', 'bearing could not answer — see the message above');
    cli.emit('graph gov bearing: no answer.');
  }
  if (cli.json) cli.data({ lines: r.lines.filter((l) => l.length > 0) as unknown as JsonValue });
  else for (const l of r.lines) cli.say(l);
  cli.emit('');
}

// ------------------------------------------------------------- helpers ---

function objOf(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  if (Array.isArray(v) || v instanceof RawNumber) return null;
  return v;
}

function strOf(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

/** `%d` over a JSON number, RawNumber literal included. */
function intOf(v: JsonValue | undefined): number {
  if (typeof v === 'number') return v;
  if (v instanceof RawNumber) return Number(v.text);
  return 0;
}

/** Python truthiness, for the `if` guards this file reproduces. */
function truthy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (v instanceof RawNumber) return Number(v.text) !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** How an f-string renders a value that may not be a string. */
function pyStr(v: JsonValue | undefined): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof RawNumber) return v.text;
  return String(v);
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// -------------------------------------------------------------- module ---

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, dispatchCtx, verb, args): never {
    const ctx = nounContext(dispatchCtx);
    switch (verb) {
      case 'code': {
        const c = args[0] ?? '';
        if (c === '') cli.dieUsage(`graph code needs a subcommand — one of: ${CODE_CMDS}`);
        const rest = args.slice(1);
        switch (c) {
          case 'build':
            // THE CHILD CHECK IS FIRST, and before `graph_need_python`: this
            // process was spawned by the arm below to do the parse, and the
            // parent has already answered every question the guards ask.
            if (isBuildChild(ctx.env)) return codeBuildChildArm(dispatchCtx.io, ctx.env);
            return codeBuildArm(cli, ctx, dispatchCtx.io, rest);
          case 'index':
            if (rest.length !== 0) cli.dieUsage('graph code index takes no arguments');
            return codeIndex(cli, ctx);
          case 'callers': case 'callees': case 'symbols': case 'find': case 'near': case 'stats':
            return codeReaderArm(cli, ctx, c, rest);
          default:
            return cli.dieUsage(`graph code: unknown subcommand '${c}' — one of: ${CODE_CMDS}`);
        }
      }
      case 'gov': {
        const c = args[0] ?? '';
        if (c === '') cli.dieUsage(`graph gov needs a subcommand — one of: ${GOV_CMDS}`);
        const rest = args.slice(1);
        switch (c) {
          case 'bearing':
            return bearingArm(cli, ctx, rest);
          // `build` shares this arm with every gov reader (`build|index|…|
          // stats`): it takes the same envelope, the same `row_fail
          // gov-graph`, and the same double invocation under `--json` -- so
          // it needs one word added here, not a second arm.
          case 'build': case 'index': case 'provenance': case 'inbound': case 'outbound':
          case 'impact': case 'orphans': case 'dangling': case 'stats':
            return govArm(cli, ctx, c, rest);
          default:
            return cli.dieUsage(`graph gov: unknown subcommand '${c}' — one of: ${GOV_CMDS}`);
        }
      }
      default:
        return cli.dieUsage(
          `unknown domain '${verb}' for noun graph — the graphs are 'code' and 'gov'. See: scrumux help graph`,
        );
    }
  },
};
