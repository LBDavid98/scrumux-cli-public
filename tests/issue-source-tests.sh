#!/bin/sh
# issue-source-tests.sh — T-0130: issue.source is a closed vocabulary.
#
# It was typed as any non-empty string and drifted into sentences:
# 'issue-validator sweep 2026-08-20, found while disproving I-0071',
# 'T-0122 re-verification on the real T-0100 diff', 'human (User
# clear-cost question)'. source is the only handle on WHO raises what,
# which is the dimension the gate telemetry (T-0132/T-0134) needs, so
# prose there makes the data unusable for the thing it is collected for.
# Run: sh tests/issue-source-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
SCHEMA="$ROOT/.deploy-claude/schemas/issue.schema.json"
SANDBOX=$(mktemp -d) || { echo "issue-source-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- 1. an off-enum source is refused, and names the valid list --------
OUT=$("$GOVCMD" issue new --type defect --source "a sentence about a thing" --summary S --fix F 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok || bad "prose was accepted as a source — the enum is not in force"
printf '%s' "$OUT" | grep -q 'closed vocabulary' && ok || bad "the refusal does not explain what source is: $OUT"
printf '%s' "$OUT" | grep -q 'issue-validator' && ok || bad "the refusal does not print the valid values: $OUT"
[ ! -f "$SANDBOX/governance/issues.json" ] || \
  jq -e '[.entries[] | select(.summary=="S")] | length == 0' "$SANDBOX/governance/issues.json" >/dev/null 2>&1 \
  && ok || bad "a refused issue still wrote a row"

# --- 2. an on-enum source succeeds ------------------------------------
"$GOVCMD" issue new --type defect --source issue-validator --summary "on enum" --fix F >/dev/null 2>&1 \
  && ok || bad "a valid enum source was refused"
jq -e '[.entries[] | select(.source=="issue-validator")] | length == 1' \
  "$SANDBOX/governance/issues.json" >/dev/null 2>&1 && ok || bad "the accepted issue did not record its source"

# --- 3. every source in the LIVE journal is an enum member ------------
# The migration is only real if it holds against the real data.
BAD=$(jq -r --slurpfile sc "$SCHEMA" \
  '[.entries[].source] | unique - $sc[0].properties.source.enum | join(", ")' \
  "$ROOT/governance/issues.json")
[ -z "$BAD" ] && ok || bad "live issues carry sources outside the enum: $BAD"

# --- 4. the schema enum and scrumux's own guard cannot drift apart --------
# Two lists of the same vocabulary in two files is exactly the shape that
# rots; this asserts they are the same set, in both directions.
# The guard lives in the issue MODULE, which is where the flag it guards is
# parsed — `src/nouns/issue.ts` since the bash CLI was retired. The list is
# still one place and still literal, so both directions below are the same
# two directions they always were.
ISSUE_SRC="$ROOT/src/nouns/issue.ts"
for v in $(jq -r '.properties.source.enum[]' "$SCHEMA"); do
  grep -q -- "$v" "$ISSUE_SRC" \
    || bad "schema enum value '$v' is not in scrumux's --source guard — the two lists have drifted"
done
ok
GUARD=$(sed -n "/^const SOURCES = \[/,/^\] as const;/p" "$ISSUE_SRC" | grep -o "'[A-Za-z][A-Za-z-]*'" | tr -d "'")
for v in $GUARD; do
  jq -e --arg v "$v" '.properties.source.enum | index($v) != null' "$SCHEMA" >/dev/null 2>&1 \
    || bad "scrumux accepts source '$v' which the schema enum does not list — a record scrumux writes would fail schema-check"
done
ok

printf 'issue-source-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "issue-source-tests: error: $FAIL case(s) wrong — issue.source has drifted back toward prose, or scrumux and the schema disagree about the vocabulary (T-0130)" >&2; exit 1; }
