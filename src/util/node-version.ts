/**
 * Fail-loud Node version check.
 *
 * Written in the most conservative syntax available so it PARSES on an old
 * runtime and can therefore report the problem. A version guard that is
 * itself a syntax error on the version it guards against prints a parser
 * stack trace instead of the one sentence the operator needs.
 *
 * Exit 2 = "could not run", which is the correct code for both namespaces:
 * the CLI's three-code rule, and a hook, where 2 means block. That is the
 * fail-closed doctrine (CLI-1): a wall whose prerequisite is missing
 * refuses rather than waving the call through.
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 11;

export function nodeVersionProblem(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!m) return null; // unparseable: do not refuse on a guess
  const major = parseInt(m[1]!, 10);
  const minor = parseInt(m[2]!, 10);
  if (major > MIN_NODE_MAJOR) return null;
  if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return null;
  return (
    'scrumux: error: Node ' +
    version +
    ' is too old — this CLI needs Node >=' +
    MIN_NODE_MAJOR +
    '.' +
    MIN_NODE_MINOR +
    '. Install a newer Node and retry; nothing was read or written.'
  );
}
