/**
 * `src/nouns/graph.ts` — the VERB LAYER of the two derived graphs, driven in
 * process.
 *
 * WHY THIS FILE EXISTS AT ALL. Until Harden E nothing imported
 * `src/nouns/graph.ts`; `test/unit/rulings-hardenE.test.ts` was the first, and
 * it reaches exactly one arm — R-006's failed `gov build`. Everything else in
 * the noun was held up by the DIFFERENTIAL alone, and the differential runs
 * both sides as PROCESSES. That is a stronger claim than a unit test where it
 * aims, and it aims at nothing here for four separate reasons:
 *
 *   1. A REPO WITH NO BUILDER. Half of `graph code index`'s decision table is
 *      "are the tree-sitter grammars here?", and the differential's fixture
 *      repos answer that question once, the same way, forever. The four
 *      outcomes — current, stale-with-a-builder, stale-without, no-index — are
 *      a 2x2 over `canBuild` and `stale`, and three of the four cells need a
 *      root that is not this checkout.
 *
 *   2. THE CHILD PROCESS. `graph code build` spawns THE BUNDLE, which does not
 *      exist until `npm run build`. A differential case therefore compares two
 *      real parses over a real tree; nothing in it can say what the PARENT does
 *      with a child that wrote to both streams and exited 1, which is the arm
 *      `graph code index` reads through `head -3`. The stub child below is that
 *      arm's only reachable input, and it is stated as a stub rather than
 *      dressed up as a build: what it proves is the RELAY (which env the child
 *      is handed, which stream lands first in the capture, which row the exit
 *      code becomes), not the parse.
 *
 *   3. AN INDEX WITH A CHOSEN PROVENANCE. The reader's first line of output on
 *      every answer is its own age, assembled from six fields, and a real build
 *      can only ever produce one of them — the true one. A dirty flag, a commit
 *      that is not HEAD, a `skipped` language, a file that is gone: all of them
 *      are hand-written here and READ BY BOTH SIDES, so the comparison against
 *      bash is still a measurement rather than a hand-written expectation.
 *
 *   4. THE STATE-DEPENDENT ARMS. A self-heal, a schema-1 index, an index that
 *      is valid JSON but not an object, a journal that stops parsing between
 *      one verb and the next — each needs the repo mutated between the two
 *      sides' runs, which is the one thing a byte-for-byte differential case
 *      cannot do.
 *
 * HOW BASH IS USED. Where the two sides are supposed to agree, they are RUN
 * and compared (`agree()`), because an expectation typed by the person porting
 * the code is the failure mode a port shares with its original. Both sides run
 * against the SAME root — every one of these messages quotes an absolute path —
 * so the state is re-seeded between them. Where the two are ruled to differ
 * (R-006's traceback, `--repo`'s shell-expansion diagnostic) only this side is
 * asserted, and the divergence is named at the assertion.
 *
 * WHAT IS DELIBERATELY NOT HERE. `needPython`'s refusal: `graph_need_python`
 * fires when `command -v python3` fails, and this process cannot make that true
 * for a `spawnSync` that inherits its own environment. Recorded as an
 * unreached arm rather than faked with a mock, which would assert the mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo, type Io } from '../../src/cli/exit.js';
import { nounContext, todayStamp, type DispatchContext } from '../../src/nouns/lib/context.js';
import { MODULE as graph } from '../../src/nouns/graph.js';
import { canBuild, runBuildChild } from '../../src/nouns/graph/code-build-arm.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const HARNESS_CLI = join(CHECKOUT, '.deploy-claude/scripts/scrumux');

let skeleton: string | null = null;
let scratch: string | null = null;

/**
 * ONE REAL DEPLOYMENT, copied per case. `graph gov` and `graph code` both run
 * an import probe for `agents/lib/*.py` on every verb and `graph_need_python`
 * above that, so a hand-built `governance/` refuses before it reaches anything
 * this file is about. The tree carries a python file and a shell file so the
 * index has symbols of two languages in it.
 */
function deploySkeleton(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-gE-skel-')));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'Harden E graph skeleton\n');
  writeFileSync(join(dir, 'src/app.py'), 'def hello():\n    return helper()\n\ndef helper():\n    return 1\n');
  writeFileSync(join(dir, 'src/tool.sh'), '#!/bin/sh\nmain() { echo hi; }\n');
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'base'], { cwd: dir });
  const r = spawnSync(process.execPath, [HARNESS_CLI, 'harness', 'deploy', dir], { cwd: CHECKOUT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`graph Harden E: skeleton deploy failed (rc=${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return dir;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scrumux-gE-')));
  skeleton = deploySkeleton();
}, 180_000);

afterAll(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  if (skeleton !== null) rmSync(skeleton, { recursive: true, force: true });
});

function caseRepo(): string {
  const root = realpathSync(mkdtempSync(join(scratch!, 'case-')));
  cpSync(skeleton!, root, { recursive: true });
  rmSync(join(root, 'governance', 'code-graph.json'), { force: true });
  rmSync(join(root, 'governance', 'governance-graph.json'), { force: true });
  return root;
}

/**
 * THE DEPLOYED REPO IS ITS OWN HARNESS. `scriptsDir` is what `codeRoot` is
 * derived from (`nounContext`), and bash derives `GRAPH_HARNESS` from `$0` the
 * same way — so driving the port with the target's own `.claude/scripts` and
 * running bash out of the target's own `scrumux` puts both sides on the same
 * two roots. The alternative (this checkout as the harness) makes the reader
 * walk 4000 files to answer a question about five.
 */
function ctxFor(root: string, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: todayStamp(),
    io: captureIo(),
    scriptsDir: join(root, '.claude/scripts'),
    env: {},
    cwd: root,
    ...over,
  };
}

interface Run { io: CapturedIo; rc: number }

/** `graph <verb> <args…>` through the module, with the dispatcher's own
 *  `command` string (`<noun> <verb>`) so a refusal's prefix is comparable. */
function drive(root: string, verb: string, args: string[], json = false, over: Partial<DispatchContext> = {}): Run {
  const io = captureIo();
  const cli = new Cli(`graph ${verb}`, args, json, io);
  let rc = 0;
  try {
    graph.run(cli, { ...ctxFor(root, over), io }, verb, args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { io, rc };
}

/**
 * `graph.run` WIDENED, for the one arm that returns.
 *
 * The `NounModule` contract says `never` because bash's `emit` and `die` both
 * end the process where they stand — and `graph code build`'s CHILD arm is the
 * documented exception: it returns so Node can drain a piped stdout with
 * `process.exitCode` already set. The signature stays honest for every other
 * caller and the exception is widened HERE, at the two tests that exercise it,
 * rather than loosened in the source for everyone.
 */
const runReturning = graph.run as unknown as (
  cli: Cli, ctx: DispatchContext, verb: string, args: readonly string[],
) => void;

function bashRun(root: string, argv: string[]): { out: string; err: string; rc: number } {
  const r = spawnSync(process.execPath, [join(root, '.claude/scripts/scrumux'), ...argv], { cwd: root, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, rc: r.status ?? -1 };
}

/**
 * Run BOTH sides over the same root and demand the same three answers.
 *
 * `seed` puts the repo back the way it was before the second side runs: a
 * self-heal writes an index, a rebuild rewrites one, and the second side would
 * otherwise be answering a different question about a different repo.
 */
function agree(root: string, argv: string[], seed: () => void = () => {}): { out: string; err: string; rc: number } {
  seed();
  const bash = bashRun(root, argv);
  seed();
  const verb = argv[1]!;
  // `--json` is a GLOBAL flag: the dispatcher strips it before a noun ever
  // sees it (`stripGlobalFlags`), so passing it through as an argument here
  // would ask `bearing` about a path named `--json`.
  const ts = drive(root, verb, argv.slice(2).filter((a) => a !== '--json'), argv.includes('--json'));
  expect(ts.io.stdout, `stdout: scrumux ${argv.join(' ')}`).toBe(bash.out);
  expect(ts.io.stderr, `stderr: scrumux ${argv.join(' ')}`).toBe(bash.err);
  expect(ts.rc, `exit code: scrumux ${argv.join(' ')}`).toBe(bash.rc);
  return bash;
}

// ------------------------------------------------------------- fixtures ---

const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

function headOf(root: string): string {
  return spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

interface IndexOver {
  files?: string[];
  symbols?: Record<string, unknown>;
  edges?: unknown[];
  parse_errors?: string[];
  coverage?: unknown;
  provenance?: Record<string, unknown>;
}

/**
 * A code index with a CHOSEN provenance, written where both sides read it.
 *
 * Default: current (the stamp is a day in the future, so no source file on
 * disk is newer than it and every listed file exists), two languages, no
 * skipped languages, and a commit that is not this repo's HEAD so
 * `commits_behind` has to be computed rather than assumed.
 */
function writeCodeIndex(root: string, over: IndexOver = {}): void {
  const doc = {
    root,
    files: over.files ?? ['src/app.py', 'src/tool.sh'],
    symbols: over.symbols ?? {
      'src/app.py::hello': { id: 'src/app.py::hello', name: 'hello', file: 'src/app.py', lang: 'python', line: 1 },
      'src/app.py::helper': { id: 'src/app.py::helper', name: 'helper', file: 'src/app.py', lang: 'python', line: 4 },
      'src/tool.sh::main': { id: 'src/tool.sh::main', name: 'main', file: 'src/tool.sh', lang: 'bash', line: 2 },
    },
    edges: over.edges ?? [{ from: 'src/app.py::hello', to: 'src/app.py::helper', kind: 'calls' }],
    parse_errors: over.parse_errors ?? [],
    coverage: over.coverage ?? { indexed: 2, by_language: { bash: 1, python: 1 }, skipped: [], not_source: 4 },
    provenance: {
      built_at: '2026-08-31T09:00:00Z',
      built_at_epoch: FUTURE,
      commit: 'unknown — the indexed tree is not a git checkout',
      dirty: false,
      root,
      builder: 'scrumux graph code build',
      ...(over.provenance ?? {}),
    },
  };
  mkdirSync(join(root, 'governance'), { recursive: true });
  writeFileSync(join(root, 'governance', 'code-graph.json'), JSON.stringify(doc, null, 2) + '\n');
}

/** The governance journals, one shape per traversal branch the CLI renders. */
function seedJournals(root: string): void {
  const w = (name: string, doc: unknown): void =>
    writeFileSync(join(root, 'governance', name), JSON.stringify(doc, null, 2) + '\n');
  w('tasks.json', {
    entries: [
      {
        id: 'T-0001',
        title: 'the edit',
        refs: { issue: 'I-0001' },
        task_order: {
          context: {
            files: [
              { path: 'src/app.py', expected_diff: 'two lines added' },
              { path: 'src/tool.sh', expected_diff: 'none — reference only' },
            ],
            expected_artifacts: ['src/new.py'],
          },
        },
      },
      {
        id: 'T-0002',
        title: 'the read',
        refs: { task: 'T-0001' },
        task_order: { context: { files: [{ path: 'src/app.py', expected_diff: 'unchanged' }] } },
      },
      { id: 'T-0003', title: 'a ref to a record that is gone', refs: { issue: 'I-9999' } },
    ],
  });
  w('decisions.json', {
    entries: [
      { id: 'D-0001', title: 'binds src/app.py', refs: { task: 'T-0001' } },
      { id: 'D-0002', title: 'reached only through the read', refs: { task: 'T-0002' } },
      { id: 'D-0003', title: 'the replacement', supersedes: 'D-0001', refs: { task: 'T-0001' } },
    ],
  });
  w('issues.json', {
    entries: [
      { id: 'I-0001', status: 'open', summary: 'produced T-0001' },
      { id: 'I-0002', status: 'resolved', summary: 'reached through the review relay' },
      { id: 'I-0004', status: 'open', summary: 'nobody points at this one' },
      // A status that is NOT a string, which the orphans row renders through
      // an f-string on one side and `pyStr` on the other.
      { id: 'I-0005', status: true, summary: 'a boolean status' },
      { id: 'I-0006', status: null, summary: 'no status at all' },
    ],
  });
  w('reviews.json', { entries: [{ id: 'R-0001', task: 'T-0001', refs: { issue: 'I-0002' } }] });
  w('log.json', { entries: [{ id: 'L-0001', title: 'a log entry' }] });
  w('sprints.json', { entries: [{ id: 'SP-0001', tasks: ['T-0001'] }] });
  w('design.json', { entries: [{ kind: 'story', id: 'S-0001', narrative: 'a story' }] });
}

/** Build the gov index the way both sides would, so a reader has one to read. */
function buildGovIndex(root: string): void {
  const r = bashRun(root, ['graph', 'gov', 'build']);
  if (r.rc !== 0) throw new Error(`gov build failed: ${r.err}`);
}

/**
 * A FACADE HARNESS: a `codeRoot` that answers yes to `canBuild` without
 * carrying a parser.
 *
 * `canBuild` asks three questions of the code root — a `tools/grammars`
 * directory, the web-tree-sitter runtime file, and a bundle to re-invoke — and
 * `graph code index`'s two rebuild arms are unreachable while any of them says
 * no. A deployed repo says no to all three by design. This says yes to all
 * three and hands the spawn a STUB whose streams and exit code the test picks,
 * which is what makes the parent's relay observable at all.
 */
interface Facade { scriptsDir: string; env: NodeJS.ProcessEnv }

function builderFacade(root: string, env: Record<string, string> = {}): Facade {
  const fake = join(root, 'facade-harness');
  mkdirSync(join(fake, 'tools/grammars'), { recursive: true });
  mkdirSync(join(fake, 'node_modules/web-tree-sitter'), { recursive: true });
  writeFileSync(join(fake, 'node_modules/web-tree-sitter/web-tree-sitter.js'), '// not loaded here\n');
  mkdirSync(join(fake, 'agents/lib'), { recursive: true });
  for (const f of ['agents/__init__.py', 'agents/lib/__init__.py', 'agents/lib/code_graph.py']) {
    writeFileSync(join(fake, f), '');
  }
  const stub = join(fake, 'stub-bundle.mjs');
  writeFileSync(stub, [
    'const e = process.env;',
    "process.stderr.write(e.STUB_ERR ?? '');",
    "process.stdout.write(e.STUB_OUT ?? '');",
    "if (e.STUB_ECHO === '1') {",
    '  process.stdout.write(`child ${e.SCRUMUX_CODE_GRAPH_CHILD} tree=${e.SCRUMUX_CODE_GRAPH_TREE_ROOT}'
      + ' data=${e.SCRUMUX_CODE_GRAPH_DATA_ROOT} code=${e.SCRUMUX_CODE_GRAPH_CODE_ROOT}\\n`);',
    '}',
    // A child that DIES rather than exits: `spawnSync` reports status null and
    // a signal, which is the one input that makes the `rc` fallback observable.
    "if (e.STUB_SIGNAL === '1') process.kill(process.pid, 'SIGKILL');",
    "process.exit(Number(e.STUB_RC ?? '0'));",
  ].join('\n') + '\n');
  chmodSync(stub, 0o755);
  return {
    // resolve(scriptsDir, '..', '..') is the code root, so two levels below
    // the facade is where a `scripts` directory has to sit.
    scriptsDir: join(fake, 'sub', 'scripts'),
    env: { SCRUMUX_CODE_GRAPH_SELF: stub, ...env },
  };
}

/** A `captureIo` that also answers the `Io` shape `runBuildChild` writes to. */
function childIo(): CapturedIo & Io {
  return captureIo();
}

/**
 * A code root carrying the runtime and only SOME of the grammars.
 *
 * The one input that produces a `skipped` row from THIS builder. A deployed
 * repo has no grammars at all (`GrammarUnavailable`, a refusal) and this
 * checkout has all twelve (nothing skipped ever), so the arm that names a
 * language it could not load — the arm whose whole purpose is that a silently
 * skipped file looks exactly like a file with nothing in it — is unreachable
 * from either. Symlinked rather than copied: `tools/grammars` is 19 MB.
 */
function partialGrammarRoot(root: string, wasm: readonly string[]): string {
  const dir = join(root, 'partial-harness');
  mkdirSync(join(dir, 'tools/grammars'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(join(CHECKOUT, 'node_modules/web-tree-sitter'), join(dir, 'node_modules/web-tree-sitter'));
  for (const w of wasm) symlinkSync(join(CHECKOUT, 'tools/grammars', w), join(dir, 'tools/grammars', w));
  return dir;
}

// =========================================================== dispatch ======

describe('the dispatch arms — every refusal `graph` can produce', () => {
  it('refuses a missing domain, a missing subcommand and an unknown one, exactly as bash does', () => {
    const root = caseRepo();
    // Five refusals, five exit 2s, and the wording is bash's rather than a
    // paraphrase — `tests/graph-wiring-tests.sh` reads CODE_CMDS and GOV_CMDS
    // out of the shell source, so the pipe-joined lists are a contract.
    for (const argv of [
      ['graph', 'code'],
      ['graph', 'code', 'zap'],
      ['graph', 'gov'],
      ['graph', 'gov', 'zap'],
      ['graph', 'zap'],
      ['graph', 'code', 'index', 'extra'],
    ]) {
      const r = agree(root, argv);
      expect(r.rc, argv.join(' ')).toBe(2);
      expect(r.out, 'a refusal writes nothing to stdout in human mode').toBe('');
    }
  });

  it('names the whole verb list in the two refusals that offer one', () => {
    const root = caseRepo();
    expect(drive(root, 'code', []).io.stderr).toBe(
      'scrumux graph code: error: graph code needs a subcommand — one of: '
      + 'build|index|callers|callees|symbols|find|near|stats\n',
    );
    expect(drive(root, 'gov', []).io.stderr).toBe(
      'scrumux graph gov: error: graph gov needs a subcommand — one of: '
      + 'build|index|provenance|inbound|outbound|impact|orphans|dangling|stats|bearing\n',
    );
  });

  it('publishes the two verb rows and a usage block naming every verb', () => {
    // `verbs()` is one TAB-separated line per DOMAIN, not per verb: the domain
    // occupies the verb slot, which is the whole reason one noun carries two
    // graphs.
    expect(graph.verbs()).toBe(
      'code\twhat calls what, over the source tree\ngov\tthe governance journals traversed as a graph\n',
    );
    const usage = graph.usage();
    for (const v of ['code build', 'code index', 'code callers', 'code callees', 'code symbols',
      'code find', 'code near', 'code stats', 'gov build', 'gov index', 'gov provenance',
      'gov inbound|outbound', 'gov impact', 'gov orphans', 'gov dangling', 'gov stats', 'gov bearing']) {
      expect(usage, `usage names ${v}`).toContain(`scrumux graph ${v}`);
    }
  });
});

// ======================================================= graph code read ===

describe('graph code — the readers, against an index whose provenance is chosen', () => {
  it('answers all six queries byte-for-byte with bash', () => {
    const root = caseRepo();
    const seed = (): void => writeCodeIndex(root);
    // Every one of these prints the provenance line on stderr and the answer
    // on stdout, and the provenance line is assembled from six fields.
    agree(root, ['graph', 'code', 'stats'], seed);
    agree(root, ['graph', 'code', 'find', 'hello'], seed);
    agree(root, ['graph', 'code', 'callers', 'src/app.py::helper'], seed);
    agree(root, ['graph', 'code', 'callees', 'src/app.py::hello'], seed);
    agree(root, ['graph', 'code', 'symbols', 'src/app.py'], seed);
    agree(root, ['graph', 'code', 'near', 'src/app.py::helper'], seed);
    agree(root, ['graph', 'code', 'near', 'src/app.py::helper', '2'], seed);
  });

  it('renders a CURRENT index as one provenance line and the answer beneath it', () => {
    const root = caseRepo();
    writeCodeIndex(root);
    const { io, rc } = drive(root, 'code', ['stats']);
    expect(rc).toBe(0);
    // "no git commit", not "unknown —": a truncation to 8 characters of the
    // sentence "unknown — the indexed tree is not a git checkout" reads as a
    // commit hash that happens to say "unknown". The HEAD half is a real
    // hash, because the repo IS a checkout — the two halves are computed
    // separately and only the index's own half is unknown here, so
    // `commits_behind` stays absent rather than becoming a number.
    expect(io.stderr).toBe(
      'graph code: index built from no git commit at 2026-08-31T09:00:00Z; '
      + `HEAD is ${headOf(root).slice(0, 8)}. Current.\n`,
    );
    expect(io.stdout).toBe(
      'files   2 indexed\n'
      + 'symbols 3  bash=1 python=2\n'
      + 'edges   1\n'
      + 'NOT INDEXED  none — every source language in this tree has a grammar\n'
      + 'other files  4 (no language mapped: docs, data, binaries)\n',
    );
  });

  it('reads a dirty flag, a real commit and a parse-error list into the same two blocks', () => {
    const root = caseRepo();
    const head = headOf(root);
    writeCodeIndex(root, {
      parse_errors: ['src/broken.sh', 'src/other.sh'],
      coverage: {
        indexed: 2,
        by_language: { bash: 1, python: 1 },
        skipped: [{ language: 'php', files: 2, reason: 'tree_sitter_php is not installed', examples: ['a.php'] }],
        not_source: 4,
      },
      provenance: { commit: head, dirty: true },
    });
    const { io, rc } = drive(root, 'code', ['stats']);
    expect(rc).toBe(0);
    // The index names HEAD itself, so `commits_behind` is 0 — and 0 is
    // PRINTED, because the field is null-or-a-number and null is the only
    // value that suppresses the clause.
    expect(io.stderr).toBe(
      `graph code: index built from ${head.slice(0, 8)} at 2026-08-31T09:00:00Z; `
      + `HEAD is ${head.slice(0, 8)} — 0 commit(s) behind; built from a DIRTY tree. Current.\n`
      + 'graph code: NOT INDEXED — 2 php file(s): tree_sitter_php is not installed\n',
    );
    expect(io.stdout).toContain('NOT INDEXED  2 php file(s) — tree_sitter_php is not installed\n');
    expect(io.stdout).toContain('parse errors 2: src/broken.sh, src/other.sh\n');
    // …and the whole thing again out of bash, over the same file.
    agree(root, ['graph', 'code', 'stats'], () => {});
  });

  it('stamps a STALE index with the reason and the refresh command', () => {
    const root = caseRepo();
    // A file the index claims and the disk does not have. A deletion moves no
    // surviving mtime (I-0085), so this is the half a walk can never see.
    writeCodeIndex(root, { files: ['src/app.py', 'src/deleted.py'] });
    const { io, rc } = drive(root, 'code', ['find', 'hello']);
    expect(rc).toBe(0);
    // THE REFRESH NAMES A COMMAND THIS REPO CAN RUN, which is what this pin
    // moved to. It used to read `Refresh: scrumux graph code build` in every
    // repo, and that command needs the tree-sitter grammars: in a DEPLOYED
    // repo -- this case repo, and every governed repo there is -- its only
    // possible answer is the refusal `graph code index` prints fifty lines
    // up. `task brief` reprinted the unreachable instruction eight times in
    // the section implement-sop says to read first. `graph code index` has
    // branched on `canBuild` since D-0044; the per-query banner now says the
    // same thing in the same words. Exit semantics are untouched: stale still
    // answers, still at rc 0 (P-20), which is the assertion below.
    expect(io.stderr).toBe(
      `graph code: index built from no git commit at 2026-08-31T09:00:00Z; HEAD is ${headOf(root).slice(0, 8)}. `
      + 'STALE: indexed file(s) no longer on disk: src/deleted.py. '
      + `Refresh from a harness checkout: scrumux graph code build --repo ${realpathSync(root)}\n`,
    );
    // A stale reader still ANSWERS. That is the ruling the whole
    // reader/builder split rests on: the age is reported at the point of use.
    expect(io.stdout).toBe('src/app.py::hello\n');
    agree(root, ['graph', 'code', 'find', 'hello'], () => {});

    // THE OTHER ARM OF THE SAME BRANCH, in the same case so the two wordings
    // are pinned against each other rather than one being asserted alone: a
    // root that answers yes to `canBuild` gets the bare command back, because
    // there it is runnable. Same index, same staleness, same exit code — the
    // only thing that moves is the sentence.
    const builder = drive(root, 'code', ['find', 'hello'], false, builderFacade(root));
    expect(builder.rc).toBe(0);
    expect(builder.io.stdout).toBe('src/app.py::hello\n');
    expect(builder.io.stderr).toContain('Refresh: scrumux graph code build\n');
    expect(builder.io.stderr).not.toContain('--repo');
  });

  it('counts the commits between the indexed tree and HEAD', () => {
    const root = caseRepo();
    const first = headOf(root);
    writeFileSync(join(root, 'src/later.py'), 'def later():\n    return 1\n');
    spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, '-c', 'user.email=d@d', '-c', 'user.name=d', 'commit', '-qm', 'second'], {
      encoding: 'utf8',
    });
    const head = headOf(root);
    expect(head).not.toBe(first);

    // The index was built from the FIRST commit, so the distance is a
    // `rev-list --count` rather than the 0-or-null pair the equality arm
    // produces.
    writeCodeIndex(root, { provenance: { commit: first } });
    const behind = drive(root, 'code', ['stats']);
    expect(behind.io.stderr).toContain(
      `graph code: index built from ${first.slice(0, 8)} at 2026-08-31T09:00:00Z; `
      + `HEAD is ${head.slice(0, 8)} — 1 commit(s) behind`,
    );
    agree(root, ['graph', 'code', 'stats'], () => writeCodeIndex(root, { provenance: { commit: first } }));

    // A commit this checkout has never heard of: `rev-list` fails, the count
    // is not a number, and the clause is DROPPED rather than printed as 0 —
    // "0 commits behind" about an unknown commit is a false statement.
    const seed = (): void => writeCodeIndex(root, { provenance: { commit: '0'.repeat(40) } });
    seed();
    const unknown = drive(root, 'code', ['stats']);
    expect(unknown.io.stderr).toContain(`HEAD is ${head.slice(0, 8)}. `);
    expect(unknown.io.stderr).not.toContain('commit(s) behind');
    agree(root, ['graph', 'code', 'stats'], seed);
  });

  it('names BOTH halves when files changed and indexed files are gone', () => {
    // The two staleness signals are computed separately and reported
    // together: a walk can never see a DELETION (I-0085) and the index's own
    // inventory can never see an EDIT, so a reason that mentions only one of
    // them is a reason that hid the other.
    const root = caseRepo();
    // The retired payload ships far fewer files than bash's did, so the
    // deployed skeleton alone no longer guarantees 5+ changed files on its
    // own — seeded explicitly here so the cap is exercised regardless of
    // how many machinery files happen to ship.
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const f of ['extra1.py', 'extra2.py', 'extra3.py']) {
      writeFileSync(join(root, 'src', f), 'x = 1\n');
    }
    const seed = (): void => writeCodeIndex(root, {
      files: ['src/app.py', 'src/deleted.py'],
      // A stamp in the past, so every source file on disk is newer than it.
      provenance: { built_at_epoch: 1 },
    });
    seed();
    const { io, rc } = drive(root, 'code', ['find', 'hello']);
    expect(rc).toBe(0);
    expect(io.stderr).toMatch(
      /STALE: 5\+ source file\(s\) changed since the build \(e\.g\. .+\) and 1 indexed file\(s\) are gone \(e\.g\. src\/deleted\.py\)\./,
    );
    // FIVE, and no more: the walk stops at the fifth changed file, which is
    // what keeps the reason a sentence rather than an inventory.
    expect(io.stderr.match(/, /g)!.length).toBe(4);
    agree(root, ['graph', 'code', 'find', 'hello'], seed);
  });

  it('says an index with NO provenance cannot be judged, rather than calling it current', () => {
    // Every field of the provenance block is absent here, which is the shape
    // an index written by an older builder has. The line still renders, and
    // the STALENESS is "cannot be judged" rather than false — a zero or
    // missing stamp is falsy in Python and the mtime comparison is skipped
    // entirely, so calling it fresh would be a claim nothing supports.
    const root = caseRepo();
    const seed = (): void => {
      writeCodeIndex(root);
      const path = join(root, 'governance/code-graph.json');
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      doc['provenance'] = {};
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
    };
    seed();
    const { io, rc } = drive(root, 'code', ['find', 'hello']);
    expect(rc).toBe(0);
    expect(io.stderr).toBe(
      `graph code: index built from no git commit at unknown; HEAD is ${headOf(root).slice(0, 8)}. `
      + 'STALE: this index carries no build stamp, so its age cannot be judged. '
      // Builder-aware, exactly as above: this case repo has no grammars, so
      // the bare `scrumux graph code build` it used to print was a command
      // whose only answer here is a refusal. The REASON is what this case
      // measures and it is untouched; only the refresh clause moved.
      + `Refresh from a harness checkout: scrumux graph code build --repo ${realpathSync(root)}\n`,
    );
    // …and the DIRTY clause is absent rather than saying the tree was clean:
    // an absent field stays absent, it does not become false.
    expect(io.stderr).not.toContain('DIRTY');
    agree(root, ['graph', 'code', 'find', 'hello'], seed);

    // A stamp of ZERO is the same answer as no stamp, and it is a separate
    // test because it is a separate comparison: Python's `if at and …` reads
    // 0 as falsy, so the mtime loop is skipped and this arm answers. A port
    // that only checked for absence would call a zero-stamped index CURRENT,
    // which is the strongest possible wrong answer — nothing on disk can be
    // newer than a stamp nothing is compared against.
    const zero = (): void => writeCodeIndex(root, { provenance: { built_at_epoch: 0 } });
    zero();
    expect(drive(root, 'code', ['find', 'hello']).io.stderr).toContain(
      'STALE: this index carries no build stamp, so its age cannot be judged.',
    );
    agree(root, ['graph', 'code', 'find', 'hello'], zero);
  });

  it('answers over an index whose containers are the wrong TYPE, guarded rather than raising', () => {
    // Every container in this file is read through an `Array.isArray` /
    // object guard, so a hand-edited or half-written index produces zeroes
    // rather than a crash. This used to be a MEASURED DIVERGENCE against
    // bash's python reader, which indexed and called the same fields
    // directly and so raised; both sides are native now and both take the
    // guarded arm (2026-09-03).
    const root = caseRepo();
    mkdirSync(join(root, 'governance'), { recursive: true });
    writeFileSync(join(root, 'governance/code-graph.json'), JSON.stringify({
      files: null, symbols: null, edges: null, parse_errors: null, coverage: null,
      provenance: { built_at: 7, built_at_epoch: FUTURE, commit: '', dirty: 0 },
    }, null, 2) + '\n');
    const { io, rc } = drive(root, 'code', ['stats']);
    expect(rc).toBe(0);
    // `built_at` is a NUMBER, so it renders as "unknown" rather than as 7 —
    // the field is typed, not coerced.
    expect(io.stderr).toBe(
      `graph code: index built from no git commit at unknown; HEAD is ${headOf(root).slice(0, 8)}. Current.\n`,
    );
    expect(io.stdout).toBe(
      'files   0 indexed\n'
      + 'symbols 0  \n'
      + 'edges   0\n'
      + 'NOT INDEXED  none — every source language in this tree has a grammar\n'
      + 'other files  0 (no language mapped: docs, data, binaries)\n',
    );
    const bash = bashRun(root, ['graph', 'code', 'stats']);
    expect(bash.rc).toBe(0);
    expect(bash.out).toBe(io.stdout);
    expect(bash.err).toBe(io.stderr);
  });

  it('folds the provenance into the payload under --json instead of onto stderr', () => {
    const root = caseRepo();
    writeCodeIndex(root);
    const { io, rc } = drive(root, 'code', ['find', 'hello'], true);
    expect(rc).toBe(0);
    // NOTHING on stderr: under --json the two stderr notices become fields.
    expect(io.stderr).toBe('');
    const env = JSON.parse(io.stdout) as {
      command: string; argv: string[]; ok: boolean; exit: number;
      data: { lines: string[]; provenance: Record<string, unknown>; coverage: Record<string, unknown> };
    };
    expect(env.command).toBe('graph code');
    expect(env.argv).toEqual(['find', 'hello']);
    expect(env.ok).toBe(true);
    expect(env.exit).toBe(0);
    expect(env.data.lines).toEqual(['src/app.py::hello']);
    expect(env.data.provenance).toEqual({
      built_at: '2026-08-31T09:00:00Z',
      built_from_commit: 'unknown — the indexed tree is not a git checkout',
      head_commit: headOf(root),
      commits_behind: null,
      built_from_dirty_tree: false,
      stale: false,
      reason: 'index is newer than every source file',
    });
    expect(env.data.coverage).toEqual({ indexed: 2, by_language: { bash: 1, python: 1 }, skipped: [], not_source: 4 });
  });
});

describe('graph code — the reader failure arms, and the asymmetry between them (OQ-cg-2)', () => {
  it('names who can build one when there is no index, and FAILS at 1 in human mode', () => {
    const root = caseRepo();
    const { io, rc } = drive(root, 'code', ['stats']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      `graph code: error: no index at ${join(root, 'governance/code-graph.json')}, so there is nothing to read.\n`
      + '  Build it here (needs the tree-sitter grammars):  scrumux graph code build\n'
      + `  Or from a harness checkout that has them:        scrumux graph code build --repo ${root}\n`
      + '  `scrumux harness deploy` builds one into every target it installs, so a\n'
      + '  deployed repo normally has one without ever needing a parser.\n',
    );
    expect(io.stdout).toContain('FAIL code-graph');
    expect(io.stdout).toContain('the reader could not answer — see the message above');
    agree(root, ['graph', 'code', 'stats'], () => {});
  });

  it('turns the SAME condition into exit 2 and a refusal under --json', () => {
    // OQ-cg-2, open and unruled: `die` under --json and `row_fail` one line
    // away in human mode, for the identical condition. Pinned as it is —
    // "the port is more correct" is exactly the drift a port certifies itself
    // with.
    const root = caseRepo();
    const { io, rc } = drive(root, 'code', ['stats'], true);
    expect(rc).toBe(2);
    expect(io.stderr).toContain('scrumux graph code: error: graph code stats: the reader could not answer — see stderr\n');
    const env = JSON.parse(io.stdout) as { exit: number; error: { kind: string } };
    expect(env.exit).toBe(2);
    expect(env.error.kind).toBe('refused');
    agree(root, ['graph', 'code', 'stats', '--json'], () => {});
  });

  it('reports a corrupt index as an instruction, never a traceback', () => {
    const root = caseRepo();
    const path = join(root, 'governance/code-graph.json');
    mkdirSync(join(root, 'governance'), { recursive: true });
    writeFileSync(path, '{"files": [1, 2\n');
    const { io, rc } = drive(root, 'code', ['stats']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      `graph code: error: ${path} is not valid JSON (Expecting ',' delimiter: line 2 column 1 (char 16)) `
      + '— the index is corrupt or truncated; rebuild it: scrumux graph code build\n',
    );
    // The decoder sentence in the middle is CPython's, transcribed — so bash,
    // which really is CPython, must produce the same bytes.
    agree(root, ['graph', 'code', 'stats'], () => {});
  });

  it('reports an index that is valid JSON but not an object', () => {
    const root = caseRepo();
    const path = join(root, 'governance/code-graph.json');
    mkdirSync(join(root, 'governance'), { recursive: true });
    writeFileSync(path, '[1, 2, 3]\n');
    const { io, rc } = drive(root, 'code', ['stats']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      `graph code: error: ${path} is valid JSON but not an index object — `
      + 'rebuild it: scrumux graph code build\n',
    );
    agree(root, ['graph', 'code', 'stats'], () => {});
  });

  it('refuses a query with no argument at 1 in human mode and 2 under --json', () => {
    const root = caseRepo();
    writeCodeIndex(root);
    for (const cmd of ['callers', 'callees', 'symbols', 'find', 'near']) {
      const human = drive(root, 'code', [cmd]);
      expect(human.rc, cmd).toBe(1);
      expect(human.io.stderr, cmd).toContain(`graph code: error: ${cmd} needs an argument\n`);
      const json = drive(root, 'code', [cmd], true);
      expect(json.rc, cmd).toBe(2);
    }
    agree(root, ['graph', 'code', 'callers'], () => writeCodeIndex(root));
  });

  // The three-shapes-of-a-partial-deployment case retired with the module
  // itself (wave 5J, 2026-09-03): `graph code` reads via web-tree-sitter now,
  // spawns no interpreter, and has no `agents/lib/code_graph.py` left to be
  // missing — removing it changes nothing this reader touches.
});

// ====================================================== graph code index ===

describe('graph code index — the four outcomes, over a repo with no builder', () => {
  it('FAILS when there is no index and nothing here can build one', () => {
    const root = caseRepo();
    const { io, rc } = drive(root, 'code', ['index']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(
      'no index at governance/code-graph.json and no tree-sitter grammars here to build one. '
      + `Build it from a harness checkout that has them: scrumux graph code build --repo ${root}. `
      + '(scrumux harness deploy installs an index into every target, so a deployed repo normally has one.)',
    );
    expect(io.stdout).toContain('graph code index: no index, and nothing here can build one.');
    agree(root, ['graph', 'code', 'index'], () => {});
  });

  it('PASSES a definitively-fresh index and says what made it current', () => {
    const root = caseRepo();
    writeCodeIndex(root);
    const { io, rc } = drive(root, 'code', ['index']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('ok   code-graph               index current — index is newer than every source file');
    expect(io.stdout).toContain('graph code index: current.');
    agree(root, ['graph', 'code', 'index'], () => writeCodeIndex(root));
  });

  it('TELLS rather than fails when a stale index cannot be rebuilt here', () => {
    // The ruling: every reader still answers and every answer carries its own
    // provenance, so a repo is not turned red over a toolchain it was never
    // meant to carry. A TELL is recorded ok:true and leaves the exit at 0.
    const root = caseRepo();
    const seed = (): void => writeCodeIndex(root, { files: ['src/app.py', 'src/deleted.py'] });
    seed();
    const { io, rc } = drive(root, 'code', ['index']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      'TELL code-graph               index is stale (indexed file(s) no longer on disk: src/deleted.py) '
      + 'and there are no tree-sitter grammars here to rebuild it. Every query still answers, stamped with '
      + `how far behind it is. Refresh from a harness checkout: scrumux graph code build --repo ${root}`,
    );
    expect(io.stdout).toContain('graph code index: stale, reported; readers still answer with provenance.');
    agree(root, ['graph', 'code', 'index'], seed);
  });

  it('FAILS an index whose provenance cannot be read, ahead of the pass arm (CLI-8)', () => {
    // The `stale === false` comparison is EXACT for this reason: a half-read
    // index whose stale flag is empty or null used to pass a check named
    // "index current".
    const root = caseRepo();
    const seed = (): void => {
      mkdirSync(join(root, 'governance'), { recursive: true });
      writeFileSync(join(root, 'governance/code-graph.json'), '{not json at all\n');
    };
    seed();
    const { io, rc } = drive(root, 'code', ['index']);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(
      'index exists but its provenance is unreadable (corrupt) — a real defect (D-0044). '
      + `Rebuild from a harness checkout: scrumux graph code build --repo ${root}`,
    );
    expect(io.stdout).toContain('graph code index: provenance unreadable — the index is corrupt.');
    agree(root, ['graph', 'code', 'index'], seed);
  });

  // The missing-module routing case retired with the module (wave 5J): there
  // is no `agents/lib/code_graph.py` left to remove, and `readAgeQuietly`
  // reads the native index directly rather than through a jq-over-python
  // pipeline that could fail empty.
});

describe('graph code index — the two rebuild arms, which need a builder to be reachable', () => {
  it('builds one when there is none, and re-says the child\'s whole report', () => {
    const root = caseRepo();
    const over = builderFacade(root, {
      STUB_OUT: 'graph code: 3 files, 9 symbols, 4 edges -> /x/code-graph.json\n  indexed: bash=3\n',
    });
    const { io, rc } = drive(root, 'code', ['index'], false, over);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      'graph code: 3 files, 9 symbols, 4 edges -> /x/code-graph.json\n'
      + '  indexed: bash=3\n'
      + '  ok   code-graph               no index existed; built one\n'
      + 'graph code index: built.\n',
    );
    expect(io.stderr).toBe('');
  });

  it('rebuilds a STALE one and says which reason it was rebuilt for (D-0043)', () => {
    const root = caseRepo();
    const over = builderFacade(root, { STUB_OUT: 'graph code: rebuilt\n' });
    // The index lives under `root`; the tree walked is the FACADE, which has
    // no source in it at all — so the only staleness left is the file the
    // index claims and the facade does not have.
    writeCodeIndex(root, { files: ['nothing-here.py'] });
    const { io, rc } = drive(root, 'code', ['index'], false, over);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      'graph code: rebuilt\n'
      + '  ok   code-graph               was stale (indexed file(s) no longer on disk: nothing-here.py)'
      + ' — rebuilt (D-0043)\n'
      + 'graph code index: rebuilt.\n',
    );
  });

  it('reports a failed rebuild through head -3 of the capture, STDERR FIRST', () => {
    // `$(graph_code_build 2>&1)` captures a PIPE, so the child's stderr is
    // unbuffered and its stdout is block-buffered until exit: the failure line
    // lands ABOVE the report in the capture, which is the opposite of the
    // order a terminal shows. `head -3` then decides which three lines the
    // row names, so the order is load-bearing rather than cosmetic.
    const root = caseRepo();
    const over = builderFacade(root, {
      STUB_RC: '1',
      STUB_ERR: 'parse errors in: a.sh, b.sh\n',
      STUB_OUT: 'graph code: 3 files\n  indexed: bash=3\n  other files: 0 (no language mapped)\n',
    });
    const { io, rc } = drive(root, 'code', ['index'], false, over);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(
      'FAIL code-graph               no index, and the build failed: '
      + 'parse errors in: a.sh, b.sh graph code: 3 files   indexed: bash=3 ',
    );
    // Exactly three lines of the capture, and the fourth is absent.
    expect(io.stdout).not.toContain('other files: 0');
    expect(io.stdout).toContain('graph code index: no index and the rebuild failed.');
  });

  it('reports a failed rebuild of a STALE index with the staleness reason beside it', () => {
    const root = caseRepo();
    const over = builderFacade(root, { STUB_RC: '2', STUB_ERR: 'the parse died\n' });
    writeCodeIndex(root, { files: ['nothing-here.py'] });
    const { io, rc } = drive(root, 'code', ['index'], false, over);
    expect(rc).toBe(1);
    expect(io.stdout).toContain(
      'FAIL code-graph               index is stale (indexed file(s) no longer on disk: nothing-here.py) '
      + 'and the rebuild failed: the parse died\n',
    );
    expect(io.stdout).toContain('graph code index: stale, and the rebuild failed.');
  });
});

// ====================================================== graph code build ===

describe('graph code build — argv, the roots, and the child it spawns', () => {
  it('hands the child the three environment values bash hands its python', () => {
    // One process boundary, in the same place, carrying the same three values
    // (`cmd-graph.sh:232-234`). The stub prints them back, so a rename or a
    // dropped root is visible here rather than at the next real build.
    const root = caseRepo();
    const over = builderFacade(root, { STUB_ECHO: '1' });
    const { io, rc } = drive(root, 'code', ['build'], false, over);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      `child 1 tree=${join(root, 'facade-harness')} data=${root} code=${join(root, 'facade-harness')}\n`,
    );
    expect(io.stdout).toContain('ok   code-graph               index rebuilt');
  });

  it('--repo overrides BOTH roots together', () => {
    const root = caseRepo();
    const other = join(root, 'src');
    const over = builderFacade(root, { STUB_ECHO: '1' });
    const { io, rc } = drive(root, 'code', ['build', '--repo', other], false, over);
    expect(rc).toBe(0);
    // The default is the tree the SCRIPTS live in for the code root and $ROOT
    // for the data root; `--repo` is the case where they genuinely are one
    // repo, so it sets both.
    expect(io.stdout).toContain(`tree=${other} data=${other} `);
  });

  it('relays the child\'s streams untouched and turns its exit code into a row', () => {
    const root = caseRepo();
    const over = builderFacade(root, {
      STUB_RC: '1',
      STUB_OUT: 'partial report\n',
      STUB_ERR: 'graph code build: error: no grammar for anything here\n',
    });
    const { io, rc } = drive(root, 'code', ['build'], false, over);
    expect(rc).toBe(1);
    // The report goes to stdout in BOTH modes — `cli.say` would suppress it
    // under --json, and bash's python does not.
    expect(io.stdout).toContain('partial report\n');
    expect(io.stderr).toBe('graph code build: error: no grammar for anything here\n');
    expect(io.stdout).toContain('FAIL code-graph               build failed (exit 1) — see the message above');
    expect(io.stdout).toContain('graph code build: failed.');
  });

  it('still prints the human report under --json, ahead of the one object', () => {
    const root = caseRepo();
    const over = builderFacade(root, { STUB_OUT: 'graph code: 1 files\n' });
    const { io, rc } = drive(root, 'code', ['build'], true, over);
    expect(rc).toBe(0);
    expect(io.stdout.startsWith('graph code: 1 files\n')).toBe(true);
    const env = JSON.parse(io.stdout.slice('graph code: 1 files\n'.length)) as { checks: Array<{ name: string }> };
    expect(env.checks.map((c) => c.name)).toEqual(['code-graph']);
  });

  it('refuses a build with no bundle to spawn rather than spawning something else', () => {
    // `process.argv[1]` under vitest is the test runner, so the env override
    // is the seam that keeps this arm reachable at all — and the arm it makes
    // reachable is the one that matters at Phase 6, where a Node SEA has no
    // script path in argv at all.
    const root = caseRepo();
    const over = builderFacade(root);
    const { io, rc } = drive(root, 'code', ['build'], false, {
      ...over,
      env: { SCRUMUX_CODE_GRAPH_SELF: join(root, 'no-such-bundle.mjs') },
    });
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      'graph code build: error: this build carries no bundle path to run the indexer in — '
      + 'the parse runs in a child process and there is nothing here to spawn.\n',
    );
    expect(io.stdout).toContain('FAIL code-graph               build failed (exit 1)');
  });

  it('refuses an unknown argument and a --repo that is not a directory, as bash does', () => {
    const root = caseRepo();
    agree(root, ['graph', 'code', 'build', '--bogus']);
    agree(root, ['graph', 'code', 'build', '--repo', join(root, 'not-a-directory')]);
  });

  it('quotes the RAW --repo argument while testing the resolved path', () => {
    // bash's `[ -d ]` runs in the caller's cwd and its message quotes `$1`;
    // the port resolves against `ctx.cwd` for the test and keeps the raw text
    // for the message, because that is what the caller has to correct.
    const root = caseRepo();
    const { io, rc } = drive(root, 'code', ['build', '--repo', 'relative/missing']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux graph code: error: graph code build: relative/missing is not a directory\n');
    // …and a RELATIVE path that does exist resolves against the cwd rather
    // than being rejected.
    const over = builderFacade(root, { STUB_ECHO: '1' });
    const ok = drive(root, 'code', ['build', '--repo', 'src'], false, over);
    expect(ok.rc).toBe(0);
    expect(ok.io.stdout).toContain(`tree=${join(root, 'src')} `);
  });

  it('refuses `--repo` with nothing after it, where bash refuses through its shell', () => {
    // APPROVED DIVERGENCE OF THE `repair journal ""` CLASS: bash's
    // `${2:?"--repo needs a path"}` names cmd-graph.sh and a line number and
    // exits 1 with no envelope. The MESSAGE is kept verbatim; the frame around
    // it becomes a refusal, so only this side is asserted.
    const root = caseRepo();
    const { io, rc } = drive(root, 'code', ['build', '--repo']);
    expect(rc).toBe(2);
    expect(io.stderr).toBe('scrumux graph code: error: --repo needs a path\n');
  });
});

describe('canBuild — the three questions, and where the bundle path comes from', () => {
  it('says no in a deployed repo and yes over a root that has all three', () => {
    // The reader/builder split, asserted as the predicate that implements it:
    // neither a pip grammar nor a wasm blob ever ships into a governed repo,
    // so a deployed root answers no and every rebuild arm stays shut.
    const root = caseRepo();
    expect(canBuild(nounContext(ctxFor(root)))).toBe(false);
    expect(canBuild(nounContext(ctxFor(root, builderFacade(root))))).toBe(true);
  });

  it('falls back to argv[1] when the test seam is not set, and to null when it names nothing', () => {
    // The env override is NAMED as a test seam in the source, and the arm it
    // hides is the real one: `process.argv[1]` is the path the caller actually
    // ran. Called directly rather than through the build arm on purpose — the
    // build arm would SPAWN whatever argv[1] is, which under vitest is the
    // test runner.
    const root = caseRepo();
    const facade = builderFacade(root);
    expect(canBuild(nounContext(ctxFor(root, { scriptsDir: facade.scriptsDir, env: {} })))).toBe(true);
    expect(canBuild(nounContext(ctxFor(root, {
      scriptsDir: facade.scriptsDir,
      env: { SCRUMUX_CODE_GRAPH_SELF: join(root, 'nothing-here.mjs') },
    })))).toBe(false);
    // …and an EMPTY override is not an override: it falls through to argv[1]
    // rather than refusing, which is what keeps an unset variable harmless.
    expect(canBuild(nounContext(ctxFor(root, {
      scriptsDir: facade.scriptsDir,
      env: { SCRUMUX_CODE_GRAPH_SELF: '' },
    })))).toBe(true);
  });

  it('reports a child that DIED as exit 2, not as exit 0', () => {
    // `spawnSync` sets `status` to null when the child was killed by a signal.
    // Reading that as 0 would turn a killed parse into "index rebuilt", which
    // is the one wrong answer a build verb must not give.
    const root = caseRepo();
    const over = builderFacade(root, { STUB_SIGNAL: '1' });
    const { io, rc } = drive(root, 'code', ['build'], false, over);
    expect(rc).toBe(1);
    expect(io.stdout).toContain('FAIL code-graph               build failed (exit 2) — see the message above');
  });
});

describe('the build CHILD, run in this process', () => {
  it('writes the index, reports coverage on stdout, and exits 0', async () => {
    // The one place the REAL parse runs here: `runBuildChild` is the port of
    // the python heredoc, and the heredoc's contract is which line goes to
    // which stream and which failure exits 1.
    const root = caseRepo();
    const io = childIo();
    const rc = await runBuildChild({
      SCRUMUX_CODE_GRAPH_CHILD: '1',
      SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
      SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
      SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT,
    }, io);
    expect(rc).toBe(0);
    expect(io.stderr).toBe('');
    const path = join(root, 'governance/code-graph.json');
    expect(io.stdout).toBe(
      `graph code: 2 files, 3 symbols, 1 edges -> ${path}\n`
      + '  indexed: bash=1, python=1\n'
      + '  other files: 0 (no language mapped)\n',
    );
    // The ids are relative to the TREE root and the index is written under the
    // DATA root: conflating the two is I-0107, and this is the one call where
    // they are deliberately different directories.
    const written = JSON.parse(readFileSync(path, 'utf8')) as { symbols: Record<string, unknown> };
    expect(Object.keys(written.symbols).sort()).toEqual(['app.py::hello', 'app.py::helper', 'tool.sh::main']);
  });

  it('names the parse errors on STDERR and exits 1 with the index already written', async () => {
    const root = caseRepo();
    writeFileSync(join(root, 'src/broken.sh'), '#!/bin/sh\nok() { echo hi; }\nif [ 1 ; then\n');
    const io = childIo();
    const rc = await runBuildChild({
      SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
      SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
      SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT,
    }, io);
    expect(rc).toBe(1);
    expect(io.stderr).toBe('parse errors in: broken.sh\n');
    // The report is still on stdout: a file that does not parse is NAMED, not
    // a reason to throw the whole index away.
    expect(io.stdout).toContain('3 files, 4 symbols');
    expect(readFileSync(join(root, 'governance/code-graph.json'), 'utf8')).toContain('app.py::hello');
  });

  it('refuses with no grammars, and names where a builder does exist', async () => {
    const root = caseRepo();
    const io = childIo();
    const rc = await runBuildChild({
      SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
      SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
      // A code root with no `tools/grammars` — which is every deployed repo.
      SCRUMUX_CODE_GRAPH_CODE_ROOT: root,
    }, io);
    expect(rc).toBe(1);
    expect(io.stderr).toContain('graph code build: error: ');
    expect(io.stderr).toContain(
      '  The BUILDER needs the grammars; readers do not — an existing index answers every query '
      + 'with no parser at all.\n'
      + `  Build from a harness checkout that has them:  scrumux graph code build --repo ${join(root, 'src')}\n`
      + '  `scrumux harness deploy` does exactly this for every target it installs.\n',
    );
    expect(io.stdout).toBe('');
  });

  it('names the path and the cause when the index cannot be written (I-0104)', async () => {
    const root = caseRepo();
    // `governance` is a FILE, so `mkdir -p` inside `writeIndex` fails.
    rmSync(join(root, 'governance'), { recursive: true, force: true });
    writeFileSync(join(root, 'governance'), 'not a directory\n');
    const io = childIo();
    const rc = await runBuildChild({
      SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
      SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
      SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT,
    }, io);
    expect(rc).toBe(1);
    expect(io.stderr.startsWith(
      `graph code build: error: cannot write the index to ${join(root, 'governance/code-graph.json')} — `,
    )).toBe(true);
    // ONE LINE. A traceback is never an answer to an operator.
    expect(io.stderr.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('NAMES a language whose grammar it could not load, rather than skipping it in silence', async () => {
    // A silently skipped file looks exactly like a file with nothing in it,
    // which is the whole argument for the coverage block. Neither a deployed
    // repo (no grammars at all — a refusal) nor this checkout (all twelve)
    // can produce a `skipped` row, so the code root here carries the runtime
    // and one grammar.
    const root = caseRepo();
    const partial = partialGrammarRoot(root, ['tree-sitter-python.wasm']);
    const io = childIo();
    const rc = await runBuildChild({
      SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
      SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
      SCRUMUX_CODE_GRAPH_CODE_ROOT: partial,
    }, io);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('  indexed: python=1\n');
    expect(io.stdout).toContain('  NOT INDEXED: 1 bash file(s) — tree-sitter-bash.wasm could not be loaded: ');
    // The examples are what make the row actionable: a count with no names
    // cannot be checked by the person reading it.
    expect(io.stdout).toContain('(e.g. tool.sh)\n');
    // WHERE the skipped file is recorded, and where it is not: `files` is the
    // INDEXED inventory, so the bash file is absent from it — and its absence
    // is exactly why the coverage block has to name it. An index that listed
    // it in `files` would claim to have read it.
    const g = JSON.parse(readFileSync(join(root, 'governance/code-graph.json'), 'utf8')) as
      { files: string[]; coverage: { indexed: number; skipped: Array<{ language: string; files: number }> } };
    expect(g.files).toEqual(['app.py']);
    expect(g.coverage.indexed).toBe(1);
    expect(g.coverage.skipped).toHaveLength(1);
    expect(g.coverage.skipped[0]).toMatchObject({ language: 'bash', files: 1 });
  });

  it('indexes NOTHING when the parent sent no tree root, never the working directory', () => {
    // The roots arrive as environment variables and default to the empty
    // string, and the empty string must not resolve to "here": a child that
    // silently indexed its own cwd would write a plausible index describing
    // the wrong repo, and the provenance block would say so in a way nobody
    // reads until the answers are wrong.
    const root = caseRepo();
    const io = childIo();
    return runBuildChild({ SCRUMUX_CODE_GRAPH_DATA_ROOT: root, SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT }, io)
      .then((rc) => {
        expect(rc).toBe(0);
        expect(io.stdout).toBe(
          `graph code: 0 files, 0 symbols, 0 edges -> ${join(root, 'governance/code-graph.json')}\n`
          + '  indexed: \n'
          + '  other files: 0 (no language mapped)\n',
        );
        const g = JSON.parse(readFileSync(join(root, 'governance/code-graph.json'), 'utf8')) as { root: string };
        expect(g.root).toBe('');
      });
  });

  it('defaults the CODE root to the tree root when the parent sent only two values', () => {
    // `env['SCRUMUX_CODE_GRAPH_CODE_ROOT'] ?? treeRoot` — the fallback exists
    // because the two roots are the same repo in every case but a `GOV_ROOT`
    // sandbox, and the child must not index nothing when the third value is
    // absent. Here the tree root has no grammars, so the fallback is
    // observable as the refusal naming that same directory twice.
    const root = caseRepo();
    const io = childIo();
    return runBuildChild({
      SCRUMUX_CODE_GRAPH_TREE_ROOT: root,
      SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
    }, io).then((rc) => {
      expect(rc).toBe(1);
      expect(io.stderr).toContain(`scrumux graph code build --repo ${root}\n`);
    });
  });

  it('lets a NON-grammar failure out, and the arm turns it into exit 2 and one line', async () => {
    // The `catch` in the child is narrow ON PURPOSE — it handles the one
    // failure the reader/builder split predicts and rethrows everything else,
    // so a genuine I/O failure is not reported as "no grammars here". What
    // catches the rethrow is the ARM, whose whole job is that a rejected
    // promise becomes an exit code rather than an unhandled rejection killing
    // the process with no message at all.
    const root = caseRepo();
    const locked = join(root, 'src/app.py');
    chmodSync(locked, 0o000);
    const before = process.exitCode;
    try {
      await expect(runBuildChild({
        SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
        SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
        SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT,
      }, childIo())).rejects.toThrow(/EACCES/);

      const io = captureIo();
      const cli = new Cli('graph code', ['build'], false, io);
      runReturning(cli, {
        ...ctxFor(root, {
          env: {
            SCRUMUX_CODE_GRAPH_CHILD: '1',
            SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
            SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
            SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT,
          },
        }),
        io,
      }, 'code', ['build']);
      for (let i = 0; i < 200 && io.stderr === ''; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(io.stderr).toMatch(/^graph code build: error: EACCES[^\n]*\n$/);
      expect(io.stdout).toBe('');
      expect(process.exitCode).toBe(2);
    } finally {
      chmodSync(locked, 0o644);
      process.exitCode = before;
    }
  });

  it('is entered from the dispatch arm BEFORE any guard, on the child marker alone', async () => {
    // The child check is first, and before `graph_need_python`: the parent has
    // already answered every question the guards ask.
    const root = caseRepo();
    const before = process.exitCode;
    try {
      const io = captureIo();
      const cli = new Cli('graph code', ['build'], false, io);
      runReturning(cli, {
        ...ctxFor(root, {
          env: {
            SCRUMUX_CODE_GRAPH_CHILD: '1',
            SCRUMUX_CODE_GRAPH_TREE_ROOT: join(root, 'src'),
            SCRUMUX_CODE_GRAPH_DATA_ROOT: root,
            SCRUMUX_CODE_GRAPH_CODE_ROOT: CHECKOUT,
          },
        }),
        io,
      }, 'code', ['build']);
      // The child arm RETURNS rather than exiting — it is the one `run()` in
      // this CLI that does, because the process ends by draining a piped
      // stdout with `process.exitCode` already set.
      for (let i = 0; i < 200 && io.stdout === ''; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(io.stdout).toContain('graph code: 2 files, 3 symbols, 1 edges -> ');
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = before;
    }
  });
});

// ======================================================== graph gov read ===

describe('graph gov — the readers, against a built index', () => {
  function govRepo(): string {
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    return root;
  }

  it('answers stats, orphans, dangling, impact, provenance, inbound and outbound as bash does', () => {
    const root = govRepo();
    // Every one of these reads the same on-disk index, so a difference here is
    // a difference in the RENDERING rather than in the traversal — which is
    // the half `test/unit/graph-queries.test.ts` cannot see, because it calls
    // the library directly.
    agree(root, ['graph', 'gov', 'stats']);
    agree(root, ['graph', 'gov', 'orphans']);
    agree(root, ['graph', 'gov', 'orphans', 'issue']);
    agree(root, ['graph', 'gov', 'dangling']);
    agree(root, ['graph', 'gov', 'impact', 'T-0001']);
    agree(root, ['graph', 'gov', 'impact', 'T-0001', '1']);
    agree(root, ['graph', 'gov', 'provenance', 'T-0001']);
    agree(root, ['graph', 'gov', 'inbound', 'T-0001']);
    agree(root, ['graph', 'gov', 'outbound', 'T-0001']);
  });

  it('renders the counts and the dangling edge in the exact shapes the rows promise', () => {
    const root = govRepo();
    const stats = drive(root, 'gov', ['stats']);
    expect(stats.rc).toBe(0);
    expect(stats.io.stdout).toBe(
      'nodes 18: decision=3 file=3 issue=5 log=1 review=1 sprint=1 story=1 task=3\n'
      + 'edges 13: carries=1 changes=2 on_task=1 reads=2 refs_issue=2 refs_task=4 supersedes=1\n'
      + 'dangling 1\n',
    );
    const dangling = drive(root, 'gov', ['dangling']);
    expect(dangling.io.stdout).toBe('T-0003 --refs_issue--> I-9999  (target does not exist)\n');
  });

  it('renders a non-string status through Python\'s f-string, not JavaScript\'s String()', () => {
    // `I-0005`'s status is the BOOLEAN true. Python prints `True`; a bare
    // `String(true)` prints `true`, and the two sides would disagree on a
    // record an operator is being asked to look at.
    const root = govRepo();
    const { io } = drive(root, 'gov', ['orphans', 'issue']);
    // …and a null status prints as a BARE id, because the guard is Python
    // TRUTHINESS rather than "is the field present" — an orphaned issue with
    // no status is still an orphan and still has to be listed.
    expect(io.stdout).toBe(
      'issue (3): I-0004[open] I-0005[True] I-0006\n'
      + 'total 3 — epics, sprints, log entries, reviews and decisions are authored roots, '
      + 'not orphans; a homed issue is owned outward\n',
    );
    expect(io.stdout).not.toContain('I-0005[true]');
  });

  it('folds the answer into .data.lines and drops the empty ones under --json', () => {
    const root = govRepo();
    const { io, rc } = drive(root, 'gov', ['stats'], true);
    expect(rc).toBe(0);
    const env = JSON.parse(io.stdout) as { data: { lines: string[] } };
    expect(env.data.lines).toHaveLength(3);
    expect(env.data.lines[2]).toBe('dangling 1');
    agree(root, ['graph', 'gov', 'stats', '--json']);
  });

  it('refuses a record query with no id', () => {
    const root = govRepo();
    for (const cmd of ['provenance', 'inbound', 'outbound', 'impact']) {
      const r = drive(root, 'gov', [cmd]);
      expect(r.rc, cmd).toBe(1);
      expect(r.io.stderr, cmd).toContain(`graph gov: error: ${cmd} needs a record id\n`);
      expect(r.io.stdout, cmd).toContain(`graph gov ${cmd} could not answer — see the message above`);
    }
    agree(root, ['graph', 'gov', 'provenance']);
  });

  it('names an unknown record id from inside the impact result rather than throwing', () => {
    const root = govRepo();
    const { io, rc } = drive(root, 'gov', ['impact', 'T-9999']);
    expect(rc).toBe(1);
    expect(io.stderr).toContain('graph gov: error: T-9999 — unknown record id\n');
    agree(root, ['graph', 'gov', 'impact', 'T-9999']);
  });

  it('SUPPRESSES the diagnostic under --json for every gov verb but bearing (OQ-cg-3)', () => {
    // The two dispatch arms disagree with each other: `--json` installs
    // `2>/dev/null` on this one and not on `bearing`. Reproduced, not tidied.
    const root = govRepo();
    const { io, rc } = drive(root, 'gov', ['impact', 'T-9999'], true);
    expect(rc).toBe(1);
    expect(io.stderr).toBe('');
    const env = JSON.parse(io.stdout) as { checks: Array<{ tier: string; detail: string }> };
    expect(env.checks).toEqual([{
      name: 'gov-graph', ok: false, tier: 'fail', detail: 'graph gov impact could not answer',
    }] as unknown);
    // …and bearing, one arm away, still writes its diagnostic under --json.
    const bearing = drive(root, 'gov', ['bearing', '--task', 'T-9999'], true);
    expect(bearing.io.stderr).toContain('graph gov: error: T-9999 is not a task in the graph\n');
  });
});

describe('graph gov — the arms that build, self-heal, or refuse to', () => {
  it('SELF-HEALS a missing index rather than refusing (D-0043, I-0002)', () => {
    // session-open Step 3 tells an agent to run `graph gov bearing` on the
    // files a task names; on a fresh deployment there is no index yet, so
    // following the skill literally failed on its first use, every time.
    const root = caseRepo();
    seedJournals(root);
    expect(bashRun(root, ['graph', 'gov', 'stats']).rc).toBe(0);
    rmSync(join(root, 'governance/governance-graph.json'), { force: true });
    const { io, rc } = drive(root, 'gov', ['stats']);
    expect(rc).toBe(0);
    expect(io.stderr).toBe('graph gov: no index — built one (18 nodes, 13 edges)\n');
    expect(io.stdout).toContain('nodes 18:');
    expect(readFileSync(join(root, 'governance/governance-graph.json'), 'utf8')).toContain('"schema": 2');
  });

  it('says what to run when the journals are the reason it cannot self-heal', () => {
    const root = caseRepo();
    seedJournals(root);
    writeFileSync(join(root, 'governance/decisions.json'), '{"entries": [\n');
    const { io, rc } = drive(root, 'gov', ['stats']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      'graph gov: error: no index and it cannot be built — '
      + 'Expecting value: line 2 column 1 (char 14)\n'
      + '  the governance journals are the source; check they parse: scrumux records check\n',
    );
    expect(io.stdout).toContain('graph gov stats could not answer — see the message above');
    agree(root, ['graph', 'gov', 'stats'], () => {
      rmSync(join(root, 'governance/governance-graph.json'), { force: true });
    });
  });

  it('reports the index CURRENT, and rebuilds it once a journal moves ahead of it', () => {
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    const current = drive(root, 'gov', ['index']);
    expect(current.rc).toBe(0);
    expect(current.io.stdout).toBe('graph gov: index current — index is newer than every journal\n');

    // A journal written outside scrumux, which the rebuild absorbs (I-0063).
    const tasks = join(root, 'governance/tasks.json');
    spawnSync('touch', ['-t', '203001010000', tasks]);
    const stale = drive(root, 'gov', ['index']);
    expect(stale.rc).toBe(0);
    // The dangling count is appended only when there IS one — an empty tail
    // rather than ", 0 dangling".
    expect(stale.io.stdout).toBe('graph gov: rebuilt — 18 nodes, 13 edges, 1 dangling\n');
    expect(stale.io.stderr).toBe('');
  });

  it('refuses when a stale index cannot be rebuilt, naming the decoder\'s own sentence', () => {
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    writeFileSync(join(root, 'governance/issues.json'), '{"entries": [},\n');
    spawnSync('touch', ['-t', '203001010000', join(root, 'governance/issues.json')]);
    const { io, rc } = drive(root, 'gov', ['index']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      'graph gov: error: index is stale and cannot be rebuilt — '
      + "Expecting value: line 1 column 14 (char 13)\n",
    );
    expect(io.stdout).toContain('graph gov index could not answer — see the message above');
  });

  it('names the dangling count on STDERR after a build, so stdout stays parseable', () => {
    const root = caseRepo();
    seedJournals(root);
    const { io, rc } = drive(root, 'gov', ['build']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe(
      `graph gov: 18 nodes, 13 edges -> ${join(root, 'governance/governance-graph.json')}\n`,
    );
    expect(io.stderr).toBe('dangling refs: 1 (scrumux graph gov dangling)\n');
    agree(root, ['graph', 'gov', 'build']);
  });

  it('rebuilds an index whose SCHEMA predates the library, which mtimes cannot see (T-0153)', () => {
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    const path = join(root, 'governance/governance-graph.json');
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    doc['schema'] = 1;
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
    const { io, rc } = drive(root, 'gov', ['stats']);
    expect(rc).toBe(0);
    expect(io.stderr).toBe('graph gov: index schema 1 predates 2 — rebuilt (rewritten)\n');
    expect(io.stdout).toContain('nodes 18:');
    // …and it really was rewritten, so the next read is quiet.
    expect(drive(root, 'gov', ['stats']).io.stderr).toBe('');
  });

  it('reports a corrupt index as an instruction, never a traceback (second site)', () => {
    // R-006's divergence (bash's python raised a bare traceback here; the
    // port catches and names the exception in one line) retired with the
    // python side (2026-09-03) — both halves of `agree` now run the same
    // native code, so there is nothing left to diverge.
    const root = caseRepo();
    seedJournals(root);
    const path = join(root, 'governance/governance-graph.json');
    mkdirSync(join(root, 'governance'), { recursive: true });
    const corrupt = (): void => writeFileSync(path, '{"nodes": }\n');

    corrupt();
    const { io, rc } = drive(root, 'gov', ['stats']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      `graph gov: error: ${path} is not valid JSON (Expecting value: line 1 column 11 (char 10)) `
      + '— the index is corrupt or truncated; rebuild it: scrumux graph gov build\n',
    );
    expect(io.stderr).not.toContain('Traceback');
    expect(io.stdout).toContain('graph gov stats could not answer — see the message above');

    agree(root, ['graph', 'gov', 'stats'], corrupt);
  });

  it('rebuilds when `index` finds no index at all, rather than reporting one', () => {
    // `is_stale` answers "no index at <path> — run: scrumux graph gov build"
    // and the verb then does exactly that, which is the D-0043 shape: the
    // check that could act does.
    const root = caseRepo();
    seedJournals(root);
    const { io, rc } = drive(root, 'gov', ['index']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('graph gov: rebuilt — 18 nodes, 13 edges, 1 dangling\n');
    agree(root, ['graph', 'gov', 'index'], () => {
      rmSync(join(root, 'governance/governance-graph.json'), { force: true });
    });
  });

  it('calls a SHAPE mismatch stale, which no mtime can see (T-0153)', () => {
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    const path = join(root, 'governance/governance-graph.json');
    const seed = (): void => {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      doc['schema'] = 1;
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
      // Newer than every journal, so the DATE half of the check says current.
      spawnSync('touch', ['-t', '203001010000', path]);
    };
    seed();
    const { io, rc } = drive(root, 'gov', ['index']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('graph gov: rebuilt — 18 nodes, 13 edges, 1 dangling\n');
    agree(root, ['graph', 'gov', 'index'], seed);
  });

  it('serialises the index the way json.dumps(ensure_ascii=False) does, byte for byte', () => {
    // The index is written by HAND rather than through `jqFormat`, and the
    // reason is exactly the bytes below: Python escapes the control range as
    // \uXXXX and leaves DEL (0x7f) RAW, while jq escapes DEL — and every
    // record in these journals is free text written by a person. The index is
    // not a journal and is not sealed, so its bytes answer to Python's
    // serializer and to nothing else. Compared as FILES, because that is the
    // artefact both sides leave behind.
    const root = caseRepo();
    seedJournals(root);
    const decisions = join(root, 'governance/decisions.json');
    const doc = JSON.parse(readFileSync(decisions, 'utf8')) as { entries: unknown[] };
    doc.entries.push({
      id: 'D-0004',
      title: 'quote " backslash \\ bs \b tab \t nl \n ff \f cr \r ctl \u0001 del \u007f café 🚀',
      refs: { task: 'T-0001' },
    });
    writeFileSync(decisions, JSON.stringify(doc, null, 2) + '\n');
    const path = join(root, 'governance/governance-graph.json');

    expect(drive(root, 'gov', ['build']).rc).toBe(0);
    const ts = readFileSync(path, 'utf8');
    rmSync(path);
    expect(bashRun(root, ['graph', 'gov', 'build']).rc).toBe(0);
    expect(ts, 'the two serializers agree on every escape').toBe(readFileSync(path, 'utf8'));

    // …and the escapes really are the ones under test, rather than a pair of
    // files that happen to match because neither carried anything hard.
    expect(ts).toContain('\\" backslash \\\\ bs \\b tab \\t nl \\n ff \\f cr \\r ctl \\u0001 del \u007f café 🚀');
  });

  it('renders an ABSENT schema as Python\'s None, not as undefined', () => {
    // The staleness message quotes the value it read with `%r`, and the value
    // it most often reads is nothing at all — every index written before the
    // field existed. `None` is what the operator sees on the bash side, so it
    // is what they see here.
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    const path = join(root, 'governance/governance-graph.json');
    const seed = (): void => {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      delete doc['schema'];
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
      spawnSync('touch', ['-t', '203001010000', path]);
    };
    seed();
    const { io, rc } = drive(root, 'gov', ['index']);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('graph gov: rebuilt — 18 nodes, 13 edges, 1 dangling\n');
    agree(root, ['graph', 'gov', 'index'], seed);

    // …and the same `%r` on a schema that is a STRING quotes it, which is how
    // an operator tells "the field is missing" from "the field says 2 in the
    // wrong type".
    const asString = (): void => {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      doc['schema'] = '2';
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
      spawnSync('touch', ['-t', '203001010000', path]);
    };
    asString();
    expect(drive(root, 'gov', ['index']).io.stdout).toBe('graph gov: rebuilt — 18 nodes, 13 edges, 1 dangling\n');
    agree(root, ['graph', 'gov', 'index'], asString);
  });

  it('keeps answering from a rebuilt-in-memory graph when the index cannot be rewritten', () => {
    // A schema older than the library is rebuilt on READ, and the rebuild is
    // written back where it can be. Where it cannot, the notice says so and
    // the ANSWER still comes out of the rebuilt graph — refusing here would
    // turn a read-only checkout into a repo with no governance graph.
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    const path = join(root, 'governance/governance-graph.json');
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    doc['schema'] = 1;
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
    chmodSync(path, 0o444);
    try {
      const { io, rc } = drive(root, 'gov', ['stats']);
      expect(rc).toBe(0);
      expect(io.stderr).toBe(
        'graph gov: index schema 1 predates 2 — rebuilt (in memory only, the index on disk is not writable)\n',
      );
      expect(io.stdout).toContain('nodes 18:');
      // …and the file really is untouched, which is the fact the notice is
      // standing in for.
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schema: 1 });
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it('reports an index that is valid JSON but not an index object', () => {
    // The second half of `load_index`: a truncation that happens to leave
    // valid JSON behind is not a decode error, and "rebuild it" is still the
    // instruction.
    const root = caseRepo();
    seedJournals(root);
    const path = join(root, 'governance/governance-graph.json');
    writeFileSync(path, '[]\n');
    const { io, rc } = drive(root, 'gov', ['stats']);
    expect(rc).toBe(1);
    expect(io.stderr).toBe(
      `graph gov: error: ${path} is valid JSON but not an index object — `
      + 'rebuild it: scrumux graph gov build\n',
    );
    const bash = bashRun(root, ['graph', 'gov', 'stats']);
    expect(bash.rc).toBe(1);
    expect(bash.out).toBe(io.stdout);
    expect(bash.err).toBe(io.stderr);
  });

  // The governance-half-missing case retired with the module (wave 5J):
  // `graph gov` is native too, and there is no `agents/lib/governance_graph.py`
  // left to remove.
});

// =========================================================== gov bearing ===

describe('graph gov bearing — the argv loop (I-0118) and the render (T-0082)', () => {
  function govRepo(): string {
    const root = caseRepo();
    seedJournals(root);
    buildGovIndex(root);
    return root;
  }

  it('answers a bare path, a --file path and a --task scope the same as bash', () => {
    const root = govRepo();
    agree(root, ['graph', 'gov', 'bearing', 'src/app.py']);
    agree(root, ['graph', 'gov', 'bearing', '--file', 'src/app.py']);
    agree(root, ['graph', 'gov', 'bearing', '--task', 'T-0002', 'src/app.py']);
    agree(root, ['graph', 'gov', 'bearing', '--task', 'T-0001']);
    agree(root, ['graph', 'gov', 'bearing', 'src/nowhere.py']);
    agree(root, ['graph', 'gov', 'bearing', 'src/app.py', '--json']);
  });

  it('renders a superseded decision as superseded, through the ONE renderer that knows', () => {
    // T-0082: a superseded decision reaching an implementer as live law is the
    // failure this whole command exists to stop. The query does not know about
    // supersession — `ref_resolve` does, and `bearing` is the one query
    // rendered through it.
    const root = govRepo();
    const { io, rc } = drive(root, 'gov', ['bearing', 'src/app.py']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain(
      'D-0001 [changes src/app.py via T-0001] binds src/app.py [SUPERSEDED by D-0003 — read that instead]\n',
    );
    expect(io.stdout).toContain('D-0002 [reads src/app.py via T-0002] reached only through the read\n');
    expect(io.stdout).toContain('I-0002 [changes src/app.py via T-0001] reached through the review relay\n');
    expect(io.stdout).toContain('bearing: 5 decision(s)/issue(s) over 1 path(s)\n');
    // The path row carries the tasks that touch it, and the relation is the
    // hardest one any of them has: T-0001 edits it, T-0002 only reads it.
    expect(io.stdout).toContain('path changes src/app.py  also T-0001 T-0002\n');
  });

  it('takes the file set from an order when only --task is given', () => {
    const root = govRepo();
    const { io } = drive(root, 'gov', ['bearing', '--task', 'T-0001']);
    // context.files plus expected_artifacts, and nothing else — with the
    // relation read from THAT order rather than from whichever task changed
    // the file hardest (I-0070, reintroduced).
    expect(io.stdout).toContain('path changes src/app.py  also T-0002\n');
    expect(io.stdout).toContain('path reads src/tool.sh\n');
    expect(io.stdout).toContain('path changes src/new.py\n');
    // T-0001 is dropped as a SOURCE: its own refs are what a caller is
    // checking, so returning them would make the check vacuous.
    expect(io.stdout).not.toContain('via T-0001');
  });

  it('refuses every flag shape I-0118 named, and one it did not', () => {
    const root = govRepo();
    for (const [args, message] of [
      [['bearing', '--task'], 'graph gov: error: bearing --task needs a task id'],
      [['bearing', '--file'], 'graph gov: error: bearing --file needs a path'],
      [['bearing', '--verbose'], 'graph gov: error: bearing: unknown flag --verbose — usage: '
        + 'scrumux graph gov bearing [--task T-XXXX] [--file <path>] [<path>...]'],
      [['bearing'], 'graph gov: error: bearing needs one or more paths, or --task T-XXXX to take them from that order'],
      [['bearing', '--task', 'T-9999'], 'graph gov: error: T-9999 is not a task in the graph'],
    ] as const) {
      const r = drive(root, 'gov', [...args]);
      expect(r.rc, args.join(' ')).toBe(1);
      expect(r.io.stderr, args.join(' ')).toContain(message + '\n');
      // The bearing arm's own summary, which no other gov verb prints.
      expect(r.io.stdout, args.join(' ')).toContain('graph gov bearing: no answer.');
    }
    agree(root, ['graph', 'gov', 'bearing', '--verbose']);
    agree(root, ['graph', 'gov', 'bearing']);
    agree(root, ['graph', 'gov', 'bearing', '--task', 'T-9999']);
  });

  it('treats a bare `-` as a path rather than a flag', () => {
    // The refusal is `a.startsWith('-') && a !== '-'`, and the exception is
    // not decoration: a lone dash is the conventional stdin path and refusing
    // it would be a check bash does not have.
    const root = govRepo();
    const { io, rc } = drive(root, 'gov', ['bearing', '-']);
    expect(rc).toBe(0);
    expect(io.stdout).toContain('path absent -\n');
    agree(root, ['graph', 'gov', 'bearing', '-']);
  });

  it('samples the task list at six and counts the rest', () => {
    // `.claude/scripts/scrumux` is named by 58 orders. Printing all 58 ids on
    // one line is the technically-complete-and-useless answer this was cut
    // back from: the count is the signal, the ids are a sample.
    const root = caseRepo();
    seedJournals(root);
    const doc = JSON.parse(readFileSync(join(root, 'governance/tasks.json'), 'utf8')) as
      { entries: Array<Record<string, unknown>> };
    for (let i = 4; i <= 12; i += 1) {
      doc.entries.push({
        id: `T-00${String(i).padStart(2, '0')}`,
        title: `crowd ${i}`,
        task_order: { context: { files: [{ path: 'src/app.py', expected_diff: 'unchanged' }] } },
      });
    }
    writeFileSync(join(root, 'governance/tasks.json'), JSON.stringify(doc, null, 2) + '\n');
    buildGovIndex(root);
    const { io } = drive(root, 'gov', ['bearing', 'src/app.py']);
    expect(io.stdout).toContain(
      'path changes src/app.py  also T-0001 T-0002 T-0004 T-0005 T-0006 T-0007 (+5 more)\n',
    );
    agree(root, ['graph', 'gov', 'bearing', 'src/app.py']);
  });

  it('says UNRESOLVED for a record the index names and the journal no longer has', () => {
    // The index is DERIVED, so a record deleted from its journal without a
    // rebuild leaves an edge pointing at nothing, and the row still has to
    // render.
    //
    // THE WORD IS `ref_resolve`'s, NOT THE RENDERER'S, and the difference is
    // worth naming because the renderer looks like it owns it: `graph.ts`
    // turns an EMPTY resolution into "UNRESOLVED — the record named by an
    // edge is gone", and `refResolve` never returns empty — its own last
    // line substitutes the bare word. Bash is arranged identically
    // (`lib.sh:684` substitutes before printing, so `bearing_render`'s
    // `[ -n "$br_t" ]` guard cannot fire either), which is why the port
    // reproduces an unreachable branch rather than dropping it: the two
    // sides are the same shape, and the fallback becomes live the moment
    // either resolver stops substituting. What is OBSERVABLE is the bare
    // word, on both sides.
    const root = govRepo();
    const decisions = join(root, 'governance/decisions.json');
    const doc = JSON.parse(readFileSync(decisions, 'utf8')) as { entries: Array<{ id: string }> };
    writeFileSync(decisions, JSON.stringify({ entries: doc.entries.filter((e) => e.id !== 'D-0002') }, null, 2) + '\n');
    const { io } = drive(root, 'gov', ['bearing', 'src/app.py']);
    expect(io.stdout).toContain('D-0002 [reads src/app.py via T-0002] UNRESOLVED\n');
    agree(root, ['graph', 'gov', 'bearing', 'src/app.py']);
  });

  it('says UNKNOWN PREFIX for a node id no journal owns', () => {
    // Hand-written into the INDEX, because `build` cannot make one: its id
    // guard is what stops a typo becoming a node. What is being pinned is the
    // renderer's fallback, which is reachable from a hand-edited index and
    // from a future prefix the resolver does not know yet.
    const root = govRepo();
    const path = join(root, 'governance/governance-graph.json');
    const g = JSON.parse(readFileSync(path, 'utf8')) as {
      nodes: Record<string, unknown>; edges: Array<Record<string, string>>;
    };
    g.nodes['Z-0001'] = { id: 'Z-0001', kind: 'decision', journal: null, title: 'a prefix nothing owns', status: null };
    g.edges.push({ from: 'Z-0001', to: 'T-0001', kind: 'refs_task' });
    writeFileSync(path, JSON.stringify(g, null, 2) + '\n');
    const { io } = drive(root, 'gov', ['bearing', 'src/app.py']);
    expect(io.stdout).toContain('Z-0001 [changes src/app.py via T-0001] UNKNOWN PREFIX\n');
    agree(root, ['graph', 'gov', 'bearing', 'src/app.py'], () => {});
  });
});
