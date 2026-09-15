/**
 * The project allow-list: the one sanctioned merge into a target's
 * `.claude/settings.json` (I-0155), and the build tools seeded from its
 * manifests (SX-008, D-S019, 2026-09-13).
 *
 * WHY SEEDING EXISTS. A dispatched `claude -p` session has no one to approve a
 * tool call, so `permissions.allow` is its whole policy. The canon list had no
 * Edit/Write, rm, mkdir, npm or uv, so Rover's sessions could not write a file
 * and were pushed toward sandbox-escape attempts over trivial cleanup. The
 * static half (Edit, Write, mkdir, rm) now ships in the canon settings.json;
 * this module adds the half that depends on the repo: its build tools, from
 * the manifests it actually has.
 *
 * UNION, NEVER REPLACE. Existing entries first, in their order, never removed;
 * a project-owned entry survives every redeploy byte for byte.
 *
 * Depends on: node:fs, `journal/jqformat.ts`, `util/fs-predicates.ts`.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../../cli/envelope.js';
import type { JsonValue } from '../../journal/jqformat.js';
import { jqFormat, parsePreservingNumbers } from '../../journal/jqformat.js';
import { isFile } from '../../util/fs-predicates.js';

/** One manifest-detected group of allow rules. */
export interface ToolSeed {
  readonly manifest: string;
  readonly rules: readonly string[];
}

/** Manifest → the build tool rules a session in that repo needs. pnpm is already canon. */
const TOOL_SEEDS: readonly ToolSeed[] = [
  { manifest: 'package.json', rules: ['Bash(npm *)', 'Bash(npx *)'] },
  { manifest: 'pyproject.toml', rules: ['Bash(uv *)'] },
  { manifest: 'uv.lock', rules: ['Bash(uv *)'] },
];

/**
 * The tool seeds whose manifest exists at the target root, deduplicated.
 *
 * Depends on: `isFile`.
 */
export function detectedToolSeeds(target: string): ToolSeed[] {
  const out: ToolSeed[] = [];
  const seen = new Set<string>();
  for (const s of TOOL_SEEDS) {
    if (!isFile(join(target, s.manifest))) continue;
    const rules = s.rules.filter((r) => !seen.has(r));
    rules.forEach((r) => seen.add(r));
    if (rules.length > 0) out.push({ manifest: s.manifest, rules });
  }
  return out;
}

/**
 * `permissions.allow` of a parsed settings document; [] when absent/null/false.
 * Throws when it is present but not an array.
 *
 * Depends on: nothing. Pure.
 */
export function allowOf(d: JsonValue): JsonValue[] {
  const perms = (d as { [k: string]: JsonValue } | null)?.['permissions'];
  const a = (perms as { [k: string]: JsonValue } | null | undefined)?.['allow'];
  if (a === null || a === undefined || a === false) return [];
  if (!Array.isArray(a)) throw new Error('allow is not an array');
  return a;
}

const eq = (x: JsonValue, y: JsonValue): boolean => jqFormat(x) === jqFormat(y);

/**
 * Append every rule in `rules` that `tset` does not already allow, existing
 * entries first. Returns how many were appended (0 writes nothing).
 *
 * An unparseable target counts as 0 appended and is left alone — the recorded
 * looseness (settings.ts header). A parseable target whose shape cannot take
 * the union (not an object, `permissions` not an object) dies with the refusal
 * deploy has always printed; the original file is left intact. Mode 0600, as
 * every deployed settings.json already has.
 *
 * Depends on: `allowOf`, `parsePreservingNumbers`, `jqFormat`, node:fs.
 */
export function unionAllow(cli: Cli, tset: string, rules: readonly JsonValue[]): number {
  let missing: JsonValue[];
  try {
    const targetAllow = allowOf(JSON.parse(readFileSync(tset, 'utf8')) as JsonValue);
    missing = rules.filter((x, i) => !targetAllow.some((y) => eq(x, y)) && rules.findIndex((z) => eq(z, x)) === i);
  } catch {
    return 0;
  }
  if (missing.length === 0) return 0;
  let doc: JsonValue;
  try { doc = parsePreservingNumbers(readFileSync(tset, 'utf8')); } catch { doc = null; }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) cli.die(`cannot union permissions.allow into ${tset}`);
  const obj = doc as { [k: string]: JsonValue };
  if (obj['permissions'] === null || obj['permissions'] === undefined) obj['permissions'] = {};
  const perms = obj['permissions'];
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) cli.die(`cannot union permissions.allow into ${tset}`);
  const permsObj = perms as { [k: string]: JsonValue };
  const existing = Array.isArray(permsObj['allow']) ? permsObj['allow'] : [];
  permsObj['allow'] = [...existing, ...missing];
  const tmp = `${tset}.tmp.${process.pid}`;
  try { writeFileSync(tmp, jqFormat(doc)); } catch { cli.die('cannot stage settings.json merge'); }
  try { chmodSync(tmp, 0o600); } catch { /* best-effort, as the staging file's mode is */ }
  try { renameSync(tmp, tset); } catch { cli.die(`cannot write ${tset} — check the target's permissions`); }
  return missing.length;
}

/**
 * Which of Edit and Write a settings file does not allow, or null when it
 * cannot be read. Used for a passive report only.
 *
 * Depends on: `allowOf`.
 */
export function missingWriteTools(tset: string): string[] | null {
  try {
    const allow = allowOf(JSON.parse(readFileSync(tset, 'utf8')) as JsonValue).map((x) => String(x));
    return ['Edit', 'Write'].filter((t) => !allow.some((a) => a === t || a.startsWith(`${t}(`)));
  } catch {
    return null;
  }
}
