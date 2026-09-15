/**
 * Reference resolution.
 *
 * ONE ENCODING OF THE PREFIX MAP, WAS THREE (T-0082/I-0031). Which journal an
 * id lives in is answered here and nowhere else; three copies of that map is
 * three chances for a new prefix to reach two of them.
 *
 * `design.json` IS POLYMORPHIC. Epics, features, stories, surfaces and
 * controls share one file (`E-`, `F-`, `S-`, `SF-`, `C-`), which is why
 * `refResolve` selects on `.kind` as well as `.id` for those and why
 * `nextId`'s caller -- not `nextId` -- owns the stream selection.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePreservingNumbers, type JsonValue } from './jqformat.js';
import { JournalRefusal } from './refusal.js';
import { bindingSupersedes, standingOf } from './standing.js';

/** THE prefix->journal map. `null` for an unknown prefix. */
export function refJournal(gov: string, id: string): string | null {
  if (id.startsWith('D-')) return join(gov, 'decisions.json');
  if (id.startsWith('I-')) return join(gov, 'issues.json');
  if (id.startsWith('T-')) return join(gov, 'tasks.json');
  // A work-log entry (SX-037): an order may cite one with --ref L-XXXX.
  if (id.startsWith('L-')) return join(gov, 'log.json');
  // SF- and S- cannot collide: S- does not prefix SF-0001.
  if (id.startsWith('SF-') || id.startsWith('S-') || id.startsWith('F-') || id.startsWith('E-') || id.startsWith('C-')) {
    return join(gov, 'design.json');
  }
  return null;
}

/** Parse a journal, or `null` when it is absent or does not parse. */
function load(path: string): JsonValue | null {
  if (!existsSync(path)) return null;
  try {
    return parsePreservingNumbers(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt file reads the same as an absent one here, deliberately: a
    // reference check is not the surface that reports a corrupt journal.
    return null;
  }
}

function entriesOf(doc: JsonValue | null): JsonValue[] {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const e = (doc as { [k: string]: JsonValue })['entries'];
  return Array.isArray(e) ? e : [];
}

function fieldOf(row: JsonValue, key: string): JsonValue | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined;
  return (row as { [k: string]: JsonValue })[key];
}

/**
 * Does `id` exist in the journal at `path`?
 *
 * @param pick which value of each row counts as an id. Defaults to `.id`.
 */
export function refExists(
  path: string,
  id: string,
  pick: (row: JsonValue) => JsonValue | undefined = (r) => fieldOf(r, 'id'),
): boolean {
  const doc = load(path);
  if (doc === null) return false;
  return entriesOf(doc).some((r) => pick(r) === id);
}

/** True iff the id exists in ITS journal (the one `refJournal` maps it to). */
export function refExistsAny(gov: string, id: string): boolean {
  const path = refJournal(gov, id);
  if (path === null) return false;
  return refExists(path, id);
}

/** Refuse, naming the fix, when a task ref does not resolve. */
export function requireTaskRef(gov: string, id: string): void {
  if (refExists(join(gov, 'tasks.json'), id)) return;
  throw new JournalRefusal(
    `task ${id} not found in governance/tasks.json — create it first: scrumux task new --title ... --check ...`,
  );
}

/**
 * `jq -r`-style rendering of one value: a string is raw, everything else is
 * its JSON text -- and a MISSING field renders as the four letters `null`,
 * which is therefore a non-empty answer.
 */
function jqRaw(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * Human text for a ref, supersession-aware for decisions. `null` for an
 * unknown prefix; `UNRESOLVED` when the id does not resolve.
 *
 * SUPERSESSION IS RESOLVED HERE AND ONLY HERE. A brief that renders a
 * retired ruling as current law is the failure this closes.
 *
 * MULTIPLE MATCHES ARE JOINED WITH A NEWLINE. No live journal has a
 * duplicate id -- the allocator is what prevents it -- so this is the shape
 * of a corrupted journal being rendered, not a normal path.
 */
export function refResolve(gov: string, id: string): string | null {
  const path = refJournal(gov, id);
  if (path === null) return null;
  const doc = load(path);
  // A MISSING FILE IS `UNRESOLVED`, and so is a present one with no match --
  // both fold to the same result below.
  if (doc === null) return 'UNRESOLVED';
  const rows = entriesOf(doc);

  const pickField = (kind: string | null, key: string, fallbackKey?: string): string => {
    const hits = rows
      .filter((r) => fieldOf(r, 'id') === id && (kind === null || fieldOf(r, 'kind') === kind))
      .map((r) => {
        const v = fieldOf(r, key);
        // `(.name // .id)` -- `//` on an absent or null field only.
        if (fallbackKey !== undefined && (v === undefined || v === null || v === false)) {
          return jqRaw(fieldOf(r, fallbackKey));
        }
        return jqRaw(v);
      });
    return hits.join('\n');
  };

  let text: string;
  if (id.startsWith('D-')) {
    text = pickField(null, 'title');
    const own = rows.find((r) => fieldOf(r, 'id') === id);
    const st = own === undefined ? null : standingOf(own);
    if (st !== null && st.status !== 'ratified') text = `${text} [${st.status.toUpperCase()} — not binding]`;
    // Only a binding successor retires it (D-S039).
    const sup = rows.find((r) => bindingSupersedes(r) === id);
    const supId = sup === undefined ? '' : jqRawOrEmpty(fieldOf(sup, 'id'));
    if (supId !== '') text = `${text} [SUPERSEDED by ${supId} — read that instead]`;
  } else if (id.startsWith('I-')) {
    text = pickField(null, 'summary');
  } else if (id.startsWith('T-') || id.startsWith('L-')) {
    text = pickField(null, 'title');
  } else if (id.startsWith('SF-')) {
    text = pickField('surface', 'name');
  } else if (id.startsWith('S-')) {
    text = pickField('story', 'narrative');
  } else if (id.startsWith('F-')) {
    text = pickField('feature', 'name');
  } else if (id.startsWith('E-')) {
    text = pickField('epic', 'name');
  } else {
    text = pickField('control', 'name', 'id');
  }
  return text === '' ? 'UNRESOLVED' : text;
}

/** `[... ] | first // ""` -- null and absent both become the empty string. */
function jqRawOrEmpty(v: JsonValue | undefined): string {
  if (v === undefined || v === null || v === false) return '';
  return jqRaw(v);
}
