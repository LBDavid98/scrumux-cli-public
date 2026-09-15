#!/bin/sh
# Upstream-wall suite (SP-0026).
#
# The wall has four parts and they are built by four tasks; this suite
# is where the parts that are DOCUMENTS get asserted, so the constitution
# and the shipped rule are script-decided rather than self-reported
# (D-0072 boundary 5). The executable parts have their own suites:
# hook-upstream-tests.sh covers the hook, harness-tests.sh covers the
# manifest and the drift pass.
#
#   section 0 (T-0196) — boundary 1 names the fourth wall; D-0078 recorded
#   section 1 (T-0200) — the harness-is-upstream rule exists, validates,
#                        and ships in the deploy payload
#
# Section 1 is added by T-0200 and is absent until then, by design: a
# suite that asserts a file nobody has written yet fails for a reason
# that teaches nothing.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
FAILED=0
RUN=0

fail() { printf 'FAIL: %s\n' "$1"; FAILED=$((FAILED + 1)); }
ok()   { printf 'ok:   %s\n' "$1"; }
check() { RUN=$((RUN + 1)); }

# ---------- section 0: the constitution ------------------------------
# The walls are enumerated exhaustively in one place, and a wall that is not
# listed there makes a shipped rule false. This asserts the list.
#
# CLAUDE.source.md was quarantined out of this repo (3101ebe). The claim it
# carried moved into the enforcement-posture rule, which is the copy that
# SHIPS to every governed repo and therefore the one that actually binds an
# agent. So this section follows the claim rather than the filename.
POSTURE="$ROOT/.deploy-claude/rules/enforcement-posture.md"

check
if grep -q 'no writes to the machinery' "$POSTURE"; then
  ok "the shipped rule's boundary 1 names the upstream wall"
else
  fail "boundary 1 does not name the fourth wall — the enforcement-posture rule's 'It names the only walls' is false while a fourth hook can stop a run (D-0078)"
fi

# The clause must sit inside the enumeration itself, not somewhere else in the
# document that happens to mention it.
check
WALLS=$(sed -n '/names the only walls/,/and reserves/p' "$POSTURE" | tr '\n' ' ')
if printf '%s' "$WALLS" | grep -q 'deployed'; then
  ok "the clause is inside the walls enumeration, not merely somewhere in the rule"
else
  fail "the fourth wall is mentioned in the rule but not where the walls are enumerated — an agent auditing its refusals reads that list"
fi

# Four walls, not three-plus-a-sentence. Counted as the comma-separated
# clauses that state a refusal, so the trailing "PreToolUse hooks only"
# qualifier is not miscounted as a wall.
check
SEMIS=$(printf '%s' "$WALLS" | sed 's/.*names the only walls —//; s/— and reserves.*//' | tr ',' '\n' | grep -c '^ *no ')
if [ "$SEMIS" -eq 4 ]; then
  ok "the shipped rule enumerates exactly four walls"
else
  fail "the shipped rule enumerates $SEMIS wall(s), expected 4 — adding a fifth wall means amending the rule and this suite together (D-0078)"
fi

# THE DECISION RECORD IS THIS AUTHOR'S DIARY, AND IT DOES NOT TRAVEL.
# governance/*.json is gitignored on purpose (.gitignore, 2026-08-23: "a
# clone should start with its own, empty"), so on any checkout that is not
# the author's -- a CI runner, a contributor's clone -- there is no
# decisions.json to read and there never will be. Asserting D-0078 there was
# not asserting the constitution; it was asserting whose machine you are on,
# and it reddened every parity and walls lane of the first CI run (2026-09-02).
#
# So the two boundary-2 assertions are conditional on the record EXISTING,
# and the skip is PRINTED. The same shape section 1 below already uses, for
# the same reason: a check that cannot apply must say so out loud rather than
# fail for a reason that teaches nothing. What is NOT conditional is
# everything above -- CLAUDE.source.md ships in the clone, so the amendment
# itself is still script-decided everywhere.
if [ -f "$ROOT/governance/decisions.json" ]; then
  check
  if jq -e '.entries[] | select(.id=="D-0078")' "$ROOT/governance/decisions.json" >/dev/null 2>&1; then
    ok "D-0078 is on record"
  else
    fail "D-0078 is not in governance/decisions.json — the constitution was amended without the decision that authorises it (boundary 2)"
  fi

  # The amendment is User's alone. A decision recorded by anyone else is
  # an agent having amended the constitution for itself.
  check
  BY=$(jq -r '.entries[] | select(.id=="D-0078") | .ratified_by // "MISSING"' "$ROOT/governance/decisions.json" 2>/dev/null)
  if [ "$BY" = "User" ]; then
    ok "D-0078 records User as the deciding authority"
  else
    fail "D-0078's authority is '$BY', not User — ratify and accept are theirs alone (boundary 2)"
  fi
else
  printf 'SKIP: governance/decisions.json is not in this checkout (it is gitignored — the working record does not travel), so the two boundary-2 assertions about D-0078 could not run here. They run on the authoring checkout.\n'
fi

# ---------- section 1: the shipped rule (T-0200) ----------------------
# Deploy does not ship CLAUDE.source.md, so a deployed repo never receives
# boundary 1. The rule is the only channel that reaches it, which is why
# its presence in the payload is an assertion and not a detail.

RULE="$ROOT/.deploy-claude/rules/harness-is-upstream.md"
if [ -f "$RULE" ]; then
  check
  if head -1 "$RULE" | grep -q -- '---'; then
    ok "harness-is-upstream.md opens with frontmatter"
  else
    fail "harness-is-upstream.md has no frontmatter block — records-check checks the rule chain through it"
  fi

  check
  if grep -q 'scrumux issue new --type harness' "$RULE"; then
    ok "the rule names the capture command"
  else
    fail "the rule does not name 'scrumux issue new --type harness' — a wall with no stated way forward is a dead end"
  fi

  check
  if grep -qE '~/tools|/Users/' "$RULE"; then
    fail "the rule names a machine-specific path as the upstream — true on one host only"
  else
    ok "the rule names no machine-specific upstream path"
  fi

  # Deploy does not ship CLAUDE.source.md (harness:41-45, the I-0029 lesson), so
  # boundary 1 never reaches a deployed repo and this rule is the ONLY
  # channel that carries the instruction there. If it stopped shipping,
  # the wall would refuse writes in repos that were never told why.
  check
  DEPLOYED_TMP=$(mktemp -d) || { fail "cannot mktemp for the payload check"; DEPLOYED_TMP=''; }
  if [ -n "$DEPLOYED_TMP" ]; then
    ( cd "$DEPLOYED_TMP" && git init -q . && printf 'x\n' > README.md && git add -A && git commit -qm init ) >/dev/null 2>&1
    "$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$DEPLOYED_TMP" >/dev/null 2>&1
    if [ -f "$DEPLOYED_TMP/.claude/rules/harness-is-upstream.md" ]; then
      ok "the rule ships: a real deploy lands it in the target"
    else
      fail "harness deploy does not carry .claude/rules/harness-is-upstream.md — a deployed repo would get the wall without ever being told the rule"
    fi
    # And it must be named in the manifest, or verify cannot report its drift.
    check
    if jq -e '.files | has(".claude/rules/harness-is-upstream.md")' "$DEPLOYED_TMP/.claude/DEPLOYED" >/dev/null 2>&1; then
      ok "the rule is listed in the deployment manifest, so its drift is reportable"
    else
      fail "the rule is not in .claude/DEPLOYED's files map — harness verify could not tell if a target rewrote it"
    fi
    rm -rf "$DEPLOYED_TMP"
  fi
else
  printf 'skip: section 1 — .claude/rules/harness-is-upstream.md not written yet (T-0200)\n'
fi

printf '\nupstream-wall-tests: %d check(s) run, %d failed\n' "$RUN" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
