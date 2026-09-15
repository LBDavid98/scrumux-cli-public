/**
 * The self-governance refusal (brief: docs/port/UNGOVERNED-GUARD.md, ruling:
 * RULINGS.md R-001).
 *
 * A repo carrying `.scrumux-ungoverned` at its root is OUTSIDE the harness and
 * this CLI refuses to govern it. The one repo that must never be governed by
 * scrumux is the one that BUILDS scrumux: a tool that writes records about its
 * own construction bakes whatever policy it happened to hold that afternoon
 * into the permanent record, and every later session reads those transient,
 * half-finished rules as law.
 *
 * DEFAULT-DENY IS THE CONTRACT, NOT THE CURRENT LIST. The guard blocks any
 * noun ABSENT from the allow list, so a noun added later is blocked without
 * anyone remembering to add it. An allow list inverted into a deny list would
 * be silently wrong the first time a noun is added — which is why
 * `isAllowed` tests membership of the allow list and nothing else.
 *
 * POSITION IS PART OF THE CONTRACT. `dispatch.ts` runs this after the noun is
 * resolved and BEFORE the help case and the noun registry, so that every verb
 * passes through it exactly once and no noun module can be reached without
 * first clearing the guard. `tests/ungoverned-repo-tests.sh` asserts that
 * ordering.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Delivery and read-only surface. The harness must stay buildable, deployable
 * and inspectable from its own source tree, and none of these writes a
 * governance record. `status session` is additionally on the SessionStart
 * hook — refusing it would turn every session in the source repo into a hook
 * failure. Kept as a single space-joined string, because the refusal text
 * below prints it verbatim.
 */
export const UNGOVERNED_ALLOWED_NOUNS = 'backlog graph harness records status';

const ALLOWED = new Set(UNGOVERNED_ALLOWED_NOUNS.split(' '));
const HELPISH = new Set(['help', '-h', '--help']);

/**
 * Walk from `root` to `/`, stopping at the first directory holding the marker.
 * Walking up is not optional: the marker is at the repo root and a session two
 * directories down is in the same repo. Terminates on `dirname(x) === x`,
 * which ends both an absolute walk (at `/`) and a relative one (at `.`).
 */
export function findMarker(root: string): string | null {
  let dir = root;
  for (;;) {
    const p = join(dir, '.scrumux-ungoverned');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Is this invocation exempt from the refusal? */
export function isAllowed(noun: string, verb: string): boolean {
  if (ALLOWED.has(noun)) return true;
  if (HELPISH.has(noun) || noun === 'version' || noun === '--version') return true;
  // `<noun> help` prints usage and writes nothing. A refusal that also hides
  // the manual teaches the reader less than the manual does.
  return HELPISH.has(verb);
}

/**
 * The refusal text. Every clause is load-bearing and asserted by
 * `tests/ungoverned-repo-tests.sh`: the marker's path, the marker's own first
 * line, why self-governance is refused, where rulings DO go, what is still
 * available, and that this is working as intended.
 *
 * The marker's first line is read for the `why` clause; an empty or
 * unreadable file yields the empty string, and the clause is then omitted
 * entirely rather than printed as an empty pair of quotes.
 */
export function refusalMessage(command: string, marker: string): string {
  let why = '';
  try {
    const first = readFileSync(marker, 'utf8').split('\n')[0];
    why = first ?? '';
  } catch {
    // An unreadable marker file yields no `why` clause.
    why = '';
  }
  return `this repo is ungoverned by scrumux and '${command}' writes records or runs the governed workflow — refused.
  The marker: ${marker}${why === '' ? '' : ` — "${why}"`}
  Why: this repo BUILDS scrumux, so it must exist OUTSIDE the harness.
  Governing it with its own tool contaminates it with transient, often
  flawed policies and bakes their gaps into the permanent record, where
  the next session reads them as settled law.
  Rulings for this repo go directly in RULINGS.md at the repo root. That
  file is the whole governance record here — there is no journal, no
  sprint and no decision entry to write.
  Still available: ${UNGOVERNED_ALLOWED_NOUNS}, plus help and version.
  This refusal is working as intended. It is not a wall to route around.`;
}
