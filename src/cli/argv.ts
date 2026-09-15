/**
 * argv handling: strips the global flags before any noun or verb sees argv.
 *
 * `--json` IS A GLOBAL FLAG, stripped before the noun, before the verb,
 * before any module sees argv. `scrumux --json task lint T-1`,
 * `scrumux task --json lint T-1` and `scrumux task lint T-1 --json` are the
 * same request; a surface that accepts some of those and not others is a
 * surface people get wrong.
 *
 * `--` ENDS THE STRIPPING and is itself removed. That is the correct answer
 * to the one hazard a global flag has: a governance record whose VALUE is
 * literally the string `--json`. Absurd and possible, so it gets the standard
 * escape rather than a caveat:
 *
 *   scrumux log new --title X --did -- --json
 *
 * Only the FIRST `--` is consumed. Everything after it is passed through
 * verbatim, including a later `--` and a later `--json`: once `passthru`
 * flips true below it never flips back.
 *
 * The loop walks the positional list rather than rebuilding a string, because
 * an argument here is routinely a whole `--rationale` paragraph with newlines
 * in it and any separator-based rebuild eventually meets a record containing
 * the separator. An array has no quoting hazard to begin with.
 */
export interface ParsedArgv {
  /** argv with the global flags removed, in original order. */
  argv: string[];
  /** true if `--json` appeared outside the passthrough region. */
  json: boolean;
}

/** What a redacted argv entry reads as. One constant so every call site agrees. */
export const REDACTED = '<redacted>';

/**
 * The argv the ENVELOPE records, which is not always the argv the module runs
 * on.
 *
 * `secret` is the one noun whose stated contract is that nothing prints a
 * value back, and `.argv` breaks it if left unredacted: `scrumux --json
 * secret set NAME VALUE` would write the credential onto stdout inside the
 * envelope's own record of what was run -- on the success path AND on every
 * refusal, because a refusal envelope carries the same list. The stdin form
 * has nothing to leak; the argv form is documented, discouraged, still
 * supported, and its value is never echoed.
 *
 * POSITIONAL, NOT PARSED. Everything after the NAME is a value as far as this
 * seam is concerned -- `secret set N a b` stores `b` and records two
 * `<redacted>` entries -- so the seam cannot disagree with `secret.ts`'s own
 * `parsePositional` about which slot held the secret. THE ENTRY COUNT IS
 * PRESERVED: `.argv` is the record of what was run, and a list that lost an
 * element misstates the act as surely as one that leaks it.
 *
 * The module still receives the REAL arguments. This is the envelope's view
 * and nothing else's; `dispatch` passes `verbArgs` to `mod.run` unchanged.
 *
 * THE NAME SLOT IS REDACTED TOO WHEN IT BEGINS WITH A DASH (R-010). The base
 * rule keeps `args[0]` verbatim because it is the NAME and the NAME is not a
 * secret -- true of every argv that HAS a name, and `scrumux secret set
 * -sup3r-s3cret` does not: the value was typed one slot early, the parse
 * refuses it as a flag, and without this extension the envelope would record
 * the credential in full. A leading dash cannot be a usable NAME
 * (`requireUsableName` allows letters, digits and underscore only, and never a
 * leading digit), so nothing about the record is lost by withholding it, and
 * the ENTRY COUNT and the POSITION still survive -- which is the whole of what
 * `.argv` is for. Enforced by the grep-everything assertions in
 * `test/unit/dispatch.test.ts` ("R-010: `secret set` never echoes the operand").
 */
export function redactArgv(noun: string, verb: string, args: readonly string[]): string[] {
  if (noun !== 'secret' || verb !== 'set' || args.length === 0) return [...args];
  const name = args[0]!;
  const head = name.startsWith('-') ? REDACTED : name;
  return [head, ...args.slice(1).map(() => REDACTED)];
}

export function stripGlobalFlags(input: readonly string[]): ParsedArgv {
  const argv: string[] = [];
  let json = false;
  let passthru = false;
  for (const a of input) {
    if (passthru) {
      argv.push(a);
      continue;
    }
    if (a === '--') {
      passthru = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    argv.push(a);
  }
  return { argv, json };
}
