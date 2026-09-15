#!/bin/sh
# README anti-drift suite (T-0205).
#
# I-0029 is the record of what this class of rot costs: the same
# architecture paragraph lived in three documents, README contradicted a
# ratified decision, and PROJECT_SPEC and SKILLS_INDEX each carried a
# differently-wrong roster of the same things. Nothing checked any of it.
#
# This suite checks the two directions that matter and nothing else:
#   1. every command the README shows a reader is a real file
#   2. every command that ships is described, so the roster cannot go
#      stale by ADDING a script and forgetting the document
#
# lib.sh is exempt from neither: it is named in the README as a library
# rather than a command, which is the honest description, and it is a
# real file, so both directions hold for it too.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
README="$ROOT/README.MD"
FAILED=0
RUN=0

fail() { printf 'FAIL: %s\n' "$1"; FAILED=$((FAILED + 1)); }
ok()   { printf 'ok:   %s\n' "$1"; }
check() { RUN=$((RUN + 1)); }

[ -f "$README" ] || { fail "README.MD does not exist at $README"; exit 1; }

# --- 1. every .claude/scripts path the README names exists -------------
check
MISSING=''
for p in $(grep -oE '\.claude/scripts/[A-Za-z0-9_.-]+' "$README" | sort -u); do
  [ -f "$ROOT/.deploy-claude/${p#.claude/}" ] || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  fail "README names script path(s) that do not exist:$MISSING"
else
  ok "every .claude/scripts path named in the README exists"
fi

# --- 2. every shipped script is named in the README --------------------
# Matched on the bare basename anywhere in the document, so a script may
# be introduced in prose or in a table without this suite dictating the
# layout of the page.
check
UNDOC=''
for f in "$ROOT"/.deploy-claude/scripts/*; do
  [ -f "$f" ] || continue
  b=$(basename -- "$f")
  case "$b" in .*) continue;; esac
  grep -q -- "$b" "$README" || UNDOC="$UNDOC $b"
done
if [ -n "$UNDOC" ]; then
  fail "script(s) ship but are not named in the README:$UNDOC"
else
  ok "every script in .claude/scripts is named in the README"
fi

# --- 3. the install path a reader is told to run is real ---------------
check
if grep -q 'harness deploy' "$README" && grep -q 'harness verify' "$README"; then
  ok "README documents both harness deploy and harness verify"
else
  fail "README must document both 'harness deploy' and 'harness verify' — they are the whole install path"
fi

# --- 4. no local-path deployment assumption ----------------------------
# The sprint that produced this document had to correct a design that
# assumed the harness checkout would still be sitting next to the target.
# A README that hands a reader a machine-specific path repeats it.
check
if grep -qE '~/tools/harness|/Users/[A-Za-z0-9_.-]+/tools' "$README"; then
  fail "README names a machine-specific harness path — the install must read the same on any host"
else
  ok "README names no machine-specific harness checkout path"
fi

# --- 5. RETIRED: the counts pinned in prose ---------------------------
# This suite used to require the README to state, verbatim, the wall count,
# the hook-chain count, and three numbers measured by running a real deploy
# ("installs 45 items", "32 machinery files arrived", "10/10 checks pass").
# The intent was anti-drift and the intent was right; the mechanism was not.
# It made every payload change fail a test for a PROSE reason, it forced the
# README's sentences into shapes a grep could find rather than shapes a
# reader wants, and it cost a full deploy + verify on every run of this file.
#
# What survives is the half that ages well: a path the README names must
# exist, a script that ships must be named, no machine-specific paths, and
# the walkthrough must name the verbs it walks through. Those stay true
# without pinning the document to a number that moves.
#
# If a count in the README goes stale, that is a documentation bug found by
# reading, not a build break. The tradeoff is deliberate.

# --- 6. one command in, and a walkthrough out -------------------------
check
if grep -q 'git clone' "$README" && grep -q 'harness deploy' "$README" && grep -q '\\$' "$README"; then
  ok "the install is a single chained command a reader can paste"
else
  fail "the install must be ONE copy-pasteable command chaining clone, deploy and verify"
fi

check
# The WALKTHROUGH is required; its heading is not. This used to also pin the
# literal string 'Your first task, start to finish', which said nothing about
# whether the walkthrough was any good and everything about whether someone
# had renamed a heading.
if grep -q 'scrumux task order' "$README" && grep -q 'scrumux task verify' "$README" \
   && grep -q 'scrumux task accept' "$README"; then
  ok "the README walks a reader from a standing start to an accepted task"
else
  fail "the README must carry a worked walkthrough naming scrumux task order, scrumux task verify and scrumux task accept"
fi

printf '\nreadme-tests: %d check(s) run, %d failed\n' "$RUN" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
