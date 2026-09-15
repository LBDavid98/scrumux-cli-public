/**
 * The journal seal. Four writers, one file: `resealOne` (the per-write
 * single-key update, below), `sealJournals` (the whole-map rebuild),
 * `sealBootstrap` (create the baseline, and record it if it laundered) --
 * plus `brokenSeals`/`sealsShapeProblem`, which only read.
 *
 * D-0044 names a content seal as the tamper signal: a sha256 per journal,
 * rewritten by every scrumux write, so a journal whose content does not
 * match its recorded hash was edited by something that is not scrumux.
 *
 * SEALS.JSON IS HAND-PRINTED, NOT jq-FORMATTED, AND THAT IS THE CONTRACT
 * (P-50). `sealJournals` builds the whole object by string concatenation --
 * two-space indent at the top level, FOUR inside `journals`, and an empty
 * map rendered as `{\n  }` rather than jq's inline `{}`. Every other object
 * this CLI writes goes through jqFormat; this one deliberately does not, and
 * "tidying" it into jqFormat would change bytes that `tests/
 * journal-shape-tests.sh` reads and that the next `records check` hashes.
 *
 * THE ONE PLACE jq's FORMATTING DOES APPLY is the bootstrap flag stamp
 * (`sealBootstrap`'s `jqFormat` write below): a seal file that recorded a
 * laundered baseline is jq-shaped from that point on, and one that did not
 * stays printf-shaped.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDir, isFile } from '../util/fs-predicates.js';
import { jqFormat, parsePreservingNumbers, type JsonValue } from './jqformat.js';
import { journalLock, journalUnlock } from './lock.js';
// jq's own semantics for "is this an object" and jq's string collation. A
// leaf helper with no dependency of its own beyond the formatter, which is
// why this file reaches sideways for it rather than keeping a second copy.
import { asObject, cmpString, field } from '../nouns/lib/jqlike.js';

export const SEAL_FILE_NAME = 'seals.json';

/**
 * The journals scrumux WRITES, named explicitly rather than globbed.
 * `governance/` also holds DERIVED artifacts -- code-graph.json and
 * governance-graph.json are rebuilt by their own index commands, so globbing
 * sealed them and they broke on every rebuild. A glob would also silently
 * adopt any future derived file (P-22). Order is load-bearing: it is the
 * order `seal_journals` prints keys in.
 */
export const SEALED_JOURNALS: readonly string[] = [
  'design.json',
  'tasks.json',
  'sprints.json',
  'decisions.json',
  'issues.json',
  'exceptions.json',
  'log.json',
  'repo-health.json',
];

/** sha256 hex digest of the file's exact bytes on disk. */
export function sealOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every `*.json` in `governance/`, sorted for deterministic order. */
export function govJsonFiles(gov: string): string[] {
  let names: string[];
  try {
    names = readdirSync(gov);
  } catch {
    return [];
  }
  return names
    // `*` does not match a leading dot, so `governance/.cache/` and any
    // dot-prefixed scratch file are outside this glob by construction.
    .filter((n) => !n.startsWith('.'))
    .filter((n) => n.endsWith('.json'))
    .filter((n) => {
      try {
        return statSync(join(gov, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort(cmpString);
}

/**
 * Rewrite every journal's recorded hash -- the whole-map rebuild, called
 * exactly once in practice (by `sealBootstrap`, to CREATE the file).
 *
 * NOTE THE EMPTY CASE: `"journals": {` immediately followed by `\n  }`, so
 * an empty map is `{\n  }` and not `{}` -- that space is part of the
 * hand-printed byte contract described above.
 */
export function sealJournals(gov: string, today: string): void {
  if (!isDir(gov)) return;
  let out = `{\n  "sealed_at": "${today}",\n  "journals": {`;
  let first = true;
  for (const name of SEALED_JOURNALS) {
    const p = join(gov, name);
    if (!existsSync(p) || !isFile(p)) continue;
    if (!first) out += ',';
    first = false;
    out += `\n    "${name}": "${sealOf(p)}"`;
  }
  out += '\n  }\n}\n';
  const tmp = join(gov, `${SEAL_FILE_NAME}.tmp.${process.pid}`);
  writeFileSync(tmp, out);
  renameSync(tmp, join(gov, SEAL_FILE_NAME));
}

/**
 * The one thing every WRITE path still owes (T-0187): create the baseline in
 * a repo that has never been sealed, and RECORD it when the baseline was
 * taken over journals that already had content.
 *
 * CREATING THE BASELINE IS NOT A NEUTRAL ACT. Delete seals.json, make any
 * write, and the whole map is rebuilt from whatever the journals contain
 * right now -- sealing in any hand edit made before it as though scrumux had
 * written it. That is the laundering the seal exists to catch, available to
 * anyone who can `rm` a file. It still creates the file, because a repo that
 * predates sealing has to be able to start; what changed is that the fact is
 * RECORDED rather than only printed to stderr, which is easy to miss or lose
 * inside an unrelated refusal's own output.
 */
export function sealBootstrap(gov: string, today: string): void {
  const seals = join(gov, SEAL_FILE_NAME);
  if (existsSync(seals)) return;

  // Only when there is content to launder. A freshly deployed repo has empty
  // journals, and baselining nothing is not a risk. NOTE the enumeration is
  // the full `governance/*.json` glob, NOT SEALED_JOURNALS -- a derived file
  // with entries trips the flag too, and that is intended.
  let hasContent = false;
  for (const name of govJsonFiles(gov)) {
    if (name === SEAL_FILE_NAME) continue;
    let doc: JsonValue;
    try {
      doc = parsePreservingNumbers(readFileSync(join(gov, name), 'utf8'));
    } catch {
      continue;
    }
    const entries = field(doc, 'entries');
    const n = Array.isArray(entries) ? entries.length : entries === null ? 0 : lengthOf(entries);
    if (n > 0) {
      hasContent = true;
      break;
    }
  }

  sealJournals(gov, today);

  if (hasContent && existsSync(seals)) {
    // This write goes through jqFormat, so the result is jq-formatted from
    // here on, and the new key lands LAST, after everything the printf
    // block above wrote.
    let doc: JsonValue;
    try {
      doc = parsePreservingNumbers(readFileSync(seals, 'utf8'));
    } catch {
      return;
    }
    const o = asObject(doc);
    if (o === null) return;
    const next: { [k: string]: JsonValue } = { ...o, bootstrapped_over_existing_content: today };
    const tmp = `${seals}.tmp.${process.pid}`;
    const text = jqFormat(next);
    writeFileSync(tmp, text);
    renameSync(tmp, seals);
  }
}

/**
 * Why the seal file cannot be used, or the empty string.
 *
 * THE SEAL SILENTLY CHECKING NOTHING IS WORSE THAN NO SEAL. `brokenSeals`
 * walks `.journals`; a file that is valid JSON but the wrong shape (`{}`, or
 * `journals` as a string) yields no rows, so every journal compares clean
 * and tamper detection is off with nothing saying so -- e.g. `{}` as the
 * whole file plus a hand-edited tasks.json gives zero findings.
 *
 * ABSENCE STAYS SILENT and is handled by the caller -- a repo may
 * legitimately predate sealing.
 */
export function sealsShapeProblem(gov: string): string {
  const p = join(gov, SEAL_FILE_NAME);
  if (!existsSync(p)) return '';
  let doc: JsonValue;
  try {
    doc = parsePreservingNumbers(readFileSync(p, 'utf8'));
  } catch {
    return `${SEAL_FILE_NAME} is not valid JSON, so no journal is being checked against it`;
  }
  const journals = asObject(field(doc, 'journals'));
  if (journals === null) {
    return `${SEAL_FILE_NAME} has no .journals object, so every journal compares clean and nothing is being checked`;
  }
  if (Object.keys(journals).length === 0) {
    return `${SEAL_FILE_NAME} records zero sealed journals, so nothing is being checked`;
  }
  return '';
}

/**
 * Every journal whose content does not match its recorded hash.
 *
 * DRIVEN BY THE SEAL MAP, never by SEALED_JOURNALS (P-52): a journal that is
 * listed and on disk but absent from the map is never hashed and never
 * reported here. `records check` names that case separately, as a WARN.
 * A sealed journal that is GONE is skipped, not reported.
 *
 * NO SPACES IN AN ENTRY. Callers word-split this output, so a name like
 * "(recorded but missing)" would be read as four separate journal names
 * instead of one description.
 */
export function brokenSeals(gov: string): string[] {
  const p = join(gov, SEAL_FILE_NAME);
  if (!existsSync(p)) return [];
  let doc: JsonValue;
  try {
    doc = parsePreservingNumbers(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  const journals = asObject(field(doc, 'journals'));
  if (journals === null) return [];
  const out: string[] = [];
  for (const [name, want] of Object.entries(journals)) {
    const jp = join(gov, name);
    if (!existsSync(jp) || !isFile(jp)) continue;
    if (sealOf(jp) !== String(want)) out.push(name);
  }
  return out;
}

/**
 * Reseal ONE journal -- the last step of every guarded write.
 *
 * DELIBERATELY NOT `sealJournals`. Resealing the whole map on every write
 * would silently DEFEAT the seal: any unrelated scrumux command would
 * re-seal a hand-edited journal as though scrumux had written it. For
 * example: a tampered `tasks.json` is reported by `records check`, then one
 * `scrumux decide`, touching a different journal entirely, makes the report
 * disappear.
 *
 * IT PRUNES. `sealJournals` rebuilds the whole map and would drop a stale
 * key, but it runs exactly once (to CREATE the file); every write after that
 * comes through here, which updates one key and REMOVES any key outside the
 * current roster. Without pruning, a seal recorded for a file the roster no
 * longer includes would survive forever, and `records check` would go on
 * checking it -- and a DERIVED file is rebuilt on every deploy, so its
 * recorded hash can never match again and the repo would fail its own
 * validation permanently, with no way to clear it. Observed in
 * scrumux-agents, whose map once carried `code-graph.json` and
 * `governance-graph.json`, so `harness deploy` reported its own clean
 * install as FAILED, every time.
 *
 * LOCK ORDER IS ALWAYS JOURNAL-THEN-SEALS, NEVER THE REVERSE. `seals.json`
 * is the single most contended object in the system because every journal
 * write touches it; taking it only while already holding a journal lock is
 * what makes a lock-ordering cycle impossible.
 *
 * SEALS.JSON BYPASSES EVERY `writeJsonBody` GUARD (P-50): it has no
 * `entries` array and would fail the shape guard outright, it gets no entry
 * count check and no `.backups` copy. The write is a temp-file-then-rename,
 * not a call into that shared write path. What it does take is the lock.
 *
 * @returns the warning text when the reseal failed, else `null`.
 */
export function resealOne(
  gov: string,
  path: string,
  today: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  // A no-op for a file outside the roster ...
  if (!SEALED_JOURNALS.includes(base)) return null;
  const seals = join(gov, SEAL_FILE_NAME);
  // ... or before the repo has ever been sealed.
  if (!existsSync(seals) || !isFile(seals)) return null;

  let hash: string;
  try {
    hash = sealOf(path);
  } catch {
    // A file that cannot be hashed is not a reseal failure -- there is
    // nothing to reseal.
    return null;
  }

  journalLock(seals, env);
  let failed = false;
  const tmp = `${seals}.tmp.${process.pid}`;
  try {
    let doc: JsonValue;
    try {
      doc = parsePreservingNumbers(readFileSync(seals, 'utf8'));
    } catch {
      throw new Error('unparseable');
    }
    const o = asObject(doc);
    // A non-object seal file cannot be updated; that's a reseal failure.
    if (o === null) throw new Error('not an object');

    // An existing key keeps its POSITION when updated; a new one is
    // appended. Same for entries in .journals. That ordering is the file's
    // bytes.
    const next: { [k: string]: JsonValue } = { ...o };
    next['sealed_at'] = today;
    const journals = asObject(next['journals']);
    const merged: { [k: string]: JsonValue } = journals === null ? {} : { ...journals };
    merged[base] = hash;
    // The prune is a rebuild, not a delete-from: the surviving keys keep
    // their order and the whole map is produced in one pass.
    const kept: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(merged)) {
      if (SEALED_JOURNALS.includes(k)) kept[k] = v;
    }
    next['journals'] = kept;

    const text = jqFormat(next);
    writeFileSync(tmp, text);
    renameSync(tmp, seals);
  } catch {
    failed = true;
  } finally {
    rmSync(tmp, { force: true });
    journalUnlock(seals);
  }

  if (!failed) return null;
  // SAY SO. A silently swallowed reseal failure means the seal quietly stops
  // matching a file scrumux just legitimately wrote -- and the NEXT records
  // check reports it as "changed outside scrumux", a false accusation of
  // tampering pointing at the wrong culprit.
  return (
    `${SEAL_FILE_NAME}: could not update the seal for ${base} — the next records check will report it ` +
    `as changed outside scrumux, wrongly. Re-run the write, or reseal with: scrumux repair journal ${base}`
  );
}

function lengthOf(v: JsonValue): number {
  const o = asObject(v);
  if (o !== null) return Object.keys(o).length;
  if (typeof v === 'string') return Array.from(v).length;
  return 0;
}
