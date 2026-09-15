/**
 * The READER question `task lint` asks of every order (§4b) -- a NOTE, never a
 * check: it moves no counter and refuses nothing (D-S016: the harness guides,
 * the app surfaces the variance).
 *
 * WHY IT NAMES THE PATTERNS (SX-003; two added by SX-032, Rover T-0014/T-0016
 * cleanup checks that enumerated instead of diffing, T-0010's vacuous loop). The generic sentence ("weakest artifact
 * that passes …") printed on every order of the Rover build, and three hollow
 * greens still shipped, each caught only by an operator probing by hand:
 *   - T-0002: the suite turned "dependency unreachable" into a SKIP, so it exited
 *     0 with the dependency down;
 *   - T-0005: the assertion could not fail ("not unreachable" passed on a 404);
 *   - T-0006: the test left folders in real shared data on every run -- and
 *     acceptance re-runs the command, so verifying polluted again.
 * A pattern an agent can recognise in its own test is guidance; a sentence it
 * has read forty times is not.
 *
 * THE DECLARED FAILURE CASE (`task order --fails-when`). An order may state
 * what must make its check go red. When it does, the note echoes it so the
 * implementer proves that case; when it does not, the note says so, and the app
 * shows "no failure case declared" at acceptance -- distinct from "declared".
 *
 * Depends on: nothing. Pure.
 */

/** The hollow-green shapes, one line each, as the note and the skill state them. */
export const HOLLOW_GREENS: readonly string[] = [
  'a test that SKIPS when its dependency is down (exit 0 with nothing proved) — make it fail instead',
  'an assertion that cannot fail (e.g. "not unreachable" also passes on a 404) — assert the positive outcome',
  'a test that writes into real shared data (a vault, a database, a folder other work reads) — acceptance re-runs the command, so it pollutes again; use a throwaway target or clean up',
  'a "nothing remains" check that enumerates the ids it expects instead of diffing the store against a snapshot taken before the run — what it did not expect to create is invisible to it',
  'an assertion over an empty input (a loop over no results, a search that returned []) — it proves nothing; assert the input is non-empty first',
];

/**
 * The note text for one order.
 *
 * Depends on: `HOLLOW_GREENS`.
 */
export function readerQuestion(verificationCommand: string, failsWhen: string): string {
  const declared = failsWhen.trim() === ''
    ? 'This order declares no failure case — say what must make the check go red: scrumux task order … --fails-when "<the broken state this command must catch>".'
    : `This order says the check must FAIL when: ${failsWhen.trim()} — prove that case goes red before calling it green.`;
  return `READER (§4b): weakest artifact that passes '${verificationCommand}' — would you accept it? A green receipt is not a check that proves its claim; if a hollow artifact passes, the command is a proxy — fix it or stop the check claiming it. Hollow greens seen in practice: ${HOLLOW_GREENS.map((h, i) => `(${i + 1}) ${h}`).join('; ')}. ${declared}`;
}
