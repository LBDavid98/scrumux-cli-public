/**
 * What every WRITE verb needs beyond the read helpers -- the small seam
 * between a noun module and `src/journal/write.ts`.
 *
 * THE ENGINE ALREADY EXISTS AND THIS IS NOT A SECOND ONE. `writeJson` /
 * `appendWithId` carry the five stacked guards, the backup and the reseal;
 * what a verb still owes on top of them is identical at every call site and is
 * written once here rather than eleven times:
 *
 *   1. BUILD THE OPTIONS. `gov`, `today` and the environment come from the
 *      noun context, and `err` is routed at the CLI's stderr seam rather
 *      than at `process.stderr`, so a test can see and pin the reseal
 *      warning rather than losing it to an unobservable write. Every
 *      guarded write and append below goes through `writeOpts`, so no call
 *      site can build its own `WriteOptions` and accidentally miss this
 *      seam.
 *   2. TURN A `JournalRefusal` INTO THE CLI's EXIT-2 REFUSAL. That is
 *      `refusing(cli, ...)`, and wrapping it here means no verb can forget:
 *      an unwrapped engine refusal would surface as a stack trace instead of
 *      the CLI's `scrumux <command>: error: <message>` shape.
 *   3. DISPOSE OF A FAILED RESEAL (D-0085/OQ-18). A failed reseal does not
 *      fail the write. D-0085 rules that the fact reaches the envelope as a
 *      WARN row, exit code unchanged -- the only place a reseal failure
 *      becomes visible to anything reading the envelope, since the
 *      process's own exit code says nothing about it.
 *
 *      THE ROW IS ADDED ONLY UNDER `--json`, and that is the ruling read
 *      precisely rather than approximately: the write engine already writes
 *      the reseal-failure line to stderr unconditionally, so a row added in
 *      human mode too would be the same fact said twice in one surface.
 *
 * JQ'S OBJECT SEMANTICS, TWICE. `.foo = v` on an object keeps `foo` where it
 * already was and APPENDS it when it is new; `a + b` keeps a's keys in a's
 * order and appends b's new ones in b's order. A JS object spread does
 * exactly both, for the string keys these journals use -- which is why the
 * record shapes below are written as spreads and not as mutation.
 *
 * `.entries += [ … ]` AND `.entries |= map( … )`, with jq's own edge cases.
 * They appear in every write verb, and each has an edge that is easy to get
 * subtly wrong and impossible to see once it is wrong:
 *
 *   - `.entries` on a document that is NOT an object is an ERROR in jq
 *     (`[] | .entries` -> "Cannot index array with \"entries\""), and an error
 *     inside the filter is guard (a) of the write engine -- "jq write failed
 *     for <path>". A port that answered `{}` there would write a NEW journal
 *     over a corrupt one instead of refusing.
 *   - `null` is the one non-object jq DOES accept: `null | .entries` is null
 *     and `null | .entries += [x]` is `{"entries":[x]}`. Reproduced, because
 *     a `null` journal is reachable (`printf 'null' > log.json`), and it
 *     must land on guard (c)'s refusal, not guard (a)'s.
 *   - `+=` on an ABSENT `.entries` yields `[x]` and adds the key at the END of
 *     the object; `|=` on an absent one is "Cannot iterate over null" and is a
 *     failure. The two are not interchangeable and the difference is only ever
 *     observable on a hand-damaged journal.
 *   - A KEY THAT ALREADY EXISTS KEEPS ITS POSITION. jq's object assignment
 *     does not move a key, and the object spread below does not either -- the
 *     re-assignment after the spread overwrites in place. Journals are
 *     compared byte-for-byte, so key ORDER is the contract, not a detail.
 *
 * Everything here is a pure function of the parsed document: nothing mutates
 * the value it was handed, because `writeJsonBody` (src/journal/write.ts)
 * measures the BEFORE count after the filter has already run, and an
 * in-place push would make the entry-count guard compare a number with itself.
 *
 * EVERY MUTATING VERB GOES THROUGH ONE OF THE EXPORTS BELOW --
 * `appendEntry`, `mapEntries`, `guardedWrite` or `guardedAppend` -- rather
 * than hand-writing a jq-equivalent filter at the call site. A verb that
 * reached for its own object spread instead would have to re-derive every
 * edge case above correctly, alone, with no test here to catch it if it
 * didn't.
 */
import type { Cli } from '../../cli/envelope.js';
import type { Io } from '../../cli/exit.js';
import { RawNumber, type JsonValue } from '../../journal/jqformat.js';
import { refusing } from '../../journal/refusal.js';
import {
  appendWithId,
  writeJson,
  type AppendResult,
  type Transform,
  type WriteOptions,
  type WriteResult,
} from '../../journal/write.js';
import type { NounContext } from './context.js';
import { asObject } from './jqlike.js';

/**
 * The slice of `Cli` the reseal disposal needs. Structural, as `beat.ts` is,
 * so a test can pin the warn row without building a whole envelope.
 */
export interface ResealReporter {
  readonly json: boolean;
  warn(name: string, detail?: string): void;
}

/** `$GOV`, `$TODAY` and the environment, in the engine's shape. */
export function writeOpts(ctx: NounContext, io: Io): WriteOptions {
  return {
    gov: ctx.gov,
    today: ctx.today,
    env: ctx.env,
    err: (s) => io.err(s),
  };
}

/**
 * `write_json <file> <filter>` from a verb's point of view: refuse through the
 * CLI, and file the reseal warning per D-0085/OQ-18.
 */
export function guardedWrite(
  cli: Cli,
  ctx: NounContext,
  io: Io,
  path: string,
  transform: Transform,
): WriteResult {
  const r = refusing(cli, () => writeJson(path, transform, writeOpts(ctx, io)));
  warnReseal(cli, r.resealWarning);
  return r;
}

/** `append_with_id <file> <id-stream> <prefix> <filter>`, same disposal. */
export function guardedAppend(
  cli: Cli,
  ctx: NounContext,
  io: Io,
  path: string,
  idStream: (doc: JsonValue) => JsonValue[],
  prefix: string,
  transform: (doc: JsonValue, id: string) => JsonValue | undefined,
  ): AppendResult {
  const r = refusing(cli, () => appendWithId(path, idStream, prefix, transform, writeOpts(ctx, io)));
  warnReseal(cli, r.resealWarning);
  return r;
}

/**
 * The one thing every caller of the filters below ALSO owes, so it sits with
 * them rather than being remembered nine times.
 *
 * APPROVED-DIVERGENCE: D-0085 (OQ-18). A failed reseal does not fail the
 * write; D-0085 rules that a failed reseal adds a WARN row to the envelope,
 * exit code unchanged.
 *
 * `--json` ONLY, and that is not a hedge: `Cli.warn` also PRINTS its row in
 * human mode, and the write engine already writes the reseal-failure line
 * to stderr unconditionally -- adding the row in human mode too would be
 * the same fact said twice in one surface.
 */
export function warnReseal(cli: ResealReporter, warning: string | null): void {
  if (warning === null || !cli.json) return;
  cli.warn('reseal', warning);
}

// `sayNow` lived here once: an early cut of `Cli.say` buffered until `emit`,
// so the two verbs that can refuse after speaking carried a local
// write-through. User's 2026-09-01 ruling moved the write-through into
// `Cli.say`/`Cli.row` themselves (src/cli/envelope.ts), and the workaround
// is retired.

/**
 * A flag that takes a value.
 *
 * REFUSES IN THE CLI'S OWN VOCABULARY, DELIBERATELY (R-002's 2026-09-02
 * amendment; docs/port/modules/cmd-task.md open question 1). A raw shell
 * parameter-expansion failure at this position -- the flag as the last
 * token on the command line -- produces a message and exit code that vary
 * by shell: one host names an absolute path and a source line number and
 * exits 1, another names the CLI's own entry point and exits 2. Neither
 * number is this CLI's own "could not run" code, and either message
 * exposes an implementation detail (a source line number) that means
 * nothing to an operator.
 *
 * Exit 2 here is deliberate too: it is this CLI's own code for "the
 * assertion did not hold, not a real answer" -- a caller that got a
 * different exit code has something real to show, and a truncated command
 * line is not an answer. Reproducing either shell's raw diagnostic would
 * pin a rough edge as contract by accident and would lie about where the
 * code lives, so this refuses in the CLI's own vocabulary instead.
 *
 * THIS FUNCTION'S JOB IS NARROW: report a missing value at position `i`,
 * nothing about the loop shape around it. Every call site takes the value
 * immediately after matching the flag, before advancing its own index, so
 * an arity mistake one iteration earlier (consuming the wrong token as a
 * flag name) is not something this function can see or is responsible for
 * catching -- it only ever answers "is there a token here".
 */
export function flagValue(cli: Cli, args: readonly string[], i: number, command: string): string {
  const v = args[i];
  if (v === undefined) cli.die(`${command}: ${args[i - 1]} needs a value`);
  return v;
}

/**
 * UNQUOTED SHELL WORD-SPLITTING, deliberately reproduced: values are joined
 * and re-split on IFS (space, tab, newline), with empty fields dropped.
 * `--add-feature ''` therefore contributes a value the WRITE stores that the
 * VALIDATION loop never sees, and `--dep 'F-1 F-2'` is checked as two ids
 * and stored as one. Both are observable and both are deliberate: quietly
 * iterating the array instead would refuse input this CLI has always
 * accepted.
 *
 * NOT reproduced: the pathname expansion an unquoted shell substitution
 * would also perform. See the note in each caller.
 */
export function shellWords(values: readonly string[]): string[] {
  return values.join('\n').split(/[ \t\n]+/).filter((s) => s !== '');
}

// --- jq's object operators, as JS spreads -------------------------------

/** `.k = v` -- in place when present, appended when new. */
export function setField(
  obj: { [k: string]: JsonValue },
  key: string,
  value: JsonValue,
): { [k: string]: JsonValue } {
  return { ...obj, [key]: value };
}

/** `a + b` -- b wins on a shared key, and keeps a's position for it. */
export function mergeFields(
  a: { [k: string]: JsonValue },
  b: { [k: string]: JsonValue },
): { [k: string]: JsonValue } {
  return { ...a, ...b };
}

/**
 * A jq TYPE error, deliberately NOT a `JournalRefusal`.
 *
 * `writeJsonBody`'s guard (a) catches anything that is not a
 * `JournalRefusal` out of the transform and turns it into the write
 * engine's `jq write failed for <path>` refusal -- the same message a jq
 * filter error produces. So a filter helper that meets a shape jq refuses
 * throws one of these and the engine words the refusal, in one place, with
 * the path it alone knows.
 *
 * THE MESSAGES MATCH jq'S OWN, because guessing here writes a NEW journal
 * over a corrupt one. `[] | .entries += [x]` is "Cannot index array with
 * string \"entries\""; `null | .entries |= map(.)` is "Cannot iterate over
 * null"; and `null` is the ONE non-object jq accepts on the `+=` side --
 * `null | .entries += [x]` is `{"entries":[x]}`, so `scrumux issue new` over
 * a `null` journal SUCCEEDS and writes I-0001. Verified against jq 1.7.
 */
class JqTypeError extends Error {}

// `asObject` (jqlike) rather than a local `typeof v === 'object'` test: a
// number that kept its source literal is a `RawNumber` INSTANCE, so `typeof`
// calls it an object, and a document of the four bytes `1` would then be
// appended to instead of refused. jq says "Cannot index number with string
// \"entries\"" and so must this.

/** jq's own word for a value's type, for the messages above. */
function typeName(v: JsonValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof RawNumber || typeof v === 'number') return 'number';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'string') return 'string';
  return 'boolean';
}

/**
 * `.entries |= map(if <pick> then <f> else . end)` -- the shape every mutating
 * verb in this wave shares.
 *
 * THE DOCUMENT IS REBUILT, NEVER MUTATED. `writeJsonBody` compares the
 * entry count of the value it was HANDED against the one the filter produced
 * (guard d), and an in-place mutation would make those two the same object.
 *
 * `|=` IS NOT `+=`. It iterates, so a document that is not an object, and an
 * object whose `.entries` is absent or not an array, are both jq errors --
 * guard (a)'s refusal, never guard (c)'s. Unreachable through this wave's
 * verbs, every one of which resolves the id through `refExists` first; kept
 * exact anyway, because the day one does not is the day the difference between
 * "jq write failed" and "not an object with an entries array" is the only
 * thing telling an operator which journal is damaged and how.
 */
export function mapEntries(
  doc: JsonValue,
  f: (row: { [k: string]: JsonValue }) => JsonValue,
): JsonValue {
  const o = asObject(doc);
  if (o === null) throw new JqTypeError(`Cannot index ${typeName(doc)} with string "entries"`);
  const entries = o['entries'];
  if (!Array.isArray(entries)) {
    throw new JqTypeError(`Cannot iterate over ${typeName(entries ?? null)}`);
  }
  return {
    ...o,
    entries: entries.map((row) => {
      // `if .id==$id then … else . end` on a non-object row: the comparison is
      // false, so the row comes back untouched rather than erroring.
      const r = asObject(row);
      return r === null ? row : f(r);
    }),
  };
}

/**
 * `.entries[].id` -- the id stream every single-prefix journal allocates on.
 *
 * A NON-OBJECT DOCUMENT YIELDS NOTHING, WHICH IS THE RIGHT ANSWER. An empty
 * stream reaches `nextId`, whose max-of-empty-plus-one falls back to 1, so a
 * non-object (or missing) journal allocates `-0001` here rather than
 * refusing at this stage -- the shape guard elsewhere is what actually
 * catches a malformed journal.
 */
export function idStream(doc: JsonValue): JsonValue[] {
  const o = asObject(doc);
  if (o === null) return [];
  const e = o['entries'];
  if (!Array.isArray(e)) return [];
  return e.map((row) => {
    const r = asObject(row);
    if (r === null) return null;
    const v = r['id'];
    return v === undefined ? null : v;
  });
}

/**
 * `.entries += [record]` -- the append every id-allocating verb performs.
 *
 * `null` IS THE ONE NON-OBJECT THIS ACCEPTS, and it is not a curiosity: a
 * journal holding the four bytes `null` is reachable by hand, and jq's own
 * semantics turn that into `{"entries":[record]}` at rc 0 rather than
 * refusing. An ARRAY does
 * not get the same treatment -- `[] | .entries` is an error, and the append
 * refuses through guard (a). An `.entries` that is absent or null appends the
 * key at the END of the object; one that is neither array nor null is
 * "string (…) and array (…) cannot be added", which is guard (a) again.
 */
export function appendEntry(doc: JsonValue, record: JsonValue): JsonValue {
  if (doc === null) return { entries: [record] };
  const o = asObject(doc);
  if (o === null) throw new JqTypeError(`Cannot index ${typeName(doc)} with string "entries"`);
  const e = o['entries'];
  if (e === undefined || e === null) return { ...o, entries: [record] };
  if (!Array.isArray(e)) {
    throw new JqTypeError(`${typeName(e)} and array cannot be added`);
  }
  return { ...o, entries: [...e, record] };
}
