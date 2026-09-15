#!/usr/bin/env node
/**
 * The end-to-end Windows story, in one script that runs anywhere.
 *
 *   node tools/ci/smoke.mjs
 *
 * WHY THIS EXISTS SEPARATELY FROM VITEST. The Windows lane runs the subset of
 * the vitest suite that needs no POSIX (tools/ci/posix-partition.mjs), and
 * that subset is unit-shaped by construction: it proves the FUNCTIONS behave.
 * It cannot prove that a person on a Windows box, with no shell, can run the
 * built CLI against a real repo and get a governance answer out of it. That
 * is a process boundary, so it needs a process.
 *
 * EVERY STEP DRIVES A BUILT BUNDLE, never a source module. If the bundle is
 * broken, minified wrong, or references a POSIX path that only resolves on
 * the machine that built it, this is where it shows.
 *
 * NO SHELL, ANYWHERE. Every spawn is `execPath` or `git` with an argv array
 * and `shell: false`. A smoke test that reaches for `sh -c` to save three
 * lines has smoke-tested the thing it was supposed to prove was unnecessary.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, '.deploy-claude', 'dist');
const CLI = join(DIST, 'scrumux.mjs');
const WALLS = ['block-destructive', 'block-secret-reads', 'block-upstream-edit', 'block-direct-llm'];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  }
}

/** node <bundle> <argv...>, no shell, cwd and env explicit. */
function node(args, opts = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    shell: false,
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
  });
  return { rc: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '', error: r.error };
}

/**
 * git with the AMBIENT CONFIG NEUTRALISED. A developer's ~/.gitconfig can
 * carry commit signing, a default branch name, or hooks; a CI runner carries
 * none of it. Passing the three that matter as `-c` makes the fixture repo
 * the same repo on every box, which is the only reason the fixture is worth
 * anything. (An ssh-backed `commit.gpgsign` in a developer's global config can
 * make the fixture commit fail on that one machine and nowhere else.)
 */
function git(args, cwd) {
  const neutral = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main'];
  return spawnSync('git', [...neutral, ...args], { encoding: 'utf8', shell: false, cwd });
}

console.log(`scrumux smoke — ${process.platform}/${process.arch}, node ${process.version}`);
console.log('');

// ---------------------------------------------------------- the bundles ---
console.log('=== the build products are on disk ===');
check(
  'the CLI bundle exists',
  existsSync(CLI),
  `${CLI} is absent — run \`npm run build\` before the smoke`,
);
for (const w of WALLS) {
  check(`the ${w} bundle exists`, existsSync(join(DIST, `${w}.mjs`)), `${w}.mjs is absent`);
}
check('BUILD.json exists', existsSync(join(DIST, 'BUILD.json')), 'no BUILD.json — the hash map the verify verb reads');

if (fail > 0) {
  console.log('');
  console.log('smoke: refusing to continue — the bundles are not built.');
  process.exit(1);
}

// ------------------------------------------------------------ the verbs ---
console.log('');
console.log('=== the CLI answers, driven as a process ===');
{
  const v = node([CLI, 'version']);
  check('`version` exits 0', v.rc === 0, `rc=${v.rc} ${v.err}`);
  check('`version` prints the contract version', /^scrumux\.cli\/\d+/.test(v.out.trim()), JSON.stringify(v.out));

  const h = node([CLI, 'help']);
  check('`help` exits 0', h.rc === 0, `rc=${h.rc} ${h.err}`);
  check('`help` prints the usage block', h.out.includes('usage: scrumux'), JSON.stringify(h.out.slice(0, 120)));
}

// ------------------------------------------------------- a fixture repo ---
console.log('');
console.log('=== a real repo: deploy, then answer about it ===');
const work = mkdtempSync(join(tmpdir(), 'scrumux-smoke-'));
let deployed = false;
try {
  const gi = git(['init', '-q', '.'], work);
  check('git init succeeds', gi.status === 0, gi.stderr);
  git(['config', 'user.email', 'smoke@example.invalid'], work);
  git(['config', 'user.name', 'smoke'], work);
  writeFileSync(join(work, 'README.md'), 'smoke\n');
  git(['add', '-A'], work);
  const gc = git(['commit', '-q', '-m', 'init'], work);
  check('git commit succeeds', gc.status === 0, gc.stderr);

  const d = node([CLI, 'harness', 'deploy', '.'], { cwd: work });

  /**
   * A FLAT ASSERTION: a perfect install exits 0, with no shell anywhere.
   * `harness deploy`'s two post-install checks -- `code-graph-built` and
   * `records-check` -- answer through a self-invocation of this same bundle
   * (`postInstall` in src/nouns/harness/deploy.ts), never through a shell, so
   * there is no with-shell/without-shell case to carve out: the exit code is
   * asserted outright on every platform.
   *
   * The failing-check names are still collected and printed, because `rc=1`
   * on its own does not say WHICH check moved.
   */
  /**
   * THE WHOLE FAIL LINE, not just the check's name.
   *
   * `cli.fail(name, detail)` renders as `  FAIL <name padded> <detail>` on ONE
   * line of stdout, and the detail is the only thing that says WHY -- for
   * `code-graph-built` it carries the first two lines of the builder child's
   * combined output, which is the difference between "the grammars would not
   * load", "the index would not write" and "the parse produced errors".
   * Capturing only `d.err` would lose that: the deciding evidence for a
   * post-install failure is in `d.out`. On a CI lane nobody can reproduce
   * locally, the log IS the instrument.
   */
  const failLines = [...`${d.out}\n${d.err}`.matchAll(/^ *FAIL +(\S+) *(.*)$/gm)]
    .map((m) => ({ name: m[1], detail: m[2].trim() }));
  const failedChecks = failLines.map((f) => f.name);
  const why = failLines.map((f) => `\n  - ${f.name}: ${f.detail}`).join('') || ' (none named)';
  check(
    '`harness deploy .` exits 0 — every check included, with or without a shell',
    d.rc === 0,
    `rc=${d.rc}, failing checks:${why}\n${d.err}`,
  );
  check(
    'the two post-install checks PASS with no POSIX shell on the box',
    !failedChecks.includes('code-graph-built') && !failedChecks.includes('records-check'),
    `failing:${why}`,
  );

  deployed = existsSync(join(work, '.claude', 'DEPLOYED'));
  check(
    'the payload landed under .claude/',
    existsSync(join(work, '.claude', 'DEPLOYED')) && existsSync(join(work, '.claude', 'dist', 'scrumux.mjs')),
    'no .claude/DEPLOYED or no .claude/dist/scrumux.mjs',
  );
  check(
    'the governance journals were seeded',
    existsSync(join(work, 'governance', 'tasks.json')),
    'governance/tasks.json absent after deploy',
  );

  const s = node([CLI, 'status', 'session', '--json'], { cwd: work });
  check('`status session --json` exits 0', s.rc === 0, `rc=${s.rc}\n${s.err}`);
  let env0 = null;
  try {
    env0 = JSON.parse(s.out);
  } catch (e) {
    check('`status session --json` emits ONE parseable object', false, `${e}\n${s.out.slice(0, 300)}`);
  }
  if (env0) {
    check('the envelope carries the contract schema', env0.schema === 'scrumux.cli/1', JSON.stringify(env0.schema));
    check('the envelope names the command', env0.command === 'status session', JSON.stringify(env0.command));
    check('the envelope reports ok', env0.ok === true, JSON.stringify({ ok: env0.ok, exit: env0.exit }));
    check(
      'the brief actually says something',
      Array.isArray(env0.data?.lines) && env0.data.lines.length > 0,
      JSON.stringify(env0.data).slice(0, 200),
    );
  }

  // A refusal is product surface (Article 5), and its exit code is the
  // contract every caller reads first. Windows must not turn 2 into 1. Run
  // INSIDE the fixture repo: from this checkout the `.scrumux-ungoverned`
  // marker refuses first, correctly, and that refusal is a different one.
  const u = node([CLI, 'nosuchnoun', 'nosuchverb'], { cwd: work });
  check('an unknown noun refuses at exit 2', u.rc === 2, `rc=${u.rc}`);
  check(
    'the refusal names the next action',
    /see:|scrumux help/.test(u.err + u.out),
    JSON.stringify((u.err + u.out).slice(0, 200)),
  );

  // ------------------------------------------ the write path, and its bytes
  // JOURNAL BYTE FIDELITY. jqformat's contract is LF-only, always -- existing
  // deployed repos' content seals were computed over jq-shaped bytes, and jq
  // never emits a CR. A single CR anywhere -- from an editor, from git's
  // autocrlf, or from a formatter reaching for os.EOL -- makes a journal's
  // seal check a false red on Windows and only on Windows. This is the
  // cheapest place to catch it: right after the process that wrote it.
  const w = node([CLI, 'log', 'new', '--title', 'smoke', '--did', 'ran tools/ci/smoke.mjs'], { cwd: work });
  check('`log new` exits 0', w.rc === 0, `rc=${w.rc}\n${w.err}`);

  const govDir = join(work, 'governance');
  const jsons = existsSync(govDir) ? readdirSync(govDir).filter((n) => n.endsWith('.json')) : [];
  check('there are journals to inspect', jsons.length > 0, 'governance/ has no .json');
  const crlf = [];
  for (const n of jsons) {
    const bytes = readFileSync(join(govDir, n));
    if (bytes.includes(0x0d)) crlf.push(n);
  }
  check(
    'NO journal carries a CR byte — jqformat is LF-only on every platform',
    crlf.length === 0,
    `CR found in: ${crlf.join(', ')}`,
  );

  const logJson = join(govDir, 'log.json');
  if (existsSync(logJson)) {
    const bytes = readFileSync(logJson);
    check('the log journal ends with exactly one LF', bytes[bytes.length - 1] === 0x0a, `last byte 0x${bytes[bytes.length - 1]?.toString(16)}`);
    let doc = null;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
      check('the log journal is parseable JSON after the write', false, String(e));
    }
    if (doc) check('the write is in the journal', JSON.stringify(doc).includes('smoke'), 'the new entry is not there');
  }
} finally {
  // ------------------------------------------------------------ the walls --
  // Run BEFORE the temp tree goes, because two of the four walls consult the
  // deployed conf and a wall asked about a tree that is not there is not the
  // wall an operator runs.
  console.log('');
  console.log('=== a wall bundle, fed a hook payload on stdin ===');
  if (deployed) {
    const payload = JSON.stringify({ tool_input: { command: 'rm -rf /Users/somebody/data' } });
    const r = node([join(DIST, 'block-destructive.mjs')], { input: payload, env: { GOV_ROOT: work }, cwd: work });
    check('the destructive wall BLOCKS an unscoped recursive delete', r.rc === 2, `rc=${r.rc}\n${r.err}`);
    check('the block names what it refused', r.err.length > 0, 'the wall blocked SILENTLY, which is a defect on its own');

    const ok = JSON.stringify({ tool_input: { command: 'ls -la' } });
    const a = node([join(DIST, 'block-destructive.mjs')], { input: ok, env: { GOV_ROOT: work }, cwd: work });
    check('the destructive wall ALLOWS an ordinary command', a.rc === 0, `rc=${a.rc}\n${a.err}`);

    const secret = JSON.stringify({ tool_input: { command: 'cat .env' } });
    const sr = node([join(DIST, 'block-secret-reads.mjs')], { input: secret, env: { GOV_ROOT: work }, cwd: work });
    check('the secret-reads wall BLOCKS a .env read', sr.rc === 2, `rc=${sr.rc}\n${sr.err}`);
  } else {
    check('the walls were exercised', false, 'the fixture repo never deployed, so the wall round did not run');
  }

  // Cleanup NEVER decides the verdict. Windows marks git's object files
  // read-only and holds handles a moment after the child exits, so an EPERM
  // or EBUSY here is a tidiness problem in a directory the runner throws away
  // anyway -- and a smoke test that goes red because it could not delete its
  // own scratch dir is reporting on the wrong thing entirely.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (e) {
    console.log(`  note  could not remove the scratch tree ${work}: ${e.code ?? e}`);
  }
}

console.log('');
console.log(`smoke: ${pass} passed, ${fail} failed on ${process.platform}`);
if (fail > 0) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
// A green over zero checks is the one result this file must never produce.
if (pass === 0) {
  console.log('smoke: ZERO checks ran — that is not a pass');
  process.exit(2);
}
