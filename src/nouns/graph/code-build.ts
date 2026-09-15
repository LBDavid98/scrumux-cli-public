/**
 * The CODE-graph BUILDER.
 *
 * --- WHY THIS FILE IS NOT `code-index.ts` --------------------------------
 *
 * The reader/builder split is the whole design: the builder is ABSENT from
 * the reader. Nothing in `code-index.ts` can reach this module, so a repo
 * with an index on disk answers every query with no parser, no grammar blob
 * and no wasm runtime -- exactly as a deployed repo does today, which
 * carries no parser at all, only the finished index.
 *
 * What this module needs and the reader does not: `tools/grammars/*.wasm`
 * (vendored, 13 blobs) and `node_modules/web-tree-sitter` (a devDependency).
 * Both live in the harness SOURCE repo only. `harness deploy` builds the
 * index INTO a target from this checkout, which is why a deployed repo has a
 * working graph without ever carrying a parser (CLI-CONSOLIDATION §8).
 *
 * --- FIVE NON-OBVIOUS INVARIANTS THIS BUILDER DEPENDS ON ------------------
 *
 * 1. `parse()` TAKES A STRING, NEVER BYTES, so `node.startIndex` is a UTF-16
 *    code-unit offset into the string you passed and NOT a byte offset. A
 *    byte-offset slice over a Buffer produces garbage symbol names the
 *    moment a file contains one non-ASCII character above a definition --
 *    silently, as a wrong name rather than as a crash. Measured: 72 of 76
 *    harness files are non-ASCII. Every text read here slices the SAME
 *    JavaScript string the parser was handed. `startPosition.row` is
 *    unaffected, so line numbers were never at risk and are no evidence.
 *
 * 2. THE TRAVERSAL ORDER IS OBSERVABLE. The walk is an explicit LIFO stack
 *    whose children are pushed in source order, so it descends RIGHT TO
 *    LEFT. Two definitions of one name in one file collapse to one symbol,
 *    and the LAST one walked wins the `line` -- a left-to-right walk would
 *    report a different line for exactly those symbols.
 *
 * 3. THE FILTERING IS THE POINT, NOT A SIMPLIFICATION. A call name with
 *    several candidate definitions and no same-file match is DROPPED
 *    ENTIRELY; an unresolved name is dropped too. Measured: an unfiltered
 *    shell parse is ~4300 coreutils invocations, and fanning `ok`/`bad`/
 *    `die` out to every suite that defines them turns 241 symbols into 3998
 *    edges. "Fixing" either filter produces a graph that is complete and
 *    useless.
 *
 * 4. `symbols` IS AN INSERTION-ORDERED MAP AND THE JSON PRESERVES IT. The
 *    index's byte layout is the walk order, not a sort. A plain object
 *    would agree by accident today and disagree the day a symbol id looks
 *    like an array index; a `Map` agrees by construction.
 *
 * 5. THE INDEX IS NOT WRITTEN WITH PLAIN `JSON.stringify`. `built_at_epoch`
 *    is a float DELIBERATELY -- truncating to whole seconds made every index
 *    look stale the moment it was built -- and `JSON.stringify` renders an
 *    integral float with no trailing `.0`, unlike the pinned format this
 *    field is written in (`pyFloat`, below; test/unit/code-build-wave5j.test.ts).
 *    `serializeIndex` owns that one difference and nothing else.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, languageOf, walkTree } from './code-index.js';

// ------------------------------------------------------------- registry ---
// DATA, not a branch (D-0042): encoding language support as an if/elif
// makes a measurement of one repo at one moment into a ceiling. A repo with
// PHP in it got "31 files, 0 parse errors" with the PHP invisible, which is
// the worst shape a coverage number can have.
//
// `EXTENSION_LANGUAGE`, `SHEBANG_LANGUAGE` and `SKIP_DIRS` are NOT repeated
// here. They are the READER's, in code-index.ts, because `language_of` is
// what `is_stale_graph` walks with and a second copy is a second answer to
// "what is a source file". This file adds only what a parse needs.

/**
 * The wasm blob behind each language name. The two halves stay deliberately
 * separate: naming a language needs no grammar, so the index can always say
 * "2 php files, no grammar loaded" rather than dropping them from the count
 * entirely. All twelve languages named below ship a grammar and all twelve
 * parse.
 */
export const GRAMMAR_FILES: Readonly<Record<string, string>> = {
  python: 'tree-sitter-python.wasm',
  bash: 'tree-sitter-bash.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
};

/**
 * The ONE dialect the registry cannot express, resolved WITHOUT touching the
 * registry (Spike C §6 and open question 1).
 *
 * `EXTENSION_LANGUAGE` sends both `.ts` and `.tsx` to the language name
 * `typescript`, and tsx is a SEPARATE grammar: the typescript grammar returns
 * `hasError = true` on tsx source (measured in the spike). Left unhandled,
 * the failure would look like "this file is full of parse errors" rather
 * than "the wrong grammar was chosen" -- and because `graph code build`
 * EXITS 1 when `parse_errors` is non-empty, a single `.tsx` file would turn
 * `harness deploy`'s code-graph-built check red in any React repo.
 *
 * So the blob is chosen per FILE while the language NAME stays `typescript`.
 * Nothing observable moves: `coverage.by_language`, `skipped`, every symbol's
 * `lang` field and `language_of` itself are untouched, which is exactly why
 * this is not the registry change the spike declined to make on User's
 * behalf. Deleting this map and `tree-sitter-tsx.wasm` restores the latent
 * defect and changes nothing else.
 */
const DIALECT_BY_SUFFIX: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  typescript: { '.tsx': 'tree-sitter-tsx.wasm' },
};

/**
 * A language whose grammar loads but whose node names are not listed here
 * still contributes its FILES and its parse status; it simply yields no
 * symbols, and `stats` says so rather than implying the files were empty.
 */
const DEFINITION_NODES: Readonly<Record<string, readonly string[]>> = {
  python: ['function_definition'],
  bash: ['function_definition'],
  javascript: ['function_declaration', 'method_definition'],
  typescript: ['function_declaration', 'method_definition'],
  go: ['function_declaration', 'method_declaration'],
  rust: ['function_item'],
  ruby: ['method'],
  php: ['function_definition', 'method_declaration'],
  java: ['method_declaration'],
  c: ['function_definition'],
  cpp: ['function_definition'],
  c_sharp: ['method_declaration'],
};

/** The node type(s) that count as a call, per language; most share the default below. */
const CALL_NODES: Readonly<Record<string, readonly string[]>> = {
  bash: ['command'],
};
const DEFAULT_CALL_NODES: readonly string[] = [
  'call', 'call_expression', 'method_invocation', 'function_call_expression',
];

/** Falls back to `function_definition` for an unlisted language, deliberately, not by omission. */
function defNodesFor(lang: string): Set<string> {
  return new Set(DEFINITION_NODES[lang] ?? ['function_definition']);
}

function callNodesFor(lang: string): Set<string> {
  return new Set(CALL_NODES[lang] ?? DEFAULT_CALL_NODES);
}

// ------------------------------------------------------- the wasm runtime ---

/**
 * The slice of `web-tree-sitter`'s API this builder uses, declared
 * STRUCTURALLY rather than imported.
 *
 * The package is a devDependency and the runtime is loaded by absolute path
 * at build time, so nothing here may depend on its types being resolvable:
 * `npm run typecheck` in a checkout that has not installed it must still
 * pass, and the bundle must carry no reference to the specifier. Declaring
 * the six members we touch also documents the whole coupling in one place --
 * the shapes below are web-tree-sitter 0.27.0's.
 */
interface TsNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number };
  readonly children: readonly (TsNode | null)[];
  childForFieldName(name: string): TsNode | null;
}
interface TsTree {
  readonly rootNode: TsNode & { readonly hasError: boolean };
  delete(): void;
}
interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): TsTree | null;
  delete(): void;
}
interface TsRuntime {
  Parser: {
    init(options: { wasmBinary: Uint8Array }): Promise<unknown>;
    new(): TsParser;
  };
  Language: { load(bytes: Uint8Array): Promise<unknown> };
}

/** Where the two halves of the toolchain live, relative to the CODE root. */
export function grammarDir(codeRoot: string): string {
  return join(codeRoot, 'tools', 'grammars');
}
export function runtimeDir(codeRoot: string): string {
  return join(codeRoot, 'node_modules', 'web-tree-sitter');
}

/** `GrammarUnavailable` (`:140`) -- no grammar for any language in the tree. */
export class GrammarUnavailable extends Error {}

/**
 * The web-tree-sitter runtime, from an ABSOLUTE PATH.
 *
 * NOT a bare specifier, and that is a wall rather than a style: `esbuild`
 * would inline the whole 156 KB emscripten glue into `.deploy-claude/dist/
 * scrumux.mjs`, which is DEPLOYED into every governed repo -- and a parser
 * living inside the reader's bundle is the reader/builder split undone in the
 * one place nobody would look. A computed specifier is left alone by the
 * bundler, so the deployed bundle contains this function and no parser at all.
 */
async function loadRuntime(codeRoot: string): Promise<TsRuntime> {
  const dir = runtimeDir(codeRoot);
  const js = join(dir, 'web-tree-sitter.js');
  const wasm = join(dir, 'web-tree-sitter.wasm');
  const specifier = pathToFileURL(js).href;
  const rt = await (import(specifier) as Promise<TsRuntime>);
  // `wasmBinary`, so the runtime wasm never has to exist as a FILE the
  // emscripten loader can find by itself (Spike C §7). It is what makes a
  // single-binary build possible later, and it costs nothing now.
  await rt.Parser.init({ wasmBinary: new Uint8Array(readFileSync(wasm)) });
  PARSER_CTOR = rt.Parser;
  return rt;
}

interface Loaded { lang: string; language: unknown; dialects: Map<string, unknown> }

/**
 * `_load_grammars` (`:144`) -- returns (loaded, missing), and NEVER crashes
 * the build on one bad grammar: a language that cannot be loaded is reported
 * by name in `coverage.skipped`, because a silently skipped file looks
 * exactly like a file with nothing in it.
 */
async function loadGrammars(
  codeRoot: string, langs: Iterable<string>,
): Promise<{ loaded: Map<string, Loaded>; missing: Map<string, string> }> {
  const loaded = new Map<string, Loaded>();
  const missing = new Map<string, string>();
  const wanted = [...langs].sort(cmpCodePoint);
  if (wanted.length === 0) return { loaded, missing };

  let rt: TsRuntime;
  try {
    rt = await loadRuntime(codeRoot);
  } catch (e) {
    // The `except ImportError` arm at `:154`, with the fact that changed:
    // there is no pip install to name, because the runtime travels with the
    // harness SOURCE checkout and with nothing else.
    throw new GrammarUnavailable(
      `the tree-sitter runtime is not in this checkout (${msgOf(e)}). The BUILDER needs `
      + 'it; readers do not. It ships with the harness source repo only: run `npm ci` in a '
      + 'scrumux-cli checkout and build from there.',
    );
  }

  for (const lang of wanted) {
    const file = GRAMMAR_FILES[lang];
    if (file === undefined) {
      missing.set(lang, `no grammar module is registered for '${lang}' — add one to `
        + 'GRAMMAR_FILES in src/nouns/graph/code-build.ts');
      continue;
    }
    try {
      const dialects = new Map<string, unknown>();
      for (const [suffix, blob] of Object.entries(DIALECT_BY_SUFFIX[lang] ?? {})) {
        dialects.set(suffix, await rt.Language.load(readGrammar(codeRoot, blob)));
      }
      loaded.set(lang, {
        lang,
        language: await rt.Language.load(readGrammar(codeRoot, file)),
        dialects,
      });
    } catch (e) {
      // `except Exception: report, never crash the build` (`:176`).
      missing.set(lang, `${file} could not be loaded: ${msgOf(e)}`);
    }
  }
  return { loaded, missing };
}

function readGrammar(codeRoot: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(grammarDir(codeRoot), file)));
}

// ---------------------------------------------------------------- shapes ---

export interface SymbolRow {
  id: string; name: string; file: string; lang: string; line: number;
}
export interface Edge { from: string; to: string; kind: string }
export interface SkippedRow {
  language: string; files: number; reason: string; examples: string[];
}
export interface Provenance {
  built_at: string;
  built_at_epoch: number;
  commit: string;
  dirty: boolean;
  root: string;
  builder: string;
}
export interface CodeGraph {
  root: string;
  files: string[];
  /** INSERTION-ORDERED, and the JSON preserves it -- see the header, item 4. */
  symbols: Map<string, SymbolRow>;
  edges: Edge[];
  parse_errors: string[];
  coverage: {
    indexed: number;
    by_language: Map<string, number>;
    skipped: SkippedRow[];
    not_source: number;
  };
  provenance: Provenance;
}

// ----------------------------------------------------------------- build ---

/**
 * `build(root)` (`:274`) -- parse the tree and return the graph. A pure
 * function of the tree plus `git` for provenance.
 *
 * LANGUAGE-AGNOSTIC, in two passes and in this order. The tree is SURVEYED
 * first and the grammars are loaded for what the survey found, so the census
 * is complete whether or not a parser exists for what it names.
 */
export async function buildCodeGraph(root: string, codeRoot: string): Promise<CodeGraph> {
  // --- pass 1: survey ------------------------------------------------
  const byLang = new Map<string, string[]>();
  let notSource = 0;
  for (const path of walkTree(root)) {
    let isFile = false;
    try { isFile = statSync(path).isFile(); } catch { isFile = false; }
    if (!isFile) continue;
    const lang = languageOf(path);
    if (lang === null) { notSource += 1; continue; }
    const list = byLang.get(lang);
    if (list === undefined) byLang.set(lang, [path]); else list.push(path);
  }

  const { loaded, missing } = await loadGrammars(codeRoot, byLang.keys());
  if (byLang.size > 0 && loaded.size === 0) {
    const langs = [...byLang.keys()].sort(cmpCodePoint).join(', ');
    const why = [...missing.entries()].sort((a, b) => cmpCodePoint(a[0], b[0]))
      .map(([k, v]) => `${k}: ${v}`).join('; ');
    throw new GrammarUnavailable(
      `this tree contains ${langs}, and no grammar could be loaded for any of them: ${why}`,
    );
  }

  const files: string[] = [];
  const symbols = new Map<string, SymbolRow>();
  // (caller_symbol_or_file, callee_name, defining_file) -- the defining file
  // is kept so a call can prefer a same-file definition.
  const rawCalls: Array<[string, string, string]> = [];
  const rawSources: Array<[string, string]> = [];
  const parseErrors: string[] = [];
  const indexedByLang = new Map<string, number>();
  const skipped: SkippedRow[] = [];

  for (const [lang, why] of [...missing.entries()].sort((a, b) => cmpCodePoint(a[0], b[0]))) {
    const paths = byLang.get(lang) ?? [];
    skipped.push({
      language: lang,
      files: paths.length,
      reason: why,
      examples: paths.map((p) => relKey(root, p)).sort(cmpCodePoint).slice(0, 5),
    });
  }

  // --- pass 2: parse what we have a grammar for ----------------------
  for (const lang of [...loaded.keys()].sort(cmpCodePoint)) {
    const entry = loaded.get(lang)!;
    const defNodes = defNodesFor(lang);
    const callNodes = callNodesFor(lang);
    // `Parser(loaded[lang])` -- ONE parser for the language, as Python has,
    // with `setLanguage` re-run per file only because a dialect blob can
    // differ by suffix. A parser is a wasm handle and leaks if it is not
    // deleted, so it is deleted when the language is done.
    const parser = new PARSER_CTOR!();
    try {
    for (const path of byLang.get(lang) ?? []) {
      const rel = relKey(root, path);
      files.push(rel);
      indexedByLang.set(lang, (indexedByLang.get(lang) ?? 0) + 1);
      // The STRING the parser indexes, and the same string every text read
      // slices. See the header, item 1.
      const src = readFileSync(path).toString('utf8');
      parser.setLanguage(languageFor(entry, rel));
      const tree = parser.parse(src);
      if (tree === null) {
        // A file the parser declined to parse is recorded as a parse error
        // rather than crashing the build, which is the answer the
        // surrounding code already gives for a tree it could not read.
        parseErrors.push(rel);
        continue;
      }
      try {
        if (tree.rootNode.hasError) parseErrors.push(rel);
        walkParseTree(tree, src, rel, lang, defNodes, callNodes,
          symbols, rawCalls, rawSources);
      } finally {
        // The wasm heap is not garbage-collected for us. Indexing this repo
        // is ~240 trees; holding them all costs hundreds of MB.
        tree.delete();
      }
    }
    } finally {
      parser.delete();
    }
  }

  files.sort(cmpCodePoint);
  parseErrors.sort(cmpCodePoint);
  return resolve(root, files, symbols, rawCalls, rawSources, parseErrors,
    indexedByLang, skipped, notSource);
}

/** The grammar for one FILE: the language's own blob, unless its suffix names
 *  a dialect (see `DIALECT_BY_SUFFIX`). */
function languageFor(entry: Loaded, rel: string): unknown {
  if (entry.dialects.size === 0) return entry.language;
  const dot = rel.lastIndexOf('.');
  const suffix = dot > 0 ? rel.slice(dot).toLowerCase() : '';
  return entry.dialects.get(suffix) ?? entry.language;
}

/** Set once by `loadRuntime`; a module-scope handle rather than a parameter
 *  threaded through six call sites for the sake of one constructor. */
let PARSER_CTOR: TsRuntime['Parser'] | null = null;

// ------------------------------------------------------------ extraction ---

/** The UTF-16 slice of the string the parser indexed. */
function nodeText(node: TsNode, src: string): string {
  return src.slice(node.startIndex, node.endIndex);
}

/** The declared name of a definition node. */
function definitionName(node: TsNode, src: string, lang: string): string | null {
  if (lang === 'python') {
    const ident = node.childForFieldName('name');
    return ident !== null ? nodeText(ident, src) : null;
  }
  // bash: function_definition's first child of type `word` is the name
  for (const child of node.children) {
    if (child !== null && child.type === 'word') return nodeText(child, src);
  }
  const ident = node.childForFieldName('name');
  return ident !== null ? nodeText(ident, src) : null;
}

/** The bare name being invoked, or null. */
function calleeName(node: TsNode, src: string, lang: string): string | null {
  if (lang === 'python') {
    const fn = node.childForFieldName('function');
    if (fn === null) return null;
    const text = nodeText(fn, src);
    return text.slice(text.lastIndexOf('.') + 1); // obj.method -> method
  }
  const name = node.childForFieldName('name');
  if (name === null) return null;
  const text = nodeText(name, src);
  // `.claude/scripts/scrumux` and `./gov` both denote the same script node
  return text.includes('/') ? purePosixName(text) : text;
}

/**
 * `_sourced_file` (`:249`) -- the basename of the file a `.`/`source` pulls
 * in. The argument is usually an expansion (`. "$(dirname -- "$0")/lib.sh"`),
 * so the literal tail after the last slash is the only reliable part.
 */
function sourcedFile(node: TsNode, src: string): string | null {
  for (const child of node.children.slice(1)) {
    if (child === null) continue;
    const text = pyStripChars(nodeText(child, src).trim(), '"\'');
    if (text === '' || text.startsWith('-')) continue;
    const tail = pyStripChars(text.slice(text.lastIndexOf('/') + 1), '"\'');
    if (tail !== '' && !tail.includes('$')) return tail;
  }
  return null;
}

/** `_imported_modules` (`:263`) -- dotted module paths as candidate files. */
function importedModules(node: TsNode, src: string): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (child === null) continue;
    if (child.type === 'dotted_name' || child.type === 'aliased_import'
      || child.type === 'relative_import') {
      const text = nodeText(child, src).split(' as ')[0]!.trim();
      if (text !== '') out.push(text.replaceAll('.', '/') + '.py');
    }
  }
  return out;
}

/**
 * `_walk_tree` (`:350`) -- one tree, walked once, tracking the innermost
 * enclosing definition so a call is attributed to the FUNCTION it sits in
 * rather than merely to the file.
 *
 * The three cases are an if/elif/elif chain there (`:361`, `:370`, `:381`),
 * so a node is only ever one of them -- and the children are pushed in source
 * order onto a LIFO stack, which makes the descent right-to-left. Both are
 * reproduced literally: see the header, item 2.
 */
function walkParseTree(
  tree: TsTree, src: string, rel: string, lang: string,
  defNodes: Set<string>, callNodes: Set<string>,
  symbols: Map<string, SymbolRow>,
  rawCalls: Array<[string, string, string]>,
  rawSources: Array<[string, string]>,
): void {
  const stack: Array<[TsNode, string | null]> = [[tree.rootNode, null]];
  while (stack.length > 0) {
    const [node, inherited] = stack.pop()!;
    let enclosing = inherited;
    if (defNodes.has(node.type)) {
      const name = definitionName(node, src, lang);
      if (name !== null && name !== '') {
        const sid = `${rel}::${name}`;
        symbols.set(sid, {
          id: sid, name, file: rel, lang, line: node.startPosition.row + 1,
        });
        enclosing = sid;
      }
    } else if (callNodes.has(node.type)) {
      const callee = calleeName(node, src, lang);
      if (callee === '.' || callee === 'source') {
        // `. lib.sh` is the single most load-bearing edge in a shell repo --
        // every script sources lib.sh -- and it is invisible if only the
        // command NAME is read.
        const target = sourcedFile(node, src);
        if (target !== null) rawSources.push([rel, target]);
      } else if (callee !== null && callee !== '') {
        rawCalls.push([enclosing ?? rel, callee, rel]);
      }
    } else if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      for (const mod of importedModules(node, src)) rawSources.push([rel, mod]);
    }
    for (const child of node.children) {
      if (child !== null) stack.push([child, enclosing]);
    }
  }
}

// --------------------------------------------------------------- resolve ---

/** `_resolve` (`:388`) -- raw name references become edges, then provenance. */
function resolve(
  root: string, files: string[], symbols: Map<string, SymbolRow>,
  rawCalls: Array<[string, string, string]>, rawSources: Array<[string, string]>,
  parseErrors: string[], indexedByLang: Map<string, number>,
  skipped: SkippedRow[], notSource: number,
): CodeGraph {
  const byName = new Map<string, string[]>();
  for (const [sid, sym] of symbols) {
    const list = byName.get(sym.name);
    if (list === undefined) byName.set(sym.name, [sid]); else list.push(sid);
  }
  // A script invoked by bare filename is a node too, not only by full path.
  const byFile = new Map<string, string>();
  for (const f of files) byFile.set(f, f);
  for (const f of files) {
    const base = purePosixName(f);
    if (!byFile.has(base)) byFile.set(base, f);
  }

  const calls: Edge[] = [];
  for (const [caller, callee, inFile] of rawCalls) {
    const targets = byName.get(callee);
    if (targets !== undefined && targets.length > 0) {
      // Prefer a definition in the SAME file. Helper names like ok, bad, die
      // and say are defined in nearly every test suite, so fanning every call
      // out to all ~30 definitions produced 3998 edges over 241 symbols --
      // complete, and useless. A shell function call resolves locally or via
      // a sourced file; it does not reach into an unrelated suite.
      const local = targets.filter((t) => symbols.get(t)!.file === inFile);
      const chosen = local.length > 0 ? local : (targets.length === 1 ? [targets[0]!] : []);
      for (const t of chosen) {
        if (t !== caller) calls.push({ from: caller, to: t, kind: 'calls' });
      }
    } else {
      const f = byFile.get(callee);
      if (f !== undefined && f !== caller) {
        calls.push({ from: caller, to: f, kind: 'invokes' });
      }
    }
  }

  // file -> file dependency: `. lib.sh` in shell, `import x` in python
  for (const [srcFile, target] of rawSources) {
    const resolved = byFile.get(target) ?? byFile.get(purePosixName(target));
    if (resolved !== undefined && resolved !== '' && resolved !== srcFile) {
      calls.push({ from: srcFile, to: resolved, kind: 'sources' });
    }
  }

  // dedupe while preserving order, so the index is deterministic
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const e of calls) {
    const key = JSON.stringify([e.from, e.to, e.kind]);
    if (!seen.has(key)) { seen.add(key); edges.push(e); }
  }
  edges.sort((a, b) => cmpCodePoint(a.from, b.from) || cmpCodePoint(a.to, b.to)
    || cmpCodePoint(a.kind, b.kind));

  return {
    root,
    files,
    symbols,
    edges,
    parse_errors: parseErrors,
    // --- coverage: what was indexed, and what was NOT -----------------
    // A skipped file used to be invisible. "31 files, 0 parse errors" over a
    // tree containing two PHP files is a true sentence and a false
    // impression, and the reader has no way to tell.
    coverage: {
      indexed: files.length,
      by_language: indexedByLang,
      skipped,
      not_source: notSource,
    },
    // --- provenance: what this index was built FROM -------------------
    // A reader answers from an index without rebuilding it, so the index has
    // to say how old it is and against what. Without this a stale answer is
    // indistinguishable from a current one.
    provenance: provenanceOf(root),
  };
}

/** `_provenance` (`:470`). */
export function provenanceOf(root: string): Provenance {
  const commit = git(root, 'rev-parse', 'HEAD');
  return {
    // `datetime.now(utc).replace(microsecond=0).isoformat()` with `+00:00`
    // rewritten to `Z`.
    built_at: new Date().toISOString().slice(0, 19) + 'Z',
    // A FLOAT, deliberately. Truncating to whole seconds made every index
    // look stale the moment it was built: a source file written at t=x.9
    // compares greater than a stamp of int(x). Python reads the clock a
    // SECOND time here, so the two fields can straddle a second boundary;
    // reproduced rather than collapsed to one read.
    built_at_epoch: Date.now() / 1000,
    commit: commit !== '' ? commit : 'unknown — the indexed tree is not a git checkout',
    dirty: commit !== '' ? git(root, 'status', '--porcelain') !== '' : false,
    root,
    builder: 'scrumux graph code build',
  };
}

// ------------------------------------------------------------- the write ---

/**
 * `json.dumps(graph, indent=2, ensure_ascii=False)`, byte for byte.
 *
 * Hand-rolled rather than `JSON.stringify` for the reason in the header
 * (item 5) and for one more: the key ORDER is the contract. Python writes a
 * dict in insertion order, so these literals ARE the file's layout, and a
 * refactor that reorders a field here rewrites every index in the fleet.
 */
export function serializeIndex(g: CodeGraph): string {
  const L: string[] = [];
  L.push('{');
  L.push(`  ${k('root')}: ${s(g.root)},`);
  L.push(`  ${k('files')}: ${arr(g.files.map(s), 2)},`);
  L.push(`  ${k('symbols')}: ${symbolsBlock(g.symbols)},`);
  L.push(`  ${k('edges')}: ${arr(g.edges.map(edgeBlock), 2)},`);
  L.push(`  ${k('parse_errors')}: ${arr(g.parse_errors.map(s), 2)},`);
  L.push(`  ${k('coverage')}: ${coverageBlock(g.coverage)},`);
  L.push(`  ${k('provenance')}: ${provenanceBlock(g.provenance)}`);
  L.push('}');
  return L.join('\n');
}

function symbolsBlock(syms: Map<string, SymbolRow>): string {
  if (syms.size === 0) return '{}';
  const rows: string[] = [];
  for (const [sid, r] of syms) {
    rows.push(`    ${k(sid)}: {\n`
      + `      ${k('id')}: ${s(r.id)},\n`
      + `      ${k('name')}: ${s(r.name)},\n`
      + `      ${k('file')}: ${s(r.file)},\n`
      + `      ${k('lang')}: ${s(r.lang)},\n`
      + `      ${k('line')}: ${r.line}\n`
      + '    }');
  }
  return `{\n${rows.join(',\n')}\n  }`;
}

function edgeBlock(e: Edge): string {
  return `{\n      ${k('from')}: ${s(e.from)},\n      ${k('to')}: ${s(e.to)},\n`
    + `      ${k('kind')}: ${s(e.kind)}\n    }`;
}

function coverageBlock(c: CodeGraph['coverage']): string {
  const langs = [...c.by_language.entries()]
    .map(([lang, n]) => `      ${k(lang)}: ${n}`)
    .join(',\n');
  const skipped = c.skipped.map((row) =>
    `{\n      ${k('language')}: ${s(row.language)},\n`
    + `      ${k('files')}: ${row.files},\n`
    + `      ${k('reason')}: ${s(row.reason)},\n`
    + `      ${k('examples')}: ${arr(row.examples.map(s), 6)}\n    }`);
  return `{\n    ${k('indexed')}: ${c.indexed},\n`
    + `    ${k('by_language')}: ${langs === '' ? '{}' : `{\n${langs}\n    }`},\n`
    + `    ${k('skipped')}: ${arr(skipped, 4)},\n`
    + `    ${k('not_source')}: ${c.not_source}\n  }`;
}

function provenanceBlock(p: Provenance): string {
  return `{\n    ${k('built_at')}: ${s(p.built_at)},\n`
    + `    ${k('built_at_epoch')}: ${pyFloat(p.built_at_epoch)},\n`
    + `    ${k('commit')}: ${s(p.commit)},\n`
    + `    ${k('dirty')}: ${p.dirty ? 'true' : 'false'},\n`
    + `    ${k('root')}: ${s(p.root)},\n`
    + `    ${k('builder')}: ${s(p.builder)}\n  }`;
}

/** An indented JSON array of ALREADY-RENDERED items. `[]` when empty, as
 *  `json.dumps` writes it -- an indented empty list is still two characters. */
function arr(items: string[], indent: number): string {
  if (items.length === 0) return '[]';
  const pad = ' '.repeat(indent + 2);
  return `[\n${items.map((i) => pad + i).join(',\n')}\n${' '.repeat(indent)}]`;
}

const k = (key: string): string => s(key);

/**
 * A JSON string as `json.dumps(..., ensure_ascii=False)` writes one: only
 * `"`, `\` and C0 controls are escaped, and non-ASCII goes out raw. NOT
 * `JSON.stringify`, which additionally escapes lone surrogates -- a shape
 * Python emits verbatim.
 */
function s(v: string): string {
  let out = '"';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/**
 * `repr(float)`-shaped: the shortest round-tripping decimal, except for the
 * integral case, which gets an explicit trailing `.0` rather than
 * `String()`'s bare integer -- the pinned format this field is written in
 * (test/unit/code-build-wave5j.test.ts).
 *
 * KNOWN LIMIT, stated rather than hidden: the exponent form is not
 * reproduced (that would render `1e-05` where this renders `0.00001`).
 * `built_at_epoch` is the only float this index holds and it is a
 * ten-digit Unix timestamp, so no exponent form is reachable; the gap is
 * real and left rather than guessed at.
 */
function pyFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/**
 * `write_index` (`:596`). Never through write_json's jq path -- I-0058: a
 * filter emitting no output truncates the target to zero bytes.
 */
export function writeIndex(g: CodeGraph, path: string): void {
  const payload = serializeIndex(g) + '\n';
  if (payload.trim() === '') throw new Error('refusing to write an empty index');
  // The index lives under governance/, and a repo that has never taken a
  // governance write does not have that directory.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload);
}

// --------------------------------------------------------------- helpers ---

/**
 * `PurePosixPath(text).name`. Not `basename`: CPython drops empty and `.`
 * components, so `./gov` is `gov` and `a/b/` is `b`, and `/` is the empty
 * string rather than `/`.
 */
export function purePosixName(text: string): string {
  const parts = text.split('/').filter((p) => p !== '' && p !== '.');
  return parts.length === 0 ? '' : parts[parts.length - 1]!;
}

/**
 * `relpath`-shaped -- but the index's keys are POSIX on every platform.
 *
 * `node:path`'s `relative()` answers in the HOST separator, so on Windows
 * every file key, symbol id and edge endpoint came out `scripts\lib.sh`.
 * That is not cosmetic. `purePosixName` (above) splits on '/' and nothing
 * else -- deliberately, because it also parses paths written INSIDE shell
 * and python source, which are always POSIX -- so a backslash key has no
 * basename, `byFile` never gets its short alias, and every `. lib.sh`
 * sources edge and every bare-script invokes edge silently vanishes.
 * Measured on windows-latest: the file-to-file cases produced 1 edge where
 * a POSIX-built index has 4.
 *
 * An index is also a JSON document that gets read on a different machine
 * than it was built on. So the separator is normalised at the one seam
 * where a host path becomes a graph key, and nowhere downstream has to
 * know the host it ran on.
 */
function relKey(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

/** `str.strip(chars)` -- both ends, any of the characters, not a prefix. */
function pyStripChars(text: string, chars: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && chars.includes(text[a]!)) a += 1;
  while (b > a && chars.includes(text[b - 1]!)) b -= 1;
  return text.slice(a, b);
}

/**
 * Python's `sorted()` over `str` compares CODE POINTS; JS `<` compares UTF-16
 * code units, and the two disagree for a non-BMP character against U+E000..
 * U+FFFF. Every id in this index is a path or an identifier, so they agree in
 * practice -- but the builder is where an id is MINTED, and getting the order
 * wrong here would write a file that never sorts back.
 */
export function cmpCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  const ai = [...a];
  const bi = [...b];
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i += 1) {
    const x = ai[i]!.codePointAt(0)!;
    const y = bi[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : (ai.length < bi.length ? -1 : 1);
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
