#!/bin/sh
# journal-shape-tests.sh — T-0157/I-0035: one journal shape.
#
# while the other nine were {entries}. lib.sh:52-60 recorded the cost in
# its own comment: write_json could assert only `type == object`, because
# has("entries") "would break two of eleven". A filter that produced a
# valid object with no entries array therefore passed the guard and
# silently discarded the journal. Both outliers are migrated, so the
# stronger guard is now available and this suite is what keeps it true.
# Run: sh tests/journal-shape-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOV="$ROOT/governance"
SANDBOX=$(mktemp -d) || { echo "journal-shape-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- 1. every governance journal is {entries:[...]} --------------------
# Derived artifacts are excluded by name and for a reason: the two graphs
# are generated indexes, and seals.json is the seal map itself.
for f in "$GOV"/*.json; do
  b=${f##*/}
  # An unmatched glob is the LITERAL pattern, and there is nothing to match
  # on a clone: governance/*.json is gitignored, so a checkout that is not
  # the author's has no journals here at all. Asserting the shape of a file
  # named `*.json` is a failure about the absence of a diary, not about a
  # journal that forked.
  [ -e "$f" ] || continue
  case "$b" in code-graph.json|governance-graph.json|seals.json) continue;; esac
  if jq -e 'type == "object" and has("entries") and (.entries | type == "array")' "$f" >/dev/null 2>&1; then
    ok
  else
    bad "$b is not {entries:[...]} — every governance journal must share one shape (I-0035)"
  fi
done

# --- 2. the two migrated journals kept their rows ----------------------
# "KEPT ITS ROWS" IS A CLAIM ABOUT THIS REPO'S OWN REGISTERED CHECKS, and
# those live in a gitignored journal. On a clone there is no repo-health.json
# to have kept anything, and both assertions read as a migration that lost
# data — which is what they reported on every parity lane of the first CI run
# (2026-09-02). Conditional, and the skip is printed: the migration is a fact
# about the authoring checkout and is asserted there.
if [ -f "$GOV/repo-health.json" ]; then
  jq -e '[.entries[] | select(.name and .command)] | length > 0' "$GOV/repo-health.json" >/dev/null 2>&1 && ok \
    || bad "repo-health.json lost its check rows in the migration"
  jq -e 'has("checks") | not' "$GOV/repo-health.json" >/dev/null 2>&1 && ok \
    || bad "repo-health.json still carries the old checks key"
else
  printf 'SKIP: governance/repo-health.json is not in this checkout (gitignored — the working record does not travel), so the I-0035 migration assertions could not run here.\n'
fi

# --- 3. write_json REFUSES output with no entries array ----------------
# This is the guard the migration buys. A filter that returns a valid
# object without entries is a filter that has thrown the journal away.
# Driven through `repair journal`, which is the one sanctioned surface that
# hands a caller's jq filter to the journal writer. It used to be a probe that
# sourced `lib.sh` and called `write_json` directly; the writer is
# `src/journal/write.ts` now and has no shell entry point, so the guard is
# exercised where an operator can actually reach it.
mkdir -p "$SANDBOX/root/governance"
printf '{"entries":[{"id":"X-0001"}]}\n' > "$SANDBOX/root/governance/j.json"
out=$(GOV_ROOT="$SANDBOX/root" "$ROOT/.deploy-claude/scripts/scrumux" repair journal j.json \
        --apply '{other: .entries}' --why 'the T-0157 guard' --by tests 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok || bad "the writer accepted an object with no entries array — the T-0157 guard is not in force"
printf '%s' "$out" | grep -q 'entries' && ok \
  || bad "the refusal does not mention the entries contract: $out"
jq -e '.entries[0].id == "X-0001"' "$SANDBOX/root/governance/j.json" >/dev/null 2>&1 && ok \
  || bad "the refused write still damaged the journal — the guard must fire BEFORE the mv"

# --- 4. the schema contract is actually read now -----------------------
# repo-health.json could not be listed in schema-check's PAIRS before the
# migration: schema_check.py returns "no entries array" for anything else,
# so the schema existed and nothing consulted it.
grep -q "'repo-health.json'" "$ROOT/src/schema/check.ts" && ok \
  || bad "repo-health.json is not in schema-check PAIRS — the schema is still read by nothing"
jq -e '.title == "RepoHealthCheck" and (.properties | has("command"))' \
  "$ROOT/.deploy-claude/schemas/repo-health.schema.json" >/dev/null 2>&1 && ok \
  || bad "repo-health.schema.json does not describe ONE check row; every other schema describes one record"

printf 'journal-shape-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "journal-shape-tests: error: $FAIL case(s) wrong — the journals have forked again, or write_json's entries guard is not in force (I-0035/T-0157)" >&2; exit 1; }
