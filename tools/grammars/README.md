# tools/grammars — the tree-sitter grammars, as WebAssembly

Thirteen `.wasm` blobs. They are what `scrumux graph code build` parses with,
and they exist so that building a code index needs **no compiler, no
node-gyp, no emscripten and no Python** — which is what makes the indexer work
on a bare Windows machine (D-0085, `docs/port/spikes/C-tree-sitter.md`).

## What reads these, and what must never read them

`src/nouns/graph/code-build.ts` — the BUILDER — and nothing else. The
reader/builder split is the whole design of the code graph: every `graph code`
QUERY answers from `governance/code-graph.json` with no parser at all, which
is why a deployed repo has a working graph and never carries one of these
files.

**These are SOURCE-REPO assets. They are not payload and they never deploy.**
`scrumux harness deploy` builds the index INTO each target from this checkout
(CLI-CONSOLIDATION §8), so the grammars stay here and the target gets the
answer. Nothing under `.deploy-claude/` references this directory, and the
deployed bundle contains no parser: `code-build.ts` loads the web-tree-sitter
runtime through a *computed* specifier precisely so esbuild leaves it alone
rather than inlining 156 KB of emscripten glue into every governed repo.

## Provenance

Every blob was extracted from the official `tree-sitter-*` npm tarball
published by the tree-sitter org — the same grammar the pip package the
harness used to pin wraps. Nothing was built from source here.

| file | npm package | version | bytes | sha256 |
|---|---|---|---:|---|
| `tree-sitter-python.wasm` | `tree-sitter-python` | 0.25.0 | 457,883 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-bash.wasm` | `tree-sitter-bash` | 0.25.1 | 1,358,224 | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript` | 0.25.0 | 411,770 | `5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240` |
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript` | 0.23.2 | 1,413,849 | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | `tree-sitter-typescript` | 0.23.2 | 1,445,638 | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |
| `tree-sitter-go.wasm` | `tree-sitter-go` | 0.25.0 | 217,182 | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `tree-sitter-rust.wasm` | `tree-sitter-rust` | 0.24.0 | 1,102,547 | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |
| `tree-sitter-ruby.wasm` | `tree-sitter-ruby` | 0.23.1 | 2,106,352 | `09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4` |
| `tree-sitter-php.wasm` | `tree-sitter-php` | 0.24.2 | 1,058,041 | `d4df6a6ff08c87c3ec4f9cbb785fe09998a0cb570e03f57d7b19b3acfb146aa7` |
| `tree-sitter-java.wasm` | `tree-sitter-java` | 0.23.5 | 414,641 | `4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4` |
| `tree-sitter-c.wasm` | `tree-sitter-c` | 0.24.1 | 625,918 | `c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9` |
| `tree-sitter-cpp.wasm` | `tree-sitter-cpp` | 0.23.4 | 3,434,931 | `174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf` |
| `tree-sitter-c_sharp.wasm` | `tree-sitter-c-sharp` | 0.23.5 | 5,350,581 | `6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40` |

19 MB total. Five of these hashes (bash, python, javascript, typescript, tsx)
were also recorded independently by Spike C on 2026-08-31 and match to the
byte, which is the closest thing to a reproducibility check this vendoring
has.

The **runtime** is not here. `web-tree-sitter@0.27.0` is a pinned exact
devDependency and both of its halves — `web-tree-sitter.js` and
`web-tree-sitter.wasm` — are read out of `node_modules/web-tree-sitter/` by
absolute path. That is deliberate on two counts: `node_modules` is in the
indexer's own `SKIP_DIRS`, so vendoring the 156 KB glue file *here* would put
a minified JavaScript file into the harness's own code graph, and a
lockfile-pinned package is better provenance than a second committed blob.

`graph code build` therefore needs `npm ci` to have been run in this checkout.
It is a source-repo tool; so does `npm run build`.

## Re-vendoring, and why it is a deliberate act

The blobs are committed, so they stop tracking anything the moment they are
written: nothing will tell you a grammar moved. A version bump is meant to be
a decision with a parity re-run behind it, not a background update
(Spike C §9, risk 2).

```sh
# in a scratch directory, NOT in the repo
npm pack tree-sitter-go@0.25.0
tar -xzf tree-sitter-go-0.25.0.tgz
cp package/tree-sitter-go.wasm <checkout>/tools/grammars/
shasum -a 256 <checkout>/tools/grammars/tree-sitter-go.wasm   # update the table above
```

`npm pack` downloads the tarball without running an install script, which is
what keeps this free of the native toolchain the same packages would
otherwise want to build.

Registering a NEW language is two things and neither is a code change in the
extraction: a row in `GRAMMAR_FILES` (`src/nouns/graph/code-build.ts`) and a
blob here. The extension→language and node-type tables are separate and
already carry twelve rows each.

## Two things about this set that are worth knowing before you trust it

**`tree-sitter-tsx.wasm` is a dialect, not a thirteenth language.**
`EXTENSION_LANGUAGE` maps BOTH `.ts` and `.tsx` to the language name
`typescript`, and the typescript grammar cannot parse tsx — it returns
`hasError` on every file (measured, Spike C §6). `graph code build` EXITS 1
when `parse_errors` is non-empty, so a naive registration would turn
`harness deploy`'s `code-graph-built` check red in any React repo. The blob is
therefore selected per FILE while the language NAME stays `typescript`, which
leaves `coverage.by_language`, `skipped`, every symbol's `lang` and
`language_of` itself untouched. Spike C's open question 1 asked whether `.tsx`
should become its own registry row; that question is still open and this does
not answer it.

**Ten grammars is not ten more languages' worth of graph.** Measured on these
exact blobs: symbols come out of ten of the twelve (c and cpp yield none —
their `function_definition` has no `name` field, the identifier sits under
`declarator`, and `_definition_name` special-cases only python before falling
back to the `name` field), and CALL EDGES come out of only three: python (its
own `function`-field branch), bash (`command`, whose field IS `name`) and java
(`method_invocation`, ditto). Everything else names the callee somewhere
`_callee_name` does not look — `function` for javascript, typescript, go,
rust, c, cpp and php; `method` for ruby — and c_sharp's `invocation_expression`
is not in `_DEFAULT_CALL_NODES` at all. That gap in the registry is a known,
untracked-by-design limitation, not a regression: it is left alone rather than
widened opportunistically, because widening callee detection is a change to
shared behaviour and belongs in its own reviewed change, not folded into
grammar vendoring. `test/unit/code-build-wave5j.test.ts` asserts the current
truth for all twelve so that a change to it has to change a test.
