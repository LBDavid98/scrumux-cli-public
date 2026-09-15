#!/bin/sh
# parity-suites.sh — the shell integration tier, run against the CLI.
#
#   npm run parity:suites               every suite
#   npm run parity:suites -- --only X   the suites whose name contains X
#
# WHY THESE SUITES, ALONGSIDE THE UNIT TESTS. Every one of them drives
# `.deploy-claude/scripts/scrumux` as a PROCESS and asserts on what comes back
# — never on an internal. They are the integration tier: assertions over the
# real command surface, the walls, the hooks and a real deploy, in the one
# shape a unit test cannot reach.
#
# The suite roster is READ FROM DISK, never listed here -- and no count of it
# is written down here either. This script derives the count and PRINTS it on
# the `parity-suites: N suite(s) on disk` line, which is the whole point:
# a prose count is a count nobody re-derives, and one that drifts from the
# real roster misreports coverage either as more or less than what actually
# runs.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
ONLY=''

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY=${2:?}; shift 2 ;;
    *) printf 'parity-suites: unknown flag %s\n' "$1" >&2; exit 2 ;;
  esac
done

SUITES=$(ls "$ROOT"/tests/*-tests.sh 2>/dev/null | sort)
[ -n "$SUITES" ] || { printf 'parity-suites: no suites under %s/tests\n' "$ROOT" >&2; exit 2; }
COUNT=$(printf '%s\n' "$SUITES" | wc -l | tr -d ' ')
printf 'parity-suites: %s suite(s) on disk\n' "$COUNT"

OVERALL=0
{
  red=0; ran=0; assert_pass=0; assert_fail=0
  t0=$(date +%s)
  for s in $SUITES; do
    name=$(basename "$s" .sh)
    case "$name" in *"$ONLY"*) ;; *) continue ;; esac
    ran=$((ran + 1))
    # `&&`, not `;`. With a semicolon a failed cd runs the suite from the
    # WRONG directory and reports its tally as though it had run from the repo
    # root -- a green over a run that never happened, which is the one result
    # this script exists to refuse.
    out=$(cd "$ROOT" && sh "$s" 2>&1); rc=$?
    # Every suite ends with a tally, and there are TWO spellings of it:
    #   "<suite>: N passed, M failed"        (most suites)
    #   "<suite>: N check(s) run, M failed"  (readme-tests, upstream-wall-tests)
    # Read it rather than counting rc alone. A suite that exits 0 having run
    # nothing is the zero-check receipt this repo has already paid for
    # (D-127), and reading only one spelling reported two live suites as
    # having asserted nothing -- which is the same false green from the other
    # direction.
    tallyline=$(printf '%s\n' "$out" | grep -E '[0-9]+ (passed|check\(s\) run), [0-9]+ failed' | tail -1)
    # awk, not sed: POSIX sed's `.*` is greedy and backtracks to the SHORTEST
    # trailing match, so `s/.*\([0-9]*\) passed/` reads "57 passed" as 7. That
    # silently under-reports every suite, which is the failure mode a tally is
    # supposed to catch rather than commit.
    p=$(printf '%s\n' "$tallyline" | awk '{for(i=2;i<=NF;i++) if($i ~ /^(passed,?|check\(s\))$/) print $(i-1)}' | tail -1)
    f=$(printf '%s\n' "$tallyline" | awk '{for(i=2;i<=NF;i++) if($i ~ /^failed\.?$/) print $(i-1)}' | tail -1)
    [ -n "$p" ] || p=0
    [ -n "$f" ] || f=0
    assert_pass=$((assert_pass + p)); assert_fail=$((assert_fail + f))
    if [ "$rc" -eq 0 ] && [ "$f" -eq 0 ] && [ "$p" -gt 0 ]; then
      printf '  ok   %-34s %s assertions\n' "$name" "$p"
    else
      red=$((red + 1))
      printf '  FAIL %-34s rc=%s  %s passed, %s failed\n' "$name" "$rc" "$p" "$f"
      printf '%s\n' "$out" | grep -E '^(FAIL|not ok|  FAIL)' | head -5 | sed 's/^/         /'
      [ "$p" -eq 0 ] && printf '         (zero assertions ran — a green rc over no checks is not a pass)\n'
    fi
  done
  t1=$(date +%s)
  printf -- '--- %s suite(s), %s red, %s assertions passed, %s failed, %ss\n' \
    "$ran" "$red" "$assert_pass" "$assert_fail" "$((t1 - t0))"
  [ "$red" -eq 0 ] || OVERALL=1
}

exit "$OVERALL"
