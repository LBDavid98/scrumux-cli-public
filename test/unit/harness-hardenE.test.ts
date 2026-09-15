/**
 * HARDEN E — the two harness VERBS driven in-process, over a synthetic harness.
 *
 * WHY THIS FILE EXISTS, given that two suites and two differential fixtures
 * already speak about `src/nouns/harness/`.
 *
 * `test/unit/harness-wave4h.test.ts` and `test/unit/harness-hardenA.test.ts`
 * cover the PURE logic — the find-order walk, the exclude list, the probe
 * verdict table, the shim renderer, the settings inspectors — and one real
 * `harness deploy` of this checkout's real payload. The differential fixtures
 * (`test/fixtures/tier2-wave4h.mjs`) cover the VERBS, end to end, against bash:
 * seven cases comparing stdout, stderr, exit code, `.argv` and the whole
 * post-state tree byte-for-byte. Between them, `harness deploy` is well held.
 *
 * `harness verify` is NOT, and the reason is structural rather than an
 * oversight: bash's own differential ran both implementations as
 * SUBPROCESSES (retired with bash itself, 2026-09-03), so every byte it
 * compared was produced by code no coverage instrument was attached to.
 * `harnessVerify` — 220 lines, ten checks, four failure arms per check — was
 * therefore proved correct and measured at 19.6% covered at the same time. A
 * refactor of it could not be caught by a unit test, only by a differential
 * run against an implementation that no longer exists. That is the gap this
 * file closes.
 *
 * THE SYNTHETIC HARNESS is what makes it affordable. Driving the real payload
 * through verify means 25 real `scrumux` probes, a real schema sweep and a
 * real `records check` — the wave 4H deploy test budgets 30 seconds for one
 * pass. `mkMini()` below builds a COMPLETE but tiny harness source in a temp
 * directory: one script (a `sh` stand-in for the deployed CLI, driven
 * entirely by the environment so it can play a healthy surface, a broken
 * surface, a failed index build or a red `records check` on demand), the
 * seven built dist bundles, one rule, one skill, one agent role, and this
 * repo's real schemas. Deploy installs it in well under a second, verify
 * probes it in about the same, and every arm of both verbs becomes reachable
 * from a `writeFileSync` rather than from a fixture repo.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE EXACT TEXT. Every check detail here is
 * an OPERATOR-FACING string that bash prints byte-for-byte, so the assertions
 * pin whole sentences rather than substrings wherever the sentence is short
 * enough to read. Three of them pin bytes that look like typos and are not:
 * the DOUBLE SPACE before the em-dash in the stray-settings detail (`$STRAY`
 * carries its own trailing space from `tr '\n' ' '`), the double space in the
 * `graph code build` failure (`shHead` keeps the second line's newline and
 * `tr` maps it to a space), and `cannot resolve  — check the path` with an
 * EMPTY target name (bash's `TARGET=$(cd …)` has already assigned the empty
 * substitution by the time the `||` arm runs). Each is reproduced deliberately
 * in the port; a test that trimmed them would let a "cleanup" break parity.
 *
 * NOTHING HERE RESTATES the two existing suites: the pure helpers they cover
 * are called only where a verb's arm needs them, and the one real-payload
 * deploy stays theirs.
 *
 * ONE FOUND-NOT-FIXED DIVERGENCE, PINNED AS IT IS AND FLAGGED WHERE IT SITS.
 * Writing these cases surfaced a bash/TypeScript disagreement in the
 * `permissions.allow` union over a target `settings.json` whose `permissions`
 * is a SCALAR. bash counts the new rules with a `jq` program that errors on
 * such a file; `2>/dev/null || echo 0` collapses that to `NEWRULES=0`, so bash
 * takes the UNCHANGED branch and never opens the file. This side reads the
 * same value with optional chaining, which yields `undefined` rather than
 * throwing, so every canon rule counts as new and the union lane runs — and
 * then EITHER refuses with exit 2 (a string, boolean or array `permissions`)
 * OR rewrites the file with the appended rules silently dropped (a NUMBER,
 * because `parsePreservingNumbers` returns a `RawNumber` object that the
 * "cannot union" guard reads as an object and `jqFormat` renders back as the
 * bare literal). The three cases below pin exactly what this side does today
 * so a refactor cannot move it by accident; they are NOT evidence of parity,
 * and each says so at its own site. No source is changed here — that decision
 * belongs upstream, with the differential corpus, which carries no
 * `permissions` case at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo, type CapturedIo } from '../../src/cli/exit.js';
import type { DispatchContext } from '../../src/nouns/lib/context.js';
import { MODULE } from '../../src/nouns/harness.js';
import { writeManifest } from '../../src/nouns/harness/manifest.js';
import type { HarnessRun } from '../../src/nouns/harness/state.js';
import {
  gitOut, sealQuiet, selfBundle, spawnCombinedWith,
} from '../../src/nouns/harness/util.js';
import {
  PAYLOAD_CLAUDE_MD, allPayloadFiles, loadExcludeRules, payloadFiles, walkLikeFind,
} from '../../src/nouns/harness/payload.js';
import { hookTargets, missingChains } from '../../src/nouns/harness/settings.js';

const CHECKOUT = resolve(__dirname, '../..');
const REAL_SCHEMAS = join(CHECKOUT, '.deploy-claude/schemas');
const TODAY = '2026-09-01';

/** Every temp tree this file makes, torn down together at the end. */
const TMPS: string[] = [];
function scratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `scrumux-hE-${tag}-`));
  TMPS.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMPS) rmSync(d, { recursive: true, force: true });
});

/** Running as root defeats every mode-based refusal; those cases skip. */
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// --------------------------------------------------------------------------
// The synthetic harness source.
// --------------------------------------------------------------------------

/**
 * The stand-in for the deployed `scrumux`. It answers every one of the 26
 * SURFACE_PROBES and both of deploy's children, and each failure mode is
 * armed by an environment variable — deploy passes its own env to the two
 * children and verify passes it to every probe, so one script covers the
 * healthy path and each red path without a second payload.
 */
const FAKE_CLI = [
  '#!/bin/sh',
  '# Synthetic stand-in for the deployed CLI (test/unit/harness-hardenE).',
  'case "$1 $2" in',
  "  'graph code')",
  '    if [ -n "${FAKE_GRAPH_FAIL:-}" ]; then',
  '      echo "graph code: error: no grammars in this checkout"',
  '      echo "second line of the failure"',
  '      echo "third line nobody sees"',
  '      exit 3',
  '    fi',
  '    ;;',
  "  'records check')",
  '    if [ -n "${FAKE_RECORDS_FAIL:-}" ]; then',
  '      echo "  FAIL roster-sweep one"',
  '      echo "ok    a quiet row"',
  '      echo "  WARN prose two"',
  '      echo "  FAIL third row"',
  '      echo "  FAIL fourth row nobody sees"',
  '      exit 1',
  '    fi',
  '    ;;',
  'esac',
  'if [ -n "${FAKE_PROBE_FAIL:-}" ]; then',
  '  echo "surface exploded"',
  '  exit 4',
  'fi',
  'exit 0',
  '',
].join('\n');

/**
 * The stand-in for `SCRUMUX_SELF` — the bundle `harness deploy`'s two
 * post-install checks (`code-graph-built`, `records-check`) re-invoke
 * natively now that bash is retired (postInstall always uses `selfBundle`,
 * never a shell). Mirrors FAKE_CLI's two failure arms so the assertions that
 * used to read the bash child's stdout still see the same lines.
 */
const FAKE_TS_CLI = [
  '// Synthetic stand-in for the TypeScript bundle (test/unit/harness-hardenE).',
  'const a = process.argv.slice(2).join(" ");',
  'if (process.env.FAKE_TS_FAIL) {',
  '  process.stdout.write("  FAIL made-up-row from the bundle\\n");',
  '  process.exit(5);',
  '}',
  'if (a.startsWith("graph code build")) {',
  '  if (process.env.FAKE_GRAPH_FAIL) {',
  '    process.stdout.write("graph code: error: no grammars in this checkout\\n");',
  '    process.stdout.write("second line of the failure\\n");',
  '    process.stdout.write("third line nobody sees\\n");',
  '    process.exit(3);',
  '  }',
  '  process.exit(0);',
  '}',
  'if (a.startsWith("records check")) {',
  '  if (process.env.FAKE_RECORDS_FAIL) {',
  '    process.stdout.write("  FAIL roster-sweep one\\n");',
  '    process.stdout.write("ok    a quiet row\\n");',
  '    process.stdout.write("  WARN prose two\\n");',
  '    process.stdout.write("  FAIL third row\\n");',
  '    process.stdout.write("  FAIL fourth row nobody sees\\n");',
  '    process.exit(1);',
  '  }',
  '  process.exit(0);',
  '}',
  'process.exit(0);',
  '',
].join('\n');

interface HookEntry { type?: string; command?: string; args?: string[] }
interface ChainEntry { matcher?: string; hooks?: HookEntry[] }
interface SettingsDoc {
  permissions?: { allow?: string[] };
  hooks?: { PreToolUse?: ChainEntry[]; SessionStart?: ChainEntry[] };
}

/**
 * All four chains, wired to the one hook, and DELIBERATELY IN BOTH FORMS.
 *
 * The shell chain is EXEC form with the `Bash|PowerShell` matcher, mirroring
 * the shipped payload: `command` is the executable and the script is `args[0]`,
 * which is the shape the old `${hp%% *}` cut read as the bare word "node".
 *
 * The `Read` chain stays SHELL form, names `$CLAUDE_PROJECT_DIR` WITHOUT
 * braces, and carries an argument after a space — the legacy spelling every
 * repo deployed before this migration still holds. Both verbs must keep
 * resolving it (substitute each spelling, then cut at the first space) or
 * every one of those repos reads as having missing hooks, so the case is
 * pinned here rather than retired with the payload that stopped writing it.
 */
function miniSettings(): SettingsDoc {
  const cmd = '${CLAUDE_PROJECT_DIR}/.claude/dist/scrumux.mjs';
  return {
    permissions: { allow: ['Bash(mini-canon:*)', 'Read(//tmp/**)'] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: 'node', args: [cmd] }],
        },
        { matcher: 'Read', hooks: [{ command: '$CLAUDE_PROJECT_DIR/.claude/dist/scrumux.mjs read' }] },
        { matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: cmd }] },
      ],
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: cmd }] }],
    },
  };
}

/**
 * The payload constitution; the marker below is what deploy's "ours" arm greps.
 * It is written under `PAYLOAD_CLAUDE_MD` — NOT `CLAUDE.md` — because that is
 * the name the source side actually carries, and a fixture that wrote the old
 * name would leave deploy's one seam untested while looking green.
 */
const MINI_CLAUDE_MD = '# Mini\n\nThis repo is governed by the **harness**.\n';

interface Mini {
  /** `$SRC_ROOT` — the repo the payload ships with. */
  root: string;
  /** `$SRC_CLAUDE` — the payload directory. */
  payload: string;
  /** `$SCRIPTS`, which is what a DispatchContext actually carries. */
  scripts: string;
}

/**
 * Build a complete miniature harness source. `payloadDirName` defaults to
 * `.deploy-claude`, matching the source repo's layout, so `srcPathOf`'s one
 * mapping seam is exercised rather than bypassed.
 *
 * There is deliberately NO `payload-exclude.list` and NO `tools/` directory:
 * the first makes `loadExcludeRules` take its absent-file arm, the second
 * keeps this payload installing as plain copies so the exclude lane
 * (already covered elsewhere) stays out of the way.
 *
 * SHAPED LIKE THE REAL PAYLOAD, POST-RETIREMENT (2026-09-03): `scripts/`
 * holds only the CLI entry point (no `lib/`, no `readonly-sh` — both bash),
 * `agents/` holds role `.md` definitions (no `lib/*.py` — SHIPPED_MODULE_FILES
 * is empty now, R-004/wave 5I/5J), and `dist/` carries the built bundles that
 * replaced `hooks/*.sh` entirely.
 */
function mkMini(opts: { payloadDirName?: string; extraScripts?: readonly string[] } = {}): Mini {
  const root = scratch('src');
  const payload = join(root, opts.payloadDirName ?? '.deploy-claude');
  const scripts = join(payload, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'scrumux'), FAKE_CLI);
  chmodSync(join(scripts, 'scrumux'), 0o755);
  for (const extra of opts.extraScripts ?? []) {
    writeFileSync(join(scripts, extra), '#!/bin/sh\nexit 0\n');
    chmodSync(join(scripts, extra), 0o755);
  }
  mkdirSync(join(payload, 'dist'), { recursive: true });
  for (const b of ['scrumux.mjs', 'block-destructive.mjs', 'block-direct-llm.mjs',
    'block-secret-reads.mjs', 'block-upstream-edit.mjs', 'session-guard.mjs']) {
    writeFileSync(join(payload, 'dist', b), '// synthetic bundle\n');
    chmodSync(join(payload, 'dist', b), 0o755);
  }
  writeFileSync(join(payload, 'dist/BUILD.json'), '{}\n');
  mkdirSync(join(payload, 'rules'), { recursive: true });
  writeFileSync(join(payload, 'rules/harness-is-upstream.md'), '---\nname: harness-is-upstream\n---\n');
  mkdirSync(join(payload, 'skills/mini'), { recursive: true });
  writeFileSync(join(payload, 'skills/mini/SKILL.md'), '# mini skill\n');
  mkdirSync(join(payload, 'agents'), { recursive: true });
  writeFileSync(join(payload, 'agents/mini-role.md'), '---\nname: mini-role\n---\n# mini role\n');
  // The REAL schemas, so the journal sweep is the real sweep over real
  // contracts; a hand-written schema here would prove nothing about verify.
  cpSync(REAL_SCHEMAS, join(payload, 'schemas'), { recursive: true });
  writeFileSync(join(payload, 'settings.json'), JSON.stringify(miniSettings(), null, 2) + '\n');
  writeFileSync(join(payload, PAYLOAD_CLAUDE_MD), MINI_CLAUDE_MD);
  return { root, payload, scripts };
}

/** The roster size a stock mini ships: 1 script, 7 dist, 9 schemas, 1+1+1. */
const MINI_ROSTER = 20;
/** Payload items + CLAUDE.md + settings.json + 8 journals + walls + standards + .gitignore. */
const MINI_ITEMS = MINI_ROSTER + 1 + 1 + 8 + 1 + 1 + 1;

/**
 * `harness deploy`'s two post-install checks always re-invoke `SCRUMUX_SELF`
 * now (bash retired); under vitest `process.argv[1]` is the test runner, not
 * a scrumux bundle, so every `ctxFor` needs a stand-in by default or those
 * two checks spawn nonsense. Built once, lazily, and reused across cases —
 * a case testing the no-bundle or a-failing-bundle arm overrides it directly.
 */
let defaultTsCliPath: string | undefined;
function defaultTsCli(): string {
  if (defaultTsCliPath === undefined) {
    defaultTsCliPath = join(scratch('default-tscli'), 'scrumux.mjs');
    writeFileSync(defaultTsCliPath, FAKE_TS_CLI);
  }
  return defaultTsCliPath;
}

function ctxFor(mini: Mini, target: string, env: NodeJS.ProcessEnv = {}): DispatchContext {
  return {
    roots: { root: target, gov: join(target, 'governance'), workRoot: target },
    today: TODAY,
    io: captureIo(),
    scriptsDir: mini.scripts,
    // PATH only, plus whatever the case arms: an inherited environment would
    // let an ambient GOV_ROOT or SCRUMUX_* reach the probes.
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', SCRUMUX_SELF: defaultTsCli(), ...env },
    cwd: target,
  };
}

interface Row { name: string; ok: boolean; tier: string; detail: string }
interface Item { path: string; status: string; detail: string }
interface Env { summary: string; exit: number; ok: boolean; checks: Row[]; items: Item[]; target: string }

interface Driven { io: CapturedIo; rc: number }

function drive(ctx: DispatchContext, verb: string, args: string[], json: boolean): Driven {
  const io = captureIo();
  const cli = new Cli(`harness ${verb}`, args, json, io);
  let rc = -1;
  try {
    MODULE.run(cli, { ...ctx, io }, verb, args);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    rc = e.code;
  }
  return { io, rc };
}

/** Drive a verb under --json and hand back the parsed envelope. */
function envelope(ctx: DispatchContext, verb: string, target: string): { env: Env; rc: number } {
  const d = drive(ctx, verb, [target], true);
  return { env: JSON.parse(d.io.stdout) as Env, rc: d.rc };
}

function row(env: Env, name: string): Row {
  const r = env.checks.find((c) => c.name === name);
  if (r === undefined) throw new Error(`no check row named ${name}; got ${env.checks.map((c) => c.name).join(',')}`);
  return r;
}
function detail(env: Env, name: string): string { return row(env, name).detail; }
function itemFor(env: Env, path: string): Item {
  const i = env.items.find((x) => x.path === path);
  if (i === undefined) throw new Error(`no item for ${path}`);
  return i;
}

/** Deploy a mini into a fresh target and assert it landed clean. */
function deployMini(mini: Mini, env: NodeJS.ProcessEnv = {}): string {
  const t = scratch('tgt');
  const { rc } = envelope(ctxFor(mini, t, env), 'deploy', t);
  if (rc !== 0) throw new Error(`fixture deploy failed with rc ${rc}`);
  return t;
}

/** Copy a deployed tree so a case can mutate it without re-deploying. */
function clone(golden: string, tag: string): string {
  const t = scratch(tag);
  cpSync(golden, t, { recursive: true });
  return t;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}
function writeJson(p: string, v: unknown): void {
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

// --------------------------------------------------------------------------
// 1. writeManifest, called directly.
// --------------------------------------------------------------------------

/**
 * `.claude/DEPLOYED` decides every drift verdict verify ever renders, and its
 * provenance half — whose commit `source_commit` names — has FIVE branches
 * that a deploy of this checkout can never take, because this checkout is a
 * git repo with an origin and is not itself a deployment. They are reached
 * here by handing `writeManifest` a source root shaped for each.
 */
describe('writeManifest, the provenance half', () => {
  function runFor(target: string, srcRoot: string, srcClaude: string): HarnessRun {
    const io = captureIo();
    return {
      cli: new Cli('harness deploy', [target], true, io),
      ctx: {
        root: target, gov: join(target, 'governance'), workRoot: target,
        scriptsDir: join(srcClaude, 'scripts'), codeRoot: srcRoot,
        harnessDir: '.claude', today: TODAY, env: {}, cwd: target,
      },
      io,
      target,
      srcClaude,
      srcRoot,
      items: [],
      rows: 0,
    };
  }

  /** A target holding two of the three roster paths, so one must be skipped. */
  function targetWithTwo(): { t: string; roster: string[] } {
    const t = scratch('man-t');
    mkdirSync(join(t, '.claude/scripts'), { recursive: true });
    writeFileSync(join(t, '.claude/scripts/a'), 'A\n');
    writeFileSync(join(t, '.claude/scripts/b'), 'B\n');
    return { t, roster: ['.claude/scripts/a', '', '.claude/scripts/b', '.claude/scripts/never-landed'] };
  }

  it('records only files that actually landed, in SORTED key order, with the jq key order', () => {
    const { t, roster } = targetWithTwo();
    const src = scratch('man-s');
    const r = writeManifest(runFor(t, src, join(src, '.claude')), roster);
    expect(r.status).toBe('CREATED');
    // The empty roster entry is skipped and so is the file that never landed:
    // a manifest claiming a path that is not there would report itself as
    // drift on the very next verify.
    expect(r.filesCount).toBe(2);
    const bytes = readFileSync(join(t, '.claude/DEPLOYED'), 'utf8');
    const doc = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['source_remote', 'source_commit', 'deployed_at', 'files']);
    expect(Object.keys(doc['files'] as object)).toEqual(['.claude/scripts/a', '.claude/scripts/b']);
    expect(doc['deployed_at']).toBe(TODAY);
    // No git anywhere above the source root, so both git reads fail and the
    // remote gets its sentence rather than an empty string.
    expect(doc['source_remote']).toBe('unknown — the deploying checkout had no origin remote');
    expect(doc['source_commit']).toBe('unknown');
    expect(r.sourceCommit).toBe('unknown');
    // jqFormat, not JSON.stringify: two-space indent and a trailing newline.
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes).toContain('\n  "deployed_at": "2026-09-01",\n');
  });

  it('takes the remote from git when the deploying checkout has one', () => {
    const src = scratch('man-git');
    execFileSync('git', ['init', '-q', '.'], { cwd: src });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/harness.git'], { cwd: src });
    const { t, roster } = targetWithTwo();
    writeManifest(runFor(t, src, join(src, '.claude')), roster);
    const doc = readJson(join(t, '.claude/DEPLOYED'));
    expect(doc['source_remote']).toBe('https://example.invalid/harness.git');
    // A repo with no commit yet: `rev-parse HEAD` fails, so the OTHER git read
    // takes its null arm in the same call.
    expect(doc['source_commit']).toBe('unknown');
  });

  it('names the ORIGINAL harness when the deploy is relayed through a deployment', () => {
    const src = scratch('man-relay');
    mkdirSync(join(src, '.claude'), { recursive: true });
    writeJson(join(src, '.claude/DEPLOYED'), {
      source_remote: 'git@github.com:someone/harness.git',
      source_commit: 'abcdef1234567890',
      files: {},
    });
    const { t, roster } = targetWithTwo();
    writeManifest(runFor(t, src, join(src, '.claude')), roster);
    const doc = readJson(join(t, '.claude/DEPLOYED'));
    expect(Object.keys(doc)).toEqual(['source_remote', 'source_commit', 'deployed_at', 'deployed_from', 'files']);
    expect(doc['source_commit']).toBe('abcdef1234567890');
    expect(doc['source_remote']).toBe('git@github.com:someone/harness.git');
    expect(doc['deployed_from']).toEqual({
      path: src,
      head: 'unknown',
      note: 'this deploy was relayed through a repo that is itself a deployment; source_commit above names the harness the payload came from, not this path',
    });
  });

  it('collapses a relay manifest with no source_remote, and stringifies a non-string one', () => {
    for (const [given, want] of [
      [undefined, 'unknown — the deploying checkout had no origin remote'],
      [null, 'unknown — the deploying checkout had no origin remote'],
      [42, '42'],
    ] as [unknown, string][]) {
      const src = scratch('man-relay2');
      mkdirSync(join(src, '.claude'), { recursive: true });
      writeJson(join(src, '.claude/DEPLOYED'), {
        ...(given === undefined ? {} : { source_remote: given }),
        source_commit: 'deadbeef',
      });
      const { t, roster } = targetWithTwo();
      writeManifest(runFor(t, src, join(src, '.claude')), roster);
      const doc = readJson(join(t, '.claude/DEPLOYED'));
      expect(doc['source_remote']).toBe(want);
      expect(doc['source_commit']).toBe('deadbeef');
    }
  });

  it('is NOT a relay when the source manifest is unreadable or names no commit', () => {
    for (const body of ['{ not json', '{"source_commit": null}', '{"source_commit": false}']) {
      const src = scratch('man-notrelay');
      mkdirSync(join(src, '.claude'), { recursive: true });
      writeFileSync(join(src, '.claude/DEPLOYED'), body);
      const { t, roster } = targetWithTwo();
      writeManifest(runFor(t, src, join(src, '.claude')), roster);
      const doc = readJson(join(t, '.claude/DEPLOYED'));
      expect(doc['deployed_from'], `for ${body}`).toBeUndefined();
      expect(doc['source_commit'], `for ${body}`).toBe('unknown');
    }
  });

  /**
   * THE MANIFEST IS REPRODUCIBLE, AND THAT IS WHAT MADE IT IDEMPOTENT.
   *
   * The roster arrives in BSD `find` order — raw readdir, APFS B-tree hash
   * order — and this map used to be written in it. Three assertions in
   * `tests/harness-tests.sh` then failed on CI's macOS lane and nowhere else
   * ("no UPDATED items", ".claude/DEPLOYED as UNCHANGED", "second deploy
   * mutated file bytes"): all three are one fact, that a second deploy of a
   * byte-identical payload wrote a byte-DIFFERENT `.claude/DEPLOYED` because
   * the enumeration came back in another order.
   *
   * The property that closes it is the one asserted here, and it is stronger
   * than the CI symptom: the bytes do not depend on the roster's order AT ALL.
   * That is checkable in a unit test on any machine, where the symptom is
   * reproducible only on the runner that happened to enumerate differently.
   */
  it('writes the same BYTES whatever order the roster arrives in', () => {
    const src = scratch('man-order-s');
    const t1 = scratch('man-order-1');
    const t2 = scratch('man-order-2');
    // Names chosen so `find` order and byte order can differ, and so one key
    // is a strict PREFIX of another — the case where a naive line sort over
    // the serialised entries and a sort over the keys can disagree.
    const names = ['.claude/scripts/scrumux', '.claude/scripts/lib.sh', '.claude/scripts/lib', '.claude/dist/z.mjs'];
    for (const t of [t1, t2]) {
      mkdirSync(join(t, '.claude/scripts'), { recursive: true });
      mkdirSync(join(t, '.claude/dist'), { recursive: true });
      for (const n of names) writeFileSync(join(t, n), `${n}\n`);
    }
    writeManifest(runFor(t1, src, join(src, '.claude')), names);
    writeManifest(runFor(t2, src, join(src, '.claude')), [...names].reverse());
    const a = readFileSync(join(t1, '.claude/DEPLOYED'), 'utf8');
    const b = readFileSync(join(t2, '.claude/DEPLOYED'), 'utf8');
    expect(b).toBe(a);
    // ...and the order it settles on is byte order, which is what the bash
    // side's `LC_ALL=C sort` produces. Asserted rather than implied: "the two
    // agree with each other" is satisfied by two implementations that are
    // both wrong in the same way.
    const keys = Object.keys((JSON.parse(a) as { files: object }).files);
    expect(keys).toEqual([...names].sort());
    expect(keys).toEqual([
      '.claude/dist/z.mjs',
      '.claude/scripts/lib',
      '.claude/scripts/lib.sh',
      '.claude/scripts/scrumux',
    ]);
  });

  it('decides its own status by BYTES, so a rewritten-identical manifest is UNCHANGED', () => {
    const { t, roster } = targetWithTwo();
    const src = scratch('man-status');
    const h = runFor(t, src, join(src, '.claude'));
    expect(writeManifest(h, roster).status).toBe('CREATED');
    expect(writeManifest(h, roster).status).toBe('UNCHANGED');
    // Any byte that moves makes it UPDATED — here the date, which is the one
    // field that changes on a redeploy that installs nothing.
    const h2 = runFor(t, src, join(src, '.claude'));
    h2.ctx.today = '2026-09-02';
    expect(writeManifest(h2, roster).status).toBe('UPDATED');
    // ... and a file whose bytes moved changes the map itself.
    writeFileSync(join(t, '.claude/scripts/a'), 'A changed\n');
    expect(writeManifest(h, roster).status).toBe('UPDATED');
  });

  it('refuses when .claude cannot hold the file, naming the path', () => {
    const t = scratch('man-die');
    // `.claude` is a FILE, so the write is ENOTDIR rather than a permission
    // problem — the refusal is the same one and needs no chmod to reach.
    writeFileSync(join(t, '.claude'), 'not a directory\n');
    const src = scratch('man-die-s');
    const h = runFor(t, src, join(src, '.claude'));
    let rc = -1;
    try {
      writeManifest(h, []);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
      rc = e.code;
    }
    expect(rc).toBe(2);
    expect((h.io as CapturedIo).stderr)
      .toContain(`cannot write ${t}/.claude/DEPLOYED — check the target's permissions`);
  });
});

// --------------------------------------------------------------------------
// 2. deploy, over the synthetic harness.
// --------------------------------------------------------------------------

describe('harness deploy into a synthetic target', () => {
  let mini: Mini;
  beforeAll(() => { mini = mkMini(); });

  it('installs the whole miniature harness and says exactly what it did', () => {
    const t = scratch('dep-fresh');
    const d = drive(ctxFor(mini, t), 'deploy', [t], false);
    expect(d.rc).toBe(0);
    expect(d.io.stdout).toContain(`=== HARNESS DEPLOY -> ${t} (${TODAY}) ===`);
    expect(d.io.stdout).toContain(
      `harness deploy: ${MINI_ITEMS} created, 0 updated, 0 unchanged, 0 removed (${MINI_ITEMS} payload item(s)) in ${t}, plus .claude/DEPLOYED.`,
    );
    // The item line's own layout: a nine-column status, then the path, then
    // the detail after an em-dash.
    expect(d.io.stdout).toContain('  CREATED   .claude/settings.json — written verbatim at the repo ROOT, which is the only place Claude Code will resolve it\n');
    expect(d.io.stdout).toContain('  CREATED   governance/repo-health.json — seeded empty — register this repo\'s checks with scrumux health add\n');
    // A journal with no detail prints the bare two-column form.
    expect(d.io.stdout).toContain('  CREATED   governance/log.json\n');
    expect(readFileSync(join(t, 'governance/decisions.json'), 'utf8')).toBe('{"entries": []}\n');
    expect(readFileSync(join(t, 'CLAUDE.md'), 'utf8')).toBe(MINI_CLAUDE_MD);
    expect(readFileSync(join(t, '.claude/settings.json'), 'utf8'))
      .toBe(readFileSync(join(mini.payload, 'settings.json'), 'utf8'));
    // `cp -p` — the execute bit travels with the file.
    expect(statSync(join(t, '.claude/scripts/scrumux')).mode & 0o111).not.toBe(0);
    const man = readJson(join(t, '.claude/DEPLOYED'));
    expect(Object.keys(man['files'] as object)).toHaveLength(MINI_ROSTER);
    expect(allPayloadFiles(mini.payload, mini.root)).toHaveLength(MINI_ROSTER);
  });

  it('is a true no-op on redeploy, down to the manifest status', () => {
    const t = deployMini(mini);
    const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
    expect(rc).toBe(0);
    expect(env.summary).toBe(
      `harness deploy: nothing changed — all ${MINI_ITEMS} payload item(s) in ${t} already match this harness byte for byte, and .claude/DEPLOYED already describes them.`,
    );
    expect(env.items.every((i) => i.status === 'UNCHANGED')).toBe(true);
    expect(itemFor(env, '.claude/DEPLOYED').status).toBe('UNCHANGED');
    expect(itemFor(env, '.claude/project-walls.conf').detail)
      .toBe('kept — a repo\'s own wall rules are never overwritten');
    expect(itemFor(env, '.claude/rules/project-standards.md').detail)
      .toBe('kept — a repo\'s own standards are never overwritten');
    expect(itemFor(env, '.gitignore').detail)
      .toBe('kept — already ignores the generated views and scratch (AI_LOG.MD DECISIONS.MD BACKLOG.MD governance/governance-graph.json .scrumux/events.jsonl .scratch/)');
    expect(itemFor(env, '.claude/settings.json').detail)
      .toBe('kept — deploy does not merge; all 4 hook chains present');
  });

  it('puts a drifted payload file back to canon bytes and calls it UPDATED', () => {
    const t = deployMini(mini);
    const p = join(t, '.claude/rules/harness-is-upstream.md');
    writeFileSync(p, 'someone edited this downstream\n');
    const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
    expect(rc).toBe(0);
    expect(itemFor(env, '.claude/rules/harness-is-upstream.md').status).toBe('UPDATED');
    expect(readFileSync(p, 'utf8'))
      .toBe(readFileSync(join(mini.payload, 'rules/harness-is-upstream.md'), 'utf8'));
    expect(env.summary).toBe(
      `harness deploy: 0 created, 1 updated, ${MINI_ITEMS - 1} unchanged, 0 removed (${MINI_ITEMS} payload item(s)) in ${t}, plus .claude/DEPLOYED.`,
    );
  });

  describe('the CLAUDE.md lane', () => {
    it('UPDATES a constitution an earlier deploy left behind', () => {
      const t = scratch('dep-cmd-ours');
      writeFileSync(join(t, 'CLAUDE.md'), '# An older cut\n\nThis repo is governed by the **harness**, in an older wording.\n');
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(itemFor(env, 'CLAUDE.md').status).toBe('UPDATED');
      expect(readFileSync(join(t, 'CLAUDE.md'), 'utf8')).toBe(MINI_CLAUDE_MD);
      // Nothing is preserved on this arm: the file that was replaced was ours,
      // so there is no repo-authored constitution to keep a copy of.
      expect(() => readFileSync(join(t, 'CLAUDE.pre-harness.md'))).toThrow();
    });

    it('PRESERVES a repo\'s own constitution and points the new one at it', () => {
      const t = scratch('dep-cmd-theirs');
      const theirs = '# Their repo\n\nNothing about a harness at all.\n';
      writeFileSync(join(t, 'CLAUDE.md'), theirs);
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      const i = itemFor(env, 'CLAUDE.md');
      expect(i.status).toBe('CREATED');
      expect(i.detail).toBe('existing one preserved at CLAUDE.pre-harness.md and pointed at from the new one');
      expect(readFileSync(join(t, 'CLAUDE.pre-harness.md'), 'utf8')).toBe(theirs);
      expect(readFileSync(join(t, 'CLAUDE.md'), 'utf8'))
        .toBe(MINI_CLAUDE_MD + '\n## This repo had its own CLAUDE.md\n\nIt is preserved verbatim at `CLAUDE.pre-harness.md` and it still\napplies. Read it. Where it and this file disagree about how THIS repo\nworks, it wins; where they disagree about the governance loop, this file\nwins, and the disagreement is worth reporting.\n');
    });

    it('refuses when it cannot rewrite a constitution of its own', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      writeFileSync(join(t, 'CLAUDE.md'), '# older cut\n\ngoverned by the **harness**\n');
      chmodSync(join(t, 'CLAUDE.md'), 0o444);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr).toContain(`cannot update CLAUDE.md in ${t}`);
      } finally {
        chmodSync(join(t, 'CLAUDE.md'), 0o644);
      }
    });

    it('refuses rather than lose a repo\'s own constitution it cannot copy aside', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      writeFileSync(join(t, 'CLAUDE.md'), '# theirs, and irreplaceable\n');
      // The root is what CLAUDE.pre-harness.md would be written into. Every
      // payload path is already installed and unchanged, so this is the first
      // write the run attempts.
      chmodSync(t, 0o555);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr).toContain('cannot preserve the existing CLAUDE.md');
      } finally {
        chmodSync(t, 0o755);
      }
      expect(readFileSync(join(t, 'CLAUDE.md'), 'utf8')).toBe('# theirs, and irreplaceable\n');
    });

    it('refuses after preserving, rather than leave a half-written constitution', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      writeFileSync(join(t, 'CLAUDE.md'), '# theirs\n');
      chmodSync(join(t, 'CLAUDE.md'), 0o444);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr).toContain(`cannot install CLAUDE.md into ${t}`);
        // The copy aside DID happen — the refusal is not a rollback.
        expect(readFileSync(join(t, 'CLAUDE.pre-harness.md'), 'utf8')).toBe('# theirs\n');
      } finally {
        chmodSync(join(t, 'CLAUDE.md'), 0o644);
      }
    });

    it('never overwrites an EXISTING CLAUDE.pre-harness.md — the first preserve is the real one', () => {
      const t = scratch('dep-cmd-twice');
      writeFileSync(join(t, 'CLAUDE.md'), '# theirs, first cut\n');
      writeFileSync(join(t, 'CLAUDE.pre-harness.md'), '# the ORIGINAL, from an earlier deploy\n');
      envelope(ctxFor(mini, t), 'deploy', t);
      expect(readFileSync(join(t, 'CLAUDE.pre-harness.md'), 'utf8'))
        .toBe('# the ORIGINAL, from an earlier deploy\n');
    });
  });

  describe('the settings.json union — the ONE sanctioned merge (I-0155)', () => {
    it('appends canon rules after the target\'s own, and leaves the file at 0600', () => {
      const t = scratch('dep-union');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeJson(join(t, '.claude/settings.json'), {
        permissions: { allow: ['Bash(mine:*)', 'Bash(mini-canon:*)'] },
        hooks: miniSettings().hooks,
      });
      const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(rc).toBe(0);
      const i = itemFor(env, '.claude/settings.json');
      expect(i.status).toBe('UPDATED');
      // Only ONE of the two canon rules is new; the other the target already had.
      expect(i.detail).toBe('permissions.allow unioned: 1 canon rule(s) appended; hooks and env untouched');
      const doc = readJson(join(t, '.claude/settings.json'));
      expect((doc['permissions'] as { allow: string[] }).allow)
        .toEqual(['Bash(mine:*)', 'Bash(mini-canon:*)', 'Read(//tmp/**)']);
      if (!AS_ROOT) {
        expect(statSync(join(t, '.claude/settings.json')).mode & 0o777).toBe(0o600);
      }
    });

    it('creates permissions when the target file has none at all', () => {
      const t = scratch('dep-union-none');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeJson(join(t, '.claude/settings.json'), { permissions: null, hooks: miniSettings().hooks });
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(itemFor(env, '.claude/settings.json').detail)
        .toBe('permissions.allow unioned: 2 canon rule(s) appended; hooks and env untouched');
      const doc = readJson(join(t, '.claude/settings.json'));
      expect((doc['permissions'] as { allow: string[] }).allow)
        .toEqual(['Bash(mini-canon:*)', 'Read(//tmp/**)']);
    });

    it('KEEPS an unparseable settings.json and calls all four chains present — the recorded looseness', () => {
      // bash's `jq … 2>/dev/null` collapses to nothing on a parse error, and
      // both the union count and the chain roster read that as "nothing to
      // do". Reproduced, not repaired: deploy reports a file it never parsed
      // as fully wired, and the ITEM says so while the CHECK below agrees.
      const t = scratch('dep-union-bad');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeFileSync(join(t, '.claude/settings.json'), '{ this is not json\n');
      const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(rc).toBe(0);
      const i = itemFor(env, '.claude/settings.json');
      expect(i.status).toBe('UNCHANGED');
      expect(i.detail).toBe('kept — deploy does not merge; all 4 hook chains present');
      expect(row(env, 'settings-hook-chains').ok).toBe(true);
      expect(readFileSync(join(t, '.claude/settings.json'), 'utf8')).toBe('{ this is not json\n');
    });

    it('reports the chains a kept settings.json does not declare', () => {
      const t = scratch('dep-union-chains');
      mkdirSync(join(t, '.claude'), { recursive: true });
      // Same allow list as canon, so the union lane finds nothing and the
      // chain report is what speaks.
      writeJson(join(t, '.claude/settings.json'), {
        permissions: { allow: ['Bash(mini-canon:*)', 'Read(//tmp/**)'] },
        hooks: { SessionStart: [{ matcher: 'startup', hooks: [] }] },
      });
      const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(rc).toBe(1);
      expect(itemFor(env, '.claude/settings.json').detail)
        .toBe('kept — deploy does not merge; hook chain(s) absent: PreToolUse:Bash|PowerShell PreToolUse:Read PreToolUse:Edit|Write|NotebookEdit');
      expect(detail(env, 'settings-hook-chains')).toBe(
        `${t}/.claude/settings.json is missing hook chain(s): PreToolUse:Bash|PowerShell PreToolUse:Read PreToolUse:Edit|Write|NotebookEdit — copy the missing chain(s) from ${mini.payload}/settings.json into ${t}/.claude/settings.json under .hooks (deploy will not merge for you); if the existing file has nothing worth keeping: cp ${mini.payload}/settings.json ${t}/.claude/settings.json`,
      );
      expect(env.summary).toContain('The install FAILED its checks — see the check lines above; nothing was rolled back, fix and re-run.');
    });

    it('REFUSES rather than guess when the document has no object to union into', () => {
      // The shape parses, `allow` is unreadable so every canon rule counts as
      // new, and the document is then one the union cannot be written into.
      // Deploy stops there rather than reshaping the file.
      //
      // NOT A PARITY ASSERTION — see the divergence note in the file header.
      // bash's `jq` errors on this file, collapses NEWRULES to 0 and reports
      // UNCHANGED; this side refuses. Pinned as-is, reported, not repaired.
      const t = scratch('dep-union-array');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeFileSync(join(t, '.claude/settings.json'), '["not an object at all"]\n');
      const d = drive(ctxFor(mini, t), 'deploy', [t], false);
      expect(d.rc).toBe(2);
      expect(d.io.stderr)
        .toContain(`cannot union permissions.allow into ${t}/.claude/settings.json`);
      // Not transactional and not rolled back — the payload written before the
      // refusal is still on disk, which is the module's stated looseness.
      expect(readFileSync(join(t, '.claude/settings.json'), 'utf8')).toBe('["not an object at all"]\n');
      expect(statSync(join(t, '.claude/scripts/scrumux')).isFile()).toBe(true);
    });

    it('REFUSES when permissions is a scalar the union cannot be written onto', () => {
      // NOT A PARITY ASSERTION — see the divergence note in the file header.
      // The same input leaves bash reporting UNCHANGED with the file
      // untouched. Pinned as-is so a refactor cannot move it unnoticed.
      const t = scratch('dep-union-string');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeFileSync(join(t, '.claude/settings.json'), '{"permissions": "none of your business"}\n');
      const d = drive(ctxFor(mini, t), 'deploy', [t], false);
      expect(d.rc).toBe(2);
      expect(d.io.stderr)
        .toContain(`cannot union permissions.allow into ${t}/.claude/settings.json`);
    });

    it('refuses when the merge cannot be STAGED, leaving the original settings.json intact', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      const own = JSON.stringify({ permissions: { allow: ['Bash(mine:*)'] }, hooks: miniSettings().hooks }, null, 2) + '\n';
      writeFileSync(join(t, '.claude/settings.json'), own);
      // bash stages the rewrite through a temp file beside the target and
      // `mv`s it into place; a `.claude` it cannot write is where that stops.
      chmodSync(join(t, '.claude'), 0o555);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr).toContain('cannot stage settings.json merge');
      } finally {
        chmodSync(join(t, '.claude'), 0o755);
      }
      expect(readFileSync(join(t, '.claude/settings.json'), 'utf8')).toBe(own);
    });

    it('leaves a SCALAR permissions alone, because the number-preserving parser makes it an object', () => {
      // Pinned as-is, not corrected. `parsePreservingNumbers` returns a
      // RawNumber for `5`, and a RawNumber is `typeof 'object'` — so the
      // "cannot union" guard above does not fire, the union writes `allow`
      // onto the RawNumber, and the serialiser renders the number literal it
      // was carrying and drops the key. The item still reports the append.
      // Reaching a different answer here means changing jqFormat, which is
      // upstream of this module and pinned by the differential.
      //
      // NOT A PARITY ASSERTION, and this is the sharpest end of the
      // divergence noted in the file header: bash leaves this file completely
      // alone and reports UNCHANGED with the absent chains named, while this
      // side reports UPDATED with "2 canon rule(s) appended", rewrites the
      // bytes through jqFormat and forces mode 0600 — having appended
      // nothing. Reported, not repaired: the fix is upstream, and a
      // differential case for a scalar `permissions` does not exist yet.
      const t = scratch('dep-union-scalar');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeFileSync(join(t, '.claude/settings.json'), '{"permissions": 5}\n');
      const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(rc).toBe(1); // the chain checks, not the union
      expect(itemFor(env, '.claude/settings.json').detail)
        .toBe('permissions.allow unioned: 2 canon rule(s) appended; hooks and env untouched');
      expect(readFileSync(join(t, '.claude/settings.json'), 'utf8')).toBe('{\n  "permissions": 5\n}\n');
    });

    it('counts nothing new when the target\'s allow is not a list', () => {
      const t = scratch('dep-union-notlist');
      mkdirSync(join(t, '.claude'), { recursive: true });
      writeJson(join(t, '.claude/settings.json'), {
        permissions: { allow: 'Bash(everything)' },
        hooks: miniSettings().hooks,
      });
      const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(rc).toBe(0);
      expect(itemFor(env, '.claude/settings.json').status).toBe('UNCHANGED');
      expect(readJson(join(t, '.claude/settings.json'))['permissions'])
        .toEqual({ allow: 'Bash(everything)' });
    });
  });

  describe('the .gitignore lane, which is append-only', () => {
    it('welds nothing onto a last line that has no newline, and adds only what is absent', () => {
      const t = scratch('dep-ign');
      // `/AI_LOG.MD` with a trailing space is a MATCH (the anchor allows
      // trailing whitespace and an optional leading slash), and the file ends
      // without a newline so the append has to open one first.
      writeFileSync(join(t, '.gitignore'), 'node_modules\n/AI_LOG.MD \nDECISIONS.MD\nno-trailing-newline');
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      const i = itemFor(env, '.gitignore');
      expect(i.status).toBe('UPDATED');
      expect(i.detail).toBe('appended BACKLOG.MD governance/governance-graph.json .scrumux/events.jsonl .scratch/ — scrumux writes them into the repo root (views render, the walls\' event log, session scratch in .scratch/), and an untracked generated file reads as an uncommitted change');
      expect(readFileSync(join(t, '.gitignore'), 'utf8')).toBe(
        'node_modules\n/AI_LOG.MD \nDECISIONS.MD\nno-trailing-newline\n'
        + '\n# Written by scrumux, not by hand: the rendered views, the walls\' event log and the session scratch directory.\n'
        + '# The JSON under governance/ is the source of truth; these are projections.\n'
        + 'BACKLOG.MD\ngovernance/governance-graph.json\n.scrumux/events.jsonl\n.scratch/\n',
      );
    });

    it('seeds .scrumux/events.jsonl too, and adds ONLY it to a repo that already ignores the views', () => {
      // THE EVENT LOG IS THE ONE ENTRY NO `views render` WRITES, which is
      // exactly why it was missing: the four WALLS append to it on every tool
      // call, so a repo that merely RAN under the harness grew an untracked
      // file, and on the 2026-09-02 E2E operator run it was committed into
      // history. Same rationale as the views — machine-appended, nothing reads
      // it back out of git — so it joins the same seeded list.
      //
      // The DRIFT PATH is the half that matters and it is what this case
      // drives: a repo deployed BEFORE the entry existed already ignores the
      // four views, so the lane must append the one line that is absent and
      // not re-append the four that are not. Append-if-absent, per entry.
      const t = scratch('dep-ign-events');
      writeFileSync(
        join(t, '.gitignore'),
        'node_modules\nAI_LOG.MD\nDECISIONS.MD\nBACKLOG.MD\ngovernance/governance-graph.json\n',
      );
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      const i = itemFor(env, '.gitignore');
      expect(i.status).toBe('UPDATED');
      expect(i.detail).toBe('appended .scrumux/events.jsonl .scratch/ — scrumux writes them into the repo root (views render, the walls\' event log, session scratch in .scratch/), and an untracked generated file reads as an uncommitted change');
      expect(readFileSync(join(t, '.gitignore'), 'utf8')).toBe(
        'node_modules\nAI_LOG.MD\nDECISIONS.MD\nBACKLOG.MD\ngovernance/governance-graph.json\n'
        + '\n# Written by scrumux, not by hand: the rendered views, the walls\' event log and the session scratch directory.\n'
        + '# The JSON under governance/ is the source of truth; these are projections.\n'
        + '.scrumux/events.jsonl\n.scratch/\n',
      );
      // …and a SECOND deploy adds nothing at all: the lane is append-if-absent
      // in both directions, so the entry that just landed is now one of the
      // ones it must leave alone.
      const again = envelope(ctxFor(mini, t), 'deploy', t);
      expect(itemFor(again.env, '.gitignore').status).toBe('UNCHANGED');
      expect(itemFor(again.env, '.gitignore').detail)
        .toBe('kept — already ignores the generated views and scratch (AI_LOG.MD DECISIONS.MD BACKLOG.MD governance/governance-graph.json .scrumux/events.jsonl .scratch/)');
    });

    it('makes the dots in a view name LITERAL — AI_LOGxMD is not AI_LOG.MD', () => {
      // The regex is built from the file name, so an unescaped `.` would call
      // this line a match and silently skip the ignore the lane exists to add
      // — a false negative shaped exactly like the bug it fixes.
      const t = scratch('dep-ign-dot');
      writeFileSync(join(t, '.gitignore'), 'AI_LOGxMD\n');
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(itemFor(env, '.gitignore').detail).toContain('appended AI_LOG.MD DECISIONS.MD BACKLOG.MD governance/governance-graph.json');
    });

    it('refuses when the .gitignore it must append to is read-only', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      writeFileSync(join(t, '.gitignore'), 'node_modules\n');
      chmodSync(join(t, '.gitignore'), 0o444);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr).toContain(`cannot write ${t}/.gitignore — check the target's permissions`);
      } finally {
        chmodSync(join(t, '.gitignore'), 0o644);
      }
    });
  });

  describe('the two seeded templates, whose write failure bash never checks', () => {
    it('reports CREATED even when neither template could be written — the recorded looseness', () => {
      if (AS_ROOT) return;
      // `cat > file <<EOF` has no `||` arm in bash: the item line prints
      // whatever happened. Reproduced rather than repaired, so a target with a
      // read-only .claude is told it got a walls file it did not get.
      const t = deployMini(mini);
      rmSync(join(t, '.claude/project-walls.conf'), { force: true });
      rmSync(join(t, '.claude/rules/project-standards.md'), { force: true });
      chmodSync(join(t, '.claude/rules'), 0o555);
      chmodSync(join(t, '.claude'), 0o555);
      try {
        const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
        expect(rc).toBe(0);
        expect(itemFor(env, '.claude/project-walls.conf').status).toBe('CREATED');
        expect(itemFor(env, '.claude/rules/project-standards.md').status).toBe('CREATED');
        expect(() => readFileSync(join(t, '.claude/project-walls.conf'))).toThrow();
        expect(() => readFileSync(join(t, '.claude/rules/project-standards.md'))).toThrow();
      } finally {
        chmodSync(join(t, '.claude'), 0o755);
        chmodSync(join(t, '.claude/rules'), 0o755);
      }
    });

    it('writes both templates verbatim when it can, and they are never overwritten after', () => {
      const t = deployMini(mini);
      const walls = readFileSync(join(t, '.claude/project-walls.conf'), 'utf8');
      expect(walls.startsWith('# This repo\'s wall rules. The one place to extend the refusal layer.\n')).toBe(true);
      expect(walls).toContain('#   refuse <extended-regex> | why this repo refuses it\n');
      expect(walls).toContain('#   allow   api\\.openai\\.com   | this coursework calls the provider directly on purpose\n');
      const std = readFileSync(join(t, '.claude/rules/project-standards.md'), 'utf8');
      expect(std.startsWith('---\nname: project-standards\npaths: ["**"]\nskills: []\nscripts: []\n---\n')).toBe(true);
      expect(std).toContain('Nothing here is enforced by the harness: no gate reads');
      // Now make them the repo's own and prove a redeploy keeps every byte.
      writeFileSync(join(t, '.claude/project-walls.conf'), 'refuse flyctl deploy | CI releases this\n');
      writeFileSync(join(t, '.claude/rules/project-standards.md'), '---\nname: project-standards\npaths: ["**"]\nskills: []\nscripts: []\n---\n# ours\n');
      envelope(ctxFor(mini, t), 'deploy', t);
      expect(readFileSync(join(t, '.claude/project-walls.conf'), 'utf8'))
        .toBe('refuse flyctl deploy | CI releases this\n');
      expect(readFileSync(join(t, '.claude/rules/project-standards.md'), 'utf8')).toContain('# ours\n');
    });
  });

  describe('the two child commands deploy shells out to', () => {
    it('reports the index build as SKIPPED and names the first two lines of why', () => {
      const t = scratch('dep-graph-fail');
      const d = drive(ctxFor(mini, t, { FAKE_GRAPH_FAIL: '1' }), 'deploy', [t], false);
      expect(d.rc).toBe(1);
      expect(d.io.stdout).toContain('  SKIPPED   governance/code-graph.json — not built\n');
      // `head -2 | tr '\n' ' '` keeps the SECOND line's newline and maps it to
      // a space, so the detail carries two spaces before the em-dash. Bash
      // does this; the port reproduces it rather than tidying it.
      const { env } = envelope(ctxFor(mini, t, { FAKE_GRAPH_FAIL: '1' }), 'deploy', t);
      expect(detail(env, 'code-graph-built')).toBe(
        `the code index was NOT built into ${t}: graph code: error: no grammars in this checkout second line of the failure  — every scrumux graph code query there will say it has no index. Build it from any harness checkout that has the tree-sitter grammars: scrumux graph code build --repo ${t}`,
      );
    });

    it('says BUILT with the first line of the child\'s report when it succeeds', () => {
      const t = scratch('dep-graph-ok');
      const d = drive(ctxFor(mini, t), 'deploy', [t], false);
      expect(d.io.stdout).toContain('  BUILT     governance/code-graph.json — \n');
      const { env } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(detail(env, 'code-graph-built')).toBe(
        `the code index was built into ${t} from this checkout, so every scrumux graph code query there answers with no parser of its own`,
      );
    });

    it('quotes the first THREE FAIL/WARN lines of a red records check, each semicolon-terminated', () => {
      const t = scratch('dep-records-fail');
      const { env, rc } = envelope(ctxFor(mini, t, { FAKE_RECORDS_FAIL: '1' }), 'deploy', t);
      expect(rc).toBe(1);
      expect(detail(env, 'records-check')).toBe(
        `exited 1 against ${t} — the install is NOT good; run GOV_ROOT=${t} ${process.execPath} ${defaultTsCli()} records check and fix each named finding. First lines:   FAIL roster-sweep one;  WARN prose two;  FAIL third row;`,
      );
      expect(env.summary).toContain('The install FAILED its checks');
    });
  });

  it('names a hook command whose file a rename left behind, without rewriting it', () => {
    const t = scratch('dep-deadhook');
    mkdirSync(join(t, '.claude'), { recursive: true });
    const s = miniSettings();
    s.hooks!.SessionStart = [{
      matcher: 'startup|resume',
      hooks: [
        { type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/scripts/gone-in-a-rename' },
        // An ABSOLUTE path outside the target is shown in full — only a path
        // under the target is shortened, and the two arms print differently.
        { type: 'command', command: '/opt/nowhere/outside-hook.sh --flag' },
      ],
    }];
    s.permissions = { allow: ['Bash(mini-canon:*)', 'Read(//tmp/**)'] };
    writeJson(join(t, '.claude/settings.json'), s);
    const before = readFileSync(join(t, '.claude/settings.json'), 'utf8');
    const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
    expect(rc).toBe(1);
    expect(detail(env, 'settings-hook-commands')).toContain(
      'declares hook command(s) naming a file that is not there: .claude/scripts/gone-in-a-rename /opt/nowhere/outside-hook.sh — every event on those chains fails silently',
    );
    expect(readFileSync(join(t, '.claude/settings.json'), 'utf8')).toBe(before);
  });

  it('says how many files a deploy left uncommitted, because a dirty checkout refuses a merge', () => {
    const t = scratch('dep-dirty');
    execFileSync('git', ['init', '-q', '.'], { cwd: t });
    const { env } = envelope(ctxFor(mini, t), 'deploy', t);
    expect(env.summary).toMatch(
      new RegExp(`${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} now has \\d+ uncommitted file\\(s\\)\\. \`deliver\` refuses a dirty checkout, so commit them before accepting or dispatching work there\\.$`),
    );
  });

  it('says nothing about git when the target is not a checkout', () => {
    const t = scratch('dep-nogit');
    const { env } = envelope(ctxFor(mini, t), 'deploy', t);
    expect(env.summary).not.toContain('uncommitted file(s)');
  });

  it('leaves a manifest-claimed path that is ALREADY gone alone, silently', () => {
    const t = deployMini(mini);
    const man = readJson(join(t, '.claude/DEPLOYED'));
    (man['files'] as Record<string, string>)['.claude/scripts/vanished-long-ago'] = '0'.repeat(64);
    writeJson(join(t, '.claude/DEPLOYED'), man);
    const { env } = envelope(ctxFor(mini, t), 'deploy', t);
    // No REMOVED item: the prune reports what it removed, and it removed
    // nothing. The path is simply absent from the new manifest.
    expect(env.items.some((i) => i.status === 'REMOVED')).toBe(false);
    expect(readJson(join(t, '.claude/DEPLOYED'))['files'])
      .not.toHaveProperty('.claude/scripts/vanished-long-ago');
  });

  it.each([
    ['a files map that is a list', '{"files": ["a"]}\n'],
    ['a files map that is a scalar', '{"files": 5}\n'],
    ['a manifest that does not parse', '{ nope\n'],
  ])('prunes NOTHING when the previous manifest is %s', (_label, body) => {
    // The prune only ever removes what a READABLE previous manifest claims.
    // An unreadable one is read as claiming nothing, which is the safe answer:
    // deleting on a guess is how a seeding lane once lost a repo's standards.
    const t = deployMini(mini);
    writeFileSync(join(t, '.claude/scripts/would-be-pruned'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(t, '.claude/DEPLOYED'), body);
    const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
    expect(rc).toBe(0);
    expect(env.items.some((i) => i.status === 'REMOVED')).toBe(false);
    expect(readFileSync(join(t, '.claude/scripts/would-be-pruned'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    // The manifest is REWRITTEN whatever state it was in, never merged.
    expect(Object.keys(readJson(join(t, '.claude/DEPLOYED'))['files'] as object)).toHaveLength(MINI_ROSTER);
  });

  it('says nothing when a prune it wanted to make is refused by the filesystem', () => {
    if (AS_ROOT) return;
    // `rm -f … && { item …; PRUNED=$((PRUNED+1)); }` — the report is INSIDE
    // the `&&`, so a removal that fails is not reported as one that happened.
    const t = deployMini(mini);
    writeFileSync(join(t, '.claude/rules/zz-retired'), 'an older payload file\n');
    const man = readJson(join(t, '.claude/DEPLOYED'));
    (man['files'] as Record<string, string>)['.claude/rules/zz-retired'] = '0'.repeat(64);
    writeJson(join(t, '.claude/DEPLOYED'), man);
    chmodSync(join(t, '.claude/rules'), 0o555);
    try {
      const { env, rc } = envelope(ctxFor(mini, t), 'deploy', t);
      expect(rc).toBe(0);
      expect(env.items.some((i) => i.path === '.claude/rules/zz-retired')).toBe(false);
      expect(env.summary).toContain('nothing changed');
    } finally {
      chmodSync(join(t, '.claude/rules'), 0o755);
    }
    expect(readFileSync(join(t, '.claude/rules/zz-retired'), 'utf8')).toBe('an older payload file\n');
  });

  describe('the refusals when the target will not take the payload', () => {
    it('refuses when a payload directory cannot be created', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      rmSync(join(t, '.claude/rules'), { recursive: true, force: true });
      chmodSync(join(t, '.claude'), 0o555);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr).toContain(`cannot create ${t}/.claude/rules — check the target's permissions`);
      } finally {
        chmodSync(join(t, '.claude'), 0o755);
      }
    });

    it('refuses when a payload file cannot be installed', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      rmSync(join(t, '.claude/rules/harness-is-upstream.md'), { force: true });
      chmodSync(join(t, '.claude/rules'), 0o555);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr)
          .toContain(`cannot install .claude/rules/harness-is-upstream.md into ${t} — check the target's permissions`);
      } finally {
        chmodSync(join(t, '.claude/rules'), 0o755);
      }
    });

    it.each([
      ['read-only', 0o444],
      // 0o000 also makes the BYTE comparison itself fail; an unreadable file
      // is treated as different rather than as equal, so the run tries the
      // install and refuses there instead of quietly calling it UNCHANGED.
      ['unreadable', 0o000],
    ])('refuses when a drifted payload file is %s', (_label, mode) => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      const p = join(t, '.claude/rules/harness-is-upstream.md');
      writeFileSync(p, 'drifted\n');
      chmodSync(p, mode);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr)
          .toContain(`cannot update .claude/rules/harness-is-upstream.md in ${t} — check the target's permissions`);
      } finally {
        chmodSync(p, 0o644);
      }
    });

    it('refuses when settings.json cannot be installed at the root', () => {
      if (AS_ROOT) return;
      const t = deployMini(mini);
      rmSync(join(t, '.claude/settings.json'), { force: true });
      chmodSync(join(t, '.claude'), 0o555);
      try {
        const d = drive(ctxFor(mini, t), 'deploy', [t], false);
        expect(d.rc).toBe(2);
        expect(d.io.stderr)
          .toContain(`cannot install .claude/settings.json into ${t} — check the target's permissions`);
      } finally {
        chmodSync(join(t, '.claude'), 0o755);
      }
    });
  });
});

// --------------------------------------------------------------------------
// 3. verify, over the synthetic harness. The reason this file exists.
// --------------------------------------------------------------------------

describe('harness verify over a synthetic target', () => {
  let mini: Mini;
  let golden: string;
  beforeAll(() => {
    mini = mkMini();
    golden = deployMini(mini);
  });

  /** A fresh copy of the deployed tree, ready to be broken one way. */
  function caseTree(tag: string): string { return clone(golden, tag); }

  it('calls a fully deployed target INSTALLED, with every check saying what it saw', () => {
    const t = caseTree('ver-clean');
    const d = drive(ctxFor(mini, t), 'verify', [t], false);
    expect(d.rc).toBe(0);
    expect(d.io.stdout).toContain(`=== HARNESS VERIFY -> ${t} (${TODAY}) ===`);
    expect(d.io.stdout).toContain(
      `harness verify: ${t} is INSTALLED — 10/10 checks pass. Installed is not live: whether these hooks fire is decided by the project root a session was LAUNCHED with, which nothing inside it can change.`,
    );

    const { env } = envelope(ctxFor(mini, t), 'verify', t);
    expect(env.checks.map((c) => c.name)).toEqual([
      'settings-at-root', 'settings-parses', 'hook-chains', 'hooks-executable',
      'scripts-roster', 'journals', 'journal-schemas', 'surfaces-run',
      'machinery-orphans', 'machinery-drift',
      // SX-008/D-S019: two ADVISORY rows after the checks. They never count
      // toward 10/10 and never move the exit code.
      'session-trust', 'session-write-tools',
    ]);
    expect(env.checks.every((c) => c.ok)).toBe(true);
    expect(env.target).toBe(t);
    expect(detail(env, 'settings-at-root'))
      .toBe(`settings.json is at the repo root (${t}/.claude/settings.json), which is where Claude Code resolves it at launch`);
    expect(detail(env, 'settings-parses')).toBe('valid JSON');
    expect(detail(env, 'hook-chains'))
      .toBe('all 4 chains declared: PreToolUse:Bash|PowerShell PreToolUse:Read PreToolUse:Edit|Write|NotebookEdit SessionStart');
    // The platform word is INTERPOLATED, not spelled: this suite runs on macOS
    // and on Linux in CI, and pinning "darwin" would make the Linux lane red
    // for a true statement.
    expect(detail(env, 'hooks-executable'))
      .toBe(`every hook declared in settings.json resolves and can start on this platform (${process.platform})`);
    expect(detail(env, 'scripts-roster')).toBe(`all ${MINI_ROSTER} payload file(s) present`);
    expect(detail(env, 'journals')).toBe('all 8 journal skeleton(s) present');
    expect(detail(env, 'journal-schemas')).toBe(`schema sweep clean against ${t}/governance`);
    expect(detail(env, 'machinery-orphans'))
      .toBe('no unclaimed machinery under .claude/scripts or .claude/dist (an unclaimed schema is variance, reported with machinery-drift)');
    expect(detail(env, 'machinery-drift'))
      .toBe(`all ${MINI_ROSTER} installed file(s) match .claude/DEPLOYED byte for byte`);
  });

  it('EXECUTES all 25 registered surfaces, with no exemptions left to declare', () => {
    // I-0104: presence checks can only confirm the copy happened. This is the
    // only check in the verb that is a statement about behaviour, so the pass
    // detail has to name every surface it actually ran.
    //
    // NO EXEMPTIONS LEFT. `lib.sh` and `lib/` were bash's sourced library and
    // noun modules — the two things a payload could ship that were scripts
    // without being commands. The retired payload ships one script, the CLI
    // entry itself, so every shipped command carries a probe and none needs
    // an exemption to explain why it does not.
    const t = caseTree('ver-surfaces');
    const { env } = envelope(ctxFor(mini, t), 'verify', t);
    const d = detail(env, 'surfaces-run');
    expect(d.startsWith(`all 25 registered surface(s) executed in ${t} and answered:`)).toBe(true);
    expect(d).toContain(' scrumux-help backlog decide epic feature graph-code graph-gov harness health issue log memory rank records repair secret session sprint status story task-usage task-lint task-verify task-brief views.');
    expect(d).toContain('Declared exemptions: none — every shipped command carries a probe');
  });

  /**
   * Check 1b. The verb's header has always stated that Claude Code resolves
   * the project root ONCE at launch, and the verb only ever applied that to a
   * STRAY settings file — never to the session doing the verifying. In the
   * E2E audit an operator ran `rm -rf` inside a governed repo from a session
   * rooted elsewhere, no wall fired, and verify said 10/10 before and after.
   */
  describe('check 1b — the session doing the verifying', () => {
    it('WARNs when CLAUDE_PROJECT_DIR names another repo, and moves nothing', () => {
      const t = caseTree('ver-topo');
      const elsewhere = '/somewhere/else';
      const { env, rc } = envelope(ctxFor(mini, t, { CLAUDE_PROJECT_DIR: elsewhere }), 'verify', t);
      // P-01: an advisory prints and is invisible to the verdict.
      expect(rc).toBe(0);
      expect(env.ok).toBe(true);
      expect(row(env, 'session-topology').tier).toBe('warn');
      expect(row(env, 'session-topology').ok).toBe(true);
      expect(detail(env, 'session-topology')).toBe(
        `CLAUDE_PROJECT_DIR is ${elsewhere}, not ${t} — the session running this check resolved its project root elsewhere at launch, so the hook chains installed under ${t}/.claude/ are INERT FOR THIS SESSION: they are installed, and nothing here is running them. Claude Code resolves the project root ONCE, at launch, and cd never re-resolves it, so no command inside this session can turn them on — to work under them, launch a session with ${t} as the project root. Advisory: it says nothing about the install below, and never moves the exit code.`,
      );
      // It sits with check 1, because it is the other half of check 1's fact.
      expect(env.checks.map((c) => c.name)).toEqual([
        'settings-at-root', 'session-topology', 'settings-parses', 'hook-chains',
        'hooks-executable', 'scripts-roster', 'journals', 'journal-schemas',
        'surfaces-run', 'machinery-orphans', 'machinery-drift',
        'session-trust', 'session-write-tools',
      ]);
      // ELEVEN rows (plus the two SX-008 advisories), TEN checks. The denominator counts checks and nothing
      // else: an operator inside a session and one in a plain terminal are
      // owed the same number, and the README states it.
      expect(env.summary).toContain('10/10 checks pass');
    });

    it('says nothing when the session IS rooted at the target, or is not a session', () => {
      const t = caseTree('ver-topo-same');
      for (const env0 of [{ CLAUDE_PROJECT_DIR: t }, { CLAUDE_PROJECT_DIR: `${t}/` }, {}]) {
        const { env, rc } = envelope(ctxFor(mini, t, env0), 'verify', t);
        expect(rc).toBe(0);
        // A trailing slash is a spelling, not a different repo: an advisory
        // that fires on one is noise, and noise is how a real one is missed.
        expect(env.checks.map((c) => c.name)).not.toContain('session-topology');
      }
    });
  });

  describe('check 1 — root placement, the whole reason the verb exists', () => {
    it('names up to FIVE settings.json found deeper, and says why they are inert', () => {
      const t = caseTree('ver-stray');
      rmSync(join(t, '.claude/settings.json'), { force: true });
      // Six of them, so the `head -5` cap is visible; each must live under a
      // `.claude/` segment, which is what the find predicate tests.
      const strays: string[] = [];
      for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) {
        mkdirSync(join(t, `sub-${n}/.claude`), { recursive: true });
        const p = join(t, `sub-${n}/.claude/settings.json`);
        writeFileSync(p, '{}\n');
        strays.push(p);
      }
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      const d = detail(env, 'settings-at-root');
      expect(d.startsWith(`no .claude/settings.json at the repo ROOT ${t}, but one exists deeper: `)).toBe(true);
      const named = strays.filter((p) => d.includes(`${p} `));
      expect(named).toHaveLength(5);
      // `$STRAY` ends in its own space, so the em-dash clause lands two spaces
      // after the last path. That is bash's byte layout, reproduced.
      expect(d).toContain('  — a settings.json below the launch root is SILENTLY INERT');
      expect(d).toContain(`Move it: mv <that file> ${t}/.claude/settings.json`);
      // The three checks downstream of placement all decline to speak.
      for (const n of ['settings-parses', 'hook-chains', 'hooks-executable']) {
        expect(row(env, n).ok, n).toBe(false);
        expect(detail(env, n), n).toBe('not checked — no settings.json at the repo root');
      }
    });

    it('says the chains are ABSENT when there is no settings.json anywhere', () => {
      const t = caseTree('ver-nosettings');
      rmSync(join(t, '.claude/settings.json'), { force: true });
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      expect(detail(env, 'settings-at-root')).toBe(
        `no .claude/settings.json at the repo ROOT ${t} — every hook chain is absent. Install it: harness deploy ${t}`,
      );
      expect(env.summary).toBe(
        `harness verify: ${t} is NOT fully installed — 4 of 10 checks failed. Each FAIL line above names the fix.`,
      );
    });
  });

  describe('check 2/3 — the parse, and what jq -e treats as a failure', () => {
    it.each([
      ['unparseable text', '{ not json\n'],
      ['a whole-file null', 'null\n'],
      ['a whole-file false', 'false\n'],
    ])('treats %s as "not valid JSON"', (_label, body) => {
      // `jq -e .` exits non-zero on null and on false, so a settings.json
      // whose entire value is either lands in the same arm as a syntax error.
      const t = caseTree('ver-parse');
      writeFileSync(join(t, '.claude/settings.json'), body);
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      expect(row(env, 'settings-at-root').ok).toBe(true);
      expect(detail(env, 'settings-parses')).toBe(
        `${t}/.claude/settings.json is not valid JSON — Claude Code loads no hooks at all from an unparseable settings file; fix it (jq . ${t}/.claude/settings.json names the offending line)`,
      );
      expect(detail(env, 'hook-chains')).toBe('not checked — settings.json does not parse');
      // A file that does not parse declares no hooks, so nothing is unusable.
      expect(row(env, 'hooks-executable').ok).toBe(true);
      rmSync(t, { recursive: true, force: true });
    });

    it('names a deregistered chain and the exact way to copy it back', () => {
      const t = caseTree('ver-chain');
      const s = readJson(join(t, '.claude/settings.json')) as unknown as SettingsDoc;
      delete s.hooks!.SessionStart;
      writeJson(join(t, '.claude/settings.json'), s);
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      expect(detail(env, 'hook-chains')).toBe(
        `hook chain(s) absent: SessionStart — copy the missing chain(s) from ${mini.payload}/settings.json into ${t}/.claude/settings.json under .hooks (deploy will not merge for you); if the existing file has nothing worth keeping: cp ${mini.payload}/settings.json ${t}/.claude/settings.json`,
      );
    });
  });

  describe('check 4 — a hook that cannot start fails silently on every event', () => {
    it('prints the ls-style mode for a SHELL-form hook that lost its execute bit', () => {
      if (AS_ROOT) return;
      const t = caseTree('ver-hookmode');
      chmodSync(join(t, '.claude/dist/scrumux.mjs'), 0o644);
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      const d = detail(env, 'hooks-executable');
      // THREE of the four declared hooks are named, not four, and the one
      // that drops out is the point. All four resolve to the same gate.sh,
      // but the shell chain declares it in EXEC form — `node` plus the path —
      // and an exec-form script is READ by its interpreter, never executed by
      // the kernel, so its mode bit is not a prerequisite for anything. A
      // check that still demanded it there would be reporting a fault that
      // does not exist, which is the same class of error as the NTFS mode bit
      // this check stopped claiming.
      expect(d.split(`${t}/.claude/dist/scrumux.mjs(mode -rw-r--r--, not executable)`)).toHaveLength(4);
      expect(d).toContain('a hook that cannot start fails on every event it is wired to');
      expect(d).toContain('Claude Code treats it as NON-BLOCKING, so the tool call proceeds and the wall is silently open');
      // Losing the mode bit is not drift: the manifest hashes CONTENT.
      expect(row(env, 'machinery-drift').ok).toBe(true);
    });

    /**
     * THE FAILURE THIS CHECK EXISTED FOR ALL ALONG, now that it can see it.
     *
     * An exec-form hook is dead when its `command` is not on PATH — the shape
     * a stock Windows box has when `node` was never installed, and the shape
     * the old mode-bit test could not even express. Forced here by emptying
     * PATH rather than by uninstalling anything.
     */
    it('names an exec-form hook whose command does not resolve on PATH', () => {
      const t = caseTree('ver-hookpath');
      const { env, rc } = envelope(ctxFor(mini, t, { PATH: '' }), 'verify', t);
      expect(rc).toBe(1);
      expect(detail(env, 'hooks-executable'))
        .toContain("node(exec form: 'node' does not resolve to an executable on PATH here)");
    });

    it('says (missing) for a hook file that is gone', () => {
      const t = caseTree('ver-hookgone');
      rmSync(join(t, '.claude/dist/scrumux.mjs'), { force: true });
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      expect(detail(env, 'hooks-executable'))
        .toContain(`declared hook(s) unusable: ${t}/.claude/dist/scrumux.mjs(missing)`);
      // The same deletion is three other things at once, and each says so.
      expect(detail(env, 'scripts-roster')).toContain('.claude/dist/scrumux.mjs');
      expect(detail(env, 'machinery-drift')).toContain(`MISSING: .claude/dist/scrumux.mjs.`);
    });
  });

  describe('checks 5 and 6 — the roster and the journals', () => {
    it('counts the payload files that are absent and names each', () => {
      const t = caseTree('ver-roster');
      rmSync(join(t, '.claude/skills/mini/SKILL.md'), { force: true });
      rmSync(join(t, '.claude/dist/session-guard.mjs'), { force: true });
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      expect(detail(env, 'scripts-roster')).toBe(
        `2 of ${MINI_ROSTER} payload file(s) absent from ${t}: .claude/skills/mini/SKILL.md .claude/dist/session-guard.mjs — re-run harness deploy ${t}`,
      );
    });

    it('names absent journals in the roster\'s order, not the filesystem\'s', () => {
      const t = caseTree('ver-journals');
      rmSync(join(t, 'governance/sprints.json'), { force: true });
      rmSync(join(t, 'governance/log.json'), { force: true });
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      expect(detail(env, 'journals')).toBe(
        `journal(s) absent from ${t}/governance: log.json sprints.json — re-run harness deploy ${t}`,
      );
    });

    it('quotes the first three sweep findings, semicolon-joined, when a record breaks its contract', () => {
      const t = caseTree('ver-sweep');
      writeJson(join(t, 'governance/tasks.json'), { entries: [{ id: 'T-0001', not_a_field: 1 }] });
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      const d = detail(env, 'journal-schemas');
      expect(d.startsWith(`the schema sweep exited 1 against ${t}/governance: `)).toBe(true);
      // `head -3 | tr '\n' ';'` — three findings, each semicolon-terminated,
      // including the third, and the remedy names the SOURCE checkout's CLI
      // with GOV_ROOT pointed at the target.
      expect(d).toContain(
        "tasks.json T-0001 <root>: missing required 'title';tasks.json T-0001 <root>: missing required 'acceptance_check';tasks.json T-0001 <root>: missing required 'status'; — fix the record, or the schema if the contract genuinely changed",
      );
      expect(d).toContain(`run GOV_ROOT=${t} ${mini.scripts}/scrumux records check for the full list`);
    });
  });

  describe('check 8 — the surfaces actually run', () => {
    it('names every surface that refuses to run, with rc and first line', () => {
      const t = caseTree('ver-probefail');
      const { env, rc } = envelope(ctxFor(mini, t, { FAKE_PROBE_FAIL: '1' }), 'verify', t);
      expect(rc).toBe(1);
      const d = detail(env, 'surfaces-run');
      expect(d.startsWith(`registered surface(s) that do NOT run in ${t}; scrumux-help (.claude/scripts/scrumux help): rc 4, and this surface declares no refusal — its no-op must exit 0 | first line: surface exploded;`)).toBe(true);
      // Of the 25 surfaces, the five that DECLARE a refusal take the other
      // arm of the verdict table, because "surface exploded" is not the
      // refusal they declared — the other 20 take the generic arm.
      expect(d.split('rc 4, and this surface declares no refusal')).toHaveLength(21);
      expect(d).toContain('graph-code (.claude/scripts/scrumux graph code stats): rc 4 and the output does not match its declared refusal /graph code: error: no index at/ | first line: surface exploded');
      expect(d).toContain('task-lint (.claude/scripts/scrumux task lint): rc 4 and the output does not match its declared refusal /scrumux task lint: error: usage:/');
      expect(d).toContain('the machinery is installed but not usable there; run the argv shown from inside');
      expect(d).toContain('Declared exemptions: none');
    });

    it('fails on a shipped command no table decides about, and folds the probe failures in after', () => {
      // Coverage is DERIVED from the payload: a script neither probed nor
      // exempt is a surface nobody decided about, which is a failure rather
      // than a silence. It needs a source that ships one, so this case gets
      // its own miniature harness.
      const m2 = mkMini({ extraScripts: ['zz-undecided'] });
      const t = deployMini(m2);
      const { env, rc } = envelope(ctxFor(m2, t), 'verify', t);
      expect(rc).toBe(1);
      expect(detail(env, 'surfaces-run')).toBe(
        'shipped command(s) probed by nothing and declared exempt by nothing: .claude/scripts/zz-undecided — every payload script must carry a SURFACE_PROBES row (cheapest bounded non-mutating no-op) or a SURFACE_EXEMPT row stating why it has none; add it in the harness source at src/nouns/harness/payload.ts.',
      );
      // Both at once: the unprobed sentence keeps its full stop and the probe
      // failures are appended to it rather than replacing it.
      const { env: env2 } = envelope(ctxFor(m2, t, { FAKE_PROBE_FAIL: '1' }), 'verify', t);
      const d2 = detail(env2, 'surfaces-run');
      expect(d2).toContain('payload.ts. Also, probe failure(s); scrumux-help (.claude/scripts/scrumux help): rc 4');
    });
  });

  describe('machinery drift, answered from the target\'s own manifest and nothing else', () => {
    it('claims nothing either way when there is no manifest at all', () => {
      const t = caseTree('ver-noman');
      rmSync(join(t, '.claude/DEPLOYED'), { force: true });
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(0);
      expect(detail(env, 'machinery-drift')).toBe(
        `no .claude/DEPLOYED in ${t} — deployed before the manifest existed, so drift cannot be computed and is not being claimed either way; re-run harness deploy ${t} to start recording it`,
      );
      // With no manifest there is no orphan check either — the whole block is
      // skipped, so the run emits nine rows rather than ten.
      expect(env.checks.map((c) => c.name)).not.toContain('machinery-orphans');
      expect(env.summary).toBe(`harness verify: ${t} is INSTALLED — 9/9 checks pass. Installed is not live: whether these hooks fire is decided by the project root a session was LAUNCHED with, which nothing inside it can change.`);
    });

    it.each([
      ['unparseable', '{ nope\n'],
      ['a null files map', '{"files": null}\n'],
      ['no files key at all', '{"source_commit": "abc"}\n'],
      ['a false files map', '{"files": false}\n'],
    ])('refuses to read drift from a manifest that is %s', (_label, body) => {
      const t = caseTree('ver-badman');
      writeFileSync(join(t, '.claude/DEPLOYED'), body);
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      expect(detail(env, 'machinery-drift')).toBe(
        `${t}/.claude/DEPLOYED does not parse or carries no files map — the one record of what was installed is unreadable; re-run harness deploy ${t}`,
      );
      rmSync(t, { recursive: true, force: true });
    });

    it('reads a files map that is not an object as claiming NOTHING, which makes everything an orphan', () => {
      const t = caseTree('ver-arrayman');
      writeFileSync(join(t, '.claude/DEPLOYED'), '{"files": ["a", "b"]}\n');
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      expect(detail(env, 'machinery-drift')).toContain('all 0 installed file(s) match the manifest, except variance the target carries in rules, skills or schemas: ');
      expect(detail(env, 'machinery-drift')).toContain('.claude/schemas/task.schema.json (not in the manifest)');
      const orph = detail(env, 'machinery-orphans');
      expect(orph.startsWith(`${t} holds machinery the manifest does not claim:`)).toBe(true);
      // The CLI entry, seven dist bundles and nine schemas: everything under
      // the three machinery directories, since the map claims none of it.
      expect(orph).toContain(' .claude/scripts/scrumux');
      expect(orph).toContain(' .claude/dist/scrumux.mjs');
      // Schemas are variance since R-019 (D-S027), never orphans.
      expect(orph).not.toContain('.claude/schemas/');
      expect(orph).toContain('A stale command left by a rename still RUNS');
    });

    it('splits FROZEN machinery from TRACKED prose, and reports prose without failing', () => {
      const t = caseTree('ver-drift-split');
      writeFileSync(join(t, '.claude/dist/scrumux.mjs'), '// drifted\n');
      writeFileSync(join(t, '.claude/rules/harness-is-upstream.md'), '---\nname: harness-is-upstream\n---\nlocalised\n');
      rmSync(join(t, '.claude/schemas/sprint.schema.json'), { force: true });
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      const d = detail(env, 'machinery-drift');
      expect(d).toContain(`the machinery in ${t} no longer matches what was installed. CHANGED: .claude/dist/scrumux.mjs. MISSING: .claude/schemas/sprint.schema.json.`);
      // The manifest's own commit, cut to eight characters — 'unknown' here,
      // because the synthetic source is not a git checkout.
      expect(d).toContain('this repo was deployed from a different source (unknown)');
      expect(d).toContain('Rules, skills or schemas also vary: .claude/rules/harness-is-upstream.md — reported, not a failure.');
    });

    it('renders a manifest with no source_commit as "null", the way jq -r does', () => {
      const t = caseTree('ver-drift-nullcommit');
      const man = readJson(join(t, '.claude/DEPLOYED'));
      delete man['source_commit'];
      writeJson(join(t, '.claude/DEPLOYED'), man);
      writeFileSync(join(t, '.claude/dist/scrumux.mjs'), '// drifted\n');
      const { env } = envelope(ctxFor(mini, t), 'verify', t);
      expect(detail(env, 'machinery-drift')).toContain('deployed from a different source (null)');
    });

    it('PASSES with localised prose alone — D-0072 boundary 7, never blocking', () => {
      const t = caseTree('ver-drift-prose');
      writeFileSync(join(t, '.claude/rules/harness-is-upstream.md'), '---\nname: harness-is-upstream\n---\nours\n');
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(0);
      expect(detail(env, 'machinery-drift')).toBe(
        `all ${MINI_ROSTER} installed file(s) match the manifest, except variance the target carries in rules, skills or schemas: .claude/rules/harness-is-upstream.md — reported, never blocking (D-0072 boundary 7, R-019); these are where a repo or the operator's canon legitimately differs`,
      );
    });

    /**
     * R-019 (D-S027): an existing deployment whose schema was edited — the
     * operator's canon publish layering a schema over the CLI — is variance,
     * never tampering. A new schema the manifest never shipped is too. The
     * walls and the CLI bundle stay frozen beside it.
     */
    it('PASSES with an edited and an added schema in an existing deployment, and still FAILS a drifted bundle', () => {
      const t = caseTree('ver-drift-schema');
      writeFileSync(join(t, '.claude/schemas/task.schema.json'), '{"$comment":"canon edit"}\n');
      writeFileSync(join(t, '.claude/schemas/extra.schema.json'), '{}\n');
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(0);
      const d = detail(env, 'machinery-drift');
      expect(row(env, 'machinery-drift').ok).toBe(true);
      expect(d).toContain('.claude/schemas/task.schema.json');
      expect(d).toContain('.claude/schemas/extra.schema.json (not in the manifest)');
      expect(d).toContain('never blocking');
      expect(row(env, 'machinery-orphans').ok).toBe(true);

      writeFileSync(join(t, '.claude/dist/scrumux.mjs'), '// drifted\n');
      const second = envelope(ctxFor(mini, t), 'verify', t);
      expect(second.rc).toBe(1);
      expect(detail(second.env, 'machinery-drift')).toContain('CHANGED: .claude/dist/scrumux.mjs.');
      expect(detail(second.env, 'machinery-drift')).not.toContain('CHANGED: .claude/schemas');
    });

    it('skips an empty key in the files map without counting it', () => {
      const t = caseTree('ver-drift-emptykey');
      const man = readJson(join(t, '.claude/DEPLOYED'));
      (man['files'] as Record<string, string>)[''] = '0'.repeat(64);
      writeJson(join(t, '.claude/DEPLOYED'), man);
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(0);
      expect(detail(env, 'machinery-drift')).toBe(`all ${MINI_ROSTER} installed file(s) match .claude/DEPLOYED byte for byte`);
    });

    it('names unclaimed machinery under all four directories, and ignores the three noise names', () => {
      const t = caseTree('ver-orphans');
      writeFileSync(join(t, '.claude/scripts/zz-orphan'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(t, '.claude/scripts/zz-orphan'), 0o755);
      mkdirSync(join(t, '.claude/dist'), { recursive: true });
      // `.claude/dist` is on the list for the reason the other three are: a
      // bundle the manifest does not claim still RUNS.
      writeFileSync(join(t, '.claude/dist/stale.mjs'), 'export {};\n');
      // The three that are stepped over: compiled Python, the Finder's
      // droppings, and anything inside a __pycache__ directory.
      writeFileSync(join(t, '.claude/dist/gate.pyc'), 'x\n');
      writeFileSync(join(t, '.claude/schemas/.DS_Store'), 'x\n');
      mkdirSync(join(t, '.claude/scripts/__pycache__'), { recursive: true });
      writeFileSync(join(t, '.claude/scripts/__pycache__/mod.cpython-311.pyc'), 'x\n');
      writeFileSync(join(t, '.claude/scripts/__pycache__/notes.txt'), 'x\n');
      const { env, rc } = envelope(ctxFor(mini, t), 'verify', t);
      expect(rc).toBe(1);
      const d = detail(env, 'machinery-orphans');
      expect(d.startsWith(`${t} holds machinery the manifest does not claim: .claude/scripts/zz-orphan .claude/dist/stale.mjs.`)).toBe(true);
      expect(d).not.toContain('.pyc');
      expect(d).not.toContain('.DS_Store');
      expect(d).not.toContain('__pycache__');
      // Schemas left this list with R-019 (D-S027): an unclaimed schema is variance.
      expect(d).toContain('.claude/scripts and .claude/dist are the harness\'s.');
      // The orphans are not drift: every file the manifest DOES claim matches.
      expect(row(env, 'machinery-drift').ok).toBe(true);
    });
  });
});

// --------------------------------------------------------------------------
// 4. The noun seam's last arm, and the helper corners the verbs lean on.
// --------------------------------------------------------------------------

describe('the noun seam', () => {
  it('refuses an unsearchable target with bash\'s EMPTY target name', () => {
    if (AS_ROOT) return;
    // `TARGET=$(CDPATH='' cd -- "$TARGET" && pwd) || die "cannot resolve
    // $TARGET …"` — the assignment has ALREADY happened with the empty
    // substitution by the time the `||` arm runs, so bash names nothing and
    // the message carries two spaces. Reproduced as-is; a "fix" here is a
    // parity break.
    const t = scratch('seam-noexec');
    const d = join(t, 'locked');
    mkdirSync(d);
    chmodSync(d, 0o000);
    try {
      const io = captureIo();
      const cli = new Cli('harness verify', [d], false, io);
      let rc = -1;
      try {
        MODULE.run(cli, {
          roots: { root: t, gov: join(t, 'governance'), workRoot: t },
          today: TODAY, io, cwd: t, scriptsDir: join(t, '.claude/scripts'),
        }, 'verify', [d]);
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
        rc = e.code;
      }
      expect(rc).toBe(2);
      expect(io.stderr).toBe('scrumux harness verify: error: cannot resolve  — check the path and its permissions\n');
    } finally {
      chmodSync(d, 0o755);
    }
  });
});

describe('the helper corners the two verbs depend on', () => {
  it('sealQuiet answers EMPTY where bash\'s pipeline prints nothing', () => {
    // `shasum … | awk` on an unreadable file prints nothing and still exits 0,
    // so `$(seal_of …)` is the empty string — never equal to a real hash, so
    // a file in this state reads as drift rather than as a match.
    expect(sealQuiet(join(tmpdir(), 'scrumux-hE-definitely-absent'))).toBe('');
  });

  it('spawnCombinedWith reports 127 when the child cannot start at all', () => {
    const r = spawnCombinedWith('true', [], { cwd: '/no/such/directory/anywhere' });
    expect(r.rc).toBe(127);
    expect(r.combined).toBe('');
  });

  it('gitOut is null outside a checkout and on a command git refuses', () => {
    const d = scratch('helper-git');
    expect(gitOut(d, ['rev-parse', 'HEAD'])).toBeNull();
    execFileSync('git', ['init', '-q', '.'], { cwd: d });
    // Initialised, but with no commit: `rev-parse HEAD` still exits non-zero.
    expect(gitOut(d, ['rev-parse', 'HEAD'])).toBeNull();
    expect(gitOut(d, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
  });

  it('the payload walk answers EMPTY for a directory that is absent or unreadable', () => {
    const d = scratch('helper-walk');
    expect(payloadFiles('never-existed', d, [])).toEqual([]);
    // No payload-exclude.list: the absent-file arm, which is the shape every
    // synthetic source in this file relies on.
    expect(loadExcludeRules(d)).toEqual([]);
    if (AS_ROOT) return;
    const locked = join(d, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'f'), 'x\n');
    chmodSync(locked, 0o000);
    try {
      // find prints an error and moves on; the roster simply sees nothing.
      expect(walkLikeFind(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('the settings inspectors keep bash\'s empty answer over the shapes jq errors on', () => {
    // Not restated from wave 4H: these are the CONTAINER shapes (a chain that
    // is a scalar, a chain that is an object rather than an array), which the
    // existing suite does not reach.
    expect(missingChains({ hooks: { PreToolUse: 'not iterable' } })).toBe('');
    // `[]` over an object iterates its VALUES, so an object-shaped chain is
    // read, not refused.
    expect(missingChains({
      hooks: {
        PreToolUse: {
          one: { matcher: 'Bash|PowerShell' }, two: { matcher: 'Read' }, three: { matcher: 'Edit' },
        },
        SessionStart: { only: { matcher: 'resume' } },
      },
    })).toBe('');
    expect(hookTargets({ hooks: { PreToolUse: { a: { hooks: { z: { command: 'x.sh' } } } } } })
      .map((t) => t.file)).toEqual(['x.sh']);
    // `.type // "command"` — an explicit false is "no type", so the entry is
    // still a command; a non-string command is stringified rather than dropped.
    expect(hookTargets({ hooks: { S: [{ hooks: [{ type: false, command: 7 }] }] } })
      .map((t) => t.file)).toEqual(['7']);
    // `.value[]?` skips a chain that is a scalar without failing the rest.
    expect(hookTargets({ hooks: { A: 3, B: [{ hooks: [{ command: 'b.sh' }] }] } })
      .map((t) => t.file)).toEqual(['b.sh']);
  });
});

// --------------------------------------------------------------------------
// The two post-install checks (`code-graph-built`, `records-check`) — both
// re-invoke this bundle natively (`selfBundle` + `process.execPath`) now that
// bash is retired. There is one lane, not a shell-vs-native choice.
// --------------------------------------------------------------------------

describe('deploy\'s post-install checks (selfBundle)', () => {
  let mini: Mini;
  let tsCli: string;

  beforeAll(() => {
    mini = mkMini();
    tsCli = join(scratch('tscli'), 'scrumux.mjs');
    writeFileSync(tsCli, FAKE_TS_CLI);
  });

  it('selfBundle prefers the named override and refuses one that is not there', () => {
    expect(selfBundle({ SCRUMUX_SELF: tsCli })).toBe(tsCli);
    expect(selfBundle({ SCRUMUX_SELF: join(tsCli, 'nope.mjs') })).toBeNull();
    // No override: `process.argv[1]`, which under vitest is a real file. The
    // VALUE is the runner, which is exactly why the override exists.
    expect(selfBundle({})).toBe(process.argv[1]);
    expect(selfBundle({ SCRUMUX_SELF: '' })).toBe(process.argv[1]);
  });

  it('a perfect install passes, with the two child-answered checks named plainly', () => {
    const t = scratch('tgt-ok');
    const { env, rc } = envelope(ctxFor(mini, t, { SCRUMUX_SELF: tsCli }), 'deploy', t);
    expect(rc, JSON.stringify(env.checks.filter((c) => !c.ok))).toBe(0);
    expect(detail(env, 'records-check')).toBe(`clean against ${t}`);
    expect(detail(env, 'code-graph-built')).toBe(
      `the code index was built into ${t} from this checkout, so every scrumux graph code query there answers with no parser of its own`,
    );
  });

  it('a FAILING check names a command that can actually be re-run', () => {
    const t = scratch('tgt-red');
    const { env, rc } = envelope(ctxFor(mini, t, { SCRUMUX_SELF: tsCli, FAKE_TS_FAIL: '1' }), 'deploy', t);
    expect(rc).toBe(1);
    expect(row(env, 'records-check').ok).toBe(false);
    expect(detail(env, 'records-check')).toContain('exited 5');
    expect(detail(env, 'records-check')).toContain('FAIL made-up-row from the bundle;');
    expect(detail(env, 'records-check')).toContain(`${process.execPath} ${tsCli} records check`);
  });

  it('no bundle to re-run: the check does not run, and says so rather than lying', () => {
    const t = scratch('tgt-nothing');
    const { env, rc } = envelope(ctxFor(mini, t, { SCRUMUX_SELF: join(tsCli, 'gone.mjs') }), 'deploy', t);
    expect(rc).toBe(1);
    for (const name of ['code-graph-built', 'records-check']) {
      expect(row(env, name).ok, name).toBe(false);
      expect(detail(env, name), name).toContain('no bundle path to re-run the check');
      expect(detail(env, name), name).toContain('the check did not run at all');
    }
  });
});
