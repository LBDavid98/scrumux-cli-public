# Spike B — jq compiled to WebAssembly as the engine behind `repair journal --apply`

> Pinned at 5d823b1 — file:line references resolve against `git show 5d823b1:<path>`; the tree may have moved.

Phase 0, scrumux-cli bash+jq → TypeScript port.
Run 2026-08-31 on macOS 25.3 / arm64, Node v24.4.1, npm 11.4.2, reference `jq-1.7.1-apple` at `/usr/bin/jq`.

All work in a scratch directory; `~/tools/harness/governance/*.json` were copied and read only.

---

## Verdict

**EMBED WASM** — `jq-wasm`, pinned to a jq version, loaded through its Node entry.

The deciding fact: over **433 differential cases** (31 real historical `--apply` filters × all
11 journals, plus 46 generated filters × 2 journals), `jq-wasm@3.0.0-jq-1.8.2` matched
`/usr/bin/jq` **byte-for-byte on stdout and exactly on exit code in 431/433 = 99.54%**, and
**both misses are the same case** — one filter I wrote that exercises a jq 1.7 → 1.8 *language*
change (`try … as $x | … catch …`), not a WASM defect. That it is a version difference and not an
engine difference is proved by the control run: **the same package pinned to jq 1.7.1 matched the
1.7.1 reference 92/92 = 100%**, including that case. The package needs no native code, no
postinstall, no toolchain, no `fetch`, and no shared memory.

---

## 1. What `repair journal --apply` actually does in bash today

`.claude/scripts/lib/cmd-repair.sh`, `repair_impl()` at :10.

**Argument shape** — the journal name is positional, then three required flags
(`cmd-repair.sh:20-32`):

```
scrumux repair journal <name.json> --apply '<jq>' --why TEXT --by WHO
```

`--apply`, `--why` and `--by` are each hard-required and the command dies naming the reason
(:30, :31, :32). The target must exist under `$GOV` (:33).

**The jq invocation shape. This is the part that matters most for the port.**

There are exactly **two** jq calls that see the user's filter, and neither passes a single flag:

| Site | Call | Purpose |
|---|---|---|
| `cmd-repair.sh:43` | `jq "$EXPR" "$GOV/$JF" > "$_chk" 2>/dev/null` | dry run into a temp file |
| `lib.sh:178` (via `write_json` → `_write_json_body`) | `jq "$@" "$f" > "$tmp"` | the real write |

So: **no `-n`, no `-r`, no `-c`, no `-s`, no `--arg`, no `--argjson`, no `--sort-keys`, no
`--tab`, no `--indent`.** One filter, one file argument, default pretty printer (2-space
indent), stdout redirected to a temp file. `stderr` is discarded on the dry run and inherited on
the write.

(Other flags do appear elsewhere in the CLI — `-r` 206 times, `-e` 182, `-c` 24, `-nc` 20,
`--arg` 19, `-s` 12, `-R` 6, `--slurpfile` 2, `--argjson` 1 across 631 `jq` lines in
`.claude/scripts/`, `.claude/hooks/` and `tests/`. None of them reach `--apply`.)

**Cross-reference to Spike A.** `A-jqformat.md` establishes that a pure-JS serializer reproduces
`jq .` output byte-for-byte on all 11 live journals, given literal-preserving number parsing. That
covers the *formatting* half of every write path. This spike covers the half Spike A does not: an
arbitrary user-supplied *filter*. The two are compatible — `jq-wasm`'s stdout also matched
`/usr/bin/jq` byte-for-byte here, so the port can either write the WASM's bytes directly or parse
and re-serialize through `jqformat`, and get the same seal either way.

**Why byte-fidelity is load-bearing, not cosmetic.** The bytes jq writes *become the journal*
(`lib.sh:274`, `mv "$tmp" "$f"`), and the very next statement reseals the file with a SHA-256 of
its content (`lib.sh:284` → `reseal_one` → `seal_of` at `lib.sh:376`,
`shasum -a 256`). A pretty-printer that differs by one space changes the seal of the journal, and
`records check` reports the difference as *"changed outside scrumux"* — a false tampering
accusation. A replacement engine therefore has to reproduce jq's output **exactly**, not merely
equivalently. That is why the comparison below is on stdout bytes and not on parsed JSON.

**The guard sequence around the filter** (all of it depends on jq's exit code and output bytes):

1. `BEFORE=$(seal_of ...)` before anything is written (`cmd-repair.sh:34`).
2. Dry run to `$_chk`; **non-zero exit ⇒ die** ("the jq expression failed", :43).
3. **Empty output ⇒ die** ("would truncate", :44). Note this relies on jq's real behaviour that
   `.entries[] | select(false)` exits **0** with no output.
4. **Seal unchanged ⇒ die** as a no-op (:46) — this ordering exists because an earlier version
   resealed a tampered journal before discovering the no-op (recorded in `AI_LOG.MD` and in the
   comment at :35-41).
5. `write_json` re-runs the same filter under the journal lock (`lib.sh:293`), then re-checks
   empty output (`lib.sh:187`), then `jq -e 'type=="object" and has("entries") and (.entries|type=="array")'`
   on the result (`lib.sh:197`), then the **entry-count guard** (`lib.sh:219-226`): a write that
   reduces `.entries|length` is refused unless `ALLOW_ENTRY_REMOVAL=1`.
6. Ten generations of the pre-write file are copied to `governance/.backups/` (`lib.sh:~245`).
7. `mv`, reseal, then `log_new` writes the record in the same operation
   (`cmd-repair.sh:49-52`) — the `--why` and the **full filter text** are stored in the log entry's
   `what_was_done`, which is how the corpus below was recovered.

**A note on the guards, not a request to change them.** The entry-count guard and the
`ALLOW_ENTRY_REMOVAL` escape hatch exist because on 2026-08-27 a filter using
`($stream) as $x | body` silently reduced `decisions.json` from 80 entries to 6 — jq binds over
an empty stream to nothing, so `map()` dropped every non-matching row and the command reported
success. Any port must reproduce these guards' *semantics* including their reliance on jq's exit
codes. Nothing here proposes changing bash behaviour.

---

## 2. Candidates

| | `jq-wasm` | `jq-web` | `node-jq` |
|---|---|---|---|
| Version tested | `3.0.0-jq-1.8.2` (also `1.1.0-jq-1.7.1`) | `0.6.2` | `6.3.1` |
| npm `time.modified` | 2026-07-05 | 2025-03-19 | 2025-08-29 |
| jq version wrapped | **jq 1.8.2** (pin available: jq 1.7.1) | reports 218 builtins, same as the reference `jq-1.7.1-apple` | **downloads jq 1.7.1 binary** |
| Mechanism | Emscripten WASM | Emscripten WASM | preinstall download of the official release binary |
| `.wasm` blob | **928,824 B** (332,195 B gzipped) | 2,784,691 B | n/a |
| JS glue | 130,484 B (`index.mjs`) | 157,480 B (`jq.js`) | ~90 KB lib + 5 deps |
| Single-file variant | `jq-wasm/inline` — 1,367,200 B, wasm base64-embedded | no | no |
| Total installed | 3.9 MB (1.3 MB for the 1.7.1 pin) | 3.5 MB (ships a full `emsdk/` tree it does not need at runtime) | 920 KB + 807,984 B downloaded binary |
| Module format | CJS + ESM, conditional exports for node / browser / workerd / edge | CJS only | CJS |
| API | `loadJq()` → **synchronous** `raw/json/first/stream`; also top-level async helpers | promise-then-**sync** `raw/json` | **async only**, spawns a child process per call |
| Errors | `raw()` **returns** `{stdout, stderr, exitCode}`; `json()` throws `JqError` carrying `stderr`/`exitCode` | **throws** `Error("Non-zero exit code: N\n<stderr>")` | rejects |
| Needs `fetch` / `instantiateStreaming` | **No** on the Node path — reads `join(__dirname,"build","jq.wasm")` with `fs/promises.readFile`. The `fetch`/`instantiateStreaming` branches exist inside the Emscripten runtime and are only reached when a URL is supplied | Emscripten default loader | n/a |
| Native code / postinstall | **none** — no `install`/`preinstall`/`postinstall`, no `.node`/`.dylib`/`.so`, no `os`/`cpu` restriction, **zero runtime dependencies** | none | **`preinstall` downloads from `github.com/jqlang/jq/releases`** |
| Node constraint | `engines: node >= 20`; ran clean on Node 24.4.1 with no flags | ran clean on Node 24.4.1, no flags | ran clean |
| License | **MIT** | ISC | MIT |

`jqjs` (0.0.1, 2022) and `jq-in-the-browser` (0.7.2, 2022) are unmaintained
reimplementations rather than builds of jq, so they cannot inherit jq's exact semantics and were
not tested. `@jq-tools/jq` (0.0.11) is at a pre-release version with no declared license field.
`jaq-wasm` was unpublished from npm on 2026-04-27.

---

## 3. Corpus

### 3.1 Real filters — 31, recovered from the harness's own log

`repair` writes `Applied: <filter>. Content hash …` into the log entry it creates
(`cmd-repair.sh:50`), so `governance/log.json` is a complete register of every repair ever run.
31 distinct filters, across 8 journals (two of which — `gates.json`, `health-review.json` — no
longer exist):

| Log id | Journal | Filter len | Shape |
|---|---|---:|---|
| L-0154 | decisions.json | 57 | `(.entries[] \| select(.id=="D-0051") \| .supersedes) = null` |
| L-0278 | decisions.json | 157 | `.entries as $all \| .entries \|= map(… ($all[] \| select(.supersedes == $e.id) \| .id) as $newer …)` — **a cross-entry join** |
| L-0281 | decisions.json | 125 | `map(if .id=="D-0063" … elif … else . end)` |
| L-0284 | decisions.json | 376 | two id-lists bound as `$g1`/`$g2`, `index()` membership, conditional set |
| L-0280 | decisions.json | 514 | `if … then .rationale \|= (split("\n\n# Superseded")[0]) elif … end` — **string surgery** |
| L-0282 | decisions.json | 1240 | a literal id→object map merged per entry |
| **L-0279** | **decisions.json** | **91,094** | **`.entries = [ …80 entries verbatim… ]`** — the restore after the journal was destroyed |
| L-0170 | design.json | 178 | `map(if .id=="F-0011" then .deps=[…] …)` |
| L-0188 | gates.json | 13 | `.entries = []` |
| L-0197 | gates.json | 117 | `map(select((.source == … and (.subject \| test("^/app/\|^/etc/\|fixture\|probe"))) \| not))` — **regex** |
| L-0198 | gates.json | 56 | `map(select(.source != "block-secret-reads"))` |
| L-0182 | health-review.json | 19 | `{entries: .reviews}` — **top-level schema reshape** |
| L-0183 | repo-health.json | 18 | `{entries: .checks}` — **top-level schema reshape** |
| L-0178 | repo-health.json | 63 | `.checks \|= map(select((.name \| test("prompt-approval")) \| not))` — **regex** |
| L-0276 | repo-health.json | 115 | rename + command rewrite |
| L-0229 | repo-health.json | 124 | drop three by name |
| L-0205 | repo-health.json | 129 | drop three by name |
| L-0189 | repo-health.json | 275 | two-branch rename + command rewrite |
| L-0201 | repo-health.json | 357 | `.entries = (.entries \| map(if …) \| map(select(…)))` — pipeline of two maps |
| L-0231 | repo-health.json | 537 | whitelist: `select([…25 names…] \| index($e.name))` |
| L-0277 | repo-health.json | 615 | five-branch command rewrite |
| L-0185 | issues.json | 670 | eight-branch enum normalisation with `startswith()` |
| L-0254 | issues.json | 1320 | set one field to a 1.2 KB sentence |
| L-0235 | log.json | 351 | `.what_was_done` through **three chained `sub()` calls** |
| L-0266 | log.json | 683 | set `.pending` to an array literal |
| L-0253 | tasks.json | 86 | `.description \|= sub("\\(T-0198\\)"; "(T-0199)")` — **regex** |
| L-0223 | tasks.json | 319 | set `.acceptance_check` |
| L-0224 | tasks.json | 351 | set `.acceptance_check` |
| L-0243 | tasks.json | 384 | set `.acceptance_check` |
| L-0225 | tasks.json | 563 | set `.acceptance_check` |
| L-0226 | tasks.json | 633 | `.task_order.scope += "…"` |

Recovery note, worth writing down because it bit this spike: the extraction regex
`capture("Applied: (?<f>.*)\\. Content hash ")` with jq flag `"s"` silently **lost 9 of the 31**,
because in jq/Oniguruma the dotall flag is **`m`**, not `s` (`s` is single-line mode). Anything in
the port that ports a jq `test`/`capture`/`sub` flag string has to carry that mapping.

### 3.2 Generated filters — 46

`generated-filters.json` in the scratch dir. Covers `map`, `select`, `del`, `to_entries` /
`from_entries` / `with_entries`, `|=`, `+=`, index and slice, `//`, `if/then/elif/else/end`,
`"\(…)"` interpolation, `@json`, `@base64`, `@text`, `sort_by`, `group_by`, `unique_by`, `add`,
`reduce`, `paths`, `getpath`/`setpath`, `walk`, `any`/`all`, `tostring`/`tonumber`, `test`, `sub`,
`gsub`, `splits`, `$ENV`, `$__loc__`, `limit`, `first`/`last`, `ltrimstr`, `ascii_downcase`,
`now`, `strftime`, `fromdateiso8601`, `recurse`, string multiplication, object construction,
`try/catch`, the **empty-stream binding that destroyed decisions.json** (`(.nomatch[]?) as $x | …`),
plus three error paths: `error("deliberate")`, a type error (`.entries + 1`), and a syntax error.

### 3.3 Case matrix

31 real × 11 journals = 341, plus 46 generated × 2 journals (`decisions.json`, `sprints.json`) =
92. **433 cases.** Comparison is `sha256` of stdout with trailing newlines normalised (jq emits a
final `\n`; both WASM wrappers return the string without it), plus exact exit-code equality.

---

## 4. Agreement

| Engine | Cases | stdout byte-identical | stdout + exit code | Fatal |
|---|---|---|---|---|
| **`jq-wasm@3.0.0-jq-1.8.2`** | 433 | 431 | **431/433 = 99.54%** | 0 |
| `jq-web@0.6.2` | 433 | 422 | 422/433 = 97.46% | **11 unrecoverable crashes** |
| `jq-wasm@1.1.0-jq-1.7.1` (version-matched to the reference) | 92 (the generated set) | 92 | **92/92 = 100.00%** | 0 |

The third row is the control. Running the version-matched WASM build against the version-matched
native jq gives **exact agreement on every generated case including `gen-try_catch`** — the only
case where 1.8.2 diverged. That isolates the divergence to the **jq version**, not to WebAssembly.
Caveat: the version-matched run covers the generated set only. The pinned 1.1.0 build is ~30×
slower per call, and the full 433-case matrix over the megabyte journals was still running after
~25 minutes and was stopped. **Not run: the pinned build across the 341 real-filter cases.** The
real-filter cases were run against 3.0.0/1.8.2, where all 341 matched.

### 4.1 Every `jq-wasm` disagreement

Two cases, the same filter on two journals:

| Filter | Input | `/usr/bin/jq` (1.7.1) | `jq-wasm` (1.8.2) |
|---|---|---|---|
| `gen-try_catch`: `.entries \|= map(try (.id \| tonumber) as $n \| . catch .)` | decisions.json | exit 0, 6,993 B of output | exit **3**, empty |
| same | sprints.json | exit 0, 2,373 B | exit **3**, empty |

`jq-wasm` stderr:

```
jq: error: syntax error, unexpected catch, expecting ';' or ')' at <top-level>, line 1, column 48:
    .entries |= map(try (.id | tonumber) as $n | . catch .)
                                                   ^^^^^
jq: 1 compile error
```

Minimal repro, `(try 1 as $n | $n catch 2)`:

```
$ echo null | jq '(try 1 as $n | $n catch 2)'
1
jq-wasm 1.8.2: exit 3, "syntax error, unexpected catch, expecting '|' or ',' or ')'"
```

**This is a jq language change between 1.7.1 and 1.8, not a WASM artifact.** Two independent
confirmations: `jq-web` (218 builtins, the same count as the reference build) produced
byte-identical output to `/usr/bin/jq` on both cases; and `jq-wasm@1.1.0-jq-1.7.1` — the *same
package* built against jq 1.7.1 — also matched, 92/92 on the whole generated set. The filter is
one I wrote to probe the boundary; **no real historical filter uses jq's `try`/`catch` at all**
(the only `catch` anywhere in the 31 is English prose inside the 91 KB restore literal), and all
341 real-filter cases matched.

### 4.2 Every `jq-web` disagreement

All eleven are the **same filter**: `L-0279`, the 91 KB literal that restored `decisions.json`
after it was destroyed. On every one of the eleven journals it fails with:

```
memory access out of bounds
```

and the Emscripten module is **poisoned for the rest of the process** — every subsequent call in
that process fails the same way regardless of filter. (The differential run had to be driven as a
restart-on-crash loop; it restarted 11 times.)

Bisecting on filter length with a synthetic `.entries = [ …n objects… ]`:

| filter length | `jq-web` | `jq-wasm` |
|---:|---|---|
| 45,012 B | OK | OK |
| 50,012 B | `memory access out of bounds` | OK |
| 57,512 B | `memory access out of bounds` | OK |
| 60,012 B | `memory access out of bounds` | OK, exit 0 |
| 250,012 B | not tested | OK, exit 0 |
| 1,010,012 B | not tested | OK, exit 0 |

At n=1100 `jq-web` produced `Aborted(Assertion failed: @, at: ����,222,gen_{)` — a garbled
message, i.e. heap corruption rather than a clean refusal. **`jq-web` is disqualified**: it fails
on the single most consequential repair in the harness's history, and it fails by corrupting its
own heap rather than by returning a non-zero exit code the guards could act on.

### 4.3 Error-path behaviour

| Case | `/usr/bin/jq` | `jq-wasm` | `jq-web` |
|---|---|---|---|
| syntax error (`.a \|`) | exit 3, `jq: error: syntax error …\njq: 1 compile error` | **returns** `{exitCode:3, stderr: same text}` | **throws** `Error("Non-zero exit code: 3\n…(Unix shell quoting issues?)…")` |
| type error (`.a + "x"`) | exit 5, `jq: error (at <file>:0): number (1) and string ("x") cannot be added` | **returns** `{exitCode:5, stderr: same, path shown as /dev/stdin}` | throws, exit 5 |
| `error("boom")` | exit 5 | returns `{exitCode:5, stderr:"jq: error (at /dev/stdin:0): boom"}` | throws, exit 5 |
| filter matches nothing | exit **0**, no output | exit **0**, `stdout: ""` | same |
| input file is malformed JSON | exit 5, `jq: parse error: Expected another array element at line 1, column 22` | exit 5, **identical message** | — |

Two notes for the port:

- `jq-wasm.raw()` **never throws for a jq-level failure** — it returns `{stdout, stderr, exitCode}`,
  which maps directly onto the bash `$?` checks at `cmd-repair.sh:43` and `lib.sh:178`. Its
  `json()`/`first()` helpers do throw a `JqError` carrying `stderr` and `exitCode`.
- The **file path in the error message differs**: jq says `(at governance/tasks.json:0)`, jq-wasm
  says `(at /dev/stdin:0)`, because the input arrives as a buffer, not a path. Any test that
  greps a jq error message for the journal name will need the port to rewrite that token.

### 4.4 Fidelity spot-checks beyond the corpus

All byte-identical to `/usr/bin/jq`: 26-digit integer and 19-decimal-place float literals
(jq 1.7's literal preservation), em dash / `·` / combining accents / astral-plane emoji, embedded
`\r\n`, non-alphabetical key order preserved, duplicate keys in the input, and empty output.

All jq flags the wider CLI uses work in `jq-wasm`: `-r`, `-c`, `-e` (returns exit 1 on false),
`-n`, `-s`, `--arg`, `--argjson`.

---

## 5. Measurements

Median of 10 runs unless noted. Reference is `execFileSync('/usr/bin/jq', [filter, path])`.

| Measurement | Value |
|---|---|
| `jq-wasm` cold: `import()` | 2.7 ms |
| `jq-wasm` cold: `loadJq()` instantiate | 3.4 ms |
| `jq-wasm` cold: first result | 7.5 ms |
| **`jq-wasm` cold total, import → first result** | **13.7 ms** (min 13.4, max 32.7 on the first-ever run) |
| `jq-wasm/inline` (base64-embedded) cold total | 10.7 ms (single run) |
| `jq-web` cold total | 11.3 ms |
| Node process startup alone (`process.uptime()` at first result) | ~21 ms total wall |
| `jq-wasm` warm, `tasks.json` (1,032,131 B) | **20.9 ms** (min 20.7, max 23.3) |
| `execFileSync jq`, `tasks.json` | **29.0 ms** (min 28.2, max 36.0) |
| `jq-wasm` warm, `sprints.json` (17,232 B) | **1.1 ms** |
| `execFileSync jq`, `sprints.json` | **2.4 ms** |
| `node-jq` (spawns the binary), `decisions.json` | 10.4 ms first, 5.7 ms/call thereafter |
| `jq-wasm@1.1.0-jq-1.7.1` (the old pinned build), `decisions.json` (105 KB) | **327 ms** — ~30× slower than 3.0.0 |
| RSS: baseline / after `loadJq()` / after one 1 MB filter | 44.7 / 49.5 / 92.3 MB |
| RSS after 21 consecutive 1 MB filters | 83.6 MB — no unbounded growth |

**Shipped bytes.** Minimum ship for the Node path is `dist/index.mjs` + `dist/build/jq.wasm` =
**1,059,308 B (1.01 MiB)**, of which the wasm is 928,824 B and gzips to 332,195 B. A single-file
bundle uses `jq-wasm/inline` at **1,367,200 B (1.30 MiB)** with the wasm base64-embedded, costing
~308 KB over the two-file layout in exchange for having no asset to locate. For comparison the
jq 1.7.1 release binary `node-jq` downloads is 807,984 B — the WASM route ships **~250 KB more
than the native binary it replaces**, and works on every platform from one artifact.

`jq-wasm` is **faster than spawning jq**, at every size tested. Embedding costs load time
(13.5 ms once per process), not throughput.

---

## 6. Windows assessment

**Not measured — no Windows machine was available. Everything below is inferred from the package
contents, and is marked as such.**

**`jq-wasm` — inferred clean:**

- **No native code.** `find` over the package returns no `.node`, `.dylib` or `.so`. *(Measured on
  the installed tree.)*
- **No install hooks.** `package.json` has no `install`, `preinstall` or `postinstall` script, and
  **no runtime dependencies at all**. *(Measured.)*
- **No platform restriction.** No `os` or `cpu` field. `engines: {node: ">=20"}`. *(Measured.)*
- **Asset loading is plain path arithmetic.** The Node entry does
  `const wasmPath = join(__dirname, "build", "jq.wasm"); return { wasmBinary: await readFile(wasmPath) }`,
  with `__dirname` from the tsup shim `path.dirname(fileURLToPath(import.meta.url))`. *(Measured
  in `dist/index.mjs`.)* **Inferred:** `url.fileURLToPath` is the documented correct way to turn a
  module URL into a Windows path including the drive letter, and `path.join` is
  platform-native, so this resolves correctly on Windows. This is the one place a Windows bug
  could live, and `jq-wasm/inline` removes it entirely by carrying the wasm as base64 in the JS.
- **No `fetch`, no `WebAssembly.instantiateStreaming` on the Node path.** Those identifiers appear
  only inside the bundled Emscripten runtime's URL branch, which is reached only when
  `wasmURL` is supplied. *(Measured by inspection.)*
- **No shared memory.** Zero occurrences of `SharedArrayBuffer` in `index.mjs` or the shared
  chunk. *(Measured.)* **Inferred:** no `WebAssembly.Memory({shared:true})`, so no
  cross-origin-isolation or Windows threading concerns.
- **Inferred:** `WebAssembly` is unflagged in Node 20+ on all platforms, so the module
  instantiates on Windows exactly as it does here.

**`node-jq` — inferred problematic, for two independent reasons:**

1. Its `preinstall` downloads a binary from `github.com/jqlang/jq/releases` at install time
   *(measured in `scripts/install-binary.mjs`)*. **Inferred:** that fails behind a proxy, on an
   offline install, or in any environment where npm can reach a registry mirror but not GitHub.
2. Its `DOWNLOAD_MAP` covers `win32: {x64, ia32}` only. **Inferred:** on **Windows on ARM** it
   falls through to `buildJqSource()`, which runs `./configure` and `make -j8` — i.e. it requires
   exactly the POSIX toolchain the port exists to eliminate. It also spawns a child process per
   call, which is the `execFileSync` cost plus a temp file.

**PATH-jq delegation — inferred:** `child_process.execFileSync('jq', …)` with no `jq` installed
fails with `ENOENT` (*measured*: `spawnSync jq ENOENT`). On Windows this additionally means
resolving `jq.exe` via `PATHEXT`, and the user having installed jq through winget/choco/scoop.
That is the dependency the port is meant to kill.

---

## 7. Recommendation

**Embed `jq-wasm`.** State the trade-off plainly:

**What it costs.** ~1.0–1.3 MiB of shipped artifact, 13.5 ms of process-start latency the first
time a filter runs, and a permanent dependency on a third-party Emscripten build of jq staying
maintained. The npm package `jq-wasm` is one maintainer's project; if it goes stale the port
inherits a pinned wasm blob it cannot rebuild without an Emscripten toolchain. Mitigation is
cheap and should be taken: **vendor the `.wasm` into the repo** rather than resolving it from
`node_modules` at runtime, so a dead upstream is a nuisance rather than an outage.

**What it buys.** The one verb that takes a user-supplied jq filter keeps *working exactly as it
does today*, on Windows, with nothing installed — and it is faster than the subprocess it
replaces (13.7 ms once, then 20.9 ms for a 1 MB journal against 29.0 ms per `execFileSync`). Every filter in the harness's own repair history
runs byte-identically. The guards at `cmd-repair.sh:43-46` and `lib.sh:178-226` — all of which
read jq's exit code and output bytes — port over unchanged, because the engine returns the same
exit codes and the same bytes.

**Version pinning is a decision, not a default.** `jq-wasm@3.0.0` is jq **1.8.2**; the harness
today runs against whatever is on PATH, which on User's Mac is `jq-1.7.1-apple`. There is a
`jq-wasm@1.1.0-jq-1.7.1` pin, but it is a 2-year-older package with an async-only API and
measured **~30× slower** execution (327 ms vs ~11 ms for the same 105 KB journal). The
recommendation is **3.0.0 / jq 1.8.2**, accepting the one grammar tightening, because:
the harness's real corpus is 100% unaffected; the port is a rewrite, so "matches the Mac's jq
exactly" is not a constraint anyone is currently relying on; and 1.8.2 is the version a Windows
user installing jq today would get anyway.

**What a `TYPED OPS ONLY` fallback would have to cover.** Classifying the 31 real filters:

| Typed op | Real filters it would serve |
|---|---|
| `--set '<id>.<field>' <json>` | 8 (L-0154, L-0223/4/5, L-0243, L-0254, L-0266, + part of others) |
| `--append-string '<id>.<path>' <text>` | 1 (L-0226) |
| `--drop-entry` by field equality | 4 (L-0198, L-0205, L-0229, plus part of L-0201) |
| `--keep-only <name-list>` | 1 (L-0231) |
| `--rename-value <field> <from> <to>` (n-way) | 6 (L-0170, L-0185, L-0189, L-0276, L-0277, L-0281) |
| `--sub <field> <regex> <replacement>` | 4 (L-0178, L-0197, L-0235, L-0253) |
| `--patch-file <path>` | 2 (L-0188 truncate, L-0279 the 91 KB restore) |
| **Not expressible as any bounded typed op** | **4** |

The four that break it:

- **L-0278**, `.entries as $all | .entries |= map(… $all[] | select(.supersedes == $e.id) …)` — a
  self-join across the journal, computing back-references. There is no "set a field" shape here;
  the value of each entry's new field is derived from a *search of the other entries*.
- **L-0284**, two id-cohorts bound as variables and applied by `index()` membership — expressible
  as 20 separate `--set` calls, but the repair is then 20 log entries instead of one, and the
  `--why` is split 20 ways. That defeats the point of the verb.
- **L-0182 / L-0183**, `{entries: .reviews}` and `{entries: .checks}` — a **top-level schema
  migration** that rebuilds the journal object around a renamed key. No entry-level operation
  reaches it, and it is precisely the class of repair the verb exists for: "the machinery that
  reads this journal changed shape" (`cmd-repair.sh:56-59`).
- **L-0280**, `.rationale |= (split("\n\n# Superseded")[0])` — truncating a field at a marker.

So a typed-ops-only CLI would have covered **27 of 31** historical repairs, and would have been
unable to perform the two schema migrations and the one back-reference backfill. It would also
have been unable to perform **L-0279**, the restore of the destroyed `decisions.json`, without a
`--patch-file` escape hatch — which is a whole-journal overwrite and therefore strictly more
dangerous than any filter.

**Suggested shape:** embed `jq-wasm` as the engine for `--apply`, **and** add the typed ops
anyway as the ergonomic front door — not because `--apply` needs replacing, but because a typed
op is structurally incapable of the class of mistake that destroyed `decisions.json`:
`--set`/`--drop-entry` cannot write `($stream) as $x | body`. Two of the recorded repairs
(L-0197 then L-0198, both on `gates.json`) are a first filter followed by a second whose own
`--why` reads *"the first filter matched only 28 of the polluted rows"* — the same
authoring-error shape at a harmless scale. That is a separate decision from this spike; it is noted, not assumed.

---

## 8. Open questions for User

1. **jq 1.8.2 or pin to 1.7.1?** 3.0.0/1.8.2 is the fast, maintained, actively-published build
   and matched the entire real corpus. Pinning to 1.7.1 costs ~30× per-call latency and a
   two-year-old API. The only measured behavioural difference is one grammar tightening no real
   filter uses. Which way?
2. **Vendor the `.wasm`, or depend on `node_modules`?** Vendoring the 929 KB blob (or the 1.37 MB
   inline module) into the repo makes the port independent of a single-maintainer npm package
   staying alive, at the cost of a large binary in git. Alternative is `jq-wasm/inline` as a
   normal dependency and accepting the supply-chain exposure.
3. **The error-message path token.** jq reports `error (at governance/tasks.json:0)`; jq-wasm
   reports `error (at /dev/stdin:0)` because the input is a buffer. Should the port rewrite that
   token so messages read identically to today, or is the difference acceptable? Some tests grep
   these strings.
4. **Do the typed ops (`--set/--unset/--drop-entry/--patch-file`) get built as well as `--apply`,
   or not at all?** They would have covered 27 of 31 real repairs and are structurally incapable
   of the empty-stream bug that destroyed `decisions.json`. That is a scope question, not a
   technical one, and I have not assumed an answer.
5. **Surfaced, not fixed** (per the migration rule): the dry run at `cmd-repair.sh:43` discards
   stderr (`2>/dev/null`) and then dies with the generic *"the jq expression failed against
   governance/$JF — check the filter"*, so the author of a broken filter never sees jq's own
   message saying **what** was wrong. The port could pass that stderr through at no behavioural
   risk. Do you want that changed, or is byte-for-byte preservation of the current message the
   requirement?
6. **Also surfaced, not fixed:** the seal comparison at `cmd-repair.sh:34-46` hashes the *dry-run
   output file*, and `write_json` then **re-runs the same filter** at `lib.sh:178`. A filter using
   `now`, `$ENV`, or `input_line_number` produces different bytes on the two runs, so the no-op
   check and the thing actually written can disagree. No historical filter does this. Worth a
   ruling before the port copies the two-run structure?
