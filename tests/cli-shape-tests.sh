#!/bin/sh
# cli-shape-tests.sh — the consolidation's own contract, asserted across
# the WHOLE surface rather than one noun at a time.
#
# The point of collapsing eleven scripts into `scrumux <noun> <verb>` was
# never the rename. It was that the cross-cutting concerns — the --json
# envelope, the exit rule, the error shape, the result vocabulary — get
# written ONCE instead of eleven times. This suite is what makes that
# claim checkable: if a noun ever grows its own envelope or its own exit
# rule, these cases go red.
#
# Run: sh tests/cli-shape-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
S="$ROOT/.deploy-claude/scripts/scrumux"
SRCN="$ROOT/src/nouns"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

SANDBOX=$(mktemp -d) || { echo "cli-shape-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/governance"
cp "$ROOT"/governance/*.json "$SANDBOX/governance/" 2>/dev/null || :
# THE COPY ABOVE COPIES NOTHING ON A CLONE. governance/*.json is gitignored
# — the working record does not travel — so on CI the sandbox is empty, and
# an empty sandbox is a different question from an empty journal. Section
# 3's `task lint T-9999` means "the named task is not there" (exit 1, the
# assertion did not hold); with no tasks.json at all the CLI correctly says
# "could not run" (exit 2) and the case reported the exit rule as broken.
# Minted, not copied: the seed is the same on every machine, and it says out
# loud what the case needs rather than inheriting it from whoever ran it.
[ -f "$SANDBOX/governance/tasks.json" ] || printf '{"entries":[]}\n' > "$SANDBOX/governance/tasks.json"

# ---------------------------------------------------------------------
# 1. THE MODULE SEAM
# ---------------------------------------------------------------------
# A noun module declares exactly one export and the dispatcher reaches it
# by no other name. It was three shell functions in `lib/cmd-<noun>.sh`
# (`<noun>_verbs`, `<noun>_usage`, `<noun>_run`) enforced by a check
# because sh has no modules; it is `export const MODULE: NounModule` in
# `src/nouns/<noun>.ts` now, with the same three members behind it. The
# language checks the SHAPE; what it cannot check is that the registry and
# the tree agree about which nouns exist, which is what this section is for.
NOUNS=$("$S" help | sed -n 's/^  \([a-z][a-z]*\) .*/\1/p')
[ -n "$NOUNS" ] && ok || bad "scrumux help lists no nouns — the registry is unreadable"

for n in $NOUNS; do
  f="$SRCN/$n.ts"
  [ -f "$f" ] || { bad "noun '$n' is in the registry with no module at $f"; continue; }
  grep -q '^export const MODULE' "$f" \
    && ok || bad "src/nouns/$n.ts does not export MODULE — the dispatcher reaches every noun through that one name"
done

# ...and the reverse: a module on disk that no registry line names is a
# noun nobody can reach.
for f in "$SRCN"/*.ts; do
  b=$(basename "$f"); n=${b%.ts}
  grep -q '^export const MODULE' "$f" || continue
  printf '%s\n' "$NOUNS" | grep -qx "$n" \
    && ok || bad "src/nouns/$b exports MODULE for a noun the registry does not list — it is unreachable"
done

# ---------------------------------------------------------------------
# 2. THE ENVELOPE
# ---------------------------------------------------------------------
# Every subcommand takes --json and emits EXACTLY ONE object carrying a
# boolean, an exit code and a per-check array. Report commands carry
# their content in .data and leave .checks empty; assertion commands fill
# .checks. Both use the same envelope, which is the whole point.
#
# One cheap, bounded, NON-MUTATING invocation per noun. Anything that
# writes a journal is excluded on purpose: this suite must be runnable
# against the live repo without leaving a record behind.
CASES="status session
status sprint
status sweep
backlog tasks
backlog features
records check
session check
graph gov stats
graph code stats
graph code find repo_root
secret list
harness verify ."

envelope_case() { # envelope_case <argv...>
  _desc="$*"
  _out=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" "$@" --json 2>/dev/null)

  # exactly one JSON value on stdout, and it parses
  if [ "$(printf '%s' "$_out" | jq -s 'length' 2>/dev/null)" = "1" ]; then ok
  else bad "$_desc --json must emit exactly one parseable object; got: $(printf '%s' "$_out" | head -3)"; return; fi

  printf '%s' "$_out" | jq -e '
      (.schema == "scrumux.cli/1")
      and (.command | type == "string")
      and (.argv | type == "array")
      and (.ok | type == "boolean")
      and (.exit | type == "number")
      and (.summary | type == "string")
      and (.checks | type == "array")
      and (.data | type == "object")' >/dev/null 2>&1 \
    && ok || bad "$_desc --json is missing a required envelope field or has the wrong type: $(printf '%s' "$_out" | jq -c 'del(.data, .checks)' 2>/dev/null)"

  # THE EXIT RULE HAS THREE VALUES, AND THIS FUNCTION USED TO KNOW TWO.
  # Section 3 below states it: 0 held, 1 did not hold, 2 COULD NOT RUN. The
  # two derivations that follow — ok from the fail rows, exit from ok — are
  # the contract for a command that ran. A command that could not run has no
  # rows to derive ok from and does not exit 1, and section 4 already writes
  # down what it owes instead. Encoding only {0,1} here was not a stricter
  # rule, it was an INCOMPLETE one: it happened to hold on a checkout where
  # every case in CASES could answer, and on a fresh clone (no gitignored
  # governance/, so no code-graph.json) `graph code stats` and `graph code
  # find` refuse correctly and were reported as three envelope violations
  # each. Six of the seven reds this suite showed in the first CI run
  # (2026-09-02) were this, and the code was right every time.
  #
  # So: route on the exit code, and assert a FULL envelope on both branches.
  # Nothing is skipped and nothing is waved through — a refusal here owes
  # exactly what section 4 makes every refusal owe.
  _ran=1
  [ "$(printf '%s' "$_out" | jq -r '.exit' 2>/dev/null)" = "2" ] && _ran=0

  if [ "$_ran" -eq 1 ]; then
    # ok is DERIVED from the rows, never asserted independently
    printf '%s' "$_out" | jq -e '.ok == ([.checks[] | select(.tier == "fail")] | length == 0)' >/dev/null 2>&1 \
      && ok || bad "$_desc: .ok disagrees with its own fail rows — ok must be derivable, or a consumer has two sources of truth"

    # exit is derived from ok, for a run that ran at all
    printf '%s' "$_out" | jq -e '.exit == (if .ok then 0 else 1 end)' >/dev/null 2>&1 \
      && ok || bad "$_desc: .exit disagrees with .ok"
  else
    # A COMMAND THAT COULD NOT RUN OWES THE REFUSAL ENVELOPE INSTEAD, and it
    # owes it in full — this branch asserts everything section 4 asserts of a
    # refusal, in the same two assertions the branch above spends.
    printf '%s' "$_out" | jq -e '.ok == false and (.checks | length) == 0' >/dev/null 2>&1 \
      && ok || bad "$_desc: exit 2 says nothing was asserted either way, so it owes ok:false and no check rows; got: $(printf '%s' "$_out" | jq -c '{ok, exit, checks}' 2>/dev/null)"
    printf '%s' "$_out" | jq -e '(.error.kind | IN("usage","refused")) and (.error.message | length > 0)' >/dev/null 2>&1 \
      && ok || bad "$_desc: a refusal owes a typed error with a message; got: $(printf '%s' "$_out" | jq -c 'del(.data, .checks)' 2>/dev/null)"
  fi

  # the tier vocabulary is closed, and a row's ok is (tier != fail), so a
  # consumer written against the old {name, ok, detail} rows still works
  printf '%s' "$_out" | jq -e '
      [.checks[] | select((.tier | IN("pass","fail","warn","tell","note")) | not)] | length == 0' >/dev/null 2>&1 \
    && ok || bad "$_desc: a row carries a tier outside pass|fail|warn|tell|note: $(printf '%s' "$_out" | jq -c '[.checks[].tier] | unique')"
  printf '%s' "$_out" | jq -e '[.checks[] | select(.ok != (.tier != "fail"))] | length == 0' >/dev/null 2>&1 \
    && ok || bad "$_desc: a row's .ok is not (tier != \"fail\") — the two encodings have drifted"

  # ADVISORIES NEVER MOVE THE VERDICT. This is D-0072 boundary 7 and
  # T-0144 made mechanical, and it is the assertion most worth having:
  # every previous attempt at it lived in one script at a time.
  # `_ran` again: "no fail row therefore ok and exit 0" is a statement about
  # a command that RAN. A refusal has no rows because it asserted nothing,
  # not because everything held, and reading it through this rule reports a
  # correct exit 2 as an advisory that moved the verdict.
  printf '%s' "$_out" | jq -e --argjson ran "$_ran" '
      if $ran == 1 and ([.checks[] | select(.tier == "fail")] | length) == 0
      then .ok == true and .exit == 0 else true end' >/dev/null 2>&1 \
    && ok || bad "$_desc: warns/tells moved the verdict — an advisory must never change the exit code"
}

OLDIFS=$IFS
IFS='
'
for c in $CASES; do
  IFS=$OLDIFS
  # shellcheck disable=SC2086
  envelope_case $c
  IFS='
'
done
IFS=$OLDIFS

# The exit CODE the process returns must equal the .exit the object
# carries. A caller that reads one and trusts the other is the failure
# this pair exists to prevent.
for c in "records check" "session check" "status session"; do
  # shellcheck disable=SC2086
  OUT=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" $c --json 2>/dev/null); RC=$?
  JRC=$(printf '%s' "$OUT" | jq -r '.exit' 2>/dev/null)
  [ "$RC" = "$JRC" ] && ok || bad "scrumux $c: process exit $RC but the object says exit $JRC"
done

# ---------------------------------------------------------------------
# 3. THE EXIT RULE
# ---------------------------------------------------------------------
#   0  the assertion held / the report was produced
#   1  the assertion did NOT hold
#   2  the command could not run — nothing was asserted either way
(cd "$ROOT" && "$S" status session >/dev/null 2>&1); [ $? -eq 0 ] \
  && ok || bad "a report that was produced must exit 0"

(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" task lint T-9999 >/dev/null 2>&1); [ $? -eq 1 ] \
  && ok || bad "an assertion that did not hold must exit 1"

(cd "$ROOT" && "$S" nosuchnoun verb >/dev/null 2>&1); [ $? -eq 2 ] \
  && ok || bad "an unknown noun must exit 2 — the command could not run, and nothing was asserted"
(cd "$ROOT" && "$S" task nosuchverb >/dev/null 2>&1); [ $? -eq 2 ] \
  && ok || bad "an unknown verb must exit 2"
(cd "$ROOT" && "$S" task >/dev/null 2>&1); [ $? -eq 2 ] \
  && ok || bad "a noun with no verb must exit 2 — there are deliberately no default verbs"

# ---------------------------------------------------------------------
# 4. THE REFUSAL SHAPE
# ---------------------------------------------------------------------
# The single biggest gain of the shared layer: a refusal under --json is
# still an OBJECT. Before the consolidation `die` printed prose and
# exited 1 whatever the caller asked for, so a machine consumer had to
# parse English to learn that its call was rejected.
for c in "task lint --bogus-flag" "records check --bogus-mode" "status nosuchverb" "rank set only-one-arg"; do
  # shellcheck disable=SC2086
  OUT=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" $c --json 2>/dev/null); RC=$?
  [ "$RC" -eq 2 ] && ok || bad "scrumux $c: a refusal must exit 2, got $RC"
  [ "$(printf '%s' "$OUT" | jq -s 'length' 2>/dev/null)" = "1" ] \
    && ok || bad "scrumux $c: a refusal under --json must still be exactly one object, not prose: $OUT"
  printf '%s' "$OUT" | jq -e '.ok == false and .exit == 2 and (.error.kind | IN("usage","refused")) and (.error.message | length > 0)' >/dev/null 2>&1 \
    && ok || bad "scrumux $c: the refusal object must carry ok:false, exit:2 and a typed error with a message; got: $OUT"
done

# ...and a refusal in HUMAN mode keeps the error shape the whole repo
# greps for: a problem, and a fix after an em-dash.
OUT=$(cd "$ROOT" && "$S" records check --bogus-mode 2>&1)
printf '%s' "$OUT" | grep -q 'error:' && ok || bad "a human-mode refusal must carry the error: marker; got: $OUT"
printf '%s' "$OUT" | grep -q ' — ' && ok || bad "a human-mode refusal must name the fix after an em-dash; got: $OUT"

# ---------------------------------------------------------------------
# 5. --json IS GLOBAL, NOT PER-NOUN
# ---------------------------------------------------------------------
# It is stripped by the dispatcher from ANYWHERE in argv, because
# `scrumux task lint --json T-1` and `scrumux task lint T-1 --json` are
# the same request, and a surface that accepts one and not the other is a
# surface people get wrong.
A=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" --json graph gov stats 2>/dev/null || true)
B=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" graph --json gov stats 2>/dev/null || true)
C=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$S" graph gov stats --json 2>/dev/null || true)
[ -n "$B" ] && [ "$B" = "$C" ] \
  && ok || bad "--json must be accepted anywhere after the noun: mid-argv gave '$(printf '%s' "$B" | head -c 60)', trailing gave '$(printf '%s' "$C" | head -c 60)'"

# No module may parse --json itself. One place, or it is not one place.
JLEAK=''
for f in "$SRCN"/*.ts; do
  grep -q "case '--json'" "$f" && JLEAK="$JLEAK $(basename "$f")"
done
[ -z "$JLEAK" ] && ok || bad "module(s) parse --json themselves:$JLEAK — the flag is the dispatcher's, and a second parser is a second thing to drift"

# Nor may a module implement its own envelope or its own exit rule.
ELEAK=''
for f in "$SRCN"/*.ts; do
  grep -q "schema: 'scrumux.cli/1'" "$f" && ELEAK="$ELEAK $(basename "$f")"
done
[ -z "$ELEAK" ] && ok || bad "module(s) build the envelope themselves:$ELEAK — src/cli/envelope.ts build() is the only writer of it"

# ---------------------------------------------------------------------
# 6. THE SESSION BRIEF NEVER FAILS
# ---------------------------------------------------------------------
# It is wired to SessionStart, so a nonzero exit there is a failure to
# start work. Asserted here as well as in status-tests because it is a
# property of the SURFACE, not of one script: any future change to the
# shared exit rule has to keep it true.
for g in "$SANDBOX" /nonexistent-cli-shape-probe; do
  (cd "$ROOT" && GOV_ROOT="$g" "$S" status session >/dev/null 2>&1); [ $? -eq 0 ] \
    && ok || bad "status session must exit 0 even with GOV_ROOT=$g — it is injected into every session"
done


# ---------------------------------------------------------------------
# 7. THE FLIP MECHANISM — GONE WITH WHAT IT FLIPPED BETWEEN
# ---------------------------------------------------------------------
# `lib/ts-owns.sh` was the single place a verb changed implementation, and
# this section held its contract: the compiled-in list starts EMPTY, the
# SCRUMUX_IMPL override works in both directions, SCRUMUX_TS_VERBS_OFF beats
# the list with no redeploy, a flip fails BACK when node or the bundle is
# absent, and CLI_TMP is removed before `exec` because exec kills the EXIT
# trap and the temp dir leaks on every invocation.
#
# Every one of those is a statement about a migration between two
# implementations. The cutover filled the list (2026-09-03) and the
# retirement deleted the other implementation, so there is nothing to flip
# between, nothing to fail back to, and no `exec` to leak across. The
# assertions are not repointed anywhere: they had no subject left.

printf 'cli-shape-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || {
  echo "cli-shape-tests: error: $FAIL case(s) wrong — the consolidation's whole claim is that the envelope, the exit rule and the error shape are written ONCE; each failure above is a place where that stopped being true (CLI-CONSOLIDATION.md)" >&2
  exit 1
}
