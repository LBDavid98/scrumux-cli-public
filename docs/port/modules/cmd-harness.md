# Module inspection — `cmd-harness` (`.claude/scripts/lib/cmd-harness.sh`)

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

Read in full (1253 lines), against `docs/port/PHILOSOPHY.md` (signed register,
53 loosenesses) and `RULINGS.md` (D-0085/D-0086), plus
`tests/harness-tests.sh` (909 lines, the primary acceptance suite) and the
harness-touching sections of `tests/readme-tests.sh`, `tests/scrumux-tests.sh`
and `tests/upstream-wall-tests.sh`. Line numbers are against the tree as read
on 2026-08-31.

**Amended 2026-09-01: the source-only exclusion list.** A fourth roster
mechanism was added at `:89-140` (`PAYLOAD_EXCLUDE` and `payload_excluded()`),
so every line citation below `:87` has shifted by roughly +50 in the current
tree — the anchors named in prose are what to search for, not the numbers.
The mechanism is described in the roster section below and proved by
`tests/payload-exclude-tests.sh`.

## Intent

`cmd-harness.sh` implements the `harness` noun: `deploy` installs the
governance machinery into a target repo; `verify` proves it is actually live
there. The file's own header states the reason `verify` exists at all, and it
is the single fact everything else in the module is downstream of:

> "Claude Code resolves project settings and `$CLAUDE_PROJECT_DIR` ONCE, at
> launch, from the directory `claude` was started in. `cd` never re-resolves
> them. So a `.claude/settings.json` anywhere other than the launch root is
> SILENTLY INERT" (`cmd-harness.sh:15-19`)

Everything downstream of that is either "does the payload exist" (checks
5–6) or "does the payload actually run" (check 8) — a distinction the module
itself draws (`:1044-1048`, citing I-0104: verify reported 7/7 green on a
target where two CLI surfaces died with an `ImportError`, because presence
checks can only confirm the copy happened).

**The payload roster is derived, never hand-listed**, and this is the
"derived-never-hand-listed discipline" the port context names. Three separate
mechanisms enforce it, and none of them is redundant with the others:

- `payload_files()` (`:147-162`) walks each `PAYLOAD_DIRS` entry
  (`scripts schemas rules hooks skills agents dist`, `:87`) with a single `find`,
  excluding dot-prefixed basenames and `__pycache__` path segments. The dot
  exclusion is deliberate and dated: T-0137's concurrent health run created
  short-lived probe scripts inside `.claude/scripts`, and including them made
  the payload roster depend on which other suite happened to be mid-run
  (`:150-156`). **Since 2026-09-01 the same walk also drops any path claimed
  by `.claude/payload-exclude.list`** (`payload_excluded()`, current
  `:117-140`): one repo-relative path per line, `#` comments, a trailing `/`
  excluding the whole directory prefix. It exists because the dot-file test is
  on the BASENAME only, so a file inside a dot-prefixed directory shipped too
  — there was no way to keep source-only guidance (the `source-session` rule,
  the `finding-validator` agent, the `source-implement` skill) out of a
  governed repo, where it would contradict the constitution that repo is
  given. The filter sits inside the walk on purpose: deploy installs from this
  roster, verify requires it, and the I-0143 prune spares only what it still
  names, so all three agree by construction. Nothing under `.claude/scripts`,
  `.claude/hooks` or `.claude/schemas` may be listed — verify's surface
  coverage is derived from the same roster, so an excluded script would be one
  nothing probes and nothing reports.
- `SHIPPED_MODULE_FILES` (`:164-193`) is a literal four-file list, admitted
  on one test stated inline: "a REGISTERED CLI surface cannot run in the
  target without it, and it imports nothing but stdlib" (`:166-167`). The
  comment records each file's admission history — `schema_check.py` since
  T-0140, `governance_graph.py` since T-0174 (and the I-0104 incident it
  fixed), `code_graph.py` only after its `tree_sitter` import moved inside
  `build()` so the module itself needed no grammars to load.
- `MACHINERY_DOCS` (`:195-200`) ships exactly one file,
  `governance/enforcement-posture.md`, "copied like the payload and not
  seeded like a skeleton — a target that edits it is describing its own
  gates, which is the point" (`:198-199`). This claim and the drift
  classification at `:1141-1144` are in tension — see Open Question 1.
  **As of 2026-09-01 `MACHINERY_DOCS` is the empty string**: the census was
  archived to `docs/history/enforcement-posture.md` and nothing ships through
  this mechanism. The mechanism itself stays and is still ported; the entry is
  gone, and with it the tension.

`all_payload_files()` (`:202-210`) concatenates the three. `deploy`
byte-compares this list into the target (`:450-467`, "a timestamp comparison
would call an untouched file changed on every fresh clone… only the bytes
decide", echoed at `:1216`); `verify` walks the same list and checks presence
(`:995-1007`). One definition, two consumers, which is exactly what keeps the
two verbs from drifting apart (`:143-146`).

**The deployment manifest** (`.claude/DEPLOYED`, `write_manifest()` at
`:243-304`) is what makes a deployed repo self-describing without a source
checkout on hand — the file's own comment records the earlier, wrong design:
"The first design of this sprint byte-compared a target against a co-located
harness checkout; that is true on one machine and false on every server that
clones, deploys and deletes the clone" (`:224-227`). `source_commit` survives
relay hops by reading an existing `.claude/DEPLOYED` at the *deploying* root
before falling back to `git rev-parse HEAD` (`:262-273`) — the relay case is
recorded separately under `deployed_from` rather than overwriting the harness
identity. The manifest's own status (`CREATED`/`UNCHANGED`/`UPDATED`) is
decided by `cmp -s` against the previous file, for the same "bytes decide"
reason as every payload item (`:290-301`).

**The surface probes** (`SURFACE_PROBES`, `:334-360`, and the coverage
mechanism around it, `:1044-1102`) are what actually execute every shipped
command surface — one row of `<name>|<argv>|<refusal-regex>`. Coverage is
itself derived: any `.claude/scripts/*` payload entry naming neither a probe
row nor a `SURFACE_EXEMPT` row fails the check (`:1096-1097`), which is the
same discipline as the payload roster applied one level up — a new command
cannot silently ship unwatched. `probe_surface()` (`:379-408`) runs each
probe under `run_with_timeout` (`lib.sh:671-674`, a `perl -e 'alarm …'`
wrapper) with `stdin < /dev/null` and `GOV_ROOT` pinned at the *target*, and
classifies the result by a fixed precedence: a Python traceback anywhere in
the output always fails first (`:387-390`), then rc 126/127/142 always fail
regardless of the declared regex (`:394-396`), and only then does a declared
refusal regex get consulted (`:397-403`).

**Machinery drift** (`:1104-1190`) answers "has the installed machinery been
altered since it was installed?" purely from `.claude/DEPLOYED` — the module
is explicit that nothing here may reach for `SRC_ROOT`, because a server
clones, deploys and deletes the clone (`:1107-1111`, and asserted by the test
suite as a static grep at `harness-tests.sh:575-577`). Files are hashed with
`seal_of` (`lib.sh:385`), the same helper the journal seals use, "so a second
hashing idiom would be a second thing to keep in step with verify"
(`:240-242`). **Machinery orphans** (`:1148-1181`) is a second, independent
sweep: files physically present under the machinery directories that the
manifest does not claim at all — the gap the prune (below) cannot close,
because a file orphaned *before* the prune existed is invisible to a
mechanism that only looks at what the *previous* manifest listed.

**Deploy's own writes**, in the order they run: payload copy (`:450-467`),
`CLAUDE.md` seed-or-preserve (`:469-504`), the one-exception settings.json
union (`:506-539`), journal skeletons via `ensure_file` (`:541-563`), the
seeded `project-walls.conf` / `project-standards.md` lane with its own
`seeded.list` tracking (`:565-675`), the append-only `.gitignore` lane for
generated views (`:677-748`), the code-graph build from the *deploying*
checkout (`:750-779`, because that checkout has the tree-sitter grammars a
target normally never will), the manifest write plus prune (`:781-836`), the
settings/hook-command checks (`:842-889`), and the terminal source-run
`records check` against the target (`:891-897`, with the reason documented
at length at `:53-75`: code location comes from `$0`, data location from
`GOV_ROOT`, so a validator can speak about a root other than its own).

## Deliberate looseness

Every entry below is a *behaviour*, stated as behaviour, not a defect.

1. **Deploy never merges an existing `.claude/settings.json` except one
   narrow, named exception.** Where one exists it is left byte-for-byte
   alone; `permissions.allow` is unioned append-if-absent, existing rules
   first, never removed. Everything else — hooks, env — stays untouched.
   `cmd-harness.sh:33-37` (header), `:506-539` (implementation), `:845-856`
   (the check reports the gap and prints the exact fix, never rewrites it).
   **PHILOSOPHY.md P-36.**

2. **`verify`'s machinery-drift check splits FROZEN and TRACKED, and TRACKED
   content is never fatal** *(TS port, R-019 / D-S027: `.claude/schemas` is
   TRACKED too, and an unclaimed schema is variance rather than an orphan)* — `.claude/rules` and `.claude/skills` are prose
   a repo legitimately localises and are reported, never blocking
   (`:1141-1144`, `:1185-1186`). But a file the manifest lists and the disk
   does not have is FROZEN-class regardless of which half it came from
   (`:1136-1139`, `:1183`) — "rules and skills never fail for CONTENT," not
   "rules and skills never fail." `cmd-harness.sh:1104-1190`. **PHILOSOPHY.md
   P-37.**

3. **Deploy seeds ZERO repo-health checks.** `governance/repo-health.json`
   lands as `{"entries": []}` like every other journal — a fresh deploy
   registers nothing to check, by design, so its WARNs are never in an
   agent's path before the repo has chosen to register its own.
   `cmd-harness.sh:38-44` (header), `:551-557` (implementation, with the
   inline reason repeated at the call site). **PHILOSOPHY.md P-38.**

4. **`project-standards.md` ships empty, is create-if-absent, and nothing
   enforces its content.** `ensure_file`'s `[ -f ]` guard means a redeploy
   never overwrites what a repo wrote there; no check reads its body; the
   template itself says so ("Nothing here is enforced by the harness… It is
   context an agent is given, not a wall it hits," seeded at `:645-649`).
   `cmd-harness.sh:565-580` (rationale), `:630-675` (seeding, with `seeded()`
   tracking so the prune below can never eat it). **PHILOSOPHY.md P-39.**

5. **NEW — the prune (I-0143) deletes unconditionally, with no backup and no
   byte comparison against what deploy would currently write.** Any path a
   *previous* manifest claims and the current `payload.list` no longer lists
   is `rm -f`'d outright (`:822-836`, the deletion at `:833`), whether or not
   the target's copy still matches what was last installed — a locally
   edited file that upstream later drops from the payload is destroyed the
   same way an untouched one is. The one carve-out is `seeded.list`
   (project-walls.conf, project-standards.md), reported `KEPT` and dropped
   from the new manifest so no later deploy reconsiders it (`:828-831`). No
   comment addresses the general case of a target-edited-then-dropped
   machinery file; `harness-tests.sh:765-845` exercises the "still shipped"
   and "seeded, never pruned" cases but not "target edited it, then it was
   dropped upstream."

6. **NEW — deploy is not transactional.** Payload files, `CLAUDE.md`,
   journals, the settings union, `.gitignore`, and the code-graph build all
   land on disk *before* the terminal `records check` gate runs
   (`:891-897`), and a FAIL there changes nothing already written — the
   summary states this outright: "The install FAILED its checks… nothing was
   rolled back, fix and re-run" (`:906`). This is the deploy-specific
   instance of the Group B "writes that never refuse" family (P-08/P-09/P-15
   are the closest registered analogues, none an exact match), stated inline
   rather than in a design doc.

7. **NEW — the surface-probe verdict table treats a declared-refusal nonzero
   exit as a pass, and only a traceback or a fixed set of exit codes (126,
   127, 142) is an unconditional FAIL regardless of the declared regex.**
   `cmd-harness.sh:325-333` (the table, stated as a design constraint: "a
   nonzero-equals-fail rule alone would red-line a healthy target: five of
   these surfaces answer their no-op with a usage line and exit 1"),
   `:391-407` (`probe_surface`'s precedence: traceback first, then the fixed
   rc set, then the regex).

8. **NEW — dot-prefixed files, and any path containing `__pycache__`, are
   silently invisible to the whole payload/verify/drift machinery** — never
   shipped, never hashed, never reported missing, and (per item 5's
   mechanism) never even eligible for the prune. `cmd-harness.sh:150-161`,
   with the T-0137 rationale for the dot exclusion and a separate `case`
   arm for `__pycache__` (`:159`). Deliberate and dated, but not previously
   registered.

## Simplify/perf

**BEHAVIOR-PRESERVING:**

- `seal_of` (`lib.sh:385`, a `shasum -a 256 | awk` subprocess pipeline) →
  Node's built-in `crypto.createHash('sha256')`. Same bytes in, same hex out,
  no fork. Applies everywhere this module calls it: `write_manifest`'s
  per-file loop (`:280`) and the drift comparison (`:1140`).
- `payload_files()`'s single `find` walk (`:147-162`) → a single recursive
  directory read (e.g. one `fs.readdir`/glob pass held in memory), preserving
  the exact dot-file and `__pycache__` exclusion predicates rather than
  re-deriving them, plus the `.claude/payload-exclude.list` predicate
  (exact-path match, or prefix match on a line ending in `/`, after leading
  whitespace is stripped and the line is cut at the first space). No `find`
  subprocess. The list is read from the payload SOURCE root, never from
  `GOV_ROOT` — same `SRC_CLAUDE` rule as the rest of the module.
- The module currently round-trips through `$TMPD` scratch files —
  `payload.list`, `roster.list`, `manifest.ndjson`, `deploy.hookcmds`,
  `hookcmds`, `orphan.scan`, `scripts.list`, `probes`, `exempt` — between
  what are really sequential in-process steps of one `deploy` or `verify`
  call. Hold these as in-memory arrays/maps in the TS port rather than files;
  this is exactly the "no spool files" class of behaviour-preserving work the
  plan already sanctions (PHILOSOPHY.md's closing section).
- `missing_chains()` and `hook_targets()` (`hook_commands()` until the Windows
  wave renamed it — see below) each shell out to `jq` against the same
  `settings.json`. `JSON.parse` it once and derive both answers from the same
  in-memory object — same predicate, one parse instead of two subprocess `jq`
  invocations per check.
- **`hook_commands()` became `hook_targets()`, and the shape of its answer
  changed with it.** `settings.json` reaches the hooks in EXEC FORM now
  (`{"command":"node","args":["${CLAUDE_PROJECT_DIR}/.claude/dist/…"]}`),
  because that is the only hook shape Claude Code can spawn on a Windows box
  with no Git Bash. In exec form `.command` is the EXECUTABLE and the script is
  `.args[0]`, so the old "echo `.command`, then cut at the first space" contract
  yields the bare word `node`. Both callers now read a TAB-separated
  `form / program / file` row. An empty field on the wire is written `-`,
  because TAB is an IFS *whitespace* character in POSIX `read` and a run of
  them collapses to one delimiter — which shifted the path into the wrong
  variable and reported `(missing)` for a file that was present.
- `HOOK_CHAIN_COUNT` is already derived once from `HOOK_CHAINS` at module
  scope (`:100-101`, the T-0202 fix). Preserve that shape in the port: compute
  it once at process start, not per check.
- No subprocess `jq`/`shasum`/`awk` anywhere the port can avoid them, per the
  plan's general anti-strictness/perf backstop — this module is one of the
  heavier `jq` users in the CLI (manifest build, settings inspection, drift
  reads) and none of those calls change what is asked, only how cheaply.

**OBSERVABLE (proposals only — User rules; each states exactly what an
operator would see change):**

- Making deploy transactional (stage writes, gate the swap on `records
  check`) would change item 6 above: today a failed deploy leaves the target
  partially or fully updated with a FAIL summary saying nothing was rolled
  back; a transactional version would leave the target completely untouched
  on failure instead. Real behaviour change, not proposed as a silent fix.
- Making the prune (item 5) diff bytes before deleting, and reporting a WARN
  instead of a silent `REMOVED` when the target's copy no longer matches
  what deploy last installed there, would change what an operator sees on a
  dropped-but-locally-edited file: today it disappears with a plain
  `REMOVED — no longer part of the payload` line indistinguishable from an
  untouched file being pruned; the proposal would surface that local edits
  were lost.
- Reclassifying `governance/enforcement-posture.md` as TRACKED rather than
  FROZEN in the drift split (see Open Question 1) would change what an
  operator sees after editing that file as its own deploy-time comment
  invites: today (if the classification is as read) that edit would FAIL
  `machinery-drift` with upstream-evasion language; the proposal would make
  it a reported, non-fatal drift line like any other localised prose file.

## Open questions

1. **`governance/enforcement-posture.md` is shipped as `MACHINERY_DOCS` and
   its own comment says a target editing it is "the point"
   (`cmd-harness.sh:198-199`), but the drift classification that decides
   FROZEN vs. TRACKED (`:1141-1144`) only carves out `.claude/rules/*` and
   `.claude/skills/*` — everything else, including this file, falls to the
   `*) DRIFT_FROZEN=…` default.** Read together, a target that edits this
   file as invited would FAIL `machinery-drift` with language about the
   upstream wall being evaded (`:1184`), which is not what the seeding
   comment describes. **Not reproduced** — this is drawn from reading both
   code paths, not from running a target through the scenario, and no
   comment at either site addresses the other. Question for User: should
   `governance/enforcement-posture.md` join the TRACKED case, or is the
   header comment describing an intent that was never wired through to the
   drift check?

   **Closed 2026-09-01 — the seeding comment was right, and the file stopped
   shipping rather than being reclassified.** `MACHINERY_DOCS` is now the
   empty string and the census is archived at
   `docs/history/enforcement-posture.md`, so a fresh target never receives one
   and there is no new copy to classify. **Existing targets keep theirs**: the
   deploy lane declares `governance/enforcement-posture.md` to `seeded()`
   ("RETIRED, NOT RECLAIMED"), so the prune leaves it and the new manifest
   stops claiming it, which also ends the drift question — an unclaimed file
   is not walked by `machinery-drift`.

   **The rule the port must carry, stated generally:** stop-shipping a path
   and reclaiming the installed copies are two decisions. Machinery is
   reclaimed by default because a stale script still runs and the target never
   authored it. A target-editable document is left where it is, because by the
   time it is retired the copy is the target's own record. Getting these two
   confused deletes someone else's governance.

2. **The `permissions.allow` union path may report a false "kept — all hook
   chains present" for a settings.json that never parsed.** `NEWRULES`
   (`:523`) falls back to `echo 0` on any `jq` failure — including an
   unparseable `$TSET` — and the `else` branch that follows (`:531-537`)
   calls `missing_chains()`, whose own `jq … 2>/dev/null` (`:430`) also
   fails silently and returns empty, so `MC=""` and the code reports "all
   $HOOK_CHAIN_COUNT hook chains present" for a file it never successfully
   parsed. **Not verified as deliberate** — no comment addresses this
   specific path, and it is a different mechanism from `harness_verify`'s
   own explicit `settings-parses` check (`:954-966`), which *does* report a
   parse failure by name. Not reproduced against a real corrupt
   `settings.json`; flagged from reading only.

3. **`write_manifest`'s per-file `seal_of` call has no failure guard.**
   `seal_of()` (`lib.sh:385`) is `shasum -a 256 "$1" | awk '{print $1}'` with
   no error check; a file that becomes unreadable between the payload-list
   build and the hashing loop (`cmd-harness.sh:277-282`) yields an empty
   string, silently recorded as that path's hash in `.claude/DEPLOYED`. A
   later `verify` run against the (now-present, now-hashable) file would
   compare a real hash against the recorded `""` and report FROZEN drift for
   a file nobody touched. **Not reproduced** — a narrow race, not
   established as having ever fired; recorded so the port does not
   "helpfully" add a throw here without a ruling on which direction is
   correct (raise at deploy time vs. preserve the current silent-empty-hash
   behaviour).

4. **OQ-12 from `docs/port/PHILOSOPHY.md` lives concretely in this file.**
   The `permissions.allow` union (`cmd-harness.sh:515-539`) only ever
   appends; nothing prunes a rule upstream has since dropped, symmetric with
   the problem `reseal_one`'s pruning half was written to fix one file over
   (`lib.sh:327-339`). No new evidence found here beyond what OQ-12 already
   states — noted so the port's `cmd-harness` module carries the same open
   item forward rather than treating its absence as newly discovered.

5. **`probe_surface`'s timeout is `perl -e 'alarm …'` via
   `run_with_timeout` (`lib.sh:671-674`), invoked at `cmd-harness.sh:381-382`
   and checked for exactly rc 142 at `:396`.** TS-port hazard: Node has no
   direct equivalent primitive; the port needs a `child_process` +
   kill-timer construction that reproduces the *specific* sentinel `142` —
   not just "some nonzero code" — because `:396` branches on that literal
   value and nothing else. Getting the sentinel wrong silently moves a
   TIMEOUT probe into the generic "rc N and output doesn't match" branch
   (`:399-402`) instead of the timeout branch, changing the printed reason
   an operator sees.

6. **`missing_chains()`'s jq predicate (`cmd-harness.sh:422-431`) matches
   hook-chain matchers with jq's `test($m)` (Oniguruma-derived) against
   short literal strings — `"Bash"`, `"Read"`, `"startup|resume"`.** These
   specific patterns translate safely to JS `RegExp`, but this is the same
   class of hazard as the general ERE-vs-RegExp question already raised as
   OQ-8 in `PHILOSOPHY.md`, applied to a live call site in this module.
   Flagging the coupling for the port's regex-translation layer rather than
   a live divergence today — no chain pattern currently in `HOOK_CHAINS`
   exercises anything Oniguruma and `RegExp` disagree on.

7. **The dot-file/`__pycache__` exclusion (`cmd-harness.sh:150-161`) is
   shallower than a casual read suggests.** `find … ! -name '.*'`
   (`:157`) excludes by *basename* only — POSIX `find -name` tests the
   current entry's own name, not any ancestor directory's — so the exclusion
   does not `-prune` whole dot-directories; it walks into them and only
   drops leaf files whose own name starts with a dot. A regular (non-dot)
   file inside a dot-prefixed subdirectory of a payload dir would still be
   found and shipped. No live case is known to exercise this today (the
   T-0137 rationale describes leaf probe scripts, not dot-directories), but
   a TS port using a directory-prune-based walk (skip descending into any
   dot-named directory) would silently narrow the roster relative to bash.
   The port must reproduce find's exact per-basename semantics, not a
   directory-level prune.
