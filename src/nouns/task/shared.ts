/**
 * What every `task` verb file shares -- row selection, `jq -r`'s rendering
 * rules, the direct-print seam, and the graph shell-out.
 *
 * THE DIRECT-PRINT SEAM IS THE ONE THAT BITES. `task brief` and `task verify`
 * print half their output through `say` (suppressed under `--json`) and the
 * other half through this direct seam, which writes to stdout
 * UNCONDITIONALLY -- so under `--json` those bytes land on stdout AHEAD of
 * the one object. This is deliberate, not an oversight: a `--json` consumer
 * of `task brief` gets the Title block, the scope, the reading list, the
 * ground truth and the history as loose text before the envelope. `out()`
 * is that seam, named, so every call site that uses it is declaring "this
 * prints in both modes".
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Io } from '../../cli/exit.js';
import { parsePreservingNumbers, RawNumber, type JsonValue } from '../../journal/jqformat.js';
import type { NounContext } from '../lib/context.js';

/** `jq -r` of one value: a string raw, `null` for null/absent, JSON otherwise. */
export function jqRaw(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof RawNumber) return v.text;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/** `"\(.x)"` -- jq string interpolation; identical to jqRaw for these types. */
export const interp = jqRaw;

/** `.x // $d` -- jq's `//` swallows false as well as null. Rendered raw. */
export function rawOr(v: JsonValue | undefined, dflt: string): string {
  if (v === undefined || v === null || v === false) return dflt;
  return jqRaw(v);
}

export function obj(v: JsonValue | undefined): { [k: string]: JsonValue } | null {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v) || v instanceof RawNumber) return null;
  return v as { [k: string]: JsonValue };
}

export function arr(v: JsonValue | undefined): JsonValue[] {
  return Array.isArray(v) ? v : [];
}

/** A tolerant journal read: `jq` over an unreadable file hands back nothing. */
export function rows(path: string): JsonValue[] {
  if (!existsSync(path)) return [];
  try {
    const doc = parsePreservingNumbers(readFileSync(path, 'utf8'));
    const o = obj(doc);
    if (o === null) return [];
    return arr(o['entries']);
  } catch {
    return [];
  }
}

/** `.entries[] | select(.id==$id)` -- the FIRST match (see the dup-id note). */
export function rowById(path: string, id: string): { [k: string]: JsonValue } | null {
  for (const r of rows(path)) {
    const o = obj(r);
    if (o !== null && o['id'] === id) return o;
  }
  return null;
}

export const tasksPath = (ctx: NounContext): string => join(ctx.gov, 'tasks.json');
export const sprintsPath = (ctx: NounContext): string => join(ctx.gov, 'sprints.json');
export const designPath = (ctx: NounContext): string => join(ctx.gov, 'design.json');

/** The unconditional-stdout seam described in the header. */
export function directOut(io: Io): (line: string) => void {
  return (line: string) => io.out(line + '\n');
}

/** `$(...)` -- command substitution strips every trailing newline. */
export function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

/**
 * `printf '%s\n' "$OUT" | tail -20` over a substitution-captured string:
 * the printf re-adds exactly one newline, so an empty capture prints one
 * blank line -- reproduced, because the evidence block's shape is contract.
 */
export function tailOfCapture(captured: string, n: number): string[] {
  return stripTrailingNewlines(captured).split('\n').slice(-n);
}

/** `[ -x "$SCRIPTS/scrumux" ]`. */
export function cliPath(ctx: NounContext): string {
  return join(ctx.scriptsDir, 'scrumux');
}

/**
 * `"$SCRIPTS/scrumux" <args...>` -- the graph shell-out `task lint` and
 * `task brief` make, with the environment inherited. Spawned through
 * `process.execPath` (node) rather than a shell, since the sibling CLI is
 * a node entry point, not a shell script.
 */
export function runScrumux(
  ctx: NounContext,
  args: readonly string[],
): { rc: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath(ctx), ...args], {
    cwd: ctx.cwd,
    env: ctx.env,
    encoding: 'utf8',
  });
  return {
    rc: r.status === null || r.status === undefined ? 127 : r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

/**
 * `awk '$1=="path" && $2=="changes" {printf "%s%s", (n++ ? " " : ""), $3}'`
 * over the bearing text: the changed paths, space-joined.
 */
export function bearingChangedPaths(bearing: string): string {
  const out: string[] = [];
  for (const line of bearing.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'path' && f[1] === 'changes' && f[2] !== undefined) out.push(f[2]);
  }
  return out.join(' ');
}

// The ids of the records whose line reads "<id> [changes ...", out of the
// bearing text.
export function bearingChangeIds(bearing: string): string[] {
  const out: string[] = [];
  for (const line of bearing.split('\n')) {
    const m = /^([DI]-[0-9]{4}) \[changes /.exec(line);
    if (m !== null) out.push(m[1]!);
  }
  return out;
}

/** `grep -E '^[DI]-[0-9]{4} '` -- every record line of the bearing text. */
export function bearingRecordLines(bearing: string): string[] {
  return bearing.split('\n').filter((l) => /^[DI]-[0-9]{4} /.test(l));
}
