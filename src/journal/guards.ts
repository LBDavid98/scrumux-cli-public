/**
 * The reserved-act guards.
 *
 * Not journal I/O, and co-located with it because every consumer is a
 * writer noun taking one of these decisions under the same lock discipline
 * -- four copies of a count is four chances to disagree about what is
 * running.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parsePreservingNumbers, type JsonValue } from './jqformat.js';
import { refExists } from './refs.js';
import { JournalRefusal } from './refusal.js';
import { standingOf, type Standing } from './standing.js';

/**
 * THE ONE VOCABULARY for "on what basis was this taken".
 *
 * THREE FORMS:
 *
 *   direct           a person said so, in this session.
 *   app[:<session>]  taken through scrumux-app, which IS the authority. The
 *                    suffix names the dispatch session, so "who was at the
 *                    helm" is answerable from the record without a second
 *                    lookup. Bare `app` is the control-plane act that belongs
 *                    to no session -- a sprint ratification is opened at repo
 *                    level, and writing `app:unknown-session` there invents
 *                    one, which is the same defect as `--by User`.
 *   standing:D-NNNN  a ratified decision delegates it. The ref MUST resolve:
 *                    an unresolvable delegation is an unrecorded one.
 *
 * NOTE WHAT THIS DOES NOT DO (P-21): it does not check WHO is calling.
 * Nothing in this CLI does, and pretending otherwise
 * would be the same lie as the old `--by User` default. It records the
 * basis; it does not verify the actor. Article 4 applied to identity.
 */
export function authorityGuard(gov: string, value: string | undefined, verb = 'accept'): void {
  const a = value ?? '';
  if (a === '') {
    throw new JournalRefusal(
      `${verb}: --authority is required — direct (a person said so in this session), app:<session> ` +
        `(taken through scrumux-app), or standing:D-XXXX (a ratified delegation). An act with no ` +
        `recorded authority is indistinguishable from an agent acting on its own say-so.`,
    );
  }
  if (a === 'direct' || a === 'app') return;
  // `app:?*` -- at least one character after the colon.
  if (a.startsWith('app:') && a.length > 4) return;
  // `standing:D-[0-9][0-9][0-9][0-9]` -- exactly four digits, nothing after.
  if (/^standing:D-[0-9]{4}$/.test(a)) {
    const dec = a.slice('standing:'.length);
    if (refExists(join(gov, 'decisions.json'), dec)) {
      // ONLY A RATIFIED DECISION DELEGATES (D-S039). A proposed one is an
      // agent's record nobody has ratified — citing it as authority would let
      // a session grant itself a delegation in two commands. A legacy record
      // (no status) reads as ratified, as everywhere else.
      const st = decisionStandingById(gov, dec);
      if (st === 'ratified') return;
      throw new JournalRefusal(
        `${verb}: --authority standing:${dec} names a ${st} decision — only a ratified decision delegates. ` +
          `A person ratifies it first (scrumux decide ratify ${dec} --by WHO --authority direct|app:<session>), ` +
          `or use --authority direct`,
      );
    }
    throw new JournalRefusal(
      `${verb}: --authority standing:${dec} does not resolve in governance/decisions.json — a standing ` +
        `delegation must be a ratified decision; record it first (scrumux decide new ...) or use ` +
        `--authority direct`,
    );
  }
  throw new JournalRefusal(
    `${verb}: --authority must be direct, app:<session>, or standing:D-XXXX, got '${a}'`,
  );
}

/** The standing of one decision by id (`standingOf`); `ratified` when the journal cannot be read (refExists already found the id). */
function decisionStandingById(gov: string, id: string): Standing {
  try {
    const doc = parsePreservingNumbers(readFileSync(join(gov, 'decisions.json'), 'utf8'));
    const row = rowsOf(doc).find((r) => str(r, 'id') === id);
    return row === undefined ? 'ratified' : standingOf(row).status;
  } catch {
    return 'ratified';
  }
}

/**
 * THE FLAG IS VALIDATED, NEVER COERCED.
 *
 * D-0084 makes the ratified sprint the unit of admission and its cap a thing
 * declared at planning. D-0006's rule was repo-global -- one task in_progress
 * anywhere -- which was never about the machine's capacity; it was about a
 * person being able to say what is in flight, and a ratified sprint with a
 * declared cap says exactly that, in the record User ratified.
 */
export function parallelGuard(value: string | undefined, verb: string): void {
  const v = value ?? '';
  if (v === '') return;
  if (/[^0-9]/.test(v)) {
    throw new JournalRefusal(
      `${verb}: --parallel must be a whole number 1 or more, got '${v}' — it is how many tasks of this ` +
        `sprint may be in_progress at once (D-0084)`,
    );
  }
  // Only the literal string "0" is rejected here. "00" is a distinct string
  // and is NOT caught by this check -- it falls through and is accepted.
  if (v === '0') {
    throw new JournalRefusal(
      `${verb}: --parallel must be a whole number 1 or more, got '0' — a sprint that admits nothing is ` +
        `an abandoned sprint (scrumux sprint status <id> abandoned)`,
    );
  }
}

/** One `admission_state` line, unpacked. */
export interface AdmissionState {
  /** The task's ratified-sprint home, or `''`. */
  home: string;
  /** That sprint's declared cap; 1 when there is no home. */
  cap: number;
  /** Busy task ids inside the same sprint. */
  same: string[];
  /** Busy work outside it, ALREADY PHRASED: "T-0009 is in SP-0003". */
  elsewhere: string[];
  /** The same set as bare ids, so a caller needs no second pass. */
  elsewhereIds: string[];
}

/**
 * THE D-0084 ARITHMETIC, COMPUTED ONCE.
 *
 * FOUR CALLERS NEED THE SAME NUMBERS: the writer that refuses the transition,
 * the brief gate that reports it, the reject TELL that reports it again, and
 * the records validator that backstops all three.
 *
 * A TASK IN NO RATIFIED SPRINT HAS AN EMPTY HOME, A CAP OF 1, AND EVERY BUSY
 * TASK COUNTED AS ELSEWHERE -- which is D-0006's original rule, unchanged,
 * for exactly the case D-0084 does not cover. The resulting repo-global cap
 * of 1 for an unsprinted task is intended, not a bug.
 *
 * THROWS WHEN `tasks.json` CANNOT BE READ. A caller that computed a cap
 * decision from no data would be worse than one that refuses outright.
 * `sprints.json`, by contrast, is optional and defaults to no sprints.
 *
 * APPROVED-DIVERGENCE: R-009, covering BOTH refusals below. Both fail CLOSED
 * and name the file that could not be read, not an internal filter name.
 */
export function admissionState(gov: string, taskId: string): AdmissionState {
  const tasksPath = join(gov, 'tasks.json');
  let tasksDoc: JsonValue;
  try {
    tasksDoc = parsePreservingNumbers(readFileSync(tasksPath, 'utf8'));
  } catch {
    throw new JournalRefusal(`cannot read ${tasksPath} — admission cannot be computed`);
  }
  const sprintsPath = join(gov, 'sprints.json');
  let sprintsDoc: JsonValue = { entries: [] };
  if (existsSync(sprintsPath)) {
    try {
      sprintsDoc = parsePreservingNumbers(readFileSync(sprintsPath, 'utf8'));
    } catch {
      // A corrupt sprints.json fails the whole computation rather than
      // pretending to no sprints -- same disposition as tasks.json.
      throw new JournalRefusal(`cannot read ${sprintsPath} — admission cannot be computed`);
    }
  }

  const sps = rowsOf(sprintsDoc);
  const ts = rowsOf(tasksDoc);

  // The FIRST ratified sprint listing the id, else "".
  const home = (id: string): string => {
    for (const s of sps) {
      if (str(s, 'status') !== 'ratified') continue;
      const tasks = arr(s, 'tasks');
      if (tasks.some((t) => t === id)) return str(s, 'id') ?? '';
    }
    return '';
  };

  const mine = home(taskId);
  let cap = 1;
  if (mine !== '') {
    const sp = sps.find((s) => str(s, 'id') === mine);
    const p = sp === undefined ? undefined : num(sp, 'parallel');
    cap = p ?? 1;
  }

  const busy = ts.filter((t) => str(t, 'status') === 'in_progress' && str(t, 'id') !== taskId);
  const same: string[] = [];
  const elsewhere: string[] = [];
  const elsewhereIds: string[] = [];
  for (const t of busy) {
    const id = str(t, 'id') ?? '';
    const h = home(id);
    if (mine !== '' && h === mine) {
      same.push(id);
    } else {
      elsewhere.push(`${id} is in ${h === '' ? 'no ratified sprint' : h}`);
      elsewhereIds.push(id);
    }
  }
  return { home: mine, cap, same, elsewhere, elsewhereIds };
}

/** Tab-separated rendering of an `AdmissionState`: home, cap, same (joined), same count, elsewhere (joined), elsewhereIds (joined). */
export function admissionTsv(s: AdmissionState): string {
  return [
    s.home,
    String(s.cap),
    s.same.join(', '),
    String(s.same.length),
    s.elsewhere.join(', '),
    s.elsewhereIds.join(', '),
  ].join('\t');
}

function rowsOf(doc: JsonValue): JsonValue[] {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const e = (doc as { [k: string]: JsonValue })['entries'];
  return Array.isArray(e) ? e : [];
}

function str(row: JsonValue, key: string): string | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const v = (row as { [k: string]: JsonValue })[key];
  return typeof v === 'string' ? v : null;
}

function arr(row: JsonValue, key: string): JsonValue[] {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return [];
  const v = (row as { [k: string]: JsonValue })[key];
  return Array.isArray(v) ? v : [];
}

function num(row: JsonValue, key: string): number | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const v = (row as { [k: string]: JsonValue })[key];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
