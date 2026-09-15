/**
 * The help surface.
 *
 * ARTICLE 5 MAKES THIS CODE, NOT CHROME. "The error message is the
 * instruction set": the agent is steered by what the scripts print at the
 * moment of the mistake, so every byte here is contract, pinned by
 * `test/unit/usage.test.ts` in both output modes.
 *
 * THE COLUMN WIDTH IS DERIVED, never the literal 9 it once was. `exception`
 * is exactly nine characters, so a hardcoded width put a single space between
 * that noun and its gloss, and every reader that splits the table on a run of
 * spaces silently dropped the noun — including the control plane's own
 * surface reader, which feeds R-A6a's coverage check. A newly added noun then
 * read as "the CLI does not have this" rather than "the app cannot reach it".
 * Same class as the hand-written counts that disagreed in five places
 * (T-0202). Deriving it is one line and cannot go stale.
 */
import { NOUN_SUMMARY, NOUN_USAGE } from './usage-text.js';

/** The 21 nouns, in registry order. */
export const NOUNS: readonly string[] = NOUN_SUMMARY.map(([n]) => n);

export function nounKnown(noun: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOUN_USAGE, noun);
}

/** `scrumux help <noun>` — the module's own usage block, verbatim. */
export function usageNoun(noun: string): string {
  const t = NOUN_USAGE[noun];
  if (t === undefined) {
    // Unreachable through the dispatcher, which validates the noun first.
    // Not a throw: a help surface that crashes is worse than one that says
    // what it does not know.
    return `scrumux ${noun} — no usage block is compiled into this build.\n`;
  }
  return t;
}

const HEAD = `scrumux — the harness command surface. One command, nouns and verbs.

usage: scrumux <noun> <verb> [--json] [args...]
       scrumux help <noun>          the verbs and flags of one noun
       scrumux version              the CLI contract version

nouns:
`;

const TAIL = `
Every verb takes --json and emits exactly ONE object on stdout carrying
\`ok\`, an \`exit\` code and a per-check array. Exit 0 means the assertion
held, 1 means it did not, 2 means the command could not run. Advisories
(WARN/TELL) never change the exit code.
`;

/** `scrumux help` / `scrumux` — the noun table. */
export function usageTop(): string {
  const width = NOUN_SUMMARY.reduce((w, [n]) => Math.max(w, n.length), 0);
  const rows = NOUN_SUMMARY.map(([n, s]) => `  ${n.padEnd(width)}  ${s}`).join('\n');
  return `${HEAD}${rows}\n${TAIL}`;
}
