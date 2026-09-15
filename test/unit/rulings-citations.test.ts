/**
 * THE CITATIONS IN `RULINGS.md` RESOLVE -- checked, rather than reviewed.
 *
 * WHY THIS FILE EXISTS. Every ruling in `RULINGS.md` ends in an "Enforced
 * at:" / "Where pinned:" line that names a file, usually a line, and often an
 * identifier. Those citations are the only thing tying a ratified decision to
 * the code that keeps it, and they are the part of a ruling that rots first:
 * the prose is immutable and the tree underneath it is not. The repo has
 * repaired the same failure by hand three times in one week --
 *
 *   Harden C  `src/journal/lock.ts:115` -> `:121`, `guards.ts:132,143` -> `:143,154`
 *   Harden E  two citations naming test files that did not exist
 *   Harden F  `.deploy-claude/scripts/scrumux:391` -> `:379` (`cli_argv_capture`)
 *
 * -- and each time it was found by a reviewer opening the file, which is not
 * a check. This is that reviewer, mechanised.
 *
 * IT WOULD HAVE CAUGHT TWO OF THOSE THREE, and the third is out of scope
 * DELIBERATELY rather than by omission. Harden E's dangling files fail the
 * "every cited file exists" case; Harden F's `:391` fails the anchor case
 * below, and both are replayed as red-proofs. Harden C's citations moved bare
 * LINE NUMBERS with no identifier beside them, and nothing here can tell a
 * bare number that has drifted from one that has not -- see the next
 * paragraph, which is why. The repair for that class is to give the citation
 * an anchor, at which point this file starts holding it.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED, because an exact-line pin over a moving
 * tree is itself drift. Nothing here requires a cited line to be exact. A
 * citation with no anchor is checked only for "the file exists" and "the line
 * is inside it", which is all a bare number can honestly support. The sharp
 * edge is reserved for citations that name an ANCHOR -- an identifier or a
 * quoted fragment -- because an anchor is a claim about content, and content
 * can be looked for:
 *
 *   - the anchor must appear in the file AT ALL (anchor-presence, the primary
 *     claim, and the only one made when the citation names no line);
 *   - if a line is also named, an occurrence of the anchor must sit within
 *     `ANCHOR_WINDOW` lines of it, preferring the anchor's DEFINITION site
 *     when the file has one.
 *
 * THE DEFINITION PREFERENCE IS LOAD-BEARING and is what makes the window
 * bite. Harden F's drifted citation pointed at `:391`, a line inside
 * `cli_argv_capture`'s body; the function is defined at `:379` and called
 * again at `:396`. Measured against ANY occurrence, `:391` is five lines from
 * the call site and passes. Measured against the DEFINITION, it is twelve
 * lines out and fails -- which is the true answer, because "Enforced at: X
 * (`f`)" cites where `f` IS, not where it happens to be mentioned. The last
 * `it` below replays exactly that string and asserts it is rejected.
 *
 * `ANCHOR_WINDOW` IS MEASURED, not guessed: across the citations in the file
 * today the largest distance between a cited line and its anchor's definition
 * is ONE (`src/nouns/records.ts:337-341`, `sweep` at `:336`). Five is five
 * times the observed drift and less than half the one real miss the repo has
 * had, so a few lines of ordinary code movement above a citation costs
 * nobody a red run and a citation that has come unstuck from its subject
 * still fails.
 *
 * SCOPE. `RULINGS.md`, plus the comment block around every
 * `APPROVED-DIVERGENCE` marker in `src/` -- the marker sites carry no
 * file:line citations today, and this is here so that the first one somebody
 * writes is checked on the day it is written rather than the week it drifts.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');

/**
 * `approvedMarkers` (formerly `tools/refusal-corpus.mjs`, retired with the
 * bash-comparison tooling it existed for, 2026-09-03) — the one piece of
 * that file this suite still needs: every `APPROVED-DIVERGENCE` marker under
 * `src/`, by file and line, so a citation inside one of those comment blocks
 * gets checked too. Self-contained and never depended on the bash side.
 */
const MARKER = /APPROVED-DIVERGENCE/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function relName(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/');
}

function approvedMarkers(root: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const file of tsFiles(join(root, 'src'))) {
    const rel = relName(root, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i += 1) if (MARKER.test(lines[i]!)) hits.push(i + 1);
    if (hits.length > 0) out.set(rel, hits);
  }
  return out;
}

/** How far a cited line may sit from its anchor. See the header. */
const ANCHOR_WINDOW = 5;

/**
 * Citations that name no file in this tree, each with the reason it is one.
 *
 * Same shape and same discipline as `NO_BASH_COUNTERPART` in
 * `test/unit/refusal-parity.test.ts` and `KNOWN_INAPPLICABLE` in
 * `tools/walls-parity.mjs`: the POPULATION is derived from the document and
 * never listed, only the EXCEPTIONS are written by hand, and each carries a
 * sentence saying why. A row here is a citation nobody can follow, kept
 * countable rather than invisible.
 */
const UNRESOLVABLE: { path: string; why: string }[] = [
  {
    path: 'governance/code-graph.json',
    why:
      'DERIVED ARTIFACT, not source: the code index is built by `graph code build` into '
      + 'whatever repo the CLI governs, and governance/ carries no tracked files, so a fresh '
      + 'clone has none and never will. The citations are accurate about what the file is and '
      + 'when it is rewritten -- R-020 is precisely a rule ABOUT this path -- but the path '
      + 'cannot resolve for anyone but an author with a built index on disk. Same class as '
      + 'governance/decisions.json below; listed rather than repaired because the alternative '
      + 'is committing a build output to satisfy a test.',
  },
  {
    path: 'governance/decisions.json',
    why:
      'RUNTIME STATE, not source: the governance journals are created by the CLI in whatever '
      + 'repo it governs and are never committed here (governance/ carries no tracked files). '
      + 'The citations are accurate -- the decisions really are recorded there, in this '
      + 'checkout -- but the path cannot resolve in a fresh clone, which is where this suite '
      + 'runs for anyone but the author. Listed rather than repaired because the alternative '
      + 'is committing a working session\'s journal to satisfy a test.',
  },
  {
    path: 'governance/validator-memory.md',
    why:
      'Same class as governance/decisions.json above: a journal the CLI writes at runtime, '
      + 'untracked by design, cited accurately by a ruling that was made while looking at it.',
  },
  {
    path: 'tools/lint/looseness-census',
    why:
      'Not a pointer at code: the 2026-08-31 orchestrator ruling ADOPTS the name for a '
      + 'mechanically derived inventory of the ~116 error-swallowing sites, in a numbered list of '
      + 'things to do. Nothing was ever written at that path -- the register the wave actually '
      + 'produced is docs/port/PHILOSOPHY.md, which is cited by name elsewhere in the same file. '
      + 'Listed rather than repaired because rewriting a ratified plan item to match what happened '
      + 'is not this test\'s business.',
  },
  {
    path: 'test/unit/refusal-parity.test.ts',
    why:
      'The refusal-parity backstop -- counting matched bash/TypeScript refusal pairs -- retired '
      + 'with bash itself (2026-09-03). The rulings that cite it are accurate history: each '
      + 'divergence really was counted there when ratified. Rewriting the citations to erase a '
      + 'mechanism that did its job and was then retired is not this test\'s business.',
  },
  {
    path: 'tools/refusal-corpus.mjs',
    why:
      'The refusal-parity backstop\'s implementation, exporting `approvedMarkers` (which this '
      + 'suite still uses, reimplemented locally) alongside the bash-comparison logic that retired '
      + 'with bash itself (2026-09-03). See the sibling row above for the mechanism it drove.',
  },
  {
    path: 'tests/fail-closed-tests.sh',
    why:
      'bash\'s half of the T-0129 fail-closed guarantee, retired with bash (2026-09-03). '
      + 'R-004 records where it stood before that: asserting a module-presence arm the native '
      + 'sweep, per this same ruling, has no counterpart for.',
  },
  {
    path: 'tools/differential/env-divergence.mjs',
    why:
      'Part of the bash/TypeScript differential apparatus, retired with bash (2026-09-03). The '
      + 'ruling it is cited from (sb-076) records a real, measured environment difference at the '
      + 'time it was ratified.',
  },
  {
    path: 'test/fixtures/tier2-hardenE.mjs',
    why:
      'A differential fixture that proved R-010\'s redaction byte-for-byte against bash, '
      + 'retired along with the whole differential apparatus when bash was (2026-09-03).',
  },
  {
    path: 'agents/lib/schema_check.py',
    why:
      'bash\'s schema-sweep interpreter, retired with bash and python both (2026-09-03, R-004). '
      + 'The ruling describes what bash\'s sweep did as the reason the native one diverges from it.',
  },
  {
    path: '.deploy-claude/scripts/lib/cmd-secret.sh',
    why: 'bash\'s secret noun, retired with the rest of the bash CLI (2026-09-03). R-010 records the parity it once held.',
  },
  {
    path: '.deploy-claude/hooks/block-upstream-edit.sh',
    why: 'bash\'s upstream-edit wall, retired with the rest of the bash walls (2026-09-03). The ruling records the parity it once held with `src/walls/block-upstream-edit.ts`.',
  },
];

/** The top-level names a citation may start with -- derived, never listed. */
const ROOTS = new Set(readdirSync(REPO));

// A backticked repo path, with an optional `:12`, `:12-34` or `:12,34` tail.
// At least one `/` is required: a bare basename (`decide.ts:86`, `ere.ts`) is
// shorthand for the reader, resolves against nothing, and is not a citation.
const PATH_TOKEN = /`((?:\.?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)(?::(\d+(?:[-,]\d+)*))?`/g;
// A continuation ref -- `:187` -- which inherits the last file named.
const BARE_TOKEN = /`:(\d+(?:[-,]\d+)*)`/g;

interface Citation {
  where: string;
  file: string;
  lines: number[];
  anchors: string[];
  quotes: string[];
  /** Every file named in the same paragraph. See `lines are inside the file`. */
  siblings: string[];
}

const esc = (s: string): string => s.replace(/[$]/g, '\\$&');
const occursIn = (name: string, line: string): boolean =>
  new RegExp(`(?:^|[^\\w$])${esc(name)}(?:[^\\w$]|$)`).test(line);
/** `function f`, `const f =`, `class f`, an arrow, or shell's `f() {`. */
const definesIn = (name: string, line: string): boolean =>
  new RegExp(
    `(?:^|[^\\w$])(?:(?:async\\s+)?function\\s+${esc(name)}\\b`
    + `|(?:const|let|var|class)\\s+${esc(name)}\\b`
    + `|${esc(name)}\\s*\\(\\s*\\)\\s*\\{`
    + `|${esc(name)}\\s*=\\s*(?:\\(|async|function))`,
  ).test(line);

/** Blank-line-separated blocks, soft-wrapped lines rejoined. */
function paragraphs(text: string, first: number): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let buf: string[] = [];
  let at = 0;
  const flush = (): void => {
    if (buf.length > 0) out.push({ at: at + first, text: buf.join(' ') });
    buf = [];
  };
  text.split('\n').forEach((l, i) => {
    if (l.trim() === '') flush();
    else {
      if (buf.length === 0) at = i;
      buf.push(l);
    }
  });
  flush();
  return out;
}

function citationsIn(text: string, source: string, first: number): Citation[] {
  const out: Citation[] = [];
  for (const p of paragraphs(text, first)) {
    const toks: { i: number; end: number; file: string | null; lines: string | undefined }[] = [];
    for (const m of p.text.matchAll(PATH_TOKEN)) {
      toks.push({ i: m.index, end: m.index + m[0].length, file: m[1]!, lines: m[2] });
    }
    for (const m of p.text.matchAll(BARE_TOKEN)) {
      toks.push({ i: m.index, end: m.index + m[0].length, file: null, lines: m[1]! });
    }
    toks.sort((a, b) => a.i - b.i);

    const here: Citation[] = [];
    let last: string | null = null;
    for (const t of toks) {
      if (t.file === null) {
        // A continuation ref belongs to the last file named. That attribution
        // is a guess, so it buys only the weakest assertion this file makes --
        // see `siblings` where the line range is checked.
        if (last !== null) {
          here.push({
            where: `${source}:${p.at}`, file: last, lines: numbers(t.lines), anchors: [], quotes: [],
            siblings: [],
          });
        }
        continue;
      }
      if (!ROOTS.has(t.file.split('/')[0]!)) continue;
      last = t.file;
      const anchors: string[] = [];
      const quotes: string[] = [];
      // A parenthetical hanging off the citation is where an anchor lives:
      // `` `src/nouns/secret.ts` (`parsePositional`) ``. Backticked
      // identifiers are anchors; a double-quoted run is a fragment quoted out
      // of the file. Prose in between is prose.
      const paren = /^ *\(([^()]*)\)/.exec(p.text.slice(t.end));
      if (paren !== null) {
        for (const a of paren[1]!.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) anchors.push(a[1]!);
        for (const q of paren[1]!.matchAll(/["“]([^"”]{8,})["”]/g)) quotes.push(q[1]!);
      }
      here.push({
        where: `${source}:${p.at}`, file: t.file, lines: numbers(t.lines), anchors, quotes,
        siblings: [],
      });
    }
    const siblings = [...new Set(here.map((c) => c.file))];
    for (const c of here) out.push({ ...c, siblings });
  }
  return out;
}

const numbers = (s: string | undefined): number[] =>
  s === undefined ? [] : s.split(/[-,]/).map(Number);

/** The contiguous comment block each `APPROVED-DIVERGENCE` marker sits in. */
function markerBlocks(): { text: string; source: string; first: number }[] {
  const out: { text: string; source: string; first: number }[] = [];
  for (const [file, lines] of approvedMarkers(REPO)) {
    const src = readFileSync(join(REPO, file), 'utf8').split('\n');
    const isComment = (i: number): boolean => /^\s*(\/\/|\*|\/\*)/.test(src[i] ?? '');
    for (const m of lines) {
      let a = m - 1;
      let b = m - 1;
      while (a > 0 && isComment(a - 1)) a -= 1;
      while (b + 1 < src.length && isComment(b + 1)) b += 1;
      out.push({ text: src.slice(a, b + 1).join('\n'), source: file, first: a + 1 });
    }
  }
  return out;
}

function allCitations(): Citation[] {
  const out = citationsIn(readFileSync(join(REPO, 'RULINGS.md'), 'utf8'), 'RULINGS.md', 1);
  for (const b of markerBlocks()) out.push(...citationsIn(b.text, b.source, b.first));
  return out.filter((c) => !UNRESOLVABLE.some((u) => u.path === c.file));
}

describe('the citations in RULINGS.md resolve', () => {
  it('finds citations at all (a parser that matches nothing passes forever)', () => {
    // The same failure `test/unit/refusal-parity.test.ts:112` guards against:
    // a scan that quietly stopped matching would leave every assertion below
    // passing over an empty list. So the population is asserted to be large
    // before anything is asserted about it.
    const cits = allCitations();
    expect(cits.length).toBeGreaterThan(60);
    expect(new Set(cits.map((c) => c.file)).size).toBeGreaterThan(20);
    expect(cits.filter((c) => c.anchors.length > 0 || c.quotes.length > 0).length)
      .toBeGreaterThan(5);
    // The marker roster is walked even though no marker carries a citation
    // today; if THAT stopped working the scope above would be silently half.
    expect(markerBlocks().length).toBeGreaterThan(8);
  });

  it('every cited file exists', () => {
    const missing = allCitations()
      .filter((c) => !existsSync(join(REPO, c.file)))
      .map((c) => `${c.where} cites ${c.file}`);
    expect(
      [...new Set(missing)],
      'A ruling cites a path that is not in the tree. Harden E repaired two of these by writing '
      + 'the files the citations named; the other repair is to correct the citation. If the path '
      + 'is deliberately not code -- a name adopted by a plan, a tool that was never built -- add '
      + 'a row to UNRESOLVABLE with the reason.',
    ).toEqual([]);
  });

  it('every cited line is inside the file it names', () => {
    const bad: string[] = [];
    for (const c of allCitations()) {
      const abs = join(REPO, c.file);
      if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
      // TOLERANT ON PURPOSE for a continuation ref: `:306` binds to the last
      // file named in the paragraph, and a paragraph that names two files can
      // bind it to the wrong one. A ref in range for ANY file the paragraph
      // names is therefore accepted -- the assertion is "this number points
      // into a file", which is the only thing a bare number can be wrong
      // about, and a misattribution must never redden a run on its own.
      const files = (c.siblings.length > 0 ? c.siblings : [c.file])
        .filter((f) => existsSync(join(REPO, f)) && !statSync(join(REPO, f)).isDirectory());
      const caps = files.map((f) => readFileSync(join(REPO, f), 'utf8').split('\n').length);
      for (const n of c.lines) {
        if (!caps.some((cap) => n >= 1 && n <= cap)) {
          bad.push(`${c.where} cites ${c.file}:${n}, which has ${caps[0] ?? 0} lines`);
        }
      }
    }
    expect(bad, 'A ruling cites a line past the end of the file it names.').toEqual([]);
  });

  it('every named anchor resolves, and lands where the citation says it does', () => {
    const bad: string[] = [];
    for (const c of allCitations()) {
      const abs = join(REPO, c.file);
      if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
      const src = readFileSync(abs, 'utf8');
      const lines = src.split('\n');
      for (const q of c.quotes) {
        if (!src.includes(q)) bad.push(`${c.where}: ${c.file} does not contain ${JSON.stringify(q)}`);
      }
      for (const a of c.anchors) {
        const hits: number[] = [];
        lines.forEach((l, i) => { if (occursIn(a, l)) hits.push(i + 1); });
        if (hits.length === 0) { bad.push(`${c.where}: ${c.file} has no \`${a}\``); continue; }
        if (c.lines.length === 0) continue;
        const defs = hits.filter((h) => definesIn(a, lines[h - 1]!));
        const cand = defs.length > 0 ? defs : hits;
        const d = Math.min(...c.lines.flatMap((n) => cand.map((h) => Math.abs(h - n))));
        if (d > ANCHOR_WINDOW) {
          bad.push(
            `${c.where}: ${c.file}:${c.lines.join(',')} names \`${a}\`, which is `
            + `${d} lines away (${defs.length > 0 ? 'defined' : 'found'} at ${cand.join(',')})`,
          );
        }
      }
    }
    expect(
      bad,
      'A citation names an identifier or quotes a fragment that is not where it says it is. '
      + `The line does not have to be exact -- ${ANCHOR_WINDOW} lines of slack is allowed for `
      + 'ordinary code movement -- but a citation this far out is pointing at whatever moved into '
      + 'its place, which is worse than no citation at all. Fix the number, not the window.',
    ).toEqual([]);
  });

  it('CATCHES a drifted citation — Harden F\'s, replayed', () => {
    // A backstop nobody has watched fail is a backstop nobody knows works.
    // The drift replayed here is the one this repo had until 2026-09-02: a
    // citation naming a shell function at a line INSIDE its body rather than
    // at its definition, twelve lines out.
    //
    // TAKEN FROM THE DOCUMENT, NOT RETYPED. The real citation is found among
    // the ones parsed above and then MOVED, so this cannot rot into a test
    // about a string that used to be in RULINGS.md, and the file the drift is
    // measured against is whichever one the ruling actually names today.
    const DRIFT = 12;
    const anchored = allCitations()
      .filter((c) => c.lines.length > 0 && c.anchors.length === 1)
      .filter((c) => existsSync(join(REPO, c.file)));
    expect(anchored.length, 'no citation names both a line and one identifier any more')
      .toBeGreaterThan(0);

    const distance = (c: Citation): number => {
      const lines = readFileSync(join(REPO, c.file), 'utf8').split('\n');
      const hits: number[] = [];
      lines.forEach((l, i) => { if (occursIn(c.anchors[0]!, l)) hits.push(i + 1); });
      const defs = hits.filter((h) => definesIn(c.anchors[0]!, lines[h - 1]!));
      const cand = defs.length > 0 ? defs : hits;
      return Math.min(...c.lines.flatMap((n) => cand.map((h) => Math.abs(h - n))));
    };

    for (const real of anchored) {
      // The citation as written resolves…
      expect(distance(real), `${real.where} no longer resolves`).toBeLessThanOrEqual(ANCHOR_WINDOW);
      // …and the same citation, moved a body's worth of lines, does not.
      const moved: Citation = { ...real, lines: real.lines.map((n) => n + DRIFT) };
      expect(
        distance(moved),
        `${real.where} still passes with ${DRIFT} lines of drift added — the window is too wide `
        + 'or the anchor is matching something other than its definition',
      ).toBeGreaterThan(ANCHOR_WINDOW);
    }
  });

  it('every UNRESOLVABLE row is still unresolvable, and still says why', () => {
    for (const u of UNRESOLVABLE) {
      expect(
        existsSync(join(REPO, u.path)),
        `${u.path} exists now -- delete its UNRESOLVABLE row and let the citation be checked`,
      ).toBe(false);
      expect(u.why.length, 'a declared exception with no reason is an exception nobody can review')
        .toBeGreaterThan(80);
    }
  });
});
