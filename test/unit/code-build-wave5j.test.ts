/**
 * WAVE 5J — the tree-sitter code-graph BUILDER.
 *
 * WHAT LIVES HERE RATHER THAN IN THE DIFFERENTIAL, and why each one has to.
 *
 *   THE TEN LANGUAGES THE PYTHON BUILDER CANNOT PARSE. `pyproject.toml`
 *   declares tree-sitter-python and tree-sitter-bash and nothing else, so
 *   go/rust/ruby/php/java/c/cpp/c_sharp/javascript/typescript are `skipped`
 *   there and indexed here. That is a dependency-manifest difference, not a
 *   logic one; a differential case over such a tree would report red and
 *   certify nothing. So the extraction for all twelve is asserted PER SIDE,
 *   here, against the node-type table each language actually has.
 *
 *   THE STALENESS LOOP. `graph code index`'s rebuild arm indexes
 *   `$GRAPH_HARNESS` — this checkout — which is not a parameter of the verb
 *   and therefore cannot be equalised between the two grammar sets. bash's
 *   half is covered by tests/code-graph-tests.sh:217-221; this is ours.
 *
 *   THE SERIALIZER. `json.dumps(indent=2, ensure_ascii=False)` is reproduced
 *   by hand (see src/nouns/graph/code-build.ts, header item 5) and the cases
 *   it must get right — an integral float, an empty container, a control
 *   character, a non-ASCII string — are not all reachable from a fixture
 *   tree, so they are asserted on the function.
 *
 * Every test drives `buildCodeGraph` directly. The CLI arm spawns a child
 * process running the BUNDLE, which does not exist until `npm run build`, and
 * a unit test that silently skipped when the bundle was absent would be a
 * test that reports green having run nothing.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodeGraph, cmpCodePoint, purePosixName, serializeIndex, writeIndex,
  type CodeGraph, type Provenance,
} from '../../src/nouns/graph/code-build.js';
import { isStaleGraph, loadIndex } from '../../src/nouns/graph/code-index.js';

/** This checkout — where `tools/grammars` and the web-tree-sitter runtime are. */
const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const roots: string[] = [];
function treeOf(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'scrumux-cg-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
function cleanup(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

const build = (files: Record<string, string>): Promise<CodeGraph> =>
  buildCodeGraph(treeOf(files), CHECKOUT);

const symbolIds = (g: CodeGraph): string[] => [...g.symbols.keys()].sort();
const edgeKeys = (g: CodeGraph): string[] =>
  g.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`).sort();

// ------------------------------------------------------ the twelve rows ---

describe('extraction, one language at a time', () => {
  /**
   * ONE BUILD FOR ALL TWELVE, not twelve builds: `Parser.init()` brings the
   * emscripten runtime up once per process and every grammar loads into it,
   * so a per-language build would re-enter that path twelve times to assert
   * the same registry. The tree is one file per language, and the assertion
   * is per language.
   */
  it('finds the definition node each language actually uses', async () => {
    const g = await build({
      'a.py': 'def py_fn():\n    return helper_py()\n\ndef helper_py():\n    return 1\n',
      'b.sh': '#!/bin/sh\nsh_fn() { sh_helper; }\nsh_helper() { echo hi; }\n',
      'c.js': 'function js_fn() { return js_helper(); }\nfunction js_helper() { return 1; }\n',
      'd.ts': 'export function ts_fn(): number { return ts_helper(); }\n'
        + 'function ts_helper(): number { return 1; }\n',
      'e.go': 'package main\n\nfunc go_fn() int { return go_helper() }\n\nfunc go_helper() int { return 1 }\n',
      'f.rs': 'fn rs_fn() -> i32 { rs_helper() }\nfn rs_helper() -> i32 { 1 }\n',
      'g.rb': 'def rb_fn\n  rb_helper\nend\n\ndef rb_helper\n  1\nend\n',
      'h.php': '<?php\nfunction php_fn() { return php_helper(); }\nfunction php_helper() { return 1; }\n',
      'i.java': 'class I {\n  int javaFn() { return javaHelper(); }\n  int javaHelper() { return 1; }\n}\n',
      'j.c': 'int c_helper(void) { return 1; }\nint c_fn(void) { return c_helper(); }\n',
      'k.cpp': 'int cpp_helper() { return 1; }\nint cpp_fn() { return cpp_helper(); }\n',
      'l.cs': 'class L {\n  int CsHelper() { return 1; }\n  int CsFn() { return CsHelper(); }\n}\n',
    });

    // Every language contributes its files and its parse status even when the
    // node-type table finds nothing in it -- that is the `skipped`/`empty`
    // distinction the coverage block exists to keep.
    expect(g.parse_errors).toEqual([]);
    expect(Object.fromEntries(g.coverage.by_language)).toEqual({
      bash: 1, c: 1, c_sharp: 1, cpp: 1, go: 1, java: 1, javascript: 1,
      php: 1, python: 1, ruby: 1, rust: 1, typescript: 1,
    });

    // TEN OF THE TWELVE YIELD SYMBOLS. `c` and `cpp` yield NONE, and that is
    // the shared registry's behaviour rather than this port's.
    // `_definition_name` (code_graph.py:221-230) special-cases ONLY python;
    // for every other language it scans the children for a node of type
    // `word` -- which is what serves bash, and which fires nowhere else --
    // and then falls back to the `name` FIELD. The c and cpp
    // `function_definition` has no `name` field: the identifier sits under
    // `declarator`, inside a `function_declarator`. Measured against these
    // exact blobs, `(function_definition type: (primitive_type) declarator:
    // (function_declarator declarator: (identifier) …))`.
    //
    // The Python registry has the same table and the same gap; it has simply
    // never been exercised, because tree-sitter-c is not a declared
    // dependency there. Recorded as the current truth. Repairing it would
    // change a table both implementations read, with no bash behaviour to
    // compare the repair to.
    expect(symbolIds(g)).toEqual([
      'a.py::helper_py', 'a.py::py_fn',
      'b.sh::sh_fn', 'b.sh::sh_helper',
      'c.js::js_fn', 'c.js::js_helper',
      'd.ts::ts_fn', 'd.ts::ts_helper',
      'e.go::go_fn', 'e.go::go_helper',
      'f.rs::rs_fn', 'f.rs::rs_helper',
      'g.rb::rb_fn', 'g.rb::rb_helper',
      'h.php::php_fn', 'h.php::php_helper',
      'i.java::javaFn', 'i.java::javaHelper',
      'l.cs::CsFn', 'l.cs::CsHelper',
    ]);
  });

  /**
   * THE CALL SIDE IS NARROWER STILL, AND IT IS THE SAME CAUSE.
   * `_callee_name` (`:233`) reads the `name` FIELD for every language but
   * python, which reads `function`. Measured against these exact blobs, of
   * the four node types in `_DEFAULT_CALL_NODES` only java's
   * `method_invocation` actually has a `name` field:
   *
   *   javascript, typescript, go, rust, c, cpp   `call_expression`, field `function`
   *   php                     `function_call_expression`, field `function`
   *   ruby                    `call`, field `method`
   *   c_sharp                 `invocation_expression` — not in the list at all
   *
   * So three languages produce call edges -- python (its own branch), bash
   * (`command`, whose field IS `name`) and java -- and the rest produce
   * definitions and no edges.
   *
   * ASSERTED, NOT FIXED, for the reason above: the table is shared with the
   * Python builder, which cannot reach any of these rows today, so a "fix"
   * here would be a divergence invented by the port. It is the most useful
   * thing this wave learned about the registry and it belongs in a report,
   * not in a quiet edit.
   */
  it('produces call edges for exactly the three languages whose call node has a name field', async () => {
    const g = await build({
      'a.py': 'def py_fn():\n    return helper_py()\n\ndef helper_py():\n    return 1\n',
      'b.sh': '#!/bin/sh\nsh_fn() { sh_helper; }\nsh_helper() { echo hi; }\n',
      'c.js': 'function js_fn() { return js_helper(); }\nfunction js_helper() { return 1; }\n',
      'e.go': 'package main\n\nfunc go_fn() int { return go_helper() }\n\nfunc go_helper() int { return 1 }\n',
      'f.rs': 'fn rs_fn() -> i32 { rs_helper() }\nfn rs_helper() -> i32 { 1 }\n',
      'h.php': '<?php\nfunction php_fn() { return php_helper(); }\nfunction php_helper() { return 1; }\n',
      'i.java': 'class I {\n  int javaFn() { return javaHelper(); }\n  int javaHelper() { return 1; }\n}\n',
      'l.cs': 'class L {\n  int CsHelper() { return 1; }\n  int CsFn() { return CsHelper(); }\n}\n',
    });
    expect(edgeKeys(g)).toEqual([
      'a.py::py_fn -calls-> a.py::helper_py',
      'b.sh::sh_fn -calls-> b.sh::sh_helper',
      'i.java::javaFn -calls-> i.java::javaHelper',
    ]);
    // and the languages with no edge still contributed every definition
    expect(g.symbols.size).toBe(16);
  });
});

// ------------------------------------------------- the offsets that bite ---

describe('UTF-16 offsets', () => {
  /**
   * The single check Spike C called the one most worth having. A byte-offset
   * port extracts a name shifted by the number of extra BYTES the characters
   * above it occupy; here that is 4 (astral rocket) + 3 (check mark) + 2
   * (e-acute) + 3 (em dash) and the name would come out mangled rather than
   * missing.
   */
  it('slices the string the parser indexed, not the bytes behind it', async () => {
    const g = await build({
      'u.sh': '#!/bin/sh\necho "✅ ok 🚀 done — café"\nmy_func() { echo hi; }\n',
      'u.py': 'LABEL = "✅ 🚀 café — 𝔘𝔫𝔦𝔠𝔬𝔡𝔢"\ndef my_py_func():\n    return LABEL\n',
    });
    expect(symbolIds(g)).toEqual(['u.py::my_py_func', 'u.sh::my_func']);
    expect(g.symbols.get('u.sh::my_func')!.line).toBe(3);
    expect(g.symbols.get('u.py::my_py_func')!.line).toBe(2);
  });
});

// ------------------------------------------------------- the two controls ---

describe('the noise controls (they are the point, not a simplification)', () => {
  it('resolves a colliding helper name to the definition in its OWN file', async () => {
    const g = await build({
      'tests/one-tests.sh': '#!/bin/sh\nok() { echo one; }\nrun_one() { ok; }\n',
      'tests/two-tests.sh': '#!/bin/sh\nok() { echo two; }\nrun_two() { ok; }\n',
    });
    expect(edgeKeys(g)).toEqual([
      'tests/one-tests.sh::run_one -calls-> tests/one-tests.sh::ok',
      'tests/two-tests.sh::run_two -calls-> tests/two-tests.sh::ok',
    ]);
  });

  it('drops a name with several candidates and no same-file definition', async () => {
    const g = await build({
      'a.sh': '#!/bin/sh\nok() { echo a; }\n',
      'b.sh': '#!/bin/sh\nok() { echo b; }\n',
      'c.sh': '#!/bin/sh\ncaller() { ok; }\n',
    });
    // Ambiguous: two `ok` definitions, none of them in c.sh. Dropped ENTIRELY
    // (code_graph.py:414), which is why a genuine cross-file call to an
    // ambiguously-named helper is not in this graph and a uniquely-named one
    // would be.
    expect(edgeKeys(g)).toEqual([]);
  });

  it('keeps a cross-file call when the name is unique', async () => {
    const g = await build({
      'a.sh': '#!/bin/sh\nonly_one() { echo a; }\n',
      'c.sh': '#!/bin/sh\ncaller() { only_one; }\n',
    });
    expect(edgeKeys(g)).toEqual(['c.sh::caller -calls-> a.sh::only_one']);
  });

  it('drops external commands, which is what makes the graph usable', async () => {
    const g = await build({ 'a.sh': '#!/bin/sh\nf() { printf x; grep y; jq .; }\n' });
    expect(g.edges).toEqual([]);
  });
});

describe('the file-to-file edges', () => {
  it('turns `. lib.sh` into a sources edge and a bare script name into invokes', async () => {
    const g = await build({
      'scripts/lib.sh': '#!/bin/sh\nshared() { echo hi; }\n',
      'scripts/alpha': '#!/bin/sh\n. "$(dirname -- "$0")/lib.sh"\nalpha_main() { shared; }\n',
      'scripts/beta.sh': '#!/bin/sh\n. "$(dirname -- "$0")/lib.sh"\nbeta_main() { alpha; }\n',
    });
    expect(edgeKeys(g)).toEqual([
      'scripts/alpha -sources-> scripts/lib.sh',
      'scripts/alpha::alpha_main -calls-> scripts/lib.sh::shared',
      'scripts/beta.sh -sources-> scripts/lib.sh',
      'scripts/beta.sh::beta_main -invokes-> scripts/alpha',
    ]);
  });

  it('turns a python import into a sources edge', async () => {
    const g = await build({
      'pkg/core.py': 'def core_fn():\n    return 1\n',
      'pkg/user.py': 'import pkg.core\ndef user_fn():\n    return pkg.core.core_fn()\n',
    });
    expect(edgeKeys(g)).toEqual([
      'pkg/user.py -sources-> pkg/core.py',
      'pkg/user.py::user_fn -calls-> pkg/core.py::core_fn',
    ]);
  });
});

// --------------------------------------------------------------- coverage ---

describe('coverage and parse status', () => {
  it('counts a non-source file rather than dropping it', async () => {
    const g = await build({
      'a.sh': '#!/bin/sh\nf() { echo hi; }\n',
      'README.md': 'prose\n',
      'data.json': '{}\n',
    });
    expect(g.coverage.indexed).toBe(1);
    expect(g.coverage.not_source).toBe(2);
    expect(g.coverage.skipped).toEqual([]);
  });

  it('names a file that does not parse and still indexes it', async () => {
    const g = await build({
      'good.sh': '#!/bin/sh\ngood_fn() { echo hi; }\n',
      'bad.sh': '#!/bin/sh\ngood2() { echo hi; }\nif [ 1 ; then\n',
    });
    expect(g.parse_errors).toEqual(['bad.sh']);
    expect(g.files).toEqual(['bad.sh', 'good.sh']);
    expect(g.symbols.has('good.sh::good_fn')).toBe(true);
  });

  /**
   * PER-SIDE ASSERTION, and the whole reason this file exists. The Python
   * builder over this same tree reports two `skipped` rows and one indexed
   * file; this one reports none and three. Nothing here is a defect on either
   * side -- it is the grammar SET, and the fact is recorded so that a change
   * to it has to change a test.
   */
  it('indexes languages the Python builder reports as skipped (the grammar-set divergence)', async () => {
    const g = await build({
      'a.sh': '#!/bin/sh\nf() { echo hi; }\n',
      'b.go': 'package main\n\nfunc go_fn() {}\n',
      'c.rs': 'fn rs_fn() {}\n',
    });
    expect(g.coverage.skipped).toEqual([]);
    expect(g.coverage.indexed).toBe(3);
    expect(symbolIds(g)).toEqual(['a.sh::f', 'b.go::go_fn', 'c.rs::rs_fn']);
  });
});

// ------------------------------------------------------------- staleness ---

describe('the build/staleness loop (bash\'s half is code-graph-tests.sh:217-221)', () => {
  it('a fresh index is current, an edited source makes it stale, a rebuild clears it', async () => {
    const root = treeOf({ 'a.sh': '#!/bin/sh\nf() { echo hi; }\n' });
    const idx = join(root, 'governance/code-graph.json');

    writeIndex(await buildCodeGraph(root, CHECKOUT), idx);
    expect(isStaleGraph(loadIndex(idx), root)[0]).toBe(false);

    // A source written AFTER the stamp. The stamp is a float precisely so a
    // file written at t=x.9 does not compare greater than int(x) (:479).
    const src = join(root, 'a.sh');
    writeFileSync(src, '#!/bin/sh\nf() { echo hi; }\ng() { f; }\n');
    const later = Date.now() / 1000 + 5;
    utimesSync(src, later, later);
    const [stale, why] = isStaleGraph(loadIndex(idx), root);
    expect(stale).toBe(true);
    expect(why).toContain('a.sh');

    // Put the mtime back inside the past before rebuilding: a source stamped
    // in the FUTURE stays newer than any stamp a rebuild can write, and the
    // index would be correctly stale forever. That is the check working, not
    // a fixture detail worth hiding.
    const now = Date.now() / 1000 - 1;
    utimesSync(src, now, now);
    writeIndex(await buildCodeGraph(root, CHECKOUT), idx);
    const g = loadIndex(idx);
    expect(isStaleGraph(g, root)[0]).toBe(false);
    expect(Object.keys(g['symbols'] as Record<string, unknown>).sort())
      .toEqual(['a.sh::f', 'a.sh::g']);
  });

  it('a deleted indexed file is stale even though no surviving mtime moved (I-0085)', async () => {
    const root = treeOf({
      'a.sh': '#!/bin/sh\nf() { echo hi; }\n',
      'b.sh': '#!/bin/sh\ng() { echo hi; }\n',
    });
    const idx = join(root, 'governance/code-graph.json');
    writeIndex(await buildCodeGraph(root, CHECKOUT), idx);
    rmSync(join(root, 'b.sh'));
    const [stale, why] = isStaleGraph(loadIndex(idx), root);
    expect(stale).toBe(true);
    expect(why).toContain('no longer on disk');
  });
});

// ------------------------------------------------------------ serializer ---

describe('serializeIndex reproduces json.dumps(indent=2, ensure_ascii=False)', () => {
  const prov = (over: Partial<Provenance> = {}): Provenance => ({
    built_at: '2026-09-01T00:00:00Z',
    built_at_epoch: 1788296329.238313,
    commit: 'unknown — the indexed tree is not a git checkout',
    dirty: false,
    root: '/r',
    builder: 'scrumux graph code build',
    ...over,
  });
  const empty = (over: Partial<CodeGraph> = {}): CodeGraph => ({
    root: '/r',
    files: [],
    symbols: new Map(),
    edges: [],
    parse_errors: [],
    coverage: { indexed: 0, by_language: new Map(), skipped: [], not_source: 0 },
    provenance: prov(),
    ...over,
  });

  it('writes empty containers as two characters, as json.dumps does', () => {
    const text = serializeIndex(empty());
    expect(text).toContain('"files": []');
    expect(text).toContain('"symbols": {}');
    expect(text).toContain('"by_language": {}');
    expect(text).toContain('"skipped": []');
  });

  it('renders an INTEGRAL float with its .0, where JSON.stringify drops it', () => {
    const text = serializeIndex(empty({ provenance: prov({ built_at_epoch: 1788296329 }) }));
    expect(text).toContain('"built_at_epoch": 1788296329.0');
    expect(JSON.stringify({ x: 1788296329 })).toBe('{"x":1788296329}'); // the trap
  });

  it('emits non-ASCII raw and escapes only what Python escapes', () => {
    const text = serializeIndex(empty({ files: ['café/🚀.sh', 'a"b\\c\td\u0001e'] }));
    expect(text).toContain('"café/🚀.sh"');
    expect(text).toContain('"a\\"b\\\\c\\td\\u0001e"');
  });

  it('preserves the symbol map in INSERTION order, not sorted', () => {
    const symbols = new Map([
      ['z.sh::zed', { id: 'z.sh::zed', name: 'zed', file: 'z.sh', lang: 'bash', line: 9 }],
      ['a.sh::ay', { id: 'a.sh::ay', name: 'ay', file: 'a.sh', lang: 'bash', line: 1 }],
    ]);
    const text = serializeIndex(empty({ symbols }));
    expect(text.indexOf('"z.sh::zed"')).toBeLessThan(text.indexOf('"a.sh::ay"'));
  });

  it('parses back to the same object it described', () => {
    const g = empty({
      files: ['a.sh'],
      symbols: new Map([['a.sh::f', { id: 'a.sh::f', name: 'f', file: 'a.sh', lang: 'bash', line: 2 }]]),
      edges: [{ from: 'a.sh::f', to: 'a.sh::g', kind: 'calls' }],
      parse_errors: ['a.sh'],
      coverage: {
        indexed: 1,
        by_language: new Map([['bash', 1]]),
        skipped: [{ language: 'go', files: 2, reason: 'why', examples: ['x.go', 'y.go'] }],
        not_source: 3,
      },
    });
    const back = JSON.parse(serializeIndex(g)) as Record<string, unknown>;
    expect(Object.keys(back)).toEqual([
      'root', 'files', 'symbols', 'edges', 'parse_errors', 'coverage', 'provenance',
    ]);
    expect(back['coverage']).toEqual({
      indexed: 1,
      by_language: { bash: 1 },
      skipped: [{ language: 'go', files: 2, reason: 'why', examples: ['x.go', 'y.go'] }],
      not_source: 3,
    });
  });
});

// --------------------------------------------------------------- helpers ---

describe('the two path/order helpers Python spells differently', () => {
  it('purePosixName is PurePosixPath(...).name, not basename', () => {
    expect(purePosixName('./gov')).toBe('gov');
    expect(purePosixName('a/b/')).toBe('b');
    expect(purePosixName('/')).toBe('');
    expect(purePosixName('.claude/scripts/scrumux')).toBe('scrumux');
    expect(purePosixName('plain')).toBe('plain');
  });

  it('cmpCodePoint orders by code point, where JS < orders by code unit', () => {
    // U+1D11E (astral) is GREATER than U+FFFD by code point and LESS by the
    // UTF-16 comparison, because its high surrogate is U+D834.
    expect(cmpCodePoint('\u{1D11E}', '�')).toBe(1);
    expect('\u{1D11E}' < '�').toBe(true);
    expect(cmpCodePoint('a', 'b')).toBe(-1);
    expect(cmpCodePoint('a', 'a')).toBe(0);
    expect(cmpCodePoint('ab', 'a')).toBe(1);
  });
});

/**
 * The two source-level walls tests/code-graph-tests.sh:328-333 puts around
 * `agents/lib/code_graph.py`, extended to the file that now does the work.
 * The bash suite still greps only the Python builder, so without these the
 * walls would silently stop covering the builder the day bash is deleted.
 */
describe('the walls the reference suite puts around the builder', () => {
  const src = readFileSync(join(CHECKOUT, 'src/nouns/graph/code-build.ts'), 'utf8');

  it('never writes the index through the jq path (I-0058 truncates on empty output)', () => {
    // A CALL, not prose: the module legitimately explains in comments why
    // write_json is avoided, which is the same trap T-0091's .env grep hit.
    expect(/writeJson\s*\(|write_json\s*\(/.test(src)).toBe(false);
  });

  it('contains no LLM call (D-0001) — the graph is repo fact', () => {
    expect(/generate\(|gateway|openai|anthropic/i.test(src)).toBe(false);
  });

  /**
   * NO RAW NUL BYTE IN ANY SOURCE FILE THE BUILDER READS.
   *
   * This is not hygiene, it is a self-hosting constraint with teeth. The
   * tree-sitter grammars report a parse error on a literal NUL inside a
   * string, `graph code build` fails the whole build when any file it walks
   * has one, and this repo INDEXES ITS OWN CHECKOUT -- so a NUL anywhere in
   * `src/`, `tools/` or `test/` turns the sandbox differential red in a way
   * that names the parse error and not the byte.
   *
   * It has happened twice in one day. Commit 4049576 removed two (a join key
   * in gov-graph.ts and a batch separator in the oracle test) and the
   * hardening wave immediately added a third in `tools/refusal-corpus.mjs`,
   * caught only because `sb-076` runs the builder over this tree. The `\0`
   * ESCAPE IS THE FIX AND IT IS FREE: the same byte at run time, and it is
   * what the code meant to say. So the class gets a guard rather than a third
   * one-off repair.
   *
   * The tree is walked HERE rather than trusting the builder to notice,
   * because the builder's failure is a red differential case forty seconds
   * into a sandbox run that names a parse error; this names the file, the
   * byte offset and the fix.
   */
  it('no source file carries a raw NUL byte — the grammars refuse to parse one', () => {
    const roots = ['src', 'tools', 'test/unit'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|mjs|js)$/.test(e.name)) continue;
        const buf = readFileSync(p);
        const at = buf.indexOf(0);
        if (at >= 0) offenders.push(`${relative(CHECKOUT, p)} at byte ${at}`);
      }
    };
    for (const r of roots) walk(join(CHECKOUT, r));
    expect(
      offenders,
      'A literal NUL byte in a source file. Write it as the `\\0` escape instead: same byte at '
      + 'run time, and the tree-sitter grammars parse it. Left as it is, `graph code build` '
      + 'fails over this checkout and the sandbox differential goes red naming a parse error '
      + 'rather than the byte. See commit 4049576.',
    ).toEqual([]);
  });
});

describe('teardown', () => {
  it('removes every fixture tree it made', () => {
    cleanup();
    expect(roots).toEqual([]);
  });
});
