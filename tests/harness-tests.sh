#!/bin/sh
# harness-tests.sh — T-0012 / S-0061 acceptance: `harness deploy` stands
# the governance machinery up in a target repo idempotently, and
# `harness verify` proves it is actually live there.
#
# The case that carries the whole suite is the last one. Claude Code
# resolves project settings and $CLAUDE_PROJECT_DIR ONCE, at launch,
# from the directory `claude` was started in; `cd` never re-resolves
# them. So a .claude/settings.json anywhere but the launch root is
# silently inert — every hook chain in it is dead while the repo looks
# entirely normal from the inside. Nothing inside a session can observe
# that about itself, which is why it is a CLI check and why moving
# settings.json one directory down must turn verify red.
#
# Run: sh tests/harness-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
HARNESS="$ROOT/.deploy-claude/scripts/scrumux"
HARNESS_CMD="harness"
# The command and the files that implement it are different things:
# `scrumux harness …` is the surface, `src/nouns/harness/` is where the
# payload roster, the probe tables and the two verbs live. It was
# lib/cmd-harness.sh until the bash CLI was retired.
HARNESS_SRC="$ROOT/src/nouns/harness/payload.ts"
VERIFY_SRC="$ROOT/src/nouns/harness/verify.ts"
SANDBOX=$(mktemp -d) || { echo "harness-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

TARGET="$SANDBOX/target"
mkdir -p "$TARGET"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# manifest <dir> — sha of every regular file, so "changed nothing" can be
# asserted on BYTES rather than believed from a summary line.
# The two graph indexes are excluded: they are DERIVED artifacts, they
# are gitignored, and a rebuild stamps a new build time into them even
# when nothing about the tree changed. Hashing them here would make
# "deploy is idempotent by bytes" false for a reason that has nothing to
# do with the payload — the same reason lib.sh keeps them out of
# SEALED_JOURNALS.
#
# `*.pyc` JOINS THEM, for the same reason and one this suite could not see.
# `harness verify` runs all 27 SURFACE_PROBES with `cd "$TARGET"`
# (cmd-harness.sh:568-571), so it executes the target's OWN python and CPython
# writes agents/__pycache__/*.pyc and agents/lib/__pycache__/*.pyc INTO the
# target. Measured: three files, absent before verify and present after. They
# were inside this byte assertion, and they are build artefacts of the
# interpreter rather than harness state — no verb writes them, nothing reads
# them back, and their names carry the python MINOR VERSION, so the same tree
# hashes differently on a runner with 3.12 than on a box with 3.11. The
# differential already excludes them from its post-state with this reasoning
# written out (tools/differential/repo.mjs:185-191); this is the same rule at
# the surface that did not have it.
# manifest_delta <before.json> <after.json> — ONE LINE naming exactly what
# moved inside .claude/DEPLOYED, for the CI-only idempotence failure.
#
# ONE LINE IS A HARD CONSTRAINT, not a style choice: tools/parity-suites.sh
# forwards only lines matching `^(FAIL|not ok|  FAIL)`, so a multi-line
# detail loses every continuation line and the CI lane — the only lane that
# reproduces this — sees nothing. That is the same trap the previous
# diagnostic fell into.
#
# Scalars are printed with BOTH values because for a date or a commit the
# values ARE the finding. The files map is printed by KEY ONLY (`+` added,
# `-` removed, `~` same key different hash): the key is what identifies the
# mechanism, and sixty-eight sha256s would blow the line without adding
# anything.
# EVERY KEY IS BOUND TO A VARIABLE BEFORE IT IS USED, and that is not
# style. A first cut wrote `map(select($x[.] != $y[.]))` and
# `select(($yf|has(.)) and ...)`, where the `|` REBINDS `.` to the object
# being piped into: `$yf | has(.)` asks whether $yf has itself as a key.
# jq then errored on half the inputs and answered "no field differs" on
# the other half — a diagnostic that is silent and confidently wrong,
# which is worse than none. Caught by driving the helper against
# hand-built manifests for each mechanism before trusting it, which is
# the only reason this comment can be written.
manifest_delta() {
  jq -rn --slurpfile a "$1" --slurpfile b "$2" '
    ($a[0] // {}) as $x | ($b[0] // {}) as $y |
    ($x.files // {}) as $xf | ($y.files // {}) as $yf |
    # EVERY VALUE IS RENDERED ONE-LINE AND SHORT, and that is not cosmetic.
    # This delta reaches a human through the parity-suites relay, which keeps
    # only lines matching ^FAIL -- so a value carrying a newline truncates the
    # report AT the newline and silently discards every field after it. Three
    # CI runs showed `source_remote: <url>` with no ` -> ` and no fields
    # following, which is exactly that shape: not a value that failed to
    # render, a line that ended. Control characters are made visible rather
    # than stripped, because "the value has a trailing newline" is itself a
    # candidate mechanism here, and length is stated so empty is unambiguous.
    def vis: tostring | gsub("\r";"<CR>") | gsub("\n";"<LF>") | gsub("\t";"<TAB>")
             | "[\(length)]" + (if length > 44 then .[0:44] + "…" else . end);
    (["source_remote","source_commit","deployed_at"]
      | map(. as $k | select($x[$k] != $y[$k])
            | "\($k): \($x[$k]|vis) -> \($y[$k]|vis)")) as $scal |
    (if ($x.deployed_from|tostring) != ($y.deployed_from|tostring)
       then ["deployed_from: \($x.deployed_from|tostring) -> \($y.deployed_from|tostring)"]
       else [] end) as $rel |
    ((($yf|keys) - ($xf|keys)) | map("+" + .)) as $add |
    ((($xf|keys) - ($yf|keys)) | map("-" + .)) as $rem |
    (($xf|keys) | map(. as $k | select(($yf|has($k)) and ($xf[$k] != $yf[$k]))
                      | "~" + $k)) as $chg |
    ($scal + $rel + $add + $rem + $chg) as $d |
    # The provenance half of BOTH manifests, verbatim, whenever a provenance
    # field is among the differences. `\(x|tostring)` renders an ABSENT field
    # and an empty one identically, so the rendered delta cannot distinguish
    # "the remote resolved to something else" from "the key is not there at
    # all" -- and on the macOS runner it is one of those two, which decides
    # whether this is a git-resolution difference or a writer that omits a key
    # it could not compute. Printing the raw halves answers it in one run.
    (if ($scal|length) > 0 or ($rel|length) > 0
       then " || relay-before: \($x.deployed_from|vis) relay-after: \($y.deployed_from|vis)"
       else "" end) as $prov |
    if ($d|length) == 0
      then "no field differs — the bytes moved without a VALUE moving, so this is key ORDER or whitespace. "
           + "first keys before: \(($xf|keys_unsorted)[0:3]|join(",")) | after: \(($yf|keys_unsorted)[0:3]|join(","))"
           + " | sorted-before: \(($xf|keys_unsorted) == ($xf|keys)) sorted-after: \(($yf|keys_unsorted) == ($yf|keys))"
      else ($d | join(" ")) + $prov end
  ' 2>/dev/null || printf 'the delta could not be computed (jq failed on one of the two manifests)'
}

manifest() {
  find "$1" -type f ! -name '*.lock' ! -name '*.pyc' ! -name 'code-graph.json' ! -name 'governance-graph.json' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "${f#"$1"/}"
  done
}

# --- 0. the script exists, is executable, and states the fact ---------
[ -x "$HARNESS" ] && ok || bad ".claude/scripts/scrumux harness must exist and be executable (mode 644 would fail with exit 126 wherever it is registered — I-0060)"
grep -q 'resolves project settings' "$VERIFY_SRC" \
  && ok || bad "verify's header must record WHY the verb exists: settings and \$CLAUDE_PROJECT_DIR are resolved once, at launch, from the launch directory"
grep -q 'SILENTLY INERT' "$VERIFY_SRC" \
  && ok || bad "verify must say plainly that a settings.json off the launch root is silently inert"

# I-0119 IS CLOSED BY DELETION. The header used to explain that the schema
# sweep is delegated to the SOURCE checkout because `agents/` is outside the
# payload — false, 145 lines above the roster that shipped it — and five
# assertions here held the corrected wording in place: name CODE_ROOT, name
# .venv, name python3, never say "deliberately NOT part of the payload",
# never name a schema-check script. There is no interpreter in the sentence
# any more: the sweep is native (R-004), the python modules are gone, and
# SHIPPED_MODULE_FILES is empty. A comment carrying a false reason cannot
# survive the removal of the thing it was reasoning about.

# --- 1. usage / argument failures are actionable ----------------------
# Exit 2, not 0: a noun with no verb is a command that could not run,
# and under the one exit rule that is 2 (CLI-CONSOLIDATION.md section 4).
# There are deliberately no default verbs — a command that guesses is a
# command that is sometimes wrong about what you asked for. The usage
# block still prints, on stderr.
OUT=$("$HARNESS" $HARNESS_CMD 2>&1); RC=$?
[ $RC -eq 2 ] && ok || bad "bare 'harness' names no verb, so it must exit 2 (could not run), got $RC: $OUT"
printf '%s' "$OUT" | grep -q 'scrumux harness deploy' && ok || bad "harness with no verb must print its usage block; got: $OUT"
OUT=$("$HARNESS" $HARNESS_CMD deploy 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "harness deploy with no target must exit nonzero"
printf '%s' "$OUT" | grep -q 'needs a target' && ok || bad "harness deploy with no target must name the missing target; got: $OUT"
OUT=$("$HARNESS" $HARNESS_CMD deploy "$SANDBOX/nope" 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "harness deploy at a nonexistent target must exit nonzero"
printf '%s' "$OUT" | grep -q 'is not a directory' && ok || bad "nonexistent target error must say so and name the fix; got: $OUT"
OUT=$("$HARNESS" $HARNESS_CMD bogus "$TARGET" 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "unknown subcommand must exit nonzero"

# --- 2. deploy into a fresh target ------------------------------------
OUT=$("$HARNESS" $HARNESS_CMD deploy "$TARGET" 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "first deploy into a fresh target must exit 0, got $RC: $OUT"
printf '%s' "$OUT" | grep -q 'CREATED' && ok || bad "first deploy must report CREATED items; got: $OUT"
printf '%s' "$OUT" | grep -q 'UPDATED' && bad "first deploy into an empty target must not report any UPDATED item" || ok

# every payload directory landed
for d in scripts schemas rules skills agents dist; do
  [ -n "$(find "$TARGET/.claude/$d" -type f 2>/dev/null | head -1)" ] \
    && ok || bad ".claude/$d landed empty — an empty directory is not an install"
done
# `hooks` LEFT THE LIST WITH THE BASH WALLS. settings.json is exec form and
# names `.claude/dist/*.mjs` directly — the only hook shape a stock Windows
# box can run — so the `.claude/hooks/block-*.sh` shims were files nothing
# called. `dist` takes the slot: it is where the walls and the CLI now are,
# and an empty one is the install that bricks every Bash tool call.

# the named load-bearing files specifically. The whole command surface is one
# bundle now, reached through a doorway whose PATH is contract; both must
# land, and the walls beside them must too.
for s in scripts/scrumux dist/scrumux.mjs dist/block-destructive.mjs \
         dist/block-secret-reads.mjs dist/block-upstream-edit.mjs \
         dist/block-direct-llm.mjs dist/session-guard.mjs dist/BUILD.json; do
  [ -f "$TARGET/.claude/$s" ] && ok || bad "deploy must install .claude/$s"
done
# the doorway keeps its execute bit — a 644 entry point fails with exit 126
# wherever it is registered (I-0060), which is silent at every call site.
[ -x "$TARGET/.claude/scripts/scrumux" ] \
  && ok || bad ".claude/scripts/scrumux lost its execute bit in the copy"

# NOTHING PYTHON LANDS, and that is asserted rather than assumed. Five
# `agents/lib/*.py` modules used to ship because a deployed target needed an
# interpreter to check its own journals, build the governance graph and read
# the code graph. All three are native; a target that grew a python module
# back would mean the roster had quietly re-admitted one.
[ -e "$TARGET/agents" ] \
  && bad "deploy carried agents/ into the target — SHIPPED_MODULE_FILES is empty and a deployment needs nothing but node" || ok
[ -e "$TARGET/.venv" ] \
  && bad "deploy must NOT carry .venv into the target" || ok

[ -f "$TARGET/.claude/settings.json" ] && ok || bad "deploy must write .claude/settings.json at the target ROOT"
cmp -s "$ROOT/.deploy-claude/settings.json" "$TARGET/.claude/settings.json" \
  && ok || bad "settings.json must be written VERBATIM into a target that has none"

# every journal skeleton, with the exact template scrumux's ensure_file uses
for j in log decisions issues tasks design sprints repo-health; do
  [ -f "$TARGET/governance/$j.json" ] && ok || bad "deploy must create governance/$j.json"
  jq -e 'type == "object" and (.entries | type == "array")' "$TARGET/governance/$j.json" >/dev/null 2>&1 \
    && ok || bad "governance/$j.json must be {\"entries\": [...]} — the shape every journal has since T-0157"
done
for j in log decisions issues tasks design sprints; do
  [ "$(jq '.entries | length' "$TARGET/governance/$j.json")" -eq 0 ] \
    && ok || bad "governance/$j.json must be seeded EMPTY"
done

# exactly ONE repo-health check, and it is records-check. Seeding
# the full 38-suite roster would seed 38 failing checks on a fresh clone,
# because the suites are not part of the payload.
[ "$(jq '.entries | length' "$TARGET/governance/repo-health.json")" -eq 0 ] \
  && ok || bad "repo-health.json must be seeded EMPTY: records-check is User-inspection surface, and seeding it ran it inside every deployed task-verify, putting its WARNs in the agent's path (boundary 7). A repo registers its own checks with scrumux health."

# ROSTERS are deliberately NOT seeded (I-0029): records-check section 10
# is guarded by a test for PROJECT_SPEC.MD, so a target without one skips
# roster drift entirely, and a roster the installer cannot keep true is
# the canon-drift failure itself.
for c in PROJECT_SPEC.MD SKILLS_INDEX.MD README.MD; do
  [ -f "$TARGET/$c" ] && bad "deploy must NOT seed $c — a roster the installer cannot keep true is the I-0029 canon-drift failure" || ok
done

# CLAUDE.md IS seeded, and the I-0029 reasoning above is why it took a
# ruling to get there (User, 2026-08-23). The canon-drift failure is
# specifically a ROSTER the installer cannot keep true — a list of files
# that goes stale the moment the repo changes. The seeded constitution
# carries no roster: it points at .claude/rules/ and .claude/skills/ as
# DIRECTORIES and tells the agent to read what is in them. Nothing in it
# can drift, because it names nothing that moves.
#
# Not seeding it had a cost that outweighed the risk it was avoiding: the
# rules deploy, but the document telling an agent to go and read them did
# not, so a deployed repo's governance began at a directory nobody was
# told to open.
[ -f "$TARGET/CLAUDE.md" ] \
  && ok || bad "deploy MUST seed CLAUDE.md at the repo root — without it the rules are a directory nobody is told to open"
grep -q 'governed by the \*\*harness\*\*' "$TARGET/CLAUDE.md" 2>/dev/null \
  && ok || bad "the seeded CLAUDE.md must be the DEPLOYED constitution (.claude/CLAUDE.md), not the harness's own /CLAUDE.source.md, which is about building the harness"
grep -qE '\.claude/rules/' "$TARGET/CLAUDE.md" && grep -qE '\.claude/skills/' "$TARGET/CLAUDE.md" \
  && ok || bad "the seeded constitution must send the agent to BOTH the rules and the skills before acting"

# An existing CLAUDE.md is preserved, never discarded.
PRESERVE_T="$SANDBOX/preserve"; mkdir -p "$PRESERVE_T"
printf '# theirs\n\nbuild with make\n' > "$PRESERVE_T/CLAUDE.md"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$PRESERVE_T" >/dev/null 2>&1
grep -q 'build with make' "$PRESERVE_T/CLAUDE.pre-harness.md" 2>/dev/null \
  && ok || bad "an existing CLAUDE.md must be preserved verbatim at CLAUDE.pre-harness.md, not overwritten"
grep -q 'CLAUDE.pre-harness.md' "$PRESERVE_T/CLAUDE.md" 2>/dev/null \
  && ok || bad "the seeded CLAUDE.md must point at the preserved one, or the repo's own instructions never reach the agent"
# The PRODUCT agents stay out; the schema MODULE ships, because records-check
# delegates the journal contracts to it and a target without it can never
# check its own records. The assertion is per-package rather than "no
# agents/ at all", which was the blanket form before the module shipped.
for _pkg in context_builder atomicity_judge design_checker story_shaper; do   # deleted; the loop proves they never return to the payload
  [ -d "$TARGET/agents/$_pkg" ] && bad "deploy must NOT carry the in-repo LangGraph agent '$_pkg' — the governance machinery is the payload" || ok
done
# THE THREE MODULES THAT USED TO SHIP ARE GONE, and their assertions with
# them. `schema_check.py` was here because a target could not check its own
# journals without it; `governance_graph.py` because `graph gov`, bearing,
# task-brief's bearing block and task-lint's D-0005 no-refs FAIL were all dead
# in a deployed repo without it (I-0104); `code_graph.py` because a target
# reads its own index. All three answer natively (R-004, wave 5I, wave 5J), so
# what those assertions protected is now protected by there being no
# interpreter in the path at all — proved above by the target carrying no
# `agents/` and by the surface probes below actually running `graph gov` and
# `graph code` inside it.
[ -s "$TARGET/governance/code-graph.json" ] \
  && ok || bad "deploy must BUILD the code index into the target — the builder travels with the harness source, which is the only checkout with the grammars"
[ -f "$TARGET/pyproject.toml" ] && bad "deploy must NOT carry pyproject.toml" || ok

# --- 3. the target validates -----------------------------------------
# The validator runs from THIS repo's scripts with GOV_ROOT pointed at
# the target — lib.sh:5-11, code location from $0, data location from
# GOV_ROOT. That is the same call deploy makes, and the reason it is not
# the target's own copy is that records-check delegates the schema
# contracts to the schema module, which imports agents/lib — deliberately not
# part of the payload.
GVOUT=$(GOV_ROOT="$TARGET" "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1); GVRC=$?
[ $GVRC -eq 0 ] && ok || bad "records-check must exit 0 against a freshly deployed target, got $GVRC: $GVOUT"
printf '%s' "$OUT" | grep -q 'records-check' \
  && ok || bad "deploy must report the records-check check it ran; got: $OUT"

# --- 4. verify says the target is INSTALLED ---------------------------
# INSTALLED, not "live": every check below is about files in the target
# and the commands they are, and none of them can see which project root
# the session reading them was launched with (E2E audit F2).
VOUT=$("$HARNESS" $HARNESS_CMD verify "$TARGET" --json 2>&1); VRC=$?
[ $VRC -eq 0 ] && ok || bad "verify on a freshly deployed target must exit 0, got $VRC: $VOUT"
printf '%s' "$VOUT" | jq -e '.ok == true' >/dev/null 2>&1 \
  && ok || bad "verify --json must report ok:true on a fully installed target; got: $VOUT"
printf '%s' "$VOUT" | jq -e '.summary | startswith("harness verify: ") and contains(" is INSTALLED — ") and contains("Installed is not live")' >/dev/null 2>&1 \
  && ok || bad "verify must say INSTALLED and say what that does NOT mean — it computes a filesystem install, never that a session is governed (E2E audit F2); got: $(printf '%s' "$VOUT" | jq -r .summary)"
printf '%s' "$VOUT" | jq -e '.checks | type == "array" and length > 0' >/dev/null 2>&1 \
  && ok || bad "verify --json must carry a non-empty per-check array (D-0059/D-0061: the app must never parse prose)"
printf '%s' "$VOUT" | jq -e 'all(.checks[]; has("name") and has("ok") and (.ok | type == "boolean"))' >/dev/null 2>&1 \
  && ok || bad "every check in verify --json must carry a name and a BOOLEAN ok"
# --json emits exactly ONE object and no prose around it
[ "$(printf '%s\n' "$VOUT" | jq -s 'length' 2>/dev/null)" = "1" ] \
  && ok || bad "verify --json must emit exactly one JSON object and nothing else; got: $VOUT"
for c in settings-at-root hook-chains hooks-executable scripts-roster journals journal-schemas surfaces-run; do
  printf '%s' "$VOUT" | jq -e --arg c "$c" 'any(.checks[]; .name == $c)' >/dev/null 2>&1 \
    && ok || bad "verify must carry a '$c' check"
done
printf '%s' "$VOUT" | jq -e 'any(.checks[]; .name == "surfaces-run" and .ok == true)' >/dev/null 2>&1 \
  && ok || bad "surfaces-run must be GREEN on a freshly deployed target — every registered command must actually run there; got: $(printf '%s' "$VOUT" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail')"
# an exemption is a hand-wave, so it has to be visible in the JSON the
# app reads — never a silent skip (T-0174)
SRD=$(printf '%s' "$VOUT" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail')
# The exemption list is PRINTED even when it is empty, which is the state
# worth being able to read at a glance. It held two entries while the payload
# shipped a sourced shell library and a directory of noun modules; the payload
# is one doorway and one bundle now, and every shipped command has a probe.
printf '%s' "$SRD" | grep -q 'Declared exemptions: ' \
  && ok || bad "surfaces-run must PRINT the exemption list, so a skip cannot hide; got: $SRD"
printf '%s' "$SRD" | grep -q 'Declared exemptions: none — every shipped command carries a probe' \
  && ok || bad "with nothing exempt, surfaces-run must SAY so rather than trailing an empty list; got: $SRD"

# --- 4-0. THE OTHER HALF OF THE GOVERNING FACT ------------------------
# Claude Code resolves the project root ONCE, at launch. verify's header
# has always said so and verify only ever applied it to a stray settings
# file — never to the session doing the verifying. In the E2E audit an
# operator ran `rm -rf` inside a governed repo from a session rooted
# elsewhere, no wall fired, and verify reported 10/10 before and after.
# session-topology is the computable half of that, and it is a WARN:
# the topology belongs to the operator's terminal, not to the target.
VCHK=$(printf '%s' "$VOUT" | jq -r '[.checks[] | select(.tier == "pass" or .tier == "fail")] | length')
VELSE=$(CLAUDE_PROJECT_DIR="$SANDBOX" "$HARNESS" $HARNESS_CMD verify "$TARGET" --json 2>&1); VERC=$?
[ $VERC -eq 0 ] && ok || bad "a WARN must never move the exit code (P-01); verify exited $VERC with CLAUDE_PROJECT_DIR elsewhere: $VELSE"
printf '%s' "$VELSE" | jq -e 'any(.checks[]; .name == "session-topology" and .tier == "warn" and .ok == true)' >/dev/null 2>&1 \
  && ok || bad "with CLAUDE_PROJECT_DIR naming a different repo, verify must emit a session-topology WARN — the hooks in the target are installed and INERT for this session, and nothing else in the report says so; got: $VELSE"
printf '%s' "$VELSE" | jq -e '.checks[] | select(.name == "session-topology") | .detail | contains("INERT FOR THIS SESSION") and contains("launch a session with")' >/dev/null 2>&1 \
  && ok || bad "the session-topology WARN must name the consequence AND the remedy (Article 5); got: $(printf '%s' "$VELSE" | jq -r '.checks[] | select(.name == "session-topology") | .detail')"
VECHK=$(printf '%s' "$VELSE" | jq -r '[.checks[] | select(.tier == "pass" or .tier == "fail")] | length')
[ "$VECHK" = "$VCHK" ] \
  && ok || bad "an advisory must not change the CHECK count: $VCHK checks without CLAUDE_PROJECT_DIR, $VECHK with it — the summary says N/N and the README states that number"
printf '%s' "$VELSE" | jq -e --arg n "$VCHK" '.summary | contains("\($n)/\($n) checks pass")' >/dev/null 2>&1 \
  && ok || bad "the summary's denominator counts CHECKS, never advisories; got: $(printf '%s' "$VELSE" | jq -r .summary)"
VSAME=$(CLAUDE_PROJECT_DIR="$TARGET" "$HARNESS" $HARNESS_CMD verify "$TARGET" --json 2>&1)
printf '%s' "$VSAME" | jq -e 'any(.checks[]; .name == "session-topology")' >/dev/null 2>&1 \
  && bad "no WARN is owed when the session IS rooted at the target — an advisory that always fires is noise; got: $VSAME" || ok

# --- 4a. COVERAGE: no shipped command may go unprobed ------------------
# Derived from the payload, not hand-listed — the same rule the scripts
# roster follows. A new .claude/scripts command that nobody wrote a probe
# row for must be a FAILURE, or the execution pass rots the first time a
# surface is added.
# An exemption ending in / covers a DIRECTORY. The two tables are TypeScript
# literals in src/nouns/harness/payload.ts; a probe row carries its argv as
# `argv: '.claude/scripts/<name> …'` and an exemption its `path:`, so both are
# found by searching for the roster-relative path in that file.
for sp in "$ROOT"/.deploy-claude/scripts/*; do
  base=$(basename "$sp")
  case "$base" in .*) continue;; esac
  rel=".claude/scripts/$base"
  [ -d "$sp" ] && rel="$rel/"
  if grep -q "'$rel " "$HARNESS_SRC" || grep -q "'$rel'" "$HARNESS_SRC"; then
    ok
  else
    bad "$rel is shipped by the payload but appears in neither SURFACE_PROBES nor SURFACE_EXEMPT in src/nouns/harness/payload.ts — every shipped command needs a probe row (its cheapest bounded non-mutating no-op) or an exemption row stating why it has none"
  fi
done

# --- 4b. THE SURFACES ACTUALLY RUN IN THE TARGET ----------------------
# I-0104: verify reported 7/7 on a target where 'graph gov index',
# 'graph gov bearing' and 'graph code index' all exited 1 with a raw
# ImportError. Presence checks cannot see that; these run the commands.
T3="$SANDBOX/target3"; mkdir -p "$T3"
"$HARNESS" $HARNESS_CMD deploy "$T3" >/dev/null 2>&1 || bad "deploy into target3 must succeed"

# graph code ANSWERS in a deployed target. It reads the index deploy
# built, with the system python3 and no grammars at all — that is the
# whole point of the reader/builder split, and the reason I-0104's
# refusal is gone rather than reworded.
GC=$( ( cd "$T3" && GOV_ROOT="$T3" ./.claude/scripts/scrumux graph code stats ) 2>&1 </dev/null ); GCRC=$?
[ $GCRC -eq 0 ] && ok || bad "graph code in a deployed target must ANSWER, got $GCRC: $GC"
printf '%s' "$GC" | grep -q 'index built from' \
  && ok || bad "every answer must carry the index's provenance — a reader never rebuilds, so how old it is is the one thing it owes its caller; got: $GC"
printf '%s' "$GC" | grep -q 'NOT INDEXED' \
  && ok || bad "stats must report coverage — a file skipped for want of a grammar must be counted and named, never silently dropped; got: $GC"
printf '%s' "$GC" | grep -q 'Traceback (most recent call last)' \
  && bad "graph code must not hand an operator a Python traceback in a deployed target; got: $GC" || ok
# and the BUILDER, which is the half that does need the grammars, must
# refuse there in one line that names a checkout which can do it.
# PATH IS NARROWED, NOT EMPTIED, and node's own directory stays on it. The
# point of the case is a target with no GRAMMARS, not a box with no runtime:
# strip node too and the refusal under test is replaced by "node: not found",
# which proves nothing about the builder.
_nodedir=$(dirname -- "$(command -v node)")
GCB=$( ( cd "$T3" && GOV_ROOT="$T3" PATH="$_nodedir:/usr/bin:/bin" ./.claude/scripts/scrumux graph code build ) 2>&1 </dev/null ); GCBRC=$?
if [ $GCBRC -ne 0 ]; then
  printf '%s' "$GCB" | grep -q 'graph code build --repo' \
    && ok || bad "the builder's refusal must name a harness checkout that CAN build, never stop at 'not installed here'; got: $GCB"
else
  ok   # a machine whose system python3 has the grammars: the builder works there too
fi
printf '%s' "$GC" | grep -q '^graph code: index built from' \
  && ok || bad "the provenance stamp must be the first thing a reader says, so a stale answer cannot be mistaken for a current one; got: $GC"

# graph gov DOES run there: build, then bearing must return the law.
GB=$( ( cd "$T3" && GOV_ROOT="$T3" ./.claude/scripts/scrumux graph gov build ) 2>&1 </dev/null ); GBRC=$?
[ $GBRC -eq 0 ] && ok || bad "graph gov build must succeed in a deployed target (governance_graph.py imports stdlib only), got $GBRC: $GB"
printf '%s' "$GB" | grep -q 'Traceback' && bad "graph gov build must not traceback in a target; got: $GB" || ok

# a fixture the graph can answer over: one order that CHANGES a file and
# cites nothing, one earlier order that changed the same file, and a
# decision hung off that earlier order — which is exactly the shape
# bearing exists to surface.
( cd "$T3" && export GOV_ROOT="$T3"
  ./.claude/scripts/scrumux task new --title "fixture" --desc "d" --check "the suite is green"
  ./.claude/scripts/scrumux task new --title "earlier" --desc "d" --check "the suite is green"
  ./.claude/scripts/scrumux task order T-0001 --light --scope "edit one file" \
    --verify "sh tests/none.sh" --file "README.MD | the file changed here | rewrite the header"
  ./.claude/scripts/scrumux task order T-0002 --light --scope "edited it before" \
    --verify "sh tests/none.sh" --file "README.MD | changed before | rewrite the header"
  ./.claude/scripts/scrumux decide new --title "the README header is law" --decision "it states the purpose" \
    --rationale "so a reader knows what the repo is" --by User --task T-0002
  ./.claude/scripts/scrumux graph gov build ) >/dev/null 2>&1

BR=$( ( cd "$T3" && GOV_ROOT="$T3" ./.claude/scripts/scrumux graph gov bearing --task T-0001 ) 2>&1 </dev/null ); BRRC=$?
[ $BRRC -eq 0 ] && ok || bad "graph gov bearing must answer in a deployed target, got $BRRC: $BR"
printf '%s' "$BR" | grep -q '^path changes README.MD' \
  && ok || bad "bearing in a target must report the path the order CHANGES; got: $BR"
printf '%s' "$BR" | grep -q 'D-0001 \[changes README.MD via T-0002\]' \
  && ok || bad "bearing in a target must return the LAW bearing on that path, resolved through the shared ref resolver; got: $BR"

# and the D-0005 no-refs FAIL — the one thing task-lint:146 genuinely
# lost in a deployed repo, because the empty-BEARING branch skipped it
TL=$( ( cd "$T3" && GOV_ROOT="$T3" ./.claude/scripts/scrumux task lint T-0001 ) 2>&1 </dev/null ); TLRC=$?
[ $TLRC -ne 0 ] && ok || bad "task-lint must FAIL an order that changes a file and cites no refs, in a DEPLOYED repo as much as in this one; got rc $TLRC: $TL"
printf '%s' "$TL" | grep -qE 'FAIL +T-0001 +this order CHANGES README.MD and cites no governance refs' \
  && ok || bad "the D-0005 no-refs FAIL must fire in a deployed target — with governance_graph.py absent, bearing came back empty and this check was silently skipped (I-0104); got: $TL"
printf '%s' "$TL" | grep -q 'graph gov bearing returned nothing' \
  && bad "task-lint must not fall back to its empty-BEARING TELL in a deployed target — the graph is shipped now; got: $TL" || ok

# --- 4c. a BROKEN surface turns verify RED ----------------------------
# The point of an execution pass: a nonzero exit from a registered
# command is a failed check, not a fact nobody looks at.
V3=$("$HARNESS" $HARNESS_CMD verify "$T3" --json 2>&1); RCV3=$?
[ $RCV3 -eq 0 ] && ok || bad "verify on target3 must be green before it is broken; got: $V3"

# (a) reproduce I-0104's SHAPE. It was a target whose `graph gov index`,
# `graph gov bearing` and `graph code index` all exited 1 with a raw
# ImportError while verify reported 7/7, because the python module they
# imported had not landed. There is no module to take away any more, so the
# case takes away the thing every surface now imports: the CLI bundle. Same
# claim — a registered command that cannot RUN must turn verify red, and a
# presence check passes it by definition, because the doorway is still there.
mv "$T3/.claude/dist/scrumux.mjs" "$SANDBOX/bundle.parked"
V4=$("$HARNESS" $HARNESS_CMD verify "$T3" --json 2>&1); RCV4=$?
[ $RCV4 -ne 0 ] && ok || bad "verify MUST exit nonzero when a registered command can no longer run — this is I-0104, which reported 7/7 ok"
printf '%s' "$V4" | jq -e 'any(.checks[]; .name == "surfaces-run" and .ok == false)' >/dev/null 2>&1 \
  && ok || bad "surfaces-run must be the check that fails when a registered command cannot run; got: $V4"
printf '%s' "$V4" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail' | grep -q 'graph-gov' \
  && ok || bad "the surfaces-run failure must NAME the surface that would not run; got: $V4"
printf '%s' "$V4" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail' | grep -q '.claude/scripts/scrumux graph gov stats' \
  && ok || bad "the surfaces-run failure must name the ARGV, so it can be re-run by hand; got: $V4"
mv "$SANDBOX/bundle.parked" "$T3/.claude/dist/scrumux.mjs"
"$HARNESS" $HARNESS_CMD verify "$T3" --json >/dev/null 2>&1 \
  && ok || bad "verify must go green again once the bundle is back"

# (b) a surface present but not executable — rc 126, the I-0060 shape,
# which a presence check passes by definition.
# There is ONE executable now, so losing its mode bit is the whole
# surface at once — which is exactly what makes the check matter: at 644
# every probe returns 126 and a presence check still passes.
chmod 644 "$T3/.claude/scripts/scrumux"
V5S=$("$HARNESS" $HARNESS_CMD verify "$T3" --json 2>&1); RCV5S=$?
[ $RCV5S -ne 0 ] && ok || bad "verify must fail when a shipped command is present but not executable (rc 126) — 'the file is there' is exactly what a presence check confirms"
printf '%s' "$V5S" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail' | grep -q 'backlog' \
  && ok || bad "the surfaces-run failure must name the surface; got: $V5S"
printf '%s' "$V5S" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail' | grep -q '126' \
  && ok || bad "the surfaces-run failure must report the rc it saw; got: $V5S"
chmod 755 "$T3/.claude/scripts/scrumux"

# (c) a surface that tracebacks — the I-0104 symptom itself. A stack
# trace is never an answer to an operator, whatever the exit code.
cp "$T3/.claude/scripts/scrumux" "$SANDBOX/scrumux.parked"
printf '#!/bin/sh\npython3 -c "raise SystemError(1)" 2>&1\nexit 0\n' > "$T3/.claude/scripts/scrumux"
chmod 755 "$T3/.claude/scripts/scrumux"
V6S=$("$HARNESS" $HARNESS_CMD verify "$T3" --json 2>&1); RCV6S=$?
[ $RCV6S -ne 0 ] && ok || bad "verify must fail a surface that prints a Python traceback even when it exits 0 — a traceback is not an answer"
printf '%s' "$V6S" | jq -r '.checks[] | select(.name == "surfaces-run") | .detail' | grep -q 'traceback' \
  && ok || bad "the surfaces-run failure must say a traceback reached the operator; got: $V6S"
cp "$SANDBOX/scrumux.parked" "$T3/.claude/scripts/scrumux"
chmod 755 "$T3/.claude/scripts/scrumux"

# --- 4d. the deployment manifest (T-0198) -----------------------------
# .claude/DEPLOYED is what makes a deployed repo self-describing: the
# upstream wall reads it to know it is in a deployment rather than in
# the harness's own checkout, and verify reads its hashes to answer the
# drift question WITHOUT a source checkout on hand. That last property
# is the correction this sprint had to make — an earlier design compared
# a target against a co-located harness clone, which is true on one
# machine and false on every server.
MAN="$TARGET/.claude/DEPLOYED"
[ -f "$MAN" ] && ok || bad "deploy must write .claude/DEPLOYED into the target — without it the upstream wall cannot tell a deployment from the harness's own checkout"
jq -e . "$MAN" >/dev/null 2>&1 && ok || bad ".claude/DEPLOYED must be valid JSON"
jq -e 'has("source_remote") and has("source_commit") and has("deployed_at") and has("files")' "$MAN" >/dev/null 2>&1 \
  && ok || bad ".claude/DEPLOYED must carry source_remote, source_commit, deployed_at and files"

# The remote is what the wall's refusal points a reader at. A local path
# there would be the exact assumption this sprint corrected.
MREMOTE=$(jq -r .source_remote "$MAN")
case "$MREMOTE" in
  /*|~*) bad "source_remote is a local filesystem path ($MREMOTE) — the upstream must be reachable from any machine" ;;
  *) ok ;;
esac

# One hash per payload file, and the count must equal the roster the
# same run installed. A manifest that describes fewer files than shipped
# is a drift check with holes in it.
ROSTER=$(find "$TARGET/.claude/scripts" "$TARGET/.claude/hooks" "$TARGET/.claude/schemas" \
              "$TARGET/.claude/rules" "$TARGET/.claude/skills" "$TARGET/.claude/agents" \
              -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')
MFILES=$(jq -r '.files | length' "$MAN")
[ "$MFILES" -ge "$ROSTER" ] \
  && ok || bad "the manifest describes $MFILES file(s) but the target holds at least $ROSTER payload file(s) — a drift check cannot cover what it does not list"

# The hashes must be real: recomputing one by hand has to match.
GOVSHA=$(shasum -a 256 "$TARGET/.claude/scripts/scrumux" | awk '{print $1}')
MANSHA=$(jq -r '.files[".claude/scripts/scrumux"]' "$MAN")
[ "$GOVSHA" = "$MANSHA" ] \
  && ok || bad "the manifest's hash for .claude/scripts/scrumux does not match the file on disk — recorded $MANSHA, actual $GOVSHA"

# It must NOT be in the payload roster it describes: all_payload_files
# walks the PAYLOAD_DIRS under .claude, and this file sits above them.
grep -q '"\.claude/DEPLOYED"' "$MAN" \
  && bad ".claude/DEPLOYED lists itself in the roster it describes — it is not payload" || ok

# A repo that has never been deployed into has no manifest. The harness's
# own checkout is that repo, and the wall's inertness there depends on it.
[ -f "$ROOT/.claude/DEPLOYED" ] \
  && bad "the harness's own checkout carries .claude/DEPLOYED — the upstream wall would fire here and the harness could not be developed" || ok

# --- 4e. the hook-chain roster is derived, not hand-counted (T-0202) --
# Three sites said "five hook chains" while HOOK_CHAINS held four and two
# checks said "four". The count is now computed from the roster, so the
# only way to make it wrong again is to change the roster — which these
# assertions then catch.
CHAINS=$(sed -n "/^export const HOOK_CHAINS = \[/,/\] as const;/p" "$HARNESS_SRC" \
         | grep -o "'[A-Za-z:|]*'" | tr -d "'")
NCHAINS=$(printf '%s\n' $CHAINS | wc -l | tr -d ' ')
grep -q "^export const HOOK_CHAIN_COUNT = HOOK_CHAINS.length;" "$HARNESS_SRC" \
  && ok || bad "harness must derive HOOK_CHAIN_COUNT from HOOK_CHAINS.length — a hand-written count is what drifted (T-0202)"
grep -qnE '(four|five|six) (hook )?chains' "$HARNESS_SRC" \
  && bad "harness still spells a chain count in words — every count must come from HOOK_CHAIN_COUNT" || ok
printf '%s' "$CHAINS" | grep -q 'PreToolUse:Edit' \
  && ok || bad "HOOK_CHAINS must include the Edit|Write|NotebookEdit chain — the upstream wall's second arm is registered there and I-0121 is why it exists"

# missing_chains carries the roster a second time, because each chain
# needs a matcher pattern jq cannot derive. The two must agree, or a
# chain is declared in one place and never checked in the other.
for c in $CHAINS; do
  case "$c" in
    PreToolUse:Edit*) pat='PreToolUse:Edit' ;;
    *) pat="$c" ;;
  esac
  grep -qF -- "$pat" "$HARNESS_SRC" \
    && ok || bad "chain $c is in HOOK_CHAINS but missing_chains never tests for it — it would be declared and unchecked"
done

# The count verify PRINTS must equal the roster it printed.
#
# Against $TARGET, not $ROOT. `harness verify` answers about a DEPLOYED
# repo, and the harness source repo stopped being one the moment its
# payload was renamed to .deploy-claude/: there is deliberately no
# .claude/settings.json at the source root any more, so verify there
# reports "no settings.json at the repo root" and never reaches the chain
# roster. Pointing this at a real deployment tests the same assertion
# where the assertion means something.
VOUT=$("$HARNESS" $HARNESS_CMD verify "$TARGET" 2>&1)
printf '%s' "$VOUT" | grep -q "all $NCHAINS chains declared" \
  && ok || bad "verify must print the derived chain count ($NCHAINS); got: $(printf '%s' "$VOUT" | grep hook-chains)"

# --- 4g. the project-standards lane (T-0203) --------------------------
# A repo carries requirements of its own. They need somewhere to live
# that carries NO penalty — User's framing — so the assertions here are
# as much about what does NOT happen as what does.
PSTD="$TARGET/.claude/rules/project-standards.md"
[ -f "$PSTD" ] && ok || bad "deploy must seed .claude/rules/project-standards.md — a repo with no place to write its own standards has to edit the harness's rules instead"
head -1 "$PSTD" | grep -q -- '---' && ok || bad "the seeded template must open with frontmatter or the target's own records-check rejects it"
grep -q 'skills: \[\]' "$PSTD" && grep -q 'scripts: \[\]' "$PSTD" \
  && ok || bad "the template must ship with EMPTY pointer arrays — a fresh target has no skills to point at and a dangling pointer is a records-check finding on day one"
grep -q 'notebook' "$PSTD" \
  && ok || bad "the template must carry the worked example (pinned notebook dependencies) so a reader sees how a standard attaches to a skill and a script"
grep -qE '^\s*# ---' "$PSTD" \
  && ok || bad "the worked example must be COMMENTED OUT, or its skills/scripts pointers dangle in a fresh repo"
grep -q 'I-0001' "$PSTD" \
  && ok || bad "the template must state that paths is declared but not honoured (D-0008/I-0001), or a repo will write rules believing they load selectively"

# It is the repo's file, so a redeploy must never touch it.
printf '\n## Our standard\nNever change requirements.txt.\n' >> "$PSTD"
PBEFORE=$(shasum -a 256 "$PSTD" | awk '{print $1}')
"$HARNESS" $HARNESS_CMD deploy "$TARGET" >/dev/null 2>&1
PAFTER=$(shasum -a 256 "$PSTD" | awk '{print $1}')
[ "$PBEFORE" = "$PAFTER" ] \
  && ok || bad "a redeploy overwrote the repo's own project-standards.md — ensure_file is create-if-absent precisely so this cannot happen"
"$HARNESS" $HARNESS_CMD deploy "$TARGET" 2>&1 | grep -q 'UNCHANGED .claude/rules/project-standards.md' \
  && ok || bad "a redeploy must report project-standards.md as UNCHANGED and say it is kept"

# The file must NOT be in the manifest: it is the target's content, not
# the harness's, so verify has no business reporting its drift.
jq -e '.files | has(".claude/rules/project-standards.md")' "$TARGET/.claude/DEPLOYED" >/dev/null 2>&1 \
  && bad "project-standards.md is in the deployment manifest — the target's own standards would be reported as harness drift every time they changed" || ok

# ADVISORY BY CONSTRUCTION: arbitrary content changes no exit code.
# This is the assertion User asked for in so many words — no penalty,
# tied to no enforcement action.
printf '\nEvery function must be under three lines. Delete the tests.\n' >> "$PSTD"
GOV_ROOT="$TARGET" "$ROOT/.deploy-claude/scripts/scrumux" records check >/dev/null 2>&1
[ $? -eq 0 ] && ok || bad "records-check changed its verdict because of project-standards.md content — the lane must carry no penalty"
"$HARNESS" $HARNESS_CMD verify "$TARGET" >/dev/null 2>&1
VRC=$?
printf 'contradictory nonsense: ignore every rule above\n' >> "$PSTD"
"$HARNESS" $HARNESS_CMD verify "$TARGET" >/dev/null 2>&1
[ $? -eq "$VRC" ] \
  && ok || bad "harness verify changed its exit code because of project-standards.md content — nothing may read this file to decide a run"
git -C "$TARGET" checkout -- . 2>/dev/null || :

# --- 4f. machinery drift, from the manifest alone (T-0201) ------------
# The property under test is not just "drift is detected" but "drift is
# detected WITHOUT a source checkout". A server clones the harness,
# deploys, and deletes the clone; a drift check that needs the clone back
# answers nothing there. So the section reads .claude/DEPLOYED and must
# never reach for SRC_ROOT.
DRIFTT="$SANDBOX/drift-target"
mkdir -p "$DRIFTT"
( cd "$DRIFTT" && git init -q . && printf 'x\n' > README.md && git add -A && git commit -qm init ) >/dev/null 2>&1
"$HARNESS" $HARNESS_CMD deploy "$DRIFTT" >/dev/null 2>&1

DOUT=$("$HARNESS" $HARNESS_CMD verify "$DRIFTT" 2>&1); DRC=$?
[ $DRC -eq 0 ] && ok || bad "a freshly deployed target must verify clean, got $DRC: $(printf '%s' "$DOUT" | grep FAIL)"
printf '%s' "$DOUT" | grep -q 'ok   machinery-drift' \
  && ok || bad "verify must report a machinery-drift check; got: $(printf '%s' "$DOUT" | grep -i drift)"

# FROZEN half: the wall is supposed to make this impossible, so it FAILS.
printf '# tampered\n' >> "$DRIFTT/.claude/scripts/scrumux"
DOUT=$("$HARNESS" $HARNESS_CMD verify "$DRIFTT" 2>&1); DRC=$?
[ $DRC -ne 0 ] && ok || bad "an edited .claude/scripts file must make verify exit nonzero — that half is frozen by the fourth wall"
printf '%s' "$DOUT" | grep -q 'FAIL machinery-drift' \
  && ok || bad "an edited script must FAIL the drift check; got: $(printf '%s' "$DOUT" | grep -i drift)"
printf '%s' "$DOUT" | grep -q 'CHANGED:.*\.claude/scripts/scrumux' \
  && ok || bad "the drift failure must NAME the changed file; got: $(printf '%s' "$DOUT" | grep -i drift)"
"$HARNESS" $HARNESS_CMD deploy "$DRIFTT" >/dev/null 2>&1

# TRACKED half: prose is where a repo localises. Reported, never fatal
# (D-0072 boundary 7 — drift is inspection data, not an agent's block).
printf 'a local standard\n' >> "$DRIFTT/.claude/rules/minimum-planning-requirements.md"
DOUT=$("$HARNESS" $HARNESS_CMD verify "$DRIFTT" 2>&1); DRC=$?
[ $DRC -eq 0 ] && ok || bad "edited PROSE must not make verify fail — rules and skills are where a target legitimately differs, got $DRC"
printf '%s' "$DOUT" | grep -q 'ok   machinery-drift' \
  && ok || bad "prose drift must be reported on a PASSING check; got: $(printf '%s' "$DOUT" | grep -i drift)"
printf '%s' "$DOUT" | grep -q 'minimum-planning-requirements.md' \
  && ok || bad "prose drift must still NAME the localised file, or the report says nothing useful"
"$HARNESS" $HARNESS_CMD deploy "$DRIFTT" >/dev/null 2>&1

# A file the manifest lists and the disk has lost is frozen-class
# whichever half it came from: the machinery is incomplete either way.
rm -f "$DRIFTT/.claude/skills/session-open/SKILL.md"
DOUT=$("$HARNESS" $HARNESS_CMD verify "$DRIFTT" 2>&1); DRC=$?
[ $DRC -ne 0 ] && ok || bad "a payload file listed in the manifest but missing from disk must fail verify"
printf '%s' "$DOUT" | grep -q 'MISSING:' \
  && ok || bad "a missing payload file must be reported as MISSING by the drift check; got: $(printf '%s' "$DOUT" | grep -i drift)"
"$HARNESS" $HARNESS_CMD deploy "$DRIFTT" >/dev/null 2>&1

# A repo deployed before the manifest existed must not be accused of
# drift it cannot be measured for.
mv "$DRIFTT/.claude/DEPLOYED" "$DRIFTT/.claude/DEPLOYED.bak"
DOUT=$("$HARNESS" $HARNESS_CMD verify "$DRIFTT" 2>&1); DRC=$?
[ $DRC -eq 0 ] && ok || bad "a target with no manifest must not fail verify — it predates the manifest, which is not a finding"
printf '%s' "$DOUT" | grep -q 'no .claude/DEPLOYED' \
  && ok || bad "a target with no manifest must say so plainly rather than claiming a clean result"
mv "$DRIFTT/.claude/DEPLOYED.bak" "$DRIFTT/.claude/DEPLOYED"

# The correction this task carries: nothing in the drift section may
# reach for the source checkout. A static assertion, because the failure
# it guards against only shows up on a machine that does not have one.
DSEC=$(awk '/machinery drift, from the target/,/const nfail/' "$VERIFY_SRC")
printf '%s' "$DSEC" | grep -q 'srcRoot' \
  && bad "the drift section references srcRoot — it must answer from .claude/DEPLOYED alone, or it cannot answer on a server that deleted its harness clone" || ok
printf '%s' "$DSEC" | grep -q 'sealQuiet' \
  && ok || bad "the drift section must hash with sealQuiet, the same helper the manifest was written with, or the comparison is meaningless"
rm -rf "$DRIFTT"

# --- 5. deploy is idempotent, by BYTES not timestamps -----------------
#
# THE MANIFEST ITSELF IS SNAPSHOTTED, not just hashed with everything else.
#
# The previous round of this suite improved the diagnostic until it could
# name WHICH FILE moved, and on CI run 33708307621 it did its job: the
# answer was `.claude/DEPLOYED` and nothing else. That is as far as a
# filename can take anyone. `.claude/DEPLOYED` is a JSON document with a
# provenance half (source_remote, source_commit, deployed_at, and an
# optional deployed_from) and a 70-odd entry `files` map, and "the manifest
# changed" is true of a date rolling over, of a commit resolving
# differently on a CI checkout, of one payload file's installed bytes
# moving, and of the key SET changing because a file appeared or vanished
# in the source between the two deploys. Those are four different bugs with
# four different fixes and the same symptom.
#
# So the manifest is kept aside here and, on failure, the delta is rendered
# FIELD BY FIELD below. It reproduces on the macOS runner and on no
# machine any of us can touch, so the instrument has to come back with the
# mechanism on one run rather than narrowing it over several.
DBEF="$SANDBOX/DEPLOYED.before.$$"
cp "$TARGET/.claude/DEPLOYED" "$DBEF" 2>/dev/null || :
BEFORE=$(manifest "$TARGET")
OUT2=$("$HARNESS" $HARNESS_CMD deploy "$TARGET" 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "second deploy must exit 0, got $RC: $OUT2"
printf '%s' "$OUT2" | grep -q 'nothing changed' \
  && ok || bad "second deploy must say plainly that nothing changed; got the summary: $(printf '%s' "$OUT2" | tail -1)"
printf '%s' "$OUT2" | grep -q 'CREATED' && bad "second deploy must report no CREATED items" || ok
printf '%s' "$OUT2" | grep -q 'UPDATED' \
  && bad "second deploy must report no UPDATED items; .claude/DEPLOYED delta: $(manifest_delta "$DBEF" "$TARGET/.claude/DEPLOYED")" || ok
# The manifest is rewritten on every deploy but reported by BYTES like
# everything else, so an unchanged target must show it UNCHANGED. If it
# ever reports UPDATED on a no-op, "nothing changed" is false.
printf '%s' "$OUT2" | grep -q 'UNCHANGED .claude/DEPLOYED' \
  && ok || bad "second deploy must report .claude/DEPLOYED as UNCHANGED — its status is decided by bytes, not by the fact that it was rewritten; delta: $(manifest_delta "$DBEF" "$TARGET/.claude/DEPLOYED")"
AFTER=$(manifest "$TARGET")
# THE DIAGNOSTIC IS THE POINT OF THE ASSERTION, and this one could never
# reach a reader. TWO separate faults, both measured:
#
#   1. It could not PRODUCE anything. `printf '%s\n' "$BEFORE" | diff -
#      /dev/stdin <<EOF2 …` gives diff the HEREDOC on stdin, so `-` and
#      `/dev/stdin` name the same open file: BSD diff notices and reports them
#      identical (rc 0, silent), and dash answers `Bad file descriptor` on
#      STDERR, which `$( )` does not capture. Ran under /bin/sh, /bin/bash and
#      /bin/dash on macOS: empty in all three.
#   2. It could not SURVIVE THE RELAY. `tools/parity-suites.sh:117` forwards
#      only lines matching `^(FAIL|not ok|  FAIL)`, so a multi-line detail
#      loses every continuation line — which is why the fix is ONE LINE naming
#      the paths, not a pasted `diff`.
#
# Measured on CI run 33651153381, where this fired three times on macOS and
# printed exactly nothing about WHICH file had moved, on the one lane nobody
# can reproduce locally. A diagnostic is the only instrument that lane has.
# Two temp files, because `sh` has no process substitution and this suite runs
# under dash; `$1$3` is diff's marker and the PATH, the hash being noise once
# the path is named.
if [ "$BEFORE" = "$AFTER" ]; then ok; else
  MBEF="$SANDBOX/manifest-before.$$"; MAFT="$SANDBOX/manifest-after.$$"
  printf '%s\n' "$BEFORE" > "$MBEF"; printf '%s\n' "$AFTER" > "$MAFT"
  MDELTA=$(diff "$MBEF" "$MAFT" 2>&1 | awk '/^[<>]/ {printf "%s%s ", $1, $3}')
  rm -f "$MBEF" "$MAFT"
  MANDELTA=''
  case "$MDELTA" in *.claude/DEPLOYED*) MANDELTA=" | .claude/DEPLOYED delta: $(manifest_delta "$DBEF" "$TARGET/.claude/DEPLOYED")" ;; esac
  bad "second deploy mutated file bytes — idempotence must be real, not just reported; moved: ${MDELTA:-(diff produced nothing, which is itself the bug)}$MANDELTA"
fi
JOUT=$("$HARNESS" $HARNESS_CMD deploy "$TARGET" --json 2>&1)
printf '%s' "$JOUT" | jq -e '.ok == true and .changed == false and .created == 0 and .updated == 0' >/dev/null 2>&1 \
  && ok || bad "deploy --json on an unchanged target must report ok:true, changed:false, created:0, updated:0; got: $JOUT"
printf '%s' "$JOUT" | jq -e '.items | type == "array" and all(.[]; .status == "UNCHANGED")' >/dev/null 2>&1 \
  && ok || bad "deploy --json must carry a per-item array, every one UNCHANGED on a no-op run"

# a NEWER timestamp with identical bytes is still UNCHANGED — the
# comparison is byte-for-byte and never a mtime
touch "$TARGET/.claude/scripts/scrumux"
OUT3=$("$HARNESS" $HARNESS_CMD deploy "$TARGET" --json 2>&1)
printf '%s' "$OUT3" | jq -e '[.items[] | select(.path == ".claude/scripts/scrumux")] | .[0].status == "UNCHANGED"' >/dev/null 2>&1 \
  && ok || bad "a target file with a NEWER mtime but identical bytes must still be UNCHANGED — never decide by timestamp"

# ...and different bytes are UPDATED, whatever the timestamp says
printf '# drifted\n' >> "$TARGET/.claude/scripts/scrumux"
OUT4=$("$HARNESS" $HARNESS_CMD deploy "$TARGET" --json 2>&1)
printf '%s' "$OUT4" | jq -e '[.items[] | select(.path == ".claude/scripts/scrumux")] | .[0].status == "UPDATED"' >/dev/null 2>&1 \
  && ok || bad "a target file whose bytes differ must be reported UPDATED"
printf '%s' "$OUT4" | jq -e '.changed == true and .updated == 1' >/dev/null 2>&1 \
  && ok || bad "deploy --json must count the update and set changed:true"
cmp -s "$ROOT/.deploy-claude/scripts/scrumux" "$TARGET/.claude/scripts/scrumux" \
  && ok || bad "an UPDATED item must actually be restored to this harness's bytes"

# an existing journal is never rewritten: deploy carries machinery, not data
printf '%s\n' '{"entries":[{"id":"L-0001","date":"2026-08-20","title":"t","actor":"tests","what_was_done":"kept"}]}' > "$TARGET/governance/log.json"
"$HARNESS" $HARNESS_CMD deploy "$TARGET" >/dev/null 2>&1
[ "$(jq -r '.entries[0].id' "$TARGET/governance/log.json")" = "L-0001" ] \
  && ok || bad "deploy must never overwrite an existing journal — ensure_file is create-if-absent"

# --- 6. a target that already has a settings.json is NOT merged -------
T2="$SANDBOX/target2"; mkdir -p "$T2/.claude"
printf '%s\n' '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}' > "$T2/.claude/settings.json"
OUT5=$("$HARNESS" $HARNESS_CMD deploy "$T2" 2>&1); RC5=$?
# I-0155: the ONE narrow merge. The target's own hooks stay exactly as
# written, and canon's permissions.allow is unioned in append-if-absent —
# without it a pre-allow-list repo refuses every headless governance call.
jq -e '.hooks.UserPromptSubmit[0].hooks[0].command == "echo mine"' "$T2/.claude/settings.json" >/dev/null \
  && ok || bad "deploy must leave the target's own hooks byte-for-byte alone while unioning permissions.allow (I-0155)"
jq -e '.permissions.allow | index("Bash(.claude/scripts/scrumux*)")' "$T2/.claude/settings.json" >/dev/null \
  && ok || bad "deploy must union canon's permissions.allow into an existing settings.json — a repo deployed before the allow list existed refuses every headless governance call (I-0155)"
printf '%s' "$OUT5" | grep -q 'permissions.allow unioned' \
  && ok || bad "deploy must REPORT the union, not do it silently; got: $OUT5"
CUSTOM_KEEP='{"permissions":{"allow":["Bash(echo mine*)"]},"hooks":{}}'
T3="$SANDBOX/target3"; mkdir -p "$T3/.claude"; printf '%s\n' "$CUSTOM_KEEP" > "$T3/.claude/settings.json"
"$HARNESS" $HARNESS_CMD deploy "$T3" >/dev/null 2>&1
[ "$(jq -r '.permissions.allow[0]' "$T3/.claude/settings.json")" = "Bash(echo mine*)" ] \
  && ok || bad "the union must keep the target's own allow rules, first (I-0155)"
H3=$(shasum -a 256 "$T3/.claude/settings.json" | awk '{print $1}')
"$HARNESS" $HARNESS_CMD deploy "$T3" >/dev/null 2>&1
[ "$(shasum -a 256 "$T3/.claude/settings.json" | awk '{print $1}')" = "$H3" ] \
  && ok || bad "the union must be idempotent — a second deploy changes nothing (I-0155)"
printf '%s' "$OUT5" | grep -q 'PreToolUse:Bash' \
  && ok || bad "deploy must NAME the hook chains absent from an existing settings.json; got: $OUT5"
printf '%s' "$OUT5" | grep -q 'SessionStart' \
  && ok || bad "deploy must name every absent chain, not just the first"
printf '%s' "$OUT5" | grep -q "cp $ROOT/.deploy-claude/settings.json" \
  && ok || bad "deploy must PRINT the fix for the absent chains, not merely report them; got: $OUT5"
[ $RC5 -ne 0 ] && ok || bad "deploy must exit nonzero when the target's settings.json is missing hook chains — the harness is not live there"
J5=$("$HARNESS" $HARNESS_CMD deploy "$T2" --json 2>&1)
printf '%s' "$J5" | jq -e 'any(.checks[]; .name == "settings-hook-chains" and .ok == false)' >/dev/null 2>&1 \
  && ok || bad "deploy --json must fail the settings-hook-chains check when chains are absent; got: $J5"
V5=$("$HARNESS" $HARNESS_CMD verify "$T2" --json 2>&1); RCV5=$?
[ $RCV5 -ne 0 ] && ok || bad "verify must exit nonzero on a target whose settings.json lacks the four chains"
printf '%s' "$V5" | jq -e 'any(.checks[]; .name == "hook-chains" and .ok == false)' >/dev/null 2>&1 \
  && ok || bad "verify must name hook-chains as the failing check on an unmerged settings.json"

# --- 7. a hook that cannot start -------------------------------------
# T-0186 deleted monitor-compliance.sh and this case was repointed at
# another declared hook. It has moved AGAIN, deliberately, and both halves
# of the move are the contract now.
#
# The payload's hook chains are EXEC FORM — `node` plus the bundle path —
# because that is the only shape that runs on a stock Windows box. So the
# mode bit on `.claude/hooks/block-destructive.sh` no longer decides
# anything: settings.json does not name that file any more, and an
# exec-form script is READ by node rather than executed by the kernel, so
# its execute bit is not a prerequisite for anything even when it IS
# named. Asserting the old way here would have gone on passing only while
# the payload stayed POSIX-only.
#
# What replaces it is the same contract against what the payload actually
# declares: a declared hook that CANNOT START fails silently on every
# event, Claude Code treats it as non-blocking so the tool call proceeds,
# and verify must say so.
#
# 7a. the exec-form file is gone.
mv "$TARGET/.claude/dist/block-destructive.mjs" "$SANDBOX/block-destructive.mjs.parked"
V6=$("$HARNESS" $HARNESS_CMD verify "$TARGET" --json 2>&1); RCV6=$?
[ $RCV6 -ne 0 ] && ok || bad "verify must fail when a declared hook names a bundle that is not there — every PreToolUse event on that chain fails to start, and a hook that cannot start is NON-BLOCKING"
printf '%s' "$V6" | jq -e 'any(.checks[]; .name == "hooks-executable" and .ok == false)' >/dev/null 2>&1 \
  && ok || bad "verify must name hooks-executable as the failing check; got: $V6"
printf '%s' "$V6" | jq -r '.checks[] | select(.name == "hooks-executable") | .detail' | grep -q 'block-destructive.mjs(missing)' \
  && ok || bad "the hooks-executable failure must name the offending hook"
mv "$SANDBOX/block-destructive.mjs.parked" "$TARGET/.claude/dist/block-destructive.mjs"
#
# 7b. the SHELL-form mode-bit contract, preserved where it still applies:
# every repo deployed before this migration names `.claude/hooks/*.sh`
# directly, verify runs against those repos, and at mode 644 they fail on
# every event exactly as they always did.
SHT="$SANDBOX/shellform"; rm -rf "$SHT"; mkdir -p "$SHT"
cp -R "$TARGET/." "$SHT/" 2>/dev/null || :
# The hook is PLANTED rather than deployed. Deploy stopped shipping
# `.claude/hooks/*.sh` with the bash walls, so the only way to stand up the
# repo this case is about — one deployed before the exec-form migration — is
# to write the file the way that older deploy did.
mkdir -p "$SHT/.claude/hooks"
printf '#!/bin/sh\nexit 0\n' > "$SHT/.claude/hooks/block-destructive.sh"
jq '.hooks.PreToolUse[0].hooks[0] = {"type":"command","command":"${CLAUDE_PROJECT_DIR}/.claude/hooks/block-destructive.sh"}' \
  "$SHT/.claude/settings.json" > "$SHT/.claude/s.j" && mv "$SHT/.claude/s.j" "$SHT/.claude/settings.json"
chmod 644 "$SHT/.claude/hooks/block-destructive.sh"
V6B=$("$HARNESS" $HARNESS_CMD verify "$SHT" --json 2>&1)
printf '%s' "$V6B" | jq -r '.checks[] | select(.name == "hooks-executable") | .detail' \
  | grep -q 'block-destructive.sh(mode -rw-r--r--, not executable)' \
  && ok || bad "a SHELL-form hook at mode 644 must still be named with its mode — that is every repo deployed before the exec-form migration; got: $(printf '%s' "$V6B" | jq -r '.checks[] | select(.name == "hooks-executable") | .detail')"
rm -rf "$SHT"

# --- 8. a missing roster script ---------------------------------------
# A schema, not a noun module: the roster is the payload walk, and what it
# carries changed when the noun modules stopped being files. Any roster entry
# proves the check; a schema is one nothing else in this suite moves.
mv "$TARGET/.claude/schemas/task.schema.json" "$SANDBOX/task.schema.json.parked"
V7=$("$HARNESS" $HARNESS_CMD verify "$TARGET" --json 2>&1); RCV7=$?
[ $RCV7 -ne 0 ] && ok || bad "verify must fail when a roster file is absent from the target"
printf '%s' "$V7" | jq -r '.checks[] | select(.name == "scripts-roster") | .detail' | grep -q 'task.schema.json' \
  && ok || bad "the scripts-roster failure must name the missing file; got: $V7"
mv "$SANDBOX/task.schema.json.parked" "$TARGET/.claude/schemas/task.schema.json"

# --- 8b. a hook pointing at a file deploy no longer ships -------------
# Deploy does not merge an existing settings.json (deliberate), but it
# DOES prune payload files it no longer ships. So a rename upstream can
# leave a repo whose hook chains deploy itself just broke: the command
# names a file that is gone, every event on that chain fails silently,
# and the repo looks entirely normal from the inside. verify catches it;
# deploy has to as well, because deploy is what caused it and the
# operator is standing right there.
DHT="$SANDBOX/deadhook"; mkdir -p "$DHT/.claude"
cp "$ROOT/.deploy-claude/settings.json" "$DHT/.claude/settings.json"
# THE PATH MOVED FROM .command TO .args[0], and this line has to move with
# it. The SessionStart chain is EXEC form now — `node` plus the script — so
# `.command` is the word "node" and repointing THAT would test whether an
# executable named `gone-in-a-rename` is on PATH, which is a different
# question with a different answer. `.args[0]` is where the file a deploy
# can prune actually lives.
jq '.hooks.SessionStart[0].hooks[0].args[0] = "${CLAUDE_PROJECT_DIR}/.claude/scripts/gone-in-a-rename"' \
  "$DHT/.claude/settings.json" > "$DHT/.claude/s.j" && mv "$DHT/.claude/s.j" "$DHT/.claude/settings.json"
DHO=$("$HARNESS" $HARNESS_CMD deploy "$DHT" --json 2>&1); DHRC=$?
[ $DHRC -ne 0 ] && ok || bad "deploy must FAIL a target whose settings name a hook file that is not there — the chain is dead and the repo looks normal from the inside"
printf '%s' "$DHO" | jq -e 'any(.checks[]; .name == "settings-hook-commands" and .ok == false)' >/dev/null 2>&1 \
  && ok || bad "deploy must name settings-hook-commands as the failing check; got: $(printf '%s' "$DHO" | jq -c '[.checks[].name]' 2>/dev/null)"
printf '%s' "$DHO" | jq -r '.checks[] | select(.name == "settings-hook-commands") | .detail' | grep -q 'gone-in-a-rename' \
  && ok || bad "the failure must NAME the missing file, or the operator has to go looking"
printf '%s' "$DHO" | jq -r '.checks[] | select(.name == "settings-hook-commands") | .detail' | grep -q 'rm ' \
  && ok || bad "the failure must name the remedy — deploy never rewrites a repo's own settings, so it owes an exact instruction instead"
# ...and a target that took the current settings verbatim passes it
rm -f "$DHT/.claude/settings.json"
DHO2=$("$HARNESS" $HARNESS_CMD deploy "$DHT" --json 2>&1)
printf '%s' "$DHO2" | jq -e 'any(.checks[]; .name == "settings-hook-commands" and .ok == true)' >/dev/null 2>&1 \
  && ok || bad "a target with the current settings must pass settings-hook-commands"

# --- 8c. source_commit survives a RELAYED deploy (the app's finding) --
# Deploying FROM a repo that is itself a deployment works, and is a
# reasonable thing to do on a machine with no harness clone. It used to
# stamp that repo's own HEAD as source_commit — a coursework commit
# recorded as the harness version, with the real harness identity thrown
# away one hop from where it was needed, while the relaying repo's own
# manifest held it correctly all along.
RLY="$SANDBOX/relay"; mkdir -p "$RLY"
"$HARNESS" $HARNESS_CMD deploy "$RLY" >/dev/null 2>&1
HARNESS_COMMIT=$(jq -r '.source_commit' "$RLY/.claude/DEPLOYED")
(cd "$RLY" && git init -q && git add -A >/dev/null 2>&1 \
  && git -c user.name=t -c user.email=t@t commit -qm relay >/dev/null 2>&1)
RLY2="$SANDBOX/relay2"; mkdir -p "$RLY2"
"$RLY/.claude/scripts/scrumux" harness deploy "$RLY2" >/dev/null 2>&1
RC1=$(jq -r '.source_commit' "$RLY2/.claude/DEPLOYED" 2>/dev/null)
[ "$RC1" = "$HARNESS_COMMIT" ] \
  && ok || bad "a relayed deploy must keep the HARNESS commit as source_commit — a consumer renders it as the harness version, so the relaying repo's own HEAD is not an answer. got '$RC1', want '$HARNESS_COMMIT'"
RLYHEAD=$(git -C "$RLY" rev-parse HEAD 2>/dev/null)
[ "$(jq -r '.deployed_from.head // ""' "$RLY2/.claude/DEPLOYED" 2>/dev/null)" = "$RLYHEAD" ] \
  && ok || bad "the relay itself must still be recorded, under deployed_from — dropping it would lose which copy the payload actually came through"
[ "$(jq -r '.deployed_from // "null"' "$RLY/.claude/DEPLOYED")" = "null" ] \
  && ok || bad "a DIRECT deploy from the harness must carry no deployed_from — there was no relay"

# --- 9. THE ROOT-PLACEMENT CASE ---------------------------------------
# Move settings.json one directory down. The repo now looks completely
# normal from the inside — the file exists, every hook it names exists
# and is executable, every script is in place — and every hook chain in
# it is DEAD, because Claude Code resolved the project settings at
# launch from the launch root and `cd` never re-resolves them. This is
# the one thing a session cannot observe about itself.
mkdir -p "$TARGET/sub/.claude"
mv "$TARGET/.claude/settings.json" "$TARGET/sub/.claude/settings.json"
V8=$("$HARNESS" $HARNESS_CMD verify "$TARGET" 2>&1); RCV8=$?
[ $RCV8 -ne 0 ] && ok || bad "verify MUST fail when settings.json is not at the repo root — that file is silently inert and every hook chain in it is dead"
printf '%s' "$V8" | grep -q 'settings-at-root' \
  && ok || bad "verify's failure must NAME the root-placement check; got: $V8"
printf '%s' "$V8" | grep -q 'sub/.claude/settings.json' \
  && ok || bad "verify must name WHERE the misplaced settings.json actually is; got: $V8"
printf '%s' "$V8" | grep -qi 'inert' \
  && ok || bad "verify must explain that a settings.json off the launch root is inert, not merely absent"
V8J=$("$HARNESS" $HARNESS_CMD verify "$TARGET" --json 2>&1)
printf '%s' "$V8J" | jq -e '.ok == false and any(.checks[]; .name == "settings-at-root" and .ok == false)' >/dev/null 2>&1 \
  && ok || bad "verify --json must report ok:false with settings-at-root failing; got: $V8J"
[ "$(printf '%s\n' "$V8J" | jq -s 'length' 2>/dev/null)" = "1" ] \
  && ok || bad "verify --json must emit exactly one object even on failure — the app must never parse prose"

# ...and putting it back makes the repo live again
mv "$TARGET/sub/.claude/settings.json" "$TARGET/.claude/settings.json"
"$HARNESS" $HARNESS_CMD verify "$TARGET" --json >/dev/null 2>&1 \
  && ok || bad "verify must go green again once settings.json is back at the repo root"

# --- deploy prunes, verify reports orphans (I-0143) -------------------
# deploy only ever added and overwrote, so a renamed or dropped payload
# file left an executable copy in every target forever. gov -> scrumux
# made it concrete: an 84KB runnable `gov` sat in a live deployment while
# verify reported 9/9, because machinery-drift walks the manifest and an
# orphan is by definition not in it.
PRUNE_T="$SANDBOX/prune"; mkdir -p "$PRUNE_T"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$PRUNE_T" >/dev/null 2>&1
printf '#!/bin/sh\necho stale\n' > "$ROOT/.deploy-claude/scripts/zz-prune-probe"
chmod +x "$ROOT/.deploy-claude/scripts/zz-prune-probe"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$PRUNE_T" >/dev/null 2>&1
[ -f "$PRUNE_T/.claude/scripts/zz-prune-probe" ] \
  && ok || bad "the probe file did not install, so the prune case below would pass for the wrong reason"
rm -f "$ROOT/.deploy-claude/scripts/zz-prune-probe"
PRUNE_OUT=$("$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$PRUNE_T" 2>&1)
[ ! -f "$PRUNE_T/.claude/scripts/zz-prune-probe" ] \
  && ok || bad "deploy must REMOVE a target file the previous manifest claimed and the payload no longer ships"
printf '%s' "$PRUNE_OUT" | grep -q 'REMOVED' \
  && ok || bad "deploy must SAY what it removed — a silent delete of an executable is not something an installer should do quietly"

# A file the repo put there itself is never in the manifest and must
# never be pruned.
mkdir -p "$PRUNE_T/scripts"
printf 'theirs\n' > "$PRUNE_T/scripts/their-own.sh"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$PRUNE_T" >/dev/null 2>&1
[ -f "$PRUNE_T/scripts/their-own.sh" ] \
  && ok || bad "deploy pruned a file it never installed — it may only remove what a previous manifest claims"

# verify catches what the prune cannot: an orphan created before the
# prune existed, or by any other route.
printf '#!/bin/sh\necho orphan\n' > "$PRUNE_T/.claude/scripts/zz-orphan"
chmod +x "$PRUNE_T/.claude/scripts/zz-orphan"
VOUT=$("$ROOT/.deploy-claude/scripts/scrumux" harness verify "$PRUNE_T" 2>&1); VRC=$?
[ "$VRC" -ne 0 ] && ok || bad "verify must FAIL on unclaimed machinery — a stale command that still runs is worse than one that is absent"
printf '%s' "$VOUT" | grep -q 'machinery-orphans' \
  && ok || bad "verify must name the orphan check so the fix is obvious"
rm -f "$PRUNE_T/.claude/scripts/zz-orphan"
"$ROOT/.deploy-claude/scripts/scrumux" harness verify "$PRUNE_T" >/dev/null 2>&1 \
  && ok || bad "verify must pass again once the orphan is gone"

# --- the prune must never eat a SEEDED file (I-0143 vs T-0203) --------
# Two lanes contradicted each other and the prune won. The seeding lane
# creates .claude/rules/project-standards.md and .claude/project-walls.conf
# once and promises, in the words it prints and in the target's own
# CLAUDE.md, that an update never overwrites them. The prune deletes any
# path the PREVIOUS manifest names that the current payload.list lacks.
# An older harness SHIPPED project-standards.md as payload, before the
# seeding lane existed, so every long-lived target's manifest still
# claims it — and the next deploy deleted the repo's own standards.
# Observed 2026-08-30 in ~/tools/scrumux-agents, both lines in ONE run:
#   UNCHANGED .claude/rules/project-standards.md — kept — a repo's own
#             standards are never overwritten
#   REMOVED   .claude/rules/project-standards.md — no longer part of the
#             payload
SEED_T="$SANDBOX/seedprune"; mkdir -p "$SEED_T"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$SEED_T" >/dev/null 2>&1
printf '# this repo wrote its own standards\n' > "$SEED_T/.claude/rules/project-standards.md"
printf 'refuse zzz-probe | this repo wrote its own walls\n' > "$SEED_T/.claude/project-walls.conf"
# The manifest an old harness left behind: it claims both seeded paths as
# payload, which is exactly what a long-lived target still carries today.
jq '.files[".claude/rules/project-standards.md"]="stale" | .files[".claude/project-walls.conf"]="stale"' \
  "$SEED_T/.claude/DEPLOYED" > "$SANDBOX/seed.DEPLOYED" \
  && mv "$SANDBOX/seed.DEPLOYED" "$SEED_T/.claude/DEPLOYED" \
  || bad "could not stage an old manifest claiming the seeded paths — the cases below would pass for the wrong reason"
SEED_OUT=$("$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$SEED_T" 2>&1)
grep -q 'wrote its own standards' "$SEED_T/.claude/rules/project-standards.md" 2>/dev/null \
  && ok || bad "deploy DESTROYED .claude/rules/project-standards.md because a previous manifest claimed it — the seeding lane's whole promise is that a repo's own standards survive every update, so the prune must never remove a path that lane seeds"
grep -q 'wrote its own walls' "$SEED_T/.claude/project-walls.conf" 2>/dev/null \
  && ok || bad "deploy DESTROYED .claude/project-walls.conf because a previous manifest claimed it — the walls lane makes the same never-overwritten promise as the standards lane and needs the same protection"
printf '%s' "$SEED_OUT" | grep -q 'KEPT .*\.claude/rules/project-standards\.md' \
  && ok || bad "deploy must SAY it kept a repo-owned file the old manifest claims — a silent not-prune is indistinguishable from the bug never having existed, and the operator needs to see why the path left the manifest"
jq -e '.files | has(".claude/rules/project-standards.md")' "$SEED_T/.claude/DEPLOYED" >/dev/null 2>&1 \
  && bad "the NEW manifest still claims .claude/rules/project-standards.md — the next deploy would reconsider pruning it on every run; a kept path must leave the manifest so there is nothing left to reconsider" || ok
jq -e '.files | has(".claude/project-walls.conf")' "$SEED_T/.claude/DEPLOYED" >/dev/null 2>&1 \
  && bad "the NEW manifest still claims .claude/project-walls.conf — same reason: a repo-owned path must not be carried forward as payload" || ok
# ...and the deploy after it is a plain no-op: nothing left to keep.
SEED_OUT2=$("$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$SEED_T" 2>&1)
grep -q 'wrote its own standards' "$SEED_T/.claude/rules/project-standards.md" 2>/dev/null \
  && ok || bad "the SECOND deploy, against a manifest this installer wrote itself, still destroyed the repo's own standards"
printf '%s' "$SEED_OUT2" | grep -q 'KEPT' \
  && bad "deploy reported KEPT on a run whose previous manifest claims no seeded path — the line must appear only when there was something to reconsider, or it becomes noise on every deploy" || ok

# --- deploy ignores the GENERATED views (SP-0006) ---------------------
# `scrumux views render` writes AI_LOG.MD, DECISIONS.MD and BACKLOG.MD
# into the repo ROOT. This repo ignores all three; a target got no such
# line, so running a report left three untracked files and the tree read
# as dirty to anything that asks git. The SP-0006 operator's accept was
# REFUSED by the Control app's delivery check — "uncommitted changes,
# nothing merged" — right after a views render that changed no code.
GI_T="$SANDBOX/gitignore"; mkdir -p "$GI_T"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$GI_T" >/dev/null 2>&1
for _v in AI_LOG.MD DECISIONS.MD BACKLOG.MD governance/governance-graph.json; do
  grep -qE "^/?$_v[[:space:]]*$" "$GI_T/.gitignore" 2>/dev/null \
    && ok || bad "deploy left $_v out of the target's .gitignore — scrumux views render writes it, and an untracked generated view reads as an uncommitted change to every delivery check"
done
# The boundary: projections are ignored, RECORDS are the target's to
# commit. seals.json is read by records check, not rendered from anything.
grep -qE '^/?governance/seals\.json[[:space:]]*$' "$GI_T/.gitignore" 2>/dev/null \
  && bad "deploy ignored governance/seals.json — that is a record records-check reads, not a generated view, and whether a target commits its governance record is the target's call" || ok
GI_BEFORE=$(shasum -a 256 "$GI_T/.gitignore" | awk '{print $1}')
GI_OUT2=$("$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$GI_T" 2>&1)
[ "$(shasum -a 256 "$GI_T/.gitignore" | awk '{print $1}')" = "$GI_BEFORE" ] \
  && ok || bad "a second deploy changed the target's .gitignore — the lane is append-if-absent, so a redeploy must add nothing at all; appending on every run would grow the file forever"
printf '%s' "$GI_OUT2" | grep -q 'UNCHANGED .gitignore' \
  && ok || bad "a redeploy must report .gitignore as UNCHANGED — an item that claims to have written something it did not makes 'nothing changed' false"

# A .gitignore the repo already wrote is APPENDED to, never rewritten.
GI_T2="$SANDBOX/gitignore-own"; mkdir -p "$GI_T2"
printf 'node_modules/\n.env\n' > "$GI_T2/.gitignore"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$GI_T2" >/dev/null 2>&1
grep -qxF 'node_modules/' "$GI_T2/.gitignore" && grep -qxF '.env' "$GI_T2/.gitignore" \
  && ok || bad "deploy REPLACED the target's own .gitignore — a repo's ignore file is the repo's; this lane may only append"
grep -qxF 'AI_LOG.MD' "$GI_T2/.gitignore" \
  && ok || bad "deploy did not append the view ignores to a .gitignore that already existed"

# ...and a file whose last byte is not a newline must not get the first
# appended line welded onto its last one.
GI_T3="$SANDBOX/gitignore-nonl"; mkdir -p "$GI_T3"
printf 'node_modules/' > "$GI_T3/.gitignore"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$GI_T3" >/dev/null 2>&1
grep -qxF 'node_modules/' "$GI_T3/.gitignore" \
  && ok || bad "deploy welded its first appended line onto a .gitignore with no trailing newline — the target's last pattern silently stopped being a pattern"

# A near-miss must NOT count as already-ignored: the presence check goes
# into an ERE, and an unescaped dot would read AI_LOGxMD as a match and
# silently skip the line it was supposed to add.
GI_T5="$SANDBOX/gitignore-nearmiss"; mkdir -p "$GI_T5"
printf 'AI_LOGxMD\n' > "$GI_T5/.gitignore"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$GI_T5" >/dev/null 2>&1
grep -qxF 'AI_LOG.MD' "$GI_T5/.gitignore" \
  && ok || bad "a line reading AI_LOGxMD was accepted as already ignoring AI_LOG.MD — the dots in the pattern are not escaped, so the lane skipped a line it had to add and the tree stays dirty"

# A repo that already ignores them its own way is left alone.
GI_T4="$SANDBOX/gitignore-theirs"; mkdir -p "$GI_T4"
printf '/AI_LOG.MD\n/DECISIONS.MD\n/BACKLOG.MD\n/governance/governance-graph.json\n' > "$GI_T4/.gitignore"
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$GI_T4" >/dev/null 2>&1
[ "$(grep -c 'AI_LOG.MD' "$GI_T4/.gitignore")" = 1 ] \
  && ok || bad "deploy added a second ignore line for a view the target already ignored its own way (/AI_LOG.MD) — the presence check must accept the anchored form git also honours"

printf 'harness-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "harness-tests: error: $FAIL case(s) wrong — fix .claude/scripts/scrumux harness before trusting 'the harness is deployed here' as a statement about any repo" >&2
  exit 1
fi
exit 0
