# Spike C — web-tree-sitter (WASM) as the replacement for the Python code-graph indexer

> Pinned at 5d823b1 — file:line references resolve against `git show 5d823b1:<path>`; the tree may have moved.

Phase 0, scrumux-cli bash+jq+Python → TypeScript port.
Run 2026-08-31 on macOS 25.3 / arm64, Node v24.4.1, npm 11.4.2.

---

## Verdict

**Yes.** A port of `code_graph.py` onto `web-tree-sitter` 0.27.0 with the official
prebuilt grammar wasm produced a graph **byte-identical to the Python indexer** over
the harness's own 76 source files — 76 files, 428 symbols, 684 edges, 0 parse errors,
**0 differences in files, symbol ids, symbol line numbers, or edges** — and it runs
with **no native build step and no `.wasm` file on disk**, because both the runtime
and every grammar accept raw bytes. That last fact is the deciding one: it is what
makes a Windows single binary possible.

---

## 1. What `code_graph.py` actually does

Read in full at `agents/lib/code_graph.py` (656 lines). The indexer proper is
`build()` at :274; everything from :551 down is query-side and needs no parser.

### What counts as a file

- **Walk** — `_walk()` :210, `os.walk` over the repo root, directory names sorted.
- **Excluded dirs** — `SKIP_DIRS` :50 = `.git`, `.venv`, `node_modules`,
  `__pycache__`, `dist`, `build`. **Tests are NOT excluded**; `tests/` is indexed
  like any other directory, and 42 of the 76 indexed files are test suites.
- **Language naming** — `language_of()` :185. `EXTENSION_LANGUAGE` :87 maps 22
  extensions to 12 language names. A file with **no extension** is decided by
  reading the first 128 bytes and matching `SHEBANG_LANGUAGE` :106 (5 patterns,
  `re.match`, so anchored at the start). Anything else is not a source file and is
  counted into `coverage.not_source`.
- Naming is deliberately independent of whether a grammar is installed (:189-193),
  so the index can report "2 php files, no grammar loaded" rather than dropping them.
  `GRAMMAR_MODULES` :71 registers 12 languages; `pyproject.toml` declares only
  **three** dependencies — `tree-sitter>=0.26`, `tree-sitter-python>=0.25`,
  `tree-sitter-bash>=0.25`. The other nine rows are registry entries with no
  dependency behind them, which is the documented intent, not an oversight.

### What counts as a symbol

- **`DEFINITION_NODES` :119** — for the two languages that matter here, both
  python and bash use exactly `("function_definition",)` (:120, :121).
  javascript/typescript use `("function_declaration", "method_definition")` (:122-123).
- **Symbol id** — `f"{rel}::{name}"` at :364, into a dict at :365, so two
  definitions of the same name in one file **collapse to one entry** and the last
  one walked wins the `line`. Fields: `id`, `name`, `file`, `lang`, `line`
  (1-based, `start_point[0] + 1`).
- **Name extraction** — `_definition_name()` :221. Python takes the `name` field;
  bash takes **the first child of type `word`** (:226-228).

### What counts as a call

- **`CALL_NODES` :133** — bash is `("command",)`, everything else falls back to
  `_DEFAULT_CALL_NODES` :136 = `call`, `call_expression`, `method_invocation`,
  `function_call_expression`.
- **`_callee_name()` :233** — python takes the `function` field and keeps the tail
  after the last dot (`obj.method` → `method`, :240). Others take the `name` field
  and keep the path basename (:246).
- **`. ` / `source`** (:374-379) is special-cased into a `sources` edge via
  `_sourced_file()` :249, which takes the literal tail after the last slash and
  rejects anything containing `$`.
- **Python imports** (:381) become `sources` edges via `_imported_modules()` :263.
- **Traversal** — `_walk_tree()` :350, an explicit LIFO stack carrying the
  innermost enclosing definition, so a call is attributed to the function it sits
  in rather than to the file. The three cases are an `if/elif/elif` chain (:361,
  :370, :381), so a node is only ever one of them.

### Resolution (`_resolve()` :388)

Call names resolve **only to symbols defined in this repo**; anything unresolved is
dropped on purpose (:395, and the module docstring :17-23 — an unfiltered shell
parse yields ~4300 coreutils invocations). Where a name has several definitions,
a **same-file definition wins** (:413-414); with no local match and more than one
candidate, the call is dropped entirely (:414). A bare filename resolves to a file
node as an `invokes` edge (:418).

### What it writes

`write_index()` :596 → `governance/code-graph.json`, keys at :436-457:
`root`, `files`, `symbols`, `edges`, `parse_errors`, `coverage`
(`indexed` / `by_language` / `skipped` / `not_source`), `provenance`
(`built_at`, `built_at_epoch` as a float, `commit`, `dirty`, `root`, `builder`).
`parse_errors` is a flat list of relative paths where `tree.root_node.has_error`
was true (:339).

`code_graph.py` imports nothing from `governance_graph.py` — checked; its only
imports are `json`, `os`, `pathlib`, `re` at module scope (:31-34), with
`tree_sitter` deliberately deferred into `_load_grammars()` (:36-46) so a reader
never needs a parser.

---

## 2. Grammar acquisition

`npm install` worked; no permission or network failure. Three sources were tried.

### The one to use: official per-grammar npm packages

**The `tree-sitter-*` npm tarballs published by the tree-sitter org already contain
a prebuilt `.wasm`.** This was not a given and is the most useful finding in this
section — it means no `tree-sitter build --wasm`, no emsdk, no Docker, and the
grammar version matches the pip package the harness pins today.

| File | Bytes | From npm package | Version | Matches pip? |
|---|---:|---|---|---|
| `tree-sitter-bash.wasm` | 1,358,224 | `tree-sitter-bash` | 0.25.1 | yes — venv has 0.25.1 |
| `tree-sitter-python.wasm` | 457,883 | `tree-sitter-python` | 0.25.0 | yes — venv has 0.25.0 |
| `tree-sitter-javascript.wasm` | 411,770 | `tree-sitter-javascript` | 0.25.0 | n/a (not pinned) |
| `tree-sitter-typescript.wasm` | 1,413,849 | `tree-sitter-typescript` | 0.23.2 | n/a |
| `tree-sitter-tsx.wasm` | 1,445,638 | `tree-sitter-typescript` | 0.23.2 | n/a |
| `web-tree-sitter.wasm` (runtime) | 209,613 | `web-tree-sitter` | 0.27.0 | runtime, ABI 15 |

The runtime wasm is named **`web-tree-sitter.wasm`**, not `tree-sitter.wasm`; the
name changed in the 0.25+ line. Grammar ABI reported at load: bash 15, python 15,
javascript 15, typescript 14, tsx 14 — the 0.27 runtime loads both.

sha256 of the five grammar blobs as fetched:

```
8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a  tree-sitter-bash.wasm
16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47  tree-sitter-python.wasm
5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240  tree-sitter-javascript.wasm
778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d  tree-sitter-typescript.wasm
79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8  tree-sitter-tsx.wasm
c03bccdc3b448a32848f5ae327e209c982bbb0840d43eec8bc2d5759544a1ed3  web-tree-sitter.wasm
```

### The one to avoid: `tree-sitter-wasms`

`tree-sitter-wasms@0.1.13` ships 37 grammars as one 51.8 MB package and is the
obvious convenience choice. Its own `package.json` devDependencies disqualify it:

```
"tree-sitter-bash": "^0.20.5",
"tree-sitter-python": "^0.21.0",
"tree-sitter-cli": "^0.20.8",
```

Those are **four and five minor versions behind** what the harness pins today
(`bash 0.25.1`, `python 0.25.0`). It is one individual maintainer
(`greeggoor <mail@dflate.io>`), Unlicense, last published ~10 months ago, and is a
fork of another individual's fork. Convenient for a spike, wrong for the harness:
it would silently introduce grammar-version skew into a parity migration whose
whole value is that the output does not change.

Sizes there also differ substantially from the official blobs
(its `tree-sitter-bash.wasm` is 1,400,214 vs 1,358,224), which is itself evidence
the grammars are not the same build.

`@vscode/tree-sitter-wasm` (0.3.1) exists and is Microsoft-published, but ships a
curated set for the editor's own needs and does not carry bash. Not pursued.

### What publishing would require

The blobs land in `assets/grammars/` and get committed, so the provenance question
is real. Three options, in order of preference:

1. **Extract from the official npm tarball at release time, commit the blob,
   record `package@version` + sha256 next to it.** This is vendoring someone
   else's binary, but that someone is the tree-sitter org itself, publishing the
   same grammar the pip package wraps. Cheapest, and the version story is exactly
   the one the harness already has in `pyproject.toml`.
2. **Build from source in CI** (`tree-sitter build --wasm`, needs emsdk or Docker).
   Reproducible and self-owned; costs an emscripten toolchain in the release
   pipeline. Nothing about it needs to touch a *user's* machine — it is a
   release-time cost only.
3. Depend on the npm packages at install time and read the wasm out of
   `node_modules`. Rejected: it defeats the single-binary goal and puts a network
   install between the user and a working `graph code build`.

**Not verified:** whether the official wasm blobs are bit-reproducible from source
at the same grammar version. If that matters, option 2 settles it and option 1
does not.

---

## 3. API — what 0.27 actually looks like

The API has changed from the older `Parser.init()` / `Parser.Language.load()` shape
that most surviving examples show. What worked:

```js
import { Parser, Language } from 'web-tree-sitter';   // named exports, not default

await Parser.init({ wasmBinary: runtimeBytes });      // Uint8Array — no path
const lang = await Language.load(grammarBytes);       // Uint8Array — no path
const p = new Parser();
p.setLanguage(lang);
const tree = p.parse(sourceString);                   // may return null
```

Signatures from `web-tree-sitter.d.ts`: `static init(moduleOptions?:
Partial<EmscriptenModule>)` :160, `static load(input: string | URL | Uint8Array)`
:319, `static loadSync(wasmModule: WebAssembly.Module)` :325,
`parse(callback: string | ParseCallback, oldTree?, options?): Tree | null` :193.

### The one API difference that will bite the port

**`parse()` takes a string or a callback — never bytes.** Passing a `Uint8Array`,
which is what the Python binding takes, fails on every file:

```
Error: Argument must be a string or a function
```

That was the first run: 76 files attempted, 76 threw, 0 symbols. Consequence:
`node.startIndex` / `endIndex` are **UTF-16 code-unit offsets into the string you
passed**, not byte offsets. A port that keeps Python's `src[node.start_byte:
node.end_byte]` over a Buffer produces garbage. Demonstrated:

```
source: 'echo "✅ ok 🚀 done"\nmy_func() { echo hi; }\n'
name via UTF-16 slice : "my_func"      <- correct
name via BYTE slice   : "ne\"\nmy_"     <- what a byte-offset port would get
```

**This is not a corner case here: 72 of the 76 indexed harness files contain
non-ASCII.** The fix is trivial — slice the same JS string the parser indexed — but
it is silent if got wrong, and it would corrupt symbol names rather than crash.
`startPosition.row` is unaffected, so line numbers are safe either way.

---

## 4. Parse results

Over `~/tools/harness`, same exclusions as `SKIP_DIRS` (:50), grammars bash 0.25.1
and python 0.25.0:

| | count |
|---|---:|
| files attempted | **76** (70 bash, 6 python) |
| parsed clean, zero ERROR nodes | **76** |
| parsed with ERROR nodes | **0** |
| threw | **0** |
| non-source files walked | 92 |

**No file listed under ERROR nodes, because there were none.** The bash grammar's
reputation for choking did not materialise on this repo at 0.25.1 — including the
17 extensionless shebang-detected scripts and `.claude/scripts/lib/*.sh`, which
carry the heavier shell. The Python indexer's own control run agrees: 0 parse
errors from both.

---

## 5. Count comparison

Two comparisons, because the committed index is stale and conflating the two would
have made a clean result look like drift.

### 5a. Against a same-tree control run — the real parity test

`code_graph.build()` is a pure function, so it was invoked read-only against the
current working tree with output written **only into the spike scratch dir**.
Nothing under `governance/` was touched. Grammar versions on both sides are
identical (bash 0.25.1, python 0.25.0), so this isolates logic from version skew.

| | Python control | web-tree-sitter | delta |
|---|---:|---:|---:|
| files | 76 | 76 | 0 |
| symbols | 428 | 428 | 0 |
| edges | 684 | 684 | 0 |
| parse_errors | 0 | 0 | 0 |
| not_source | 92 | 92 | 0 |

Set-level diff:

```
files:   both=76  onlyJS=0  onlyPY=0
symbols: both=428 onlyJS=0  onlyPY=0
line mismatches on shared symbols: 0
edges:   both=684 onlyJS=0  onlyPY=0
```

**Zero divergences. There is no divergence table for this comparison because the
table is empty.**

### 5b. Against the committed `governance/code-graph.json`

The committed index is stale, and the staleness is measured, not assumed:

- built at `2026-08-31T14:27:07Z` from commit `078c3a91`;
- `HEAD` is `26e81207`; `git rev-list --count 078c3a91..HEAD` = **4 commits behind**
  (`078c3a91` confirmed an ancestor of HEAD);
- the file is gitignored (`.gitignore:25 governance/*.json`), so it has no commit
  history of its own.

| | committed index | web-tree-sitter | delta |
|---|---:|---:|---:|
| files | 76 | 76 | 0 |
| symbols | 427 | 428 | +1 |
| edges | 680 | 684 | +4 |
| parse_errors | 0 | 0 | 0 |
| not_source | 89 | 92 | +3 |

All 13 divergences, with a diagnosis each:

| # | Divergence | Diagnosis |
|---|---|---|
| 1 | symbol `.claude/hooks/block-secret-reads.sh::secret_block_msg` present in mine, absent from index | **Stale index.** `block-secret-reads.sh` is in `git diff --name-only 078c3a91..HEAD`; the function was added after the index was built. |
| 2 | edge `block-secret-reads.sh -> …::secret_block_msg [calls]` | Same commit. Consequence of #1. |
| 3 | edge `block-secret-reads.sh -> walls-lib.sh::walls_cmd_words [calls]` | **Stale index.** Both `block-secret-reads.sh` and `walls-lib.sh` changed in the range. |
| 4 | edge `tests/hook-secret-tests.sh -> …::bad [calls]` | **Stale index.** `tests/hook-secret-tests.sh` changed in the range. |
| 5 | edge `tests/hook-secret-tests.sh -> …::ok [calls]` | Same file, same commit. |
| 6-13 | 8 symbols in `.claude/hooks/block-destructive.sh` shifted by exactly **+6 lines** (`has_word` 84→90, `first_word` 85→91, `attest` 114→120, `has_attestation` 127→133, `block` 136→142, `lex_resolve` 160→166, `is_temp` 188→194, `rm_targets_temp` 202→208) | **Stale index.** `block-destructive.sh` changed in the range; six lines were inserted above the first affected function. A uniform +6 shift with identical names and identical containment is a text edit above the definitions, not a parse difference. |

The `not_source` +3 is the same cause: `TS-MIGRATION-HANDOFF.md` (added in the
commit range) and `HARNESS_MANIFESTO.MD` (untracked, new). **Didn't do:** I did not
pin down the third new non-source file; the two named are confirmed new, the third
is unidentified.

**Every divergence lands inside exactly the four source files touched in
`078c3a91..HEAD` — `block-destructive.sh`, `block-secret-reads.sh`, `walls-lib.sh`,
`tests/hook-secret-tests.sh` — and there is not one divergence outside them.**
Combined with 5a, this is staleness of the committed artefact, with no contribution
from the parser, the grammars, or the port.

---

## 6. js/ts grammar availability

Obtainable from the same source, the same way, all loading and parsing under the
0.27 runtime:

| language | wasm | bytes | ABI | load | parsed sample |
|---|---|---:|---:|---:|---|
| javascript | `tree-sitter-javascript` 0.25.0 | 411,770 | 15 | 1.2 ms | clean, 2 defs found |
| typescript | `tree-sitter-typescript` 0.23.2 | 1,413,849 | 14 | 0.7 ms | clean, 2 defs found |
| tsx | `tree-sitter-typescript` 0.23.2 | 1,445,638 | 14 | 1.2 ms | clean, 1 def found |

"defs found" counts nodes matching `DEFINITION_NODES["typescript"]` :123
(`function_declaration`, `method_definition`) — so the existing node-type table
works unmodified against these grammars.

**One thing surfaced, not fixed.** `EXTENSION_LANGUAGE` :92 maps **both** `.ts` and
`.tsx` to the language name `typescript`, and `GRAMMAR_MODULES` :77 gives
`typescript` a single grammar. tsx is a **separate grammar**, and the typescript
grammar cannot parse tsx:

```
.tsx parsed with the TYPESCRIPT grammar -> hasError = true   (tsx grammar: false)
```

So an index built over a React codebase would list every `.tsx` file under
`parse_errors` and extract few or no symbols from it. This is latent — no `.ts` or
`.tsx` file exists in the harness today and no typescript grammar is declared in
`pyproject.toml`, so it has never fired. The comment at :174 (*"some grammar
packages expose several dialects"*) suggests the dialect problem was anticipated;
the registry has no row for it. **Recorded as an open question below, not changed.**

**Inference, not measured:** the pip `tree_sitter_typescript` package almost
certainly exposes `language_typescript()` and `language_tsx()` rather than the bare
`mod.language()` that `_load_grammars()` :173 calls, in which case typescript would
land in `missing` rather than parsing wrongly. I did not install it to check —
the harness venv is read-only for this spike.

---

## 7. SEA vs Bun-compile

Both were **built and executed**, not reasoned about. The pivotal question — whether
the Emscripten runtime insists on a file path — was answered by test, and by a
negative control first.

### The enabling fact (measured)

`Parser.init()` accepts the standard Emscripten `wasmBinary` option, so **the
runtime wasm never needs to exist as a file**, and `Language.load()` takes a
`Uint8Array` directly. Neither needs `locateFile`.

Negative control, because a check that cannot fail proves nothing — the runtime
wasm was moved out of `node_modules` and both paths re-run:

```
[1] no wasmBinary:  RuntimeError: Aborted(Error: ENOENT: no such file or directory,
                    open '.../node_modules/web-tree-sitter/web-tree-sitter.wasm')
[2] with wasmBinary: Parser.init({wasmBinary}) OK
                     Language.load(Uint8Array) OK, abi 15
                     parsed, root: program hasError: false
```

The check fails when it should, and passes on bytes alone. The bytes are genuinely
used.

### Node SEA — measured, works

Bundled with esbuild to CJS (182 KB), three wasm blobs declared as `sea-config.json`
assets, read with `sea.getAsset()` (returns an `ArrayBuffer`, wrapped in a
`Uint8Array`), injected with postject, ad-hoc codesigned. Run **from `/`**, with no
`node_modules` anywhere in scope:

```
SEA: isSea = true
SEA: bash parse -> program hasError false
SEA: bash sexp  -> (program (function_definition name: (word) body: (compound_stat…
SEA: py   parse -> module hasError false
SEA: cold init + 2 grammars, ms = 17
```

Artefacts: `prep.blob` 2,212,399 bytes (= bundle + the three wasm, embedded
uncompressed), final binary **72,962,736 bytes (70 MB)**.

Friction encountered, all on the macOS packaging side rather than in tree-sitter:
the copied `node` binary is mode `r-xr-xr-x`, so postject fails with
`Error: Can't read and write to target executable` until `chmod u+w`; the signature
must be stripped before injection and re-applied after. **Inference:** on Windows
neither codesigning step applies and postject uses a PE resource section instead of
a Mach-O segment, which is the better-trodden path — but I did not run it there.

### Bun `--compile` — measured, works

Bun 1.4.0, installed into the spike scratch dir. Wasm embedded via
`import x from './y.wasm' with { type: 'file' }`, which yields a path served from
the binary's virtual filesystem; `fs.readFileSync` on it returns the bytes, which
go to the same `wasmBinary` / `Language.load` calls. Run from `/`:

```
BUN: bash -> program hasError false
BUN: py   -> module hasError false
BUN: cold init + 2 grammars, ms = 22
```

Build: `bundle 5 modules [32ms]`, `compile [175ms]`. Binary **66,073,586 bytes
(63 MB)**.

### The call

**Node SEA, for a Windows single binary.**

| | Node SEA | Bun compile |
|---|---|---|
| Works with wasm bytes | yes (measured) | yes (measured) |
| Binary size | 70 MB | 63 MB |
| Cold init + 2 grammars | 17 ms | 22 ms |
| Build steps | bundle → sea-config → postject → sign | one command |
| Windows cross-compile | inference: same-host build; postject targets PE | `--target=bun-windows-x64` from any host (inference, not run) |

Bun is unambiguously **less friction to build** — one command against four steps,
and it cross-compiles for Windows from macOS, which SEA does not. If build
ergonomics were the only axis, Bun wins.

Node SEA still gets the recommendation, for reasons outside this spike's
measurements and marked accordingly:

- **Measured:** the asset mechanism is a first-class, declared part of the artefact
  (`sea-config.json` `assets` + `sea.getAsset()`), rather than a bundler convention.
  Both worked; SEA's is the more explicit contract.
- **Inference:** the rest of the ported CLI is Node-targeted TypeScript. Adopting
  Bun as the *packaging* toolchain quietly makes it the runtime too, and every
  future dependency then has to work under Bun's Node-compat layer. That is a
  larger commitment than a packaging decision should carry, and it is not a
  tree-sitter question.

**Neither was run on Windows.** Everything above is macOS/arm64. The claim this
spike actually establishes is the one that matters for Windows — *no compiler
toolchain and no wasm file on disk are required at any point* — and that is
platform-independent. The packaging mechanics on Windows are unverified.

---

## 8. Timings

Full index of `~/tools/harness` (76 files), 5 runs each, same machine, warm cache.

| | web-tree-sitter (Node) | Python indexer |
|---|---:|---:|
| build only, best | 186.1 ms | 110.5 ms |
| build only, median | 190.6 ms | 112.0 ms |
| process wall clock | 0.22–0.25 s | 0.12–0.16 s |

Node breakdown (median run): `Parser.init()` **2.8 ms**, filesystem survey 2.8 ms,
load 2 grammars from bytes **2.8 ms** (bash 2.2, python 0.6), parse + walk 179 ms.

Cold init in the packaged binaries: SEA **17 ms**, Bun **22 ms**, both including
runtime init and two grammars.

**The Python indexer is roughly 1.7× faster on this workload** — 190 ms vs 112 ms.
Both are well inside the noise of a CLI invocation, and `graph code build` is not on
a hot path. Recorded as a fact, not treated as a blocker.

Install footprint: `node_modules/web-tree-sitter` 4.5 MB as published (includes
source maps and a debug build). **Runtime-required subset is 365,745 bytes** —
`web-tree-sitter.js` 156,132 + `web-tree-sitter.wasm` 209,613. Grammars:
1,816,107 bytes for bash + python; 5,087,364 bytes for all five.
So a bash+python CLI carries **~2.1 MB** of parser assets.

Python side for comparison: the harness `.venv` with `tree-sitter` 0.26.0 plus two
grammar wheels, and a CPython interpreter under it — which the port removes
entirely. That removal, not the millisecond count, is the point.

---

## 9. Recommendation and risks

**Port it.** Use `web-tree-sitter@0.27.x` with grammar wasm extracted from the
official `tree-sitter-<lang>` npm tarballs at release time, committed to
`assets/grammars/` with `package@version` and sha256 recorded beside each blob.
Embed via SEA assets. The parity evidence is as strong as this kind of evidence
gets: identical output, not merely similar counts.

Risks, in the order I would worry about them:

1. **UTF-16 offsets (high likelihood, silent).** 72 of 76 harness files contain
   non-ASCII. A byte-offset port corrupts symbol names without raising anything.
   Mitigation: one parity test asserting the full symbol set against a fixture that
   contains a non-BMP character above a definition. This is the single check most
   worth having.
2. **Grammar-version drift (medium).** The wasm blobs are committed, so they stop
   tracking `pyproject.toml` the moment Python is removed. Mitigation: record the
   version next to the blob and make a version bump a deliberate act with a
   re-run of the parity comparison.
3. **tsx (medium, latent).** Section 6. Fires the first time a repo with `.tsx` is
   indexed, and the failure looks like "this file is full of parse errors" rather
   than "the wrong grammar was chosen".
4. **`parse()` can return `null` (low).** The type is `Tree | null`; Python's
   binding has no such case. Handle it explicitly rather than letting it surface as
   a null-dereference. It did not occur on any of the 76 files.
5. **Binary size (low).** 70 MB, of which ~2 MB is parser assets — the rest is the
   Node runtime and would be there regardless.
6. **Windows unverified (low but unclosed).** The no-toolchain claim holds by
   construction; the postject/PE packaging step has not been exercised.

---

## 10. Open questions for User

Everything here is surfaced, not fixed, per the migration rule. None of it was
changed.

1. **`.tsx` maps to the typescript grammar, which cannot parse tsx.**
   `EXTENSION_LANGUAGE` :92 sends `.tsx` to language `typescript`; tsx is a distinct
   grammar and the typescript one returns `hasError = true` on tsx source
   (measured). Never fired, because no `.ts`/`.tsx` exists in the harness and no
   typescript grammar is declared. The port has to pick a registry shape for
   dialects. Does `.tsx` become its own language row (`tsx`), or does the
   language→grammar map gain a dialect field? This is a design choice the port
   forces; I did not make it.

2. **Should the port reproduce the committed index, or the same-tree result?**
   The committed `governance/code-graph.json` is 4 commits stale and gitignored. If
   the port's acceptance test compares against the committed artefact it will fail
   on 13 divergences that are all staleness. I used a same-tree control run instead.
   Confirming that is the right acceptance baseline would be useful before the port
   is written.

3. **Vendored blob or CI-built wasm?** Option 1 (extract from the official npm
   tarball, commit, record sha256) is cheapest and matches today's pinned grammar
   versions. Option 2 (build from source in CI with emsdk) is self-owned and
   reproducible. Both are release-time only; neither touches a user's machine.
   Section 2 lays out the trade; the choice is yours.

4. **Bun was measured to be materially easier to build with and can cross-compile
   for Windows, and I still recommended Node SEA.** My reason is that adopting Bun
   for packaging makes it the runtime for the whole ported CLI, which is a bigger
   decision than packaging — and that part is inference, not measurement. If you
   would rather take the Bun runtime dependency deliberately, the build story is
   genuinely better and this spike does not argue against it.

5. **Two behaviours in `code_graph.py` that I am NOT calling defects, and did not
   touch.** Both are load-bearing for parity, so the port should reproduce them
   knowingly rather than discover them:
   - a call name with several candidate definitions and no same-file match is
     **dropped entirely** (:414), so a genuine cross-file call to a uniquely-named
     helper is kept but one to an ambiguously-named helper is not;
   - two definitions of the same name in one file **collapse to one symbol** and the
     last one walked wins the `line` (:364-365).

   The docstring (:17-23) and the comment at :406-412 say the filtering is
   deliberate and measured. Flagging them so the port does not "improve" either one.

---

## Reproduction

Scratch dir (nothing was written into any repo except this file):
`…/scratchpad/spikes/C-tree-sitter/` — `index.mjs` (the port), `out-graph.json`,
`py-graph.json` (control), `apitest/` (byte-loading + negative control), `sea/`,
`bunbuild/`, `jsts.mjs`, `utf.mjs`.

`~/tools/harness` was read-only throughout; `governance/` was not written.
The Bun installer appended a `BUN_INSTALL`/`PATH` block to `~/.zshrc`; that was
removed and the file verified back to its prior contents (0 bun references remain).
