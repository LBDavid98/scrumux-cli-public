/**
 * Guarded journal read (T-0163/I-0102).
 *
 * ABSENT IS NOT UNREADABLE, AND THE DIFFERENCE IS THE WHOLE POINT. A read
 * that does not distinguish the two turns a parse error into an empty
 * result, and empty then renders as "(no open tasks)", "(no features)", or a
 * normal-looking session brief whose counts are silently wrong (I-0078,
 * I-0083, I-0102).
 *
 * A MISSING JOURNAL IS A NORMAL STATE a fresh repo is in. A journal that
 * exists and does not parse is a state where the only truthful answer is
 * "I could not read it".
 *
 * THE RETURN TYPE IS A DISCRIMINATED UNION, NOT A THROW (P-16): a function
 * that throws on both absent and malformed collapses this THREE-state
 * contract into two. Each caller must dispose of the difference: `status`
 * prints the refusal INTO the brief and still exits 0, while `backlog`
 * refuses at exit 2.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parsePreservingNumbers, type JsonValue } from './jqformat.js';

export type JournalRead =
  | { kind: 'absent'; value: JsonValue }
  | { kind: 'ok'; value: JsonValue; raw: string }
  | { kind: 'unreadable'; error: string };

const DEFAULT_JOURNAL = '{"entries":[]}';

export function readJournal(path: string, defaultJson = DEFAULT_JOURNAL): JournalRead {
  if (!existsSync(path)) {
    return { kind: 'absent', value: parsePreservingNumbers(defaultJson) };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { kind: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    return { kind: 'ok', value: parsePreservingNumbers(raw), raw };
  } catch (e) {
    return { kind: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * THE ONE WORDING for that refusal, so every caller says the same thing and
 * names the same repair. Returned as the clause AFTER "<command>: error: ",
 * which is what the refusal path prepends and what backlog-tests and
 * error-shape-tests grep for: the marker, the file, and an em-dash fix
 * clause.
 */
export function journalUnreadable(path: string): string {
  const n = basename(path);
  return `governance/${n} is not valid JSON — restore it from git, or repair it with scrumux repair journal ${n}`;
}
