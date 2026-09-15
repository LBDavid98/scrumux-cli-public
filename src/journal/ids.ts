/**
 * Id allocation.
 *
 * NO COUNTER IS STORED ANYWHERE. Every allocation re-derives max+1 from the
 * journal's current id stream and formats it `<prefix>-%04d`. That is why it
 * MUST run inside the same lock as the write it feeds: an allocator that
 * computes max+1 before entering the critical section hands two processes the
 * same number even when each write is individually locked (I-0079;
 * `appendWithId` is the half that closes it).
 *
 * THE CALLER OWNS THE STREAM. This function takes the already-selected id
 * values and discriminates nothing itself -- most journals pass every
 * `.entries[].id`, but `design.json` is polymorphic (`E-`/`F-`/`S-`/`SF-`/
 * `C-` share one file), so a caller there must narrow the selection first.
 * A generic filter-by-kind inside this function would silently change
 * behaviour for a caller that meant to pass an unfiltered stream.
 */
import { RawNumber, type JsonValue } from './jqformat.js';
import { JournalRefusal } from './refusal.js';

/**
 * A LITERAL PREFIX STRIP, not a pattern. Prefix `T` strips exactly `T-`, and
 * a value that does not start with it passes through unchanged -- straight
 * into the numeric parse below, which is where a foreign id lands.
 */
function stripPrefix(text: string, prefix: string): string {
  const p = `${prefix}-`;
  return text.startsWith(p) ? text.slice(p.length) : text;
}

/**
 * The next id for `prefix`, given the ids already in the journal.
 *
 * @param ids     the ids already in the journal, already selected by the
 *                caller, in order.
 * @param prefix  `T`, `I`, `D`, ... -- no trailing dash.
 * @param journal the journal's bare name, for the refusal message only.
 */
export function nextId(ids: readonly JsonValue[], prefix: string, journal = 'the journal'): string {
  let max = 0;
  for (const raw of ids) {
    // Nulls are dropped before the prefix strip runs.
    if (raw === null || raw === undefined) continue;

    let n: number;
    if (raw instanceof RawNumber || typeof raw === 'number') {
      // A numerically-typed id is legal input too.
      n = Number(raw instanceof RawNumber ? raw.text : raw);
      if (!Number.isFinite(n)) n = NaN;
    } else if (typeof raw === 'string') {
      const suffix = stripPrefix(raw, prefix);
      // APPROVED-DIVERGENCE: D-0085 (OQ-7). A suffix that is not a number
      // refuses here rather than silently allocating a duplicate id. This is
      // the one site in this module ruled STRICTER than bash was.
      //
      // The accepted shape is a run of digits, which is what `%04d` writes
      // and the only shape any live journal holds. A handful of other
      // strings a looser numeric coercion might accept (` 1`, `+5`, `1e3`)
      // refuse here too, under the same ruling, because none of them
      // round-trips through `%04d` either.
      n = /^[0-9]+$/.test(suffix) ? Number(suffix) : NaN;
    } else {
      n = NaN;
    }

    if (!Number.isFinite(n)) {
      throw new JournalRefusal(
        `refusing to allocate the next ${prefix}- id: ${journal} holds the id ${JSON.stringify(raw)}, ` +
          `whose suffix is not a number — bash would fall back to ${prefix}-0001 here and hand out an id ` +
          `that already exists (D-0085/OQ-7). Repair the id first: scrumux repair journal ${journal}`,
      );
    }
    if (n > max) max = n;
  }
  return formatId(prefix, max + 1);
}

/**
 * `printf '%s-%04d'`. FOUR IS A MINIMUM WIDTH, not a truncation -- the
 * ten-thousandth record is `T-10000`, seven characters, and every consumer
 * that matches ids with `[0-9][0-9][0-9][0-9]` (`authority_guard`'s
 * `standing:D-NNNN` among them) is pinned to four by its own pattern, not by
 * this one.
 */
export function formatId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}
