#!/bin/sh
# issue-validator-def-tests.sh — T-0041: the issue-validator agent
# definition holds its contract: Opus-class read-only validator with
# memory, backlog-aware dedupe, new-evidence preservation, and a
# return shape matching scrumux issue validate. Run: sh tests/issue-validator-def-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DEF="$ROOT/.deploy-claude/agents/issue-validator.md"
MEM="$ROOT/governance/validator-memory.md"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }
has()  { grep -q "$1" "$DEF" && ok || bad "$2"; }

[ -f "$DEF" ] && ok || { bad "definition file missing at $DEF"; printf 'issue-validator-def-tests: %d passed, %d failed\n' "$PASS" "$FAIL"; exit 1; }

# --- frontmatter contract --------------------------------------------
FM=$(sed -n '/^---$/,/^---$/p' "$DEF")
printf '%s' "$FM" | grep -q '^name: issue-validator$' && ok || bad "frontmatter name"
printf '%s' "$FM" | grep -q '^model: opus$' && ok || bad "frontmatter pins Opus-class model"
printf '%s' "$FM" | grep -q '^tools: Read, Glob, Grep, Bash$' && ok || bad "read-only toolset (no Edit/Write)"
printf '%s' "$FM" | grep '^tools:' | grep -qi 'edit\|write\|notebookedit' && bad "tools line leaks a write tool" || ok

# --- protocol contract ------------------------------------------------
has 'validator-memory.md' "protocol reads/appends the memory file"
has 'memory-append:' "memory handoff block defined (agent is read-only)"
has 'backlog' "dedupe checks the backlog, not just the issues journal"
has 'new_evidence_note' "duplicate verdicts preserve new evidence"
has 'duplicate_of' "duplicate verdicts name the original"
has 'reproduced | evidenced | invalidated | duplicate' "verdict enum matches scrumux issue validate"
has 'repro_cmd' "reproduced verdicts capture the repro command"
has 'I-0010' "authorization-is-not-validation noted in protocol"
has 'evidence says what is true' "memory subordinate to evidence"

# --- memory file seeded ----------------------------------------------
# THIS ASKS ABOUT THE AUTHOR'S OWN MEMORY FILE, WHICH DOES NOT TRAVEL.
# governance/validator-memory.md is gitignored, and nothing seeds it at
# deploy: D-0089 made `scrumux memory add` CREATE it on first use, which is
# the contract that actually ships. So on a clone the file is legitimately
# absent and these two read as a missing seed — both went red on every
# parity lane of the first CI run (2026-09-02).
#
# The travelling half of the claim is asserted where it belongs and in a
# sandbox: tests/scrumux-memory-tests.sh section 4b drives `memory add`
# against an absent file and asserts the created header states the
# append-only contract. What is left here is the local instance of it,
# conditional and with the skip printed.
if [ -f "$MEM" ]; then
  ok
  grep -q 'Append-only' "$MEM" && ok || bad "memory seed states append-only contract"
else
  printf 'SKIP: governance/validator-memory.md is not in this checkout (gitignored, and created on first `scrumux memory add` rather than seeded at deploy — D-0089). Its creation contract is asserted in tests/scrumux-memory-tests.sh section 4b.\n'
fi

printf 'issue-validator-def-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
