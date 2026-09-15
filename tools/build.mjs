#!/usr/bin/env node
/**
 * esbuild -> zero-dependency ESM bundles. They are BUILT into this source
 * repo's payload dir (.deploy-claude/dist/) and deployed per-repo at
 * .claude/dist/, which is why the BUILD.json keys below stay target-relative.
 *
 * VENDORED, NEVER RESOLVED. A wall must not depend on ambient state: no
 * global resolution shim, ever. Vendoring also lands the bundles under
 * `harness verify`'s existing hash-for-hash drift detection for free, so a
 * tampered wall is detected by machinery that already exists.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '.deploy-claude/dist');

// The CLI, the four walls, and the session guard. Each wall is its own bundle
// rather than one shared binary with a mode flag, for the same reason the four
// hooks are four files: a syntax error in one must not be able to take the
// other three down, and `harness verify` hashes them independently.
//
// `session-guard` is the fifth hook and the first that is not a PreToolUse
// wall. It is the SessionStart half of the fail-closed doctrine: exec form —
// the only hook shape that runs on a stock Windows box — has no shell and so
// cannot carry the `command -v node || exit 2` the `.sh` shims carried, so the
// guarantee moved to the one event that fires before any tool call. Its own
// header carries the reasoning; it is bundled separately for the same
// blast-radius reason as the walls.
const ENTRIES = [
  { in: 'src/bin/scrumux.ts', out: 'scrumux' },
  { in: 'src/walls/block-destructive.ts', out: 'block-destructive' },
  { in: 'src/walls/block-secret-reads.ts', out: 'block-secret-reads' },
  { in: 'src/walls/block-upstream-edit.ts', out: 'block-upstream-edit' },
  { in: 'src/walls/block-direct-llm.ts', out: 'block-direct-llm' },
  { in: 'src/walls/session-guard.ts', out: 'session-guard' },
];

mkdirSync(OUT, { recursive: true });

await build({
  // The {in,out} form, not a bare path list: with entry points in two
  // directories esbuild otherwise mirrors the source tree into outdir and the
  // bundles land at <payload>/dist/walls/… where nothing looks for them.
  entryPoints: ENTRIES.map((e) => ({ in: resolve(ROOT, e.in), out: e.out })),
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false, // a wall a person may need to read at 3am stays readable
  logLevel: 'warning',
});

// BUILD.json carries a sha256 per bundle so `harness verify` can report
// drift without the original checkout.
const files = {};
for (const e of ENTRIES) {
  const p = resolve(OUT, `${e.out}.mjs`);
  // Target-relative on purpose: this map is read by `harness verify` INSIDE
  // a deployed repo, where the bundles are at .claude/dist/.
  files[`.claude/dist/${e.out}.mjs`] = createHash('sha256')
    .update(readFileSync(p))
    .digest('hex');
}
writeFileSync(
  resolve(OUT, 'BUILD.json'),
  JSON.stringify({ built_at: new Date().toISOString().slice(0, 10), files }, null, 2) + '\n',
);

console.log(`built ${ENTRIES.length} bundle(s) into .deploy-claude/dist/`);
// The keys are target-relative (see above); the operator wants the path that
// was just written HERE, so print the source layout rather than the map's key.
for (const [f, h] of Object.entries(files)) {
  console.log(`  ${f.replace('.claude/', '.deploy-claude/')}  sha256:${h.slice(0, 12)}`);
}
