#!/bin/sh
# deployed-surface-tests.sh — T-0214.
#
# A deployed repo receives .claude/rules and .claude/skills and NO
# CLAUDE.MD (harness:41-45), so the shipped prose is the whole of what
# tells an agent how to behave there. This suite asserts that prose points
# the agent at the PRODUCT's work and never at the harness.
#
# The failure it guards against is not misbehaviour. An agent that spends
# a session minting tasks to improve the machinery is following
# instructions we shipped it — implement-sop used to say a missing scrumux
# capability was its own task, and session-review used to ask what else
# had been noticed and not filed. Both are gone (T-0209/D-0079) and this
# suite is what keeps them gone.
#
# It reads the PAYLOAD ROSTER, not a hand-written list, so a rule or skill
# added later is covered the day it ships.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

SHIPPED=$(find "$ROOT/.deploy-claude/rules" "$ROOT/.deploy-claude/skills" -type f -name '*.md' 2>/dev/null)
[ -n "$SHIPPED" ] && ok || bad "no shipped rules or skills found — the roster this suite reads is empty"

# --- 1. nothing tells an agent to build or repair the machinery --------
# Each pattern is a phrase that was, or would be, an instruction to spend
# the session on the harness. The message names the file and the line so
# a failure is actionable without a search.
for f in $SHIPPED; do
  rel=${f#"$ROOT"/}
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    bad "$rel:$hit — this instructs an agent to create harness work. The harness supports the work; it is never the job (D-0079)."
  # A prohibition contains the phrase it prohibits, so lines that NEGATE
  # the pull are excluded — otherwise the suite fails on the very text
  # that fixes the problem.
  done <<EOF
$(grep -niE 'missing scrumux capability|is its own task|scrumux task new for it|not yet scrumux issue|anything noticed off-scope that|file an issue for anything|improve the harness|fix the harness' "$f" 2>/dev/null | grep -viE 'do not|never|not filed|forbid|instead of' | cut -d: -f1,2)
EOF
done
[ "$FAIL" -eq 0 ] && ok || :

# --- 2. the replacement instructions are actually there ---------------
# Removing the pull is half of it; the agent still needs to know what to
# do when the CLI cannot express the task, or it will improvise.
SOP="$ROOT/.deploy-claude/skills/implement-sop/SKILL.md"
grep -q 'do not build a way around it' "$SOP" \
  && ok || bad "implement-sop must tell an agent to stop and say so when the CLI cannot express the task — otherwise it improvises, and improvising means changing the harness"
grep -q 'not filed at all' "$SOP" \
  && ok || bad "implement-sop must state the bug threshold: an observation that is not a bug is not filed at all (D-0079)"
grep -qi 'never go looking for more' "$SOP" \
  && ok || bad "implement-sop must forbid hunting for further findings mid-task"

REV="$ROOT/.deploy-claude/skills/session-review/SKILL.md"
grep -qi 'do \*\*not\*\* sweep\|do not sweep' "$REV" \
  && ok || bad "session-review must forbid the end-of-session hunt for things to file — that hunt is where a session's last turns go"

# --- 3. the one harness-facing action that survives -------------------
UP="$ROOT/.deploy-claude/rules/harness-is-upstream.md"
[ -f "$UP" ] && ok || bad "the harness-is-upstream rule must ship — it is the only thing that tells a deployed repo not to edit the machinery"
grep -q 'scrumux issue new --type harness' "$UP" \
  && ok || bad "the rule must name the ONE harness-facing action an agent may take, or a blocked agent has nowhere to put what it found"
grep -qi 'stop, not an obstacle' "$UP" \
  && ok || bad "the rule must carry the I-0121 lesson: a denied call is a stop, not an obstacle"

# --- 4. and the agent-facing types are the bug types ------------------
# The threshold is enforced by scrumux, but the prose has to agree with it or
# an agent reads one thing and hits another.
# The refusal and its wording live in the issue module now.
GOV="$ROOT/src/nouns/issue.ts"
grep -q "an agent files bugs" "$GOV" \
  && ok || bad "scrumux must refuse a non-bug type from an agent with a message saying so (D-0079)"
for t in defect harness; do
  grep -q -- "--type $t" "$SOP$(printf '')" >/dev/null 2>&1 || :
done
grep -qE -- '--type (defect|harness)' "$SOP" \
  && ok || bad "implement-sop must name the type an agent actually files, or the guidance and the guard disagree"

printf 'deployed-surface-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "deployed-surface-tests: error: $FAIL assertion(s) failed — the shipped prose points an inheriting agent at the harness instead of at the work" >&2
  exit 1
fi
exit 0
