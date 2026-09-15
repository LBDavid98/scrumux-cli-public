/**
 * `.claude/project-walls.conf` — the one pathway a repo extends the refusal
 * layer through.
 *
 * WHY ONE FILE AND NOT A FORK. The base harness cannot know what is dangerous
 * in your repo, and it cannot know which of its own refusals your work
 * legitimately requires. A repo with no way to say either forks the hooks, and
 * a forked hook is a hook nobody upgrades.
 *
 *   refuse <extended-regex> | why this repo refuses it
 *   allow  <extended-regex> | why this repo permits it
 *
 * ALLOW WINS, including over a built-in wall (P-29). A repo that says a thing
 * is fine here has said so on purpose, and a wall that argues with its own
 * owner is the wall people route around.
 *
 * EACH PATTERN IS VALIDATED ON ITS OWN BEFORE THE SET IS USED, and that is the
 * load-bearing mechanism, not a nicety: merging every rule into one alternation
 * would mean a single bad pattern breaks compilation for the WHOLE set,
 * silently disabling every rule — including, on the allow side, ones a repo
 * depends on, and on the refuse side, unrelated protections like an `id_rsa`
 * rule sitting next to a broken `.env` rule.
 *
 * THE THREE SKIP REASONS, each named on stderr and never dropped quietly:
 *   - no pattern after the verb;
 *   - no reason after the last pipe (D-0085/OQ-4): a pipe being PRESENT does
 *     not mean anything follows it, so a reasonless rule would otherwise be
 *     silently ACTIVE — firing a refusal reading "BLOCKED by
 *     project-walls.conf: " with nothing after the colon, and on the allow
 *     side exempting a command with no auditable justification at all, which
 *     is the worse half;
 *   - a pattern that will not compile.
 *
 * A FOURTH CASE THE PATTERN VALIDATION MUST HANDLE (OQ-8, ruled in D-0085): a
 * pattern that is a valid POSIX ERE (one grep could compile) but that this
 * build's JS regex translator cannot express. It FAILS CLOSED on a refuse
 * line — the rule refuses — and is SKIPPED-AND-NAMED on an allow line: the
 * same "when in doubt, refuse" asymmetry as everywhere else in this file.
 *
 * PARSED ONCE PER PROCESS: `loadConf` parses the file exactly once, and
 * `allows`, `refuses` and `reason` all read from that same structure, so a
 * named skip line prints ONCE per process rather than being re-derived (and
 * re-warned) on every call.
 */
import { readFileSync, existsSync } from 'node:fs';
import { translateEre, matchesAnyLine, ereOrThrow } from './ere.js';

export type Verb = 'allow' | 'refuse';

export interface ConfRule {
  verb: Verb;
  pattern: string;
  reason: string;
  regex: RegExp | null;
  /** Set when the rule is not usable; the text is what goes to stderr. */
  skipped: string | null;
  /** A valid ERE this build cannot express. Refuse lines fail closed on it. */
  untranslatable: boolean;
}

export interface Conf {
  path: string;
  present: boolean;
  rules: ConfRule[];
  /** Lines named on stderr, once per process. */
  warnings: string[];
}

/**
 * Strip the verb and the reason off one line.
 *
 * THE REASON SPLITS AT THE LAST PIPE, NOT THE FIRST. Splitting at the first
 * truncated any pattern that legally contained one: `refuse (foo|bar)\.env`
 * became `(foo`, and the combined alternation became unbalanced-parens
 * garbage.
 */
/**
 * POSIX SPACE, NOT `\s`. JavaScript's `\s` additionally matches U+00A0 and
 * eleven other Unicode spaces beyond true POSIX whitespace, so a line
 * written `refuse<NBSP>zz | reason` must NOT parse as a rule -- if it did, a
 * repo would silently gain an exemption (or a refusal) nobody deliberately
 * wrote, matching only by locale accident.
 */
const POSIX_LEAD = ereOrThrow('^[[:space:]]+', 'g');
const POSIX_TRAIL = ereOrThrow('[[:space:]]+$', 'g');

const VERB_RE: Readonly<Record<Verb, RegExp>> = {
  allow: ereOrThrow('^[[:space:]]*allow[[:space:]]+'),
  refuse: ereOrThrow('^[[:space:]]*refuse[[:space:]]+'),
};

export function splitRule(verb: Verb, line: string): { pattern: string; reason: string } | null {
  const m = VERB_RE[verb].exec(line);
  if (m === null) return null;
  const rest = line.slice(m[0].length);
  const bar = rest.lastIndexOf('|');
  if (bar < 0) return null;                       // No pipe at all: not a rule.
  return {
    // POSIX space here too, not `\s`: a pattern ending in a NBSP keeps it,
    // and a reason beginning with one keeps it too. Trimming more than true
    // POSIX whitespace would silently change what a repo's rule matches.
    pattern: rest.slice(0, bar).replace(POSIX_TRAIL, ''),
    reason: rest.slice(bar + 1).replace(POSIX_LEAD, '').replace(POSIX_TRAIL, ''),
  };
}

/** Read and validate the conf. One parse; every caller reads this structure. */
export function loadConf(root: string): Conf {
  const path = `${root}/.claude/project-walls.conf`;
  const conf: Conf = { path, present: false, rules: [], warnings: [] };
  if (!existsSync(path)) return conf;
  conf.present = true;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Unreadable is not a reason to disable a repo's walls silently, but there
    // is nothing to apply either. Named, and the built-ins still run.
    conf.warnings.push(`project-walls.conf: cannot be read, so none of this repo's own rules apply: ${path}`);
    return conf;
  }

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*/, '');       // Strip a trailing comment.
    for (const verb of ['allow', 'refuse'] as const) {
      const split = splitRule(verb, line);
      if (split === null) continue;
      const { pattern, reason } = split;
      if (pattern === '') continue;                // Empty pattern: skipped, unnamed.

      if (reason === '') {
        const w = `project-walls.conf: ignoring a ${verb} rule with no reason, so the rest still apply: ${pattern}`;
        conf.warnings.push(w);
        conf.rules.push({ verb, pattern, reason, regex: null, skipped: w, untranslatable: false });
        break;
      }

      const t = translateEre(pattern);
      if (t.ok) {
        conf.rules.push({ verb, pattern, reason, regex: t.regex, skipped: null, untranslatable: false });
        break;
      }
      if (t.kind === 'untranslatable') {
        // A pattern grep accepts as valid ERE syntax, but this build's
        // translator cannot express as a JS regex. Refuse lines fail closed
        // on it (see `refuses` below); allow lines are skipped and named.
        const w = `project-walls.conf: this build cannot evaluate a ${verb} pattern that grep accepts (${t.reason}): ${pattern}`;
        conf.warnings.push(w);
        conf.rules.push({ verb, pattern, reason, regex: null, skipped: w, untranslatable: true });
        break;
      }
      const w = `project-walls.conf: ignoring an invalid ${verb} pattern, so the rest still apply: ${pattern}`;
      conf.warnings.push(w);
      conf.rules.push({ verb, pattern, reason, regex: null, skipped: w, untranslatable: false });
      break;
    }
  }
  return conf;
}

/** Print every named skip, once. Callers do this before deciding anything. */
export function emitWarnings(conf: Conf, err: (s: string) => void = (s) => process.stderr.write(s)): void {
  for (const w of conf.warnings) err(w + '\n');
}

/**
 * Has this repo declared the string exempt?
 *
 * FAILS CLOSED BY RETURNING "not exempt" on anything but a real match. An
 * exemption is the one place a wall stops looking, so the doubtful answer is
 * "keep looking".
 */
export function allows(conf: Conf, subject: string): boolean {
  for (const r of conf.rules) {
    if (r.verb !== 'allow' || r.regex === null) continue;
    if (matchesAnyLine(r.regex, subject)) return true;
  }
  return false;
}

/**
 * Has this repo declared the string refused?
 *
 * FAILS CLOSED BY RETURNING "refused" when it cannot tell -- the one
 * direction that matters: when in doubt, refuse.
 */
export function refuses(conf: Conf, subject: string): { refused: boolean; failedClosed: boolean } {
  for (const r of conf.rules) {
    if (r.verb !== 'refuse') continue;
    if (r.untranslatable) return { refused: true, failedClosed: true };
    if (r.regex === null) continue;
    if (matchesAnyLine(r.regex, subject)) return { refused: true, failedClosed: false };
  }
  return { refused: false, failedClosed: false };
}

/**
 * The why for the first matching rule, so a refusal can say WHOSE rule fired
 * and a reader can find it.
 *
 * Can legitimately return the empty string: a rule whose reason is empty is
 * skipped by `loadConf`, so this cannot reach one — but a fail-closed refusal
 * has no matching rule at all, and the caller supplies its own sentence there.
 */
export function reasonFor(conf: Conf, verb: Verb, subject: string): string {
  for (const r of conf.rules) {
    if (r.verb !== verb || r.regex === null) continue;
    if (matchesAnyLine(r.regex, subject)) return r.reason;
  }
  return '';
}
