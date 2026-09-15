#!/bin/sh
# error-shape-tests.sh — T-0021 / S-0010. Every governance script
# failure must give agent-actionable feedback: nonzero exit AND a
# message that names the problem (error:/FAIL) AND carries a fix clause
# (either "— <next step>" or a usage: line). A bare or unactionable
# failure message fails this suite.
# sprint-status has no failure paths (report tool; exit 3 is a verdict,
# not an error) — nothing to assert there.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
S="$ROOT/.deploy-claude/scripts"
SANDBOX=$(mktemp -d) || { echo "error-shape-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# expect_shape <desc> <cmd...> — nonzero exit + problem marker + fix clause
expect_shape() {
  desc=$1; shift
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then bad "$desc — expected failure, got exit 0"; return; fi
  printf '%s' "$out" | grep -Eq 'error:|FAIL' || { bad "$desc — no error:/FAIL marker in: '$out'"; return; }
  # actionable = any of: usage block, em-dash fix clause, required-flag
  # statement, must-be constraint, or an enum list of the valid values
  if printf '%s' "$out" | grep -q 'usage:' ; then ok; return; fi
  if printf '%s' "$out" | grep -q '— ..*'; then ok; return; fi
  if printf '%s' "$out" | grep -Eq -- '--[a-z-]+.* required'; then ok; return; fi
  if printf '%s' "$out" | grep -Eq -- '--[a-z-]+ must be'; then ok; return; fi
  if printf '%s' "$out" | grep -Eq '[a-z_]+\|[a-z_]+'; then ok; return; fi
  bad "$desc — no actionable fix clause in: '$out'"
}

G="$S/scrumux"

# --- scrumux: stateless failure paths ------------------------------------
expect_shape "scrumux unknown subcommand" "$G" bogus
expect_shape "scrumux feature missing desc" "$G" feature new --name X
expect_shape "scrumux feature unknown flag" "$G" feature new --name X --desc D --bogus v
expect_shape "scrumux story missing criterion" "$G" story new --feature F-0001 --narrative N
expect_shape "scrumux surface bad type" "$G" surface --name S --type bogus
expect_shape "scrumux control no statements" sh -c "'$G' feature --name F --desc D >/dev/null; '$G' surface --name S --type cli >/dev/null; '$G' control --surface SF-0001"
expect_shape "scrumux epic dangling feature" "$G" epic new --name E --desc D --feature F-9999
expect_shape "scrumux task new missing check" "$G" task new --title X
expect_shape "scrumux task status unknown task" "$G" task status T-9999 ready
expect_shape "scrumux task status invalid status" sh -c "'$G' task new --title T --check C >/dev/null; '$G' task status T-0001 bogus"
expect_shape "scrumux task order missing verify" "$G" task order T-0001 --scope S
expect_shape "scrumux task order missing files" "$G" task order T-0001 --scope S --verify V
expect_shape "scrumux task order file without why" "$G" task order T-0001 --scope S --verify V --file pathonly
expect_shape "scrumux task order bad ref pattern" "$G" task order T-0001 --scope S --verify V --file "a | b" --ref X-1
expect_shape "scrumux log missing did" "$G" log new --title T
expect_shape "scrumux log dangling task" "$G" log new --task T-9999 --title T --did D
expect_shape "scrumux issue bad type" "$G" issue new --type bogus --source monitor --summary S --fix F
expect_shape "scrumux issue missing fix" "$G" issue new --type defect --source monitor --summary S
expect_shape "scrumux decide missing by" "$G" decide new --title T --decision D --rationale R
expect_shape "scrumux decide bad scope" "$G" decide new --title T --decision D --rationale R --by W --scope galaxy
expect_shape "gov review missing lens" "$G" review --task T-0001 --scope pass --governance pass --code-diff pass
expect_shape "gov review bad finding prefix" "$G" review --task T-0001 --scope pass --governance pass --code-diff pass --blast-radius pass --finding "vibes: meh"
expect_shape "scrumux task accept unknown review" "$G" task accept R-9999
expect_shape "scrumux sprint new missing epic" "$G" sprint new
expect_shape "scrumux sprint hotfix missing issue" "$G" sprint new --hotfix
expect_shape "scrumux sprint add unknown sprint" "$G" sprint add SP-9999 T-0001
expect_shape "scrumux sprint ratify unknown" "$G" sprint ratify SP-9999
# D-0084: the parallel cap. Both refusals are agent-facing -- one on the
# flag, one on the plan's standing -- so both owe an actionable clause.
expect_shape "scrumux sprint new parallel not a number" "$G" sprint new --epic E-0001 --parallel two
expect_shape "scrumux sprint new parallel zero" "$G" sprint new --epic E-0001 --parallel 0
expect_shape "scrumux sprint update unknown sprint" "$G" sprint update SP-9999 --parallel 2
expect_shape "scrumux sprint update no field" "$G" sprint update SP-0001
expect_shape "scrumux sprint status invalid" sh -c "'$G' epic --name E --desc D >/dev/null; '$G' sprint new --epic E-0001 >/dev/null; '$G' sprint status SP-0001 bogus"
expect_shape "scrumux health missing command" "$G" health add --name N

# --- scrumux: lifecycle-gate failure paths -------------------------------
expect_shape "scrumux one-in-progress gate" sh -c "'$G' task new --title T2 --check C >/dev/null; '$G' task status T-0001 in_progress >/dev/null; '$G' task status T-0002 in_progress"
expect_shape "scrumux accepted-without-log gate" "$G" task status T-0002 accepted
expect_shape "scrumux sprint-add-without-order gate" sh -c "'$G' sprint add SP-0001 T-0002"
expect_shape "scrumux ratify-empty-sprint gate" "$G" sprint ratify SP-0001

# --- task-lint --------------------------------------------------------
expect_shape "task-lint no args" "$S/scrumux" task lint
expect_shape "task-lint unknown task" "$S/scrumux" task lint T-9999
expect_shape "task-lint incomplete task" "$S/scrumux" task lint T-0002
expect_shape "task-lint feature without tasks" "$S/scrumux" task lint --feature F-9999

# --- task-brief -------------------------------------------------------
expect_shape "task-brief no args" "$S/scrumux" task brief
expect_shape "task-brief unknown task" "$S/scrumux" task brief T-9999
expect_shape "task-brief gate failure (unsprinted)" "$S/scrumux" task brief T-0002

# --- task-verify ------------------------------------------------------
expect_shape "task-verify no args" "$S/scrumux" task verify
expect_shape "task-verify task without order" "$S/scrumux" task verify T-0002
expect_shape "task-verify failing verification" sh -c "'$G' task order T-0002 --scope S --verify false --out O --file 'a | b' >/dev/null; '$S/scrumux' task verify T-0002"

# --- session-check failure lines -------------------------------------
# A task claiming done with no receipt FAILs and names the task. The
# close is the one place the <problem> — <fix> shape does NOT apply: a
# fix here would be a governance command, and an exit message that sends
# the agent to do governance is how a close becomes a governance
# sub-project. It states the problem and stops.
OUT=$(sh -c "'$G' task status T-0001 in_review >/dev/null 2>&1; '$S/scrumux' session check" 2>&1); rc=$?
if [ $rc -ne 0 ] && printf '%s' "$OUT" | grep -q 'T-0001'; then ok; else bad "session-check must FAIL a receipt-less claim and name it (rc=$rc)"; fi
if printf '%s' "$OUT" | grep -qE '— scrumux (log|task|issue|sprint|accept)'; then bad "the close prescribes a governance command: $(printf '%s' "$OUT" | grep -E '— scrumux ' | head -1)"; else ok; fi
# T-0186 removed section 4 (reviews): documented approval IS the review
# (D-0072 boundary 2), so the CLI no longer demands a review record. The
# assertion is inverted rather than dropped — a reviews FAIL coming back
# would mean the deleted gate returned.
if printf '%s' "$OUT" | grep -q 'no review record for'; then bad "session-check is demanding a review record again — section 4 was removed by T-0186"; else ok; fi

# --- governance-validate finding lines -------------------------------
cp "$SANDBOX/governance/tasks.json" "$SANDBOX/governance/tasks.json.bak"
jq '.entries[0].status = "bogus"' "$SANDBOX/governance/tasks.json.bak" > "$SANDBOX/governance/tasks.json"
OUT=$("$S/scrumux" records check 2>&1); rc=$?
# the enum finding now comes from schema-check (T-0113); what this case
# pins is unchanged — the finding must carry a FIX, not just name the
# problem. The shared row renderer splits the two apart on the em-dash
# once (name = the problem, detail = the fix), which is what --porcelain
# used to do for machines only and now happens for every consumer.
if [ $rc -ne 0 ] \
   && printf '%s' "$OUT" | grep -qE "FAIL +schema: tasks.json .* not one of " \
   && printf '%s' "$OUT" | grep -q "the record does not match"; then ok
else bad "records check finding line lacks a fix clause (rc=$rc): $(printf '%s' "$OUT" | grep -i schema | head -1)"; fi
mv "$SANDBOX/governance/tasks.json.bak" "$SANDBOX/governance/tasks.json"

# --- hook: block-direct-llm ------------------------------------------
OUT=$(printf '{"tool_input":{"command":"curl https://api.anthropic.com/v1/messages"}}' | node "$ROOT/.deploy-claude/dist/block-direct-llm.mjs" 2>&1); rc=$?
if [ $rc -eq 2 ] && printf '%s' "$OUT" | grep -q 'BLOCKED' && printf '%s' "$OUT" | grep -q 'no-direct-llm-calls.md'; then ok; else bad "block-direct-llm hook message lacks rule pointer (rc=$rc)"; fi


# --- PK-5 (D-0085): sprint ratify's usage states its real contract ------
# `--by` and `--authority` are BOTH required at the write (cmd-sprint.sh),
# while the usage block advertised `[--by WHO]` -- optional -- and never
# named --authority at all. A usage line that understates its own required
# flags walks the caller into a refusal it could have avoided, and Article 5
# makes that text product surface, not chrome. Found because the
# session-check fixture still calls the old form and errors on every run.
USG=$("$G" help sprint 2>&1)
printf '%s' "$USG" | grep -q 'ratify' \
  && ok || bad "PK-5: the sprint usage block must document ratify"
printf '%s' "$USG" | grep 'ratify' | grep -q '\[--by' \
  && bad "PK-5: --by is REQUIRED for sprint ratify — the usage line must not render it as optional [--by WHO]" || ok
printf '%s' "$USG" | grep 'ratify' | grep -q -- '--authority' \
  && ok || bad "PK-5: sprint ratify requires --authority and the usage line never names it; got: $(printf '%s' "$USG" | grep ratify)"

printf 'error-shape-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "error-shape-tests: error: $FAIL failure path(s) give unactionable feedback — fix the named script messages to the '<problem> — <fix>' shape before proceeding" >&2
  exit 1
fi
exit 0
