/**
 * THE PAYLOAD SKILLS AND THE CLI CONTRACT DO NOT DRIFT APART -- checked,
 * rather than reviewed.
 *
 * WHY THIS FILE EXISTS. `.deploy-claude/skills/*\/SKILL.md` is the procedure a
 * deployed session follows, and the commands printed in its fenced blocks are
 * meant to be TYPED. They are the only part of the payload that names the CLI
 * by verb and flag, and they are the part that rots first: the prose is stable
 * and the argv contract underneath it is not. Nothing was checking, so nothing
 * caught it when `sprint ratify` gained two REQUIRED flags and the session-open
 * skill kept printing the two-word form.
 *
 * THE MEASURED FAILURE, and it is the red-proof at the bottom of this file. On
 * the 2026-09-02 end-to-end operator run the agent reached step 4 of
 * session-open, typed the line the skill prints --
 *
 *     .claude/scripts/scrumux sprint ratify SP-XXXX
 *
 * -- and was refused: `sprint ratify: --by is required`. That refusal is a good
 * one (it names what is missing and both legitimate answers), but the agent had
 * been sent at it by the harness's own instructions, at the one step where the
 * User is watching. A skill that prints a command the CLI refuses is
 * an Article 5 defect one level up: the instruction set itself is wrong.
 *
 * WHAT IS ASSERTED, and it is deliberately narrow:
 *
 *   1. the NOUN exists;
 *   2. the VERB exists for it;
 *   3. every flag the noun's own usage block marks REQUIRED is present.
 *
 * WHAT IS NOT ASSERTED, on purpose. Flag VALUES are not checked -- a skill
 * writes `--verdict ...` and an ellipsis is the right thing for a skill to
 * write. Unknown flags are not rejected either: the usage synopsis is a summary
 * and this test is not a second parser. The claim is only "a reader who types
 * this line is not refused for something the skill could have told them", which
 * is the failure that actually happened.
 *
 * REQUIREDNESS COMES FROM `scrumux help <noun>`, NEVER FROM A LIST HERE. The
 * usage blocks are themselves GENERATED from bash (`tools/gen-usage.mjs`), so
 * the chain is skill -> usage -> bash, with no hand-maintained copy anywhere in
 * it (D-0010: a second copy is free to drift). A flag outside `[...]` in a
 * synopsis is required; a flag inside is not. Alternative forms separated by
 * ` | ` are satisfied by ANY one of them -- `sprint new` takes `--epic` OR
 * `--hotfix --issue`, and a skill naming either is correct.
 *
 * WHAT COUNTS AS A COMMAND, and why it is not just the fenced blocks. A fence
 * is the skill's own signal that a line is meant to be typed, so every fenced
 * `scrumux ...` line is read. But the drift is not confined to fences: the
 * session-start skill routes the agent to `scrumux task accept T-XXXX
 * --authority "..."` from inside a TABLE CELL, and that line was missing
 * `--by` for exactly as long as session-open's ratify line was. So a BACKTICKED
 * span is read too -- but only when it carries at least one `--flag`, which is
 * the line between a full command being quoted and prose naming a verb.
 * `scrumux sprint add` mid-sentence names the verb and is skipped; a check that
 * read those would be measuring English.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { nounKnown, usageNoun } from '../../src/cli/usage.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const SKILLS = join(CHECKOUT, '.deploy-claude/skills');

/** One CLI line lifted out of a skill's fenced block. */
interface Invocation {
  skill: string;
  line: number;
  /** The command as it appears, continuations joined. */
  text: string;
  /** argv after `scrumux`, with the `.claude/scripts/` prefix dropped. */
  words: string[];
}

/** `--flag` tokens present in an invocation. */
function flagsOf(words: readonly string[]): Set<string> {
  return new Set(words.filter((w) => /^--[a-z][a-z-]*$/.test(w)));
}

/**
 * Split a command line into words the way a reader does -- quoted runs stay
 * together, and everything inside them is opaque. `--file "path | why"` is one
 * flag and one value, not a pipe.
 */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[0]);
  return out;
}

/**
 * Every `scrumux ...` line inside a fenced block, continuations joined.
 *
 * A line ending in `\` continues onto the next, which is how every multi-flag
 * example in these skills is written; read one line at a time, `task order`
 * would look like it carries no flags at all.
 */
function invocations(skill: string, src: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = src.split('\n');
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    if (!fenced) {
      // A backticked span carrying a flag is a full command being quoted.
      for (const span of raw.match(/`[^`]+`/g) ?? []) {
        const inner = span.slice(1, -1);
        const b = /^(?:[.a-zA-Z0-9_/-]*\/)?scrumux\s+(.*)$/.exec(inner.trim());
        if (b === null) continue;
        const w = words(b[1]!);
        if (flagsOf(w).size === 0) continue;
        out.push({ skill, line: i + 1, text: b[1]!.trim(), words: w });
      }
      continue;
    }
    const m = /^\s*(?:[.a-zA-Z0-9_/-]*\/)?scrumux\s+(.*)$/.exec(raw);
    if (m === null) continue;
    let text = m[1]!;
    let j = i;
    while (text.endsWith('\\') && j + 1 < lines.length) {
      text = text.slice(0, -1) + ' ' + (lines[j + 1] ?? '').trim();
      j += 1;
    }
    // A trailing `#` comment is documentation, not argv.
    text = text.replace(/\s+#\s.*$/, '').trim();
    out.push({ skill, line: i + 1, text, words: words(text) });
    i = j;
  }
  return out;
}

/** A synopsis entry: its literal leading words, and the flags it requires. */
interface Synopsis {
  /** e.g. ['graph', 'code', 'callers'] -- the words a caller types verbatim. */
  literal: string[];
  /** One set per alternative form; satisfying ANY of them is enough. */
  required: Set<string>[];
}

/** `[...]` marks optional. Removed innermost-first so nesting cannot survive. */
function stripOptional(s: string): string {
  let prev = '';
  let cur = s;
  while (cur !== prev) { prev = cur; cur = cur.replace(/\[[^[\]]*\]/g, ' '); }
  return cur;
}

/** Quoted runs are opaque -- their contents are example text, never argv. */
const stripQuoted = (s: string): string => s.replace(/"[^"]*"|'[^']*'/g, ' ');

/**
 * The synopsis entries in `scrumux help <noun>`.
 *
 * An entry starts at a line reading `  scrumux <noun> ...` and swallows the
 * more-indented lines under it, which is how a long form like `task order`
 * wraps its flags.
 */
function synopses(noun: string): Synopsis[] {
  const out: Synopsis[] = [];
  const lines = usageNoun(noun).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^ {2}scrumux\s+(.*)$/.exec(lines[i]!);
    if (head === null) continue;
    let body = head[1]!;
    // A continuation is more-indented argv. A PARENTHESISED continuation is
    // PROSE about the form above it -- `(superseded needs --reason TEXT,
    // optionally --by T-0002)` under `task status`, `(drift|idea|governance:
    // User/human only)` under `issue new` -- and reading those as argv made
    // this file demand `--reason` of every `task status` line in the payload.
    while (i + 1 < lines.length
      && /^ {6,}\S/.test(lines[i + 1]!)
      && !/^ {2}scrumux\s/.test(lines[i + 1]!)
      && !/^\s*\(/.test(lines[i + 1]!)) {
      body += ' ' + lines[i + 1]!.trim();
      i += 1;
    }
    // The literal prefix: the lowercase words before the first placeholder,
    // flag or bracket. `task order T-0001 --scope ...` -> ['task','order'].
    // It can run PAST the verb into a description column -- `status session
    // orientation block; ALWAYS exits 0` -- which is why the matcher below
    // scores a prefix rather than demanding the whole of it.
    const literal: string[] = [];
    for (const w of body.split(/\s+/)) {
      if (/^[a-z][a-z-]*$/.test(w)) literal.push(w);
      else break;
    }
    const bare = stripOptional(stripQuoted(body));
    out.push({
      literal,
      required: bare.split(/\s\|\s/).map((alt) => flagsOf(alt.split(/\s+/))),
    });
  }
  return out;
}

/**
 * The synopsis sharing the LONGEST leading run of literal words with this line.
 *
 * Scored rather than all-or-nothing, because a synopsis's literal run can spill
 * into its description column (`status session orientation block`) and because
 * one noun's entries differ only after the verb -- `graph code callers <file>`
 * has to win over `graph code build` for a `callers` line. Two words are the
 * floor: noun and verb both have to be there for the match to mean anything.
 */
function matchSynopsis(all: readonly Synopsis[], w: readonly string[]): Synopsis | null {
  let best: Synopsis | null = null;
  let bestK = 1;
  for (const s of all) {
    let k = 0;
    while (k < s.literal.length && w[k] === s.literal[k]) k += 1;
    if (k > bestK) { bestK = k; best = s; }
  }
  return best;
}

/** One human-readable complaint, or '' when the line is fine. */
export function checkInvocation(inv: Invocation): string {
  const noun = inv.words[0] ?? '';
  if (noun === '') return '';
  // `help` and `version` are the dispatcher's own surface, not a noun with a
  // usage block to measure against.
  if (noun === 'help' || noun === 'version') return '';
  if (!nounKnown(noun)) return `unknown noun '${noun}'`;

  const all = synopses(noun);
  const syn = matchSynopsis(all, inv.words);
  if (syn === null) {
    const verb = inv.words[1] ?? '(none)';
    return `no '${noun} ${verb}' in scrumux help ${noun}`;
  }
  const have = flagsOf(inv.words);
  const missing = syn.required
    .map((req) => [...req].filter((f) => !have.has(f)))
    .sort((a, b) => a.length - b.length)[0] ?? [];
  if (missing.length === 0) return '';
  return `${syn.literal.join(' ')} is missing required ${missing.join(' ')}`;
}

function allSkills(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  for (const d of readdirSync(SKILLS).sort()) {
    const p = join(SKILLS, d, 'SKILL.md');
    try {
      if (!statSync(p).isFile()) continue;
    } catch { continue; }
    out.push({ name: d, src: readFileSync(p, 'utf8') });
  }
  return out;
}

describe('the payload skills type commands the CLI accepts', () => {
  const skills = allSkills();

  it('finds the skills and their fenced CLI lines at all', () => {
    // Without this the whole file is satisfied by reading nothing -- the
    // failure mode every source-scanning meta-test has.
    expect(skills.length).toBeGreaterThan(3);
    const total = skills.reduce((n, s) => n + invocations(s.name, s.src).length, 0);
    expect(total).toBeGreaterThan(15);
  });

  it('every fenced `scrumux <noun> <verb>` line names a real verb and carries its required flags', () => {
    const bad: string[] = [];
    for (const s of skills) {
      for (const inv of invocations(s.name, s.src)) {
        const why = checkInvocation(inv);
        if (why !== '') bad.push(`${s.name}/SKILL.md:${inv.line}  ${why}\n    ${inv.text}`);
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  // ------------------------------------------------------------ red-proof ---
  // The measured failure, replayed as a string so the check is shown biting
  // rather than asserted to bite. If a later change makes this pass, the test
  // above has stopped holding anything.
  it('REJECTS the exact line the E2E run was refused on', () => {
    const inv: Invocation = {
      skill: 'session-open',
      line: 138,
      text: 'sprint ratify SP-XXXX',
      words: ['sprint', 'ratify', 'SP-XXXX'],
    };
    expect(checkInvocation(inv)).toBe('sprint ratify is missing required --by --authority');
  });

  it('ACCEPTS the same line once it carries them', () => {
    const inv: Invocation = {
      skill: 'session-open',
      line: 138,
      text: 'sprint ratify SP-XXXX --by User --authority direct',
      words: ['sprint', 'ratify', 'SP-XXXX', '--by', 'User', '--authority', 'direct'],
    };
    expect(checkInvocation(inv)).toBe('');
  });

  it('reads an OPTIONAL flag as optional, and an alternative form as satisfied by either', () => {
    // `sprint new --epic E-0001 [--parallel N] | --hotfix --issue I-0001`.
    // Both arms are legitimate and neither wants the other's flags.
    expect(checkInvocation({ skill: 'x', line: 0, text: '', words: ['sprint', 'new', '--epic', 'E-0001'] })).toBe('');
    expect(checkInvocation({ skill: 'x', line: 0, text: '', words: ['sprint', 'new', '--hotfix', '--issue', 'I-0001'] })).toBe('');
    expect(checkInvocation({ skill: 'x', line: 0, text: '', words: ['sprint', 'new'] }))
      .toBe('sprint new is missing required --epic');
  });

  it('rejects a verb that does not exist, and a noun that does not', () => {
    expect(checkInvocation({ skill: 'x', line: 0, text: '', words: ['sprint', 'unratify', 'SP-0001'] }))
      .toBe("no 'sprint unratify' in scrumux help sprint");
    expect(checkInvocation({ skill: 'x', line: 0, text: '', words: ['sprocket', 'new'] }))
      .toBe("unknown noun 'sprocket'");
  });
});
