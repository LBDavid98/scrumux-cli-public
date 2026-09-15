#!/bin/sh
# scrumux-memory-tests.sh — T-0124: scrumux owns the validator memory append.
#
# The issue-validator is read-only by design (D-0007), so its memory only
# persists if the orchestrating session writes it. That was a by-hand
# append instructed in prose by two files, which is precisely the shape
# CLAUDE.MD says to replace with a scrumux command. The append-only contract
# is the load-bearing property: a run that rewrites earlier memory has
# destroyed the thing memory is for.
# Run: sh tests/scrumux-memory-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
SANDBOX=$(mktemp -d) || { echo "scrumux-memory-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"
mkdir -p "$SANDBOX/governance"
MEM="$SANDBOX/governance/validator-memory.md"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

SEED='# Validator memory

## Run 2020-01-01 — seed
existing line that must never move
'
printf '%s' "$SEED" > "$MEM"
BEFORE=$(wc -c < "$MEM" | tr -d ' ')

# --- 1. an append leaves every existing byte exactly where it was ------
printf 'first fact\nsecond fact\n' | "$GOVCMD" memory add --by issue-validator >/dev/null 2>&1 \
  && ok || bad "a valid append was refused"
head -c "$BEFORE" "$MEM" > "$SANDBOX/head"
printf '%s' "$SEED" > "$SANDBOX/seed"
cmp -s "$SANDBOX/head" "$SANDBOX/seed" && ok \
  || bad "the append rewrote bytes that were already there — memory must be append-only"

# --- 2. the block lands last, under a dated heading naming its author --
tail -4 "$MEM" | grep -q 'second fact' && ok || bad "the new block is not at the end"
grep -q "^## Run $(date +%F) — issue-validator\$" "$MEM" && ok \
  || bad "no dated heading naming the author: $(grep '^## Run' "$MEM" | tail -1)"

# --- 3. a second append does not disturb the first --------------------
MID=$(wc -c < "$MEM" | tr -d ' ')
printf 'third fact\n' | "$GOVCMD" memory add --by debugger >/dev/null 2>&1
head -c "$MID" "$MEM" > "$SANDBOX/head2"
cmp -s "$SANDBOX/head2" "$SANDBOX/mid" 2>/dev/null || {
  head -c "$MID" "$MEM" | cmp -s - "$SANDBOX/head2" && ok || bad "second append disturbed the first"
}
grep -c '^## Run' "$MEM" | grep -q '^3$' && ok \
  || bad "expected 3 run headings after two appends, got $(grep -c '^## Run' "$MEM")"
grep -q 'first fact' "$MEM" && ok || bad "the first append's content was lost"

# --- 4. refusals: empty block, missing --by, absent memory file -------
printf '' | "$GOVCMD" memory add --by issue-validator >/dev/null 2>&1 \
  && bad "an empty block was appended — a run with nothing to say is not a run" || ok
printf 'x\n' | "$GOVCMD" memory >/dev/null 2>&1 \
  && bad "--by is not required, so a block can land with no author" || ok

# --- 4b. an ABSENT memory file is created on first use (D-0089) -------
# REVERSED 2026-08-31. This block used to assert the opposite: that
# `memory add` refused a nonexistent file and "must not create one". The
# code comment behind that refusal called itself deliberate; User ruled
# that a comment asserting deliberateness is not a ruling, and there was
# none behind this one. The effect was that `harness deploy` seeds no
# validator-memory.md and the verb refuses to make one, so the memory noun
# was unreachable on every fresh deploy until a person hand-wrote the file
# -- which is a wall in front of the user, not in front of the agent.
mv "$MEM" "$SANDBOX/stash"
OUT=$(printf 'x\n' | "$GOVCMD" memory add --by issue-validator 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok || bad "memory add refused an absent memory file — D-0089 says it creates one: $OUT"
[ -f "$MEM" ] && ok || bad "memory add did not create governance/validator-memory.md"
# The header matters: the [ -s ] guard below refuses a file that has LOST
# its header, so creating an empty one would produce a file the very next
# add refuses.
head -1 "$MEM" | grep -q '^# validator-memory.md' && ok \
  || bad "the created file has no header line: $(head -1 "$MEM")"
grep -q 'Append-only' "$MEM" && ok || bad "the created header does not state the append-only contract"
grep -q "^## Run $(date +%F) — issue-validator\$" "$MEM" && ok \
  || bad "the first block did not land under a dated heading in the file it just created"
grep -q '^x$' "$MEM" && ok || bad "the first block's content did not land"
# Article 5: the report says which of the two things happened.
printf '%s' "$OUT" | grep -q 'created' && ok \
  || bad "the report does not say the file was created, only that something was appended: $OUT"
# ...and the very next add is an ordinary append onto what was created.
CREATED=$(wc -c < "$MEM" | tr -d ' ')
printf 'y\n' | "$GOVCMD" memory add --by debugger >/dev/null 2>&1 \
  && ok || bad "the add after a creation was refused"
# Append-only still holds across the boundary: the created header and the
# first block are byte-identical after the second add.
head -c "$CREATED" "$MEM" > "$SANDBOX/created-head"
[ "$(wc -c < "$SANDBOX/created-head" | tr -d ' ')" = "$CREATED" ] && ok \
  || bad "the add after a creation rewrote bytes that were already there"
[ "$(grep -c '^## Run' "$MEM")" -eq 2 ] && ok \
  || bad "expected 2 run headings after create+append, got $(grep -c '^## Run' "$MEM")"

# --- 4c. an EXISTING but EMPTY file is still refused -------------------
# D-0089 reversed the ABSENT case only. A file that exists and is zero
# bytes has LOST its header, which is a different fact and a different
# answer: creating over it would silently discard whatever was there.
: > "$MEM"
OUT=$(printf 'x\n' | "$GOVCMD" memory add --by issue-validator 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok || bad "an existing EMPTY memory file was appended to — it has lost its header"
printf '%s' "$OUT" | grep -q 'empty' && ok || bad "the empty-file refusal does not say why: $OUT"
mv "$SANDBOX/stash" "$MEM"

# --- 5. --file and stdin agree ----------------------------------------
printf 'from a file\n' > "$SANDBOX/block.md"
"$GOVCMD" memory add --by issue-validator --file "$SANDBOX/block.md" >/dev/null 2>&1 \
  && ok || bad "--file was refused"
grep -q 'from a file' "$MEM" && ok || bad "--file content did not land"
"$GOVCMD" memory add --by issue-validator --file "$SANDBOX/nope.md" >/dev/null 2>&1 \
  && bad "a missing --file was accepted" || ok

# --- 6. the prose that used to instruct the by-hand append is gone ----
grep -q 'scrumux memory' "$ROOT/.deploy-claude/skills/session-open/SKILL.md" && ok \
  || bad "session-open still tells the orchestrator to append by hand (the skill was sprint-plan until T-0189)"
grep -q 'scrumux memory' "$ROOT/.deploy-claude/agents/issue-validator.md" && ok \
  || bad "the issue-validator definition still describes a by-hand append"

printf 'scrumux-memory-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "scrumux-memory-tests: error: $FAIL case(s) wrong — the memory append is not append-only, or scrumux memory is not the path (T-0124)" >&2; exit 1; }
