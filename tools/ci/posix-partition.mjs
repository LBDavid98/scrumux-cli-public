#!/usr/bin/env node
/**
 * The Windows partition — DERIVED FROM THE TREE, never hand-listed.
 *
 *   node tools/ci/posix-partition.mjs            print the partition + counts
 *   node tools/ci/posix-partition.mjs --run      run the eligible subset in vitest
 *   node tools/ci/posix-partition.mjs --json     the partition as one object
 *
 * WHAT THIS IS FOR. windows-latest has no POSIX shell we are willing to
 * depend on, no jq, no grep/awk/sed, and no mode bits. A meaningful share of
 * this repo's vitest files spawn one of those, assert a POSIX-only fact
 * (mode bits, a symlink, an absolute `/usr/bin/...` path), or drive the
 * `.deploy-claude/scripts`/`hooks` payload that needs a shell to run — and
 * those cannot run on Windows. The rest are the whole point of testing
 * cross-platform at all, and they must run there or the claim is unproven.
 * This script prints the real split rather than stating one, because the
 * figure moves as files are added.
 *
 * WHY A SCANNER AND NOT A LIST. A hand-written exclude list is a list that
 * goes stale on the next test file somebody adds, silently, in the direction
 * that loses coverage — the new file either reddens Windows or (worse) gets
 * appended to the list by whoever is annoyed by the red. This classifies
 * every file under test/ against SIGNALS read out of its own source, so a
 * new test file is classified the moment it lands and the partition is a
 * property of the tree rather than of anybody's memory. The count is printed,
 * never written down: a figure in a comment is a figure nobody re-derives.
 *
 * IT IS LOUD, AND IT IS TOTAL. Every file lands in exactly one bucket, the
 * two buckets are asserted to sum to the roster, and the excluded set is
 * printed with the LINE that excluded it. A skip nobody can see is a skip
 * that becomes permanent.
 *
 * WHAT IS *NOT* A SIGNAL, deliberately:
 *   git      windows-latest ships git, and `spawnSync('git', ...)` is
 *            portable. src/journal/paths.ts shells git on nearly every
 *            journal read; treating that as POSIX would exclude the suite.
 *   node     the bundles are the thing under test on Windows.
 *   chmodSync IN SRC. Node's chmodSync is a no-op-ish on Windows rather
 *            than a throw, so source that calls it still runs. It is only a
 *            signal when a TEST ASSERTS a mode, because that assertion is
 *            what Windows cannot satisfy.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_DIR = join(ROOT, 'test');
const SRC_DIR = join(ROOT, 'src');

// -------------------------------------------------------------- roster ----
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

/** Repo-relative, forward slashes — the form vitest matches its filters against. */
const rel = (p) => relative(ROOT, p).split(sep).join('/');

// ------------------------------------------------- the src spawner set ----
/**
 * src modules that shell out to a POSIX shell or to jq. A test that imports
 * one of these DIRECTLY inherits the dependency even though its own source
 * shows no spawn at all -- test/unit/nouns-wave4g.test.ts feeds `sleep 3`
 * and `test -f x` to src/nouns/task.ts, and nothing in the test file says so.
 *
 * ONE HOP, not transitive. Transitive closure is useless here: everything
 * reaches src/journal/paths.ts eventually, so a full walk marks the entire
 * suite POSIX and the partition says nothing. One hop is the depth at which
 * the import is a statement of intent -- the test chose to drive that module.
 */
const SRC_SHELLS_OUT = /(spawnSync|execFileSync|execSync|spawn)\(\s*['"](sh|bash|jq)['"]/;

function posixSpawners() {
  const set = new Set();
  for (const f of walk(SRC_DIR, (p) => p.endsWith('.ts'))) {
    if (SRC_SHELLS_OUT.test(stripComments(readFileSync(f, 'utf8')))) {
      // Keyed by the module's repo-relative path WITHOUT extension, so the
      // `.js` specifier a NodeNext test writes matches the `.ts` on disk.
      set.add(rel(f).replace(/\.ts$/, ''));
    }
  }
  return set;
}

// -------------------------------------------------------- the signals ----
/**
 * Each signal is a regex plus the sentence that says why a Windows box
 * cannot satisfy it. The reason is printed beside the file it excluded --
 * a partition entry without a reason is a skip list with extra steps.
 */
const SIGNALS = [
  {
    id: 'spawn-posix-binary',
    why: 'spawns a POSIX-only binary (sh/bash/jq/grep/awk/sed/head/find/env/chmod/ln)',
    re: /\b(spawnSync|spawn|execFileSync|execSync)\(\s*['"`](sh|bash|jq|grep|awk|sed|head|find|env|chmod|ln|mktemp|stat)\b/,
  },
  {
    id: 'absolute-posix-path',
    why: 'names an absolute POSIX binary path (/usr/bin/..., /bin/...) that does not exist on Windows',
    re: /['"`]\/(usr\/bin|bin|usr\/local\/bin)\/[a-z]/,
  },
  {
    id: 'mode-bits',
    why: 'creates or ASSERTS POSIX mode bits / symlinks, which Windows does not carry',
    re: /\bchmodSync\(|\bsymlinkSync\(|\.mode\s*&|\bmode:\s*0o/,
  },
  {
    id: 'bash-payload',
    why: 'drives the bash payload on disk (.deploy-claude/scripts or .deploy-claude/hooks), which needs a POSIX shell',
    re: /\.deploy-claude\/(scripts|hooks)\b/,
  },
];

/**
 * Comments are stripped before the signals run. Without this, one PROSE
 * mention of `.deploy-claude/scripts/scrumux` in a header excludes a file of
 * pure string tests -- test/unit/argv.test.ts is exactly that, and a scanner
 * that reads commentary as dependency will keep finding new ways to be wrong
 * as the headers get better. Only whole comment LINES go: `//`, `/*`, and the
 * ` * ` continuation. Nothing tries to parse strings out of code, because a
 * half-parser is the thing that eats a URL and calls it a comment.
 */
function stripComments(src) {
  return src
    .split('\n')
    .map((l) => {
      const t = l.trimStart();
      return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') ? '' : l;
    })
    .join('\n');
}

/**
 * The escape hatch. The FOUR SIGNALS ABOVE ARE THE MECHANISM; this is only
 * for the case a signal genuinely cannot see -- a Windows-specific fact that
 * nothing in the source spells out, so no regex over the source can find it.
 *
 * Both entries here are the same shape, and it is the shape that argues for
 * keeping the hatch small: a test asserting a literal POSIX path that the
 * function under test PRODUCES by path arithmetic. A regex cannot tell that
 * from a test asserting a literal POSIX path that it merely passed IN (which
 * is portable, and which four other files do) -- the signal that catches the
 * first catches the second, and excluding those four costs Windows the wall
 * unit tests, which are the headline of the whole lane.
 *
 * Every entry MUST carry the sentence saying what was read and where,
 * because an entry without one is indistinguishable from somebody making a
 * red go away. If this grows past a handful, the signals are wrong and the
 * signals are what should change.
 */
const EXTRA_POSIX = {
  'test/unit/paths.test.ts':
    "test/unit/paths.test.ts:82 asserts selfDir('file:///a/b/c.js') === '/a/b'. On Windows fileURLToPath yields '\\a\\b\\c.js' and dirname returns '\\a\\b', so the expectation is a POSIX-path fact rather than a behaviour fact. Read at Harden D; nothing in the source spells the dependency, which is why no signal sees it.",
  'test/unit/nouns-wave1b.test.ts':
    "test/unit/nouns-wave1b.test.ts:147 asserts scriptsDirFromBundle('/x/.claude/dist') === '/x/.claude/scripts' — real path arithmetic, and node:path on Windows joins with a backslash, so the literal cannot match. Read at Harden D. The rest of the file is portable; when that one expectation becomes separator-agnostic this entry goes.",
};

// ------------------------------------------------------- classification --
function classify() {
  const spawners = posixSpawners();
  const files = walk(TEST_DIR, (p) => p.endsWith('.test.ts'));
  const bound = [];
  const eligible = [];

  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const src = stripComments(raw);
    const r = rel(f);
    let hit = null;

    for (const s of SIGNALS) {
      const m = src.match(s.re);
      if (m) {
        const line = src.slice(0, m.index).split('\n').length;
        hit = { signal: s.id, why: s.why, line, text: m[0] };
        break;
      }
    }

    if (!hit) {
      // One hop: does it import a module that shells out?
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const target = rel(resolve(dirname(f), spec)).replace(/\.(js|ts|mjs)$/, '');
        if (spawners.has(target)) {
          const line = src.slice(0, m.index).split('\n').length;
          hit = {
            signal: 'imports-shelling-module',
            why: `imports ${target}.ts, which spawns a POSIX shell or jq`,
            line,
            text: m[0],
          };
          break;
        }
      }
    }

    if (!hit && EXTRA_POSIX[r]) {
      hit = { signal: 'declared', why: EXTRA_POSIX[r], line: 0, text: '(declared)' };
    }

    if (hit) bound.push({ file: r, ...hit });
    else eligible.push({ file: r });
  }

  // TOTALITY. A file that fell out of both buckets is a file nobody ran and
  // nobody skipped, which is the one outcome this script exists to refuse.
  if (bound.length + eligible.length !== files.length) {
    throw new Error(
      `posix-partition: ${files.length} file(s) on disk but ${bound.length} + ${eligible.length} classified`,
    );
  }
  return { total: files.length, bound, eligible, spawners: [...spawners].sort() };
}

// ------------------------------------------------------------- reporting --
function report(p) {
  console.log(`posix-partition: ${p.total} vitest file(s) under test/`);
  console.log(`  windows-eligible : ${p.eligible.length}`);
  console.log(`  posix-bound      : ${p.bound.length}  (SKIPPED on a box with no POSIX shell)`);
  console.log(`  src modules that shell out to sh/bash/jq: ${p.spawners.length}`);
  console.log('');
  console.log('POSIX-BOUND — each line names the signal and the line that set it:');
  for (const b of p.bound) {
    console.log(`  skip  ${b.file}`);
    console.log(`          :${b.line}  [${b.signal}]  ${b.why}`);
  }
  console.log('');
  console.log('WINDOWS-ELIGIBLE:');
  for (const e of p.eligible) console.log(`  run   ${e.file}`);
}

// ------------------------------------------------------------------ main --
const argv = process.argv.slice(2);
const partition = classify();

if (argv.includes('--json')) {
  console.log(JSON.stringify(partition, null, 2));
} else {
  report(partition);
}

if (argv.includes('--run')) {
  if (partition.eligible.length === 0) {
    console.error('posix-partition: refusing to run — the eligible set is EMPTY, which is not a pass');
    process.exit(2);
  }
  // Passed as positional include filters rather than --exclude: vitest's
  // filters are substring matches on the path, and an explicit include list
  // means a file the scanner has never seen cannot slip into the run.
  //
  // Forward slashes are correct on Windows too, and not by luck. Vitest's
  // filterFiles slashes the filters on win32 and then also compares against
  // `relative(root, filter)` -- which re-separates a relative filter with the
  // platform separator before matching. Verified by reading
  // node_modules/vitest/dist/chunks/cli-api.*.js `filterFiles`, because "it
  // probably normalises" is the kind of assumption that silently runs zero
  // files and reports a green.
  //
  // `cwd: ROOT` below is load-bearing for the same reason: that comparison is
  // relative to vitest's root, so a run started anywhere else would match
  // nothing.
  const args = ['run', ...partition.eligible.map((e) => e.file), ...argv.filter((a) => a.startsWith('--coverage'))];
  console.log('');
  console.log(`posix-partition: vitest ${args.join(' ')}`);
  console.log('');
  const bin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', cwd: ROOT });
  // The count again, AFTER the run — the tail of the log is what a human
  // reads, and "N green" means nothing without "and M were never attempted".
  console.log('');
  console.log(
    `posix-partition: ${partition.eligible.length} file(s) run, ${partition.bound.length} POSIX-bound file(s) NOT run on this platform.`,
  );
  process.exit(r.status ?? 1);
}
