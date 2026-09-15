#!/bin/sh
# hook-destructive-tests.sh — T-0014 acceptance: rm-rf/purge/force-push
# classes blocked without backup attestation (exit 2, instructive),
# normal commands and temp-space cleanup unaffected (exit 0).
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
HOOK="$ROOT/.deploy-claude/dist/block-destructive.mjs"

# The hook now WRITES an attestation record (T-0131), so every case below
# runs against a sandbox root — set up before the first hook invocation,
# or the attested cases further down append to the real governance dir.
SANDBOX=$(mktemp -d) || { echo "hook-destructive-tests: cannot mktemp" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT INT TERM
mkdir -p "$SANDBOX/governance"
GOV_ROOT="$SANDBOX"; export GOV_ROOT
ATT="$SANDBOX/governance/attestations.jsonl"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

rows()  { if [ -f "$ATT" ]; then wc -l <"$ATT" | tr -d ' '; else echo 0; fi; }
clear_rows() { : >"$ATT"; }
# wrote <desc> <expected-rows> [expected-class] — row COUNT is the
# load-bearing assertion: one hook invocation, one row, never two.
wrote() {
  n=$(rows)
  if [ "$n" != "$2" ]; then bad "$1 — want $2 attestation row(s), got $n: '$(cat "$ATT" 2>/dev/null)'"; return; fi
  if [ "$2" != 0 ]; then
    if ! jq -e 'has("date") and has("class") and has("command") and has("attested_path")' "$ATT" >/dev/null 2>&1; then
      bad "$1 — row is not a jsonl object with date/class/command/attested_path: '$(cat "$ATT")'"; return
    fi
    if [ -n "${3:-}" ] && [ "$(jq -r '.class' "$ATT" 2>/dev/null)" != "$3" ]; then
      bad "$1 — want class '$3', got '$(jq -r '.class' "$ATT" 2>/dev/null)'"; return
    fi
  fi
  ok
}

blocked() {
  out=$(printf '%s' "$2" | node "$HOOK" 2>&1); rc=$?
  if [ $rc -eq 2 ] && printf '%s' "$out" | grep -q 'BLOCKED by block-destructive' && printf '%s' "$out" | grep -q 'CLAUDE.MD hard limit'; then ok
  else bad "$1 — want exit 2 + instructive message, got rc=$rc: '$out'"; fi
}
allowed() {
  out=$(printf '%s' "$2" | node "$HOOK" 2>&1); rc=$?
  if [ $rc -eq 0 ] && [ -z "$out" ]; then ok
  else bad "$1 — want silent exit 0, got rc=$rc: '$out'"; fi
}

# --- rm -rf class -----------------------------------------------------
blocked "rm -rf on repo path"        '{"tool_input":{"command":"rm -rf /Users/x/project"}}'
blocked "rm -fr variant"             '{"tool_input":{"command":"rm -fr ./src"}}'
blocked "rm -rf home"                '{"tool_input":{"command":"rm -rf ~/stuff"}}'
blocked "no-preserve-root"           '{"tool_input":{"command":"rm -rf --no-preserve-root /"}}'
blocked "chained rm -rf"             '{"tool_input":{"command":"cd /app && rm -rf data"}}'
allowed "rm -rf in /tmp"             '{"tool_input":{"command":"rm -rf /tmp/build-cache"}}'
allowed "rm -rf private tmp"         '{"tool_input":{"command":"rm -rf /private/tmp/claude-501/x/scratchpad/t"}}'
allowed "rm -rf mktemp sandbox"      '{"tool_input":{"command":"SANDBOX=$(mktemp -d); rm -rf \"$SANDBOX\""}}'
allowed "plain rm single file"       '{"tool_input":{"command":"rm ./old.log"}}'
allowed "rm -f non-recursive"        '{"tool_input":{"command":"rm -f ./stale.lock"}}'

# --- I-0103: the exemption tests the TARGET, not the command string ----
# Every command below carries a temp keyword SOMEWHERE and deletes
# something that is not temp. The suite used to assert only that genuine
# temp paths are allowed, so it tested the absence of a block and never
# its presence — all nine of these exited 0 before T-0160.
blocked "traversal out of temp"        '{"tool_input":{"command":"rm -rf /tmp/../Users/foo/data"}}'
blocked "mktemp as a path component"   '{"tool_input":{"command":"rm -rf /Users/foo/mktemp-archive"}}'
blocked "scratchpad as a path component" '{"tool_input":{"command":"rm -rf /Users/foo/scratchpad-old"}}'
blocked "temp keyword in a comment"    '{"tool_input":{"command":"rm -rf $HOME/data # /tmp/"}}'
blocked "home target, comment keyword" '{"tool_input":{"command":"rm -rf $HOME/x # /var/folders"}}'
blocked "home target, no keyword"      '{"tool_input":{"command":"rm -rf $HOME/x"}}'
blocked "second rm leaves temp"        '{"tool_input":{"command":"rm -rf /Users/x && rm -rf /tmp/a"}}'
blocked "one temp target, one not"     '{"tool_input":{"command":"rm -rf /tmp/a /Users/x"}}'
blocked "temp root without a boundary" '{"tool_input":{"command":"rm -rf /tmpfoo"}}'
blocked "cd into temp, delete elsewhere" '{"tool_input":{"command":"cd /tmp && rm -rf /Users/x"}}'
# ...and a target that really is in temp still passes, however it is spelt
allowed "TMPDIR target"                '{"tool_input":{"command":"rm -rf \"$TMPDIR\"/build"}}'
allowed "braced TMPDIR target"         '{"tool_input":{"command":"rm -rf ${TMPDIR}/build"}}'
allowed "mktemp var-folders path"      '{"tool_input":{"command":"rm -rf /var/folders/xy/z/T/tmp.AbC"}}'
allowed "two temp targets"             '{"tool_input":{"command":"rm -rf /tmp/a && rm -rf /tmp/b"}}'
allowed "dotdot resolving inside temp" '{"tool_input":{"command":"rm -rf /tmp/a/../b"}}'

# --- database purge class --------------------------------------------
blocked "DROP DATABASE"              '{"tool_input":{"command":"psql -c \"DROP DATABASE prod\""}}'
blocked "drop table lowercase"       '{"tool_input":{"command":"sqlite3 app.db \"drop table users\""}}'
blocked "TRUNCATE"                   '{"tool_input":{"command":"mysql -e \"TRUNCATE TABLE events\""}}'
blocked "redis flushall"             '{"tool_input":{"command":"redis-cli FLUSHALL"}}'
blocked "mongo dropDatabase"         '{"tool_input":{"command":"mongosh --eval \"db.dropDatabase()\""}}'
allowed "purge with backup attested" '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 sqlite3 app.db \"drop table tmp_import\""}}'
allowed "select query"               '{"tool_input":{"command":"psql -c \"SELECT * FROM users LIMIT 5\""}}'
allowed "create table"               '{"tool_input":{"command":"sqlite3 app.db \"CREATE TABLE t (id int)\""}}'

# --- git history destruction -----------------------------------------
blocked "bare force push"            '{"tool_input":{"command":"git push --force origin main"}}'
blocked "short -f push"              '{"tool_input":{"command":"git push -f"}}'
blocked "reset --hard"               '{"tool_input":{"command":"git reset --hard origin/main"}}'
blocked "git clean -fd"              '{"tool_input":{"command":"git clean -fd"}}'
allowed "force-with-lease"           '{"tool_input":{"command":"git push --force-with-lease origin feature-x"}}'
allowed "reset --hard attested"      '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 git reset --hard HEAD~1"}}'
allowed "normal push"                '{"tool_input":{"command":"git push origin main"}}'
allowed "git reset soft"             '{"tool_input":{"command":"git reset --soft HEAD~1"}}'

# --- attestation record (T-0131) --------------------------------------
# The header claimed the attestation was "logged by the agent"; nothing
# enforced it. The hook writes the row itself now, one per invocation.
clear_rows
allowed "attested db purge"            '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 psql -c \"DROP DATABASE staging\""}}'
wrote   "attested db purge logs one row" 1 db-purge

clear_rows
allowed "attested rm -rf outside temp" '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 rm -rf /Users/x/project/build"}}'
wrote   "attested rm -rf logs one row" 1 rm-rf
p=$(jq -r '.attested_path' "$ATT" 2>/dev/null)
if [ "$p" = "/Users/x/project/build" ]; then ok
else bad "attested rm -rf row names its target — want '/Users/x/project/build', got '$p'"; fi

clear_rows
allowed "attested reset --hard"        '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 git reset --hard HEAD~1"}}'
wrote   "attested reset --hard logs one row" 1 git-history

# two classes, one invocation, one row — the load-bearing case
clear_rows
allowed "attested rm -rf + drop table" '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 rm -rf /Users/x/db && sqlite3 app.db \"drop table users\""}}'
wrote   "two destructive classes still log exactly one row" 1 rm-rf

# a refusal must name the sanctioned path, and must leave no row
clear_rows
out=$(printf '%s' '{"tool_input":{"command":"rm -rf /Users/x/project"}}' | node "$HOOK" 2>&1); rc=$?
if [ $rc -eq 2 ] && printf '%s' "$out" | grep -q 'HARNESS_BACKUP_DONE=1'; then ok
else bad "bare rm -rf refusal names HARNESS_BACKUP_DONE=1 — rc=$rc: '$out'"; fi
wrote "blocked rm -rf logs no row" 0

# no attestation opens --no-preserve-root
clear_rows
blocked "no-preserve-root even attested" '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 rm -rf --no-preserve-root /"}}'
wrote   "attested no-preserve-root logs no row" 0

# temp space engages no destructive class, so it records nothing
clear_rows
allowed "temp rm -rf still passes"     '{"tool_input":{"command":"rm -rf /tmp/build-cache"}}'
wrote   "temp rm -rf logs no row" 0

clear_rows
allowed "plain temp target passes"     '{"tool_input":{"command":"rm -rf /tmp/foo"}}'
wrote   "plain temp target logs no row" 0

# I-0103, the two arms the exemption swallowed whole. A temp keyword in
# the string used to skip the --no-preserve-root block AND the
# attestation write, so a spoofed-temp delete ran with no record of it.
clear_rows
blocked "no-preserve-root behind a temp comment" '{"tool_input":{"command":"rm -rf --no-preserve-root / # /tmp/"}}'
wrote   "no-preserve-root behind a comment logs no row" 0

clear_rows
allowed "attested spoofed-temp target" '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 rm -rf /Users/foo/mktemp-archive"}}'
wrote   "attested spoofed-temp logs one row" 1 rm-rf
p=$(jq -r '.attested_path' "$ATT" 2>/dev/null)
if [ "$p" = "/Users/foo/mktemp-archive" ]; then ok
else bad "attested spoofed-temp row names its target — want '/Users/foo/mktemp-archive', got '$p'"; fi

# --- degradation ------------------------------------------------------
allowed "empty input"                '{}'
allowed "unrelated command"          '{"tool_input":{"command":"npm run build"}}'

# --- the wall event names the sub-agent that was refused (I-0154) ------
#
# A wall records the refusal into .scrumux/events.jsonl, the same stream
# scrumux-app reads. A Task-tool sub-agent fires the hook under the PARENT
# session id, so without `subAgent` the record says the session itself was
# refused when it was something the session spawned -- the same defect class
# as the "unknown" session id, one field along. The hook payload names it:
# `agent_id`, present only on a sub-agent call.
WEV="$SANDBOX/.scrumux/events.jsonl"
wall_field() { jq -r "$2" "$WEV" 2>/dev/null | tail -n 1; }
rm -f "$WEV"
blocked "sub-agent rm -rf is refused" '{"session_id":"s-parent","agent_id":"ade4b1934b3e0caae","agent_type":"general-purpose","tool_input":{"command":"rm -rf /Users/x/project"}}'
v=$(wall_field x '.subAgent')
if [ "$v" = "ade4b1934b3e0caae" ]; then ok
else bad "a sub-agent's refusal names the sub-agent — want 'ade4b1934b3e0caae', got '$v' in '$(tail -n 1 "$WEV" 2>/dev/null)'"; fi
v=$(wall_field x '.sessionId')
if [ "$v" = "s-parent" ]; then ok
else bad "a sub-agent's refusal is still charged to the parent session — want 's-parent', got '$v'"; fi

rm -f "$WEV"
blocked "session's own rm -rf is refused" '{"session_id":"s-parent","tool_input":{"command":"rm -rf /Users/x/project"}}'
v=$(wall_field x '.subAgent')
if [ "$v" = "null" ]; then ok
else bad "the session's own refusal names no sub-agent — want null, got '$v' in '$(tail -n 1 "$WEV" 2>/dev/null)'"; fi

# --- CLI-3: a trailing comment neither disarms a wall nor fakes a backup ---
# The old exemptions matched the target keyword / --force-with-lease anywhere
# in the string, so a comment tail waved a destructive act through — and the
# disarmed rm -rf then wrote a FALSE backup row into attestations.jsonl.
clear_rows
blocked "rm -rf disarmed by comment attestation" '{"tool_input":{"command":"rm -rf /Users/x/data # HARNESS_BACKUP_DONE=1"}}'

# --- D-0090: the attestation must PRECEDE the act ----------------------
# An attestation in a LATER segment attests for a command that has already
# run. `rm -rf X && HARNESS_BACKUP_DONE=1 echo done` deleted X unbacked-up
# and then wrote a row into governance/attestations.jsonl claiming a backup
# existed -- a false record in the audit sink Article 6 says is written by
# programs, and the CLI-3 defect class (a comment supplying the attestation)
# one shape along. Found by the Phase 2 adversarial round; ruled by User.
blocked "attestation AFTER the rm"        '{"tool_input":{"command":"rm -rf /Users/x/data && HARNESS_BACKUP_DONE=1 echo done"}}'
blocked "attestation after, semicolon"    '{"tool_input":{"command":"rm -rf /Users/x/data ; HARNESS_BACKUP_DONE=1 echo done"}}'
blocked "attestation after a db purge"    '{"tool_input":{"command":"psql -c \"DROP DATABASE prod\" && HARNESS_BACKUP_DONE=1 echo done"}}'
blocked "attestation after git reset"     '{"tool_input":{"command":"git reset --hard HEAD~3 && HARNESS_BACKUP_DONE=1 echo ok"}}'
# ...and a false row must not be written for any of them.
clear_rows
printf '%s' '{"tool_input":{"command":"rm -rf /Users/x/data && HARNESS_BACKUP_DONE=1 echo done"}}' | node "$HOOK" >/dev/null 2>&1
wrote "a refused late attestation writes NO row" 0

# The attestation still counts from an EARLIER segment, which is what an
# operator actually types when they back up first.
clear_rows
allowed "attested in an earlier segment"  '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 echo backed up && rm -rf /Users/x/data"}}'
allowed "attested after a cd"             '{"tool_input":{"command":"cd /app && HARNESS_BACKUP_DONE=1 rm -rf /Users/x/data"}}'
clear_rows
wrote   "comment-disarmed rm -rf writes NO false attestation row" 0
blocked "force push disarmed by lease comment" '{"tool_input":{"command":"git push --force origin main # --force-with-lease"}}'
# the attestation prefix must still be honoured when it is a REAL prefix, not a comment
clear_rows
allowed "real HARNESS_BACKUP_DONE=1 rm -rf prefix" '{"tool_input":{"command":"HARNESS_BACKUP_DONE=1 rm -rf /Users/x/data"}}'
wrote   "real attested rm -rf writes one row" 1 rm-rf
clear_rows
allowed "real force-with-lease push" '{"tool_input":{"command":"git push --force-with-lease origin feature-x"}}'

# --- CLI-4: the wall matches the ACT, not a quoted string or the prose word --
# A governance record or a --rationale/--summary that QUOTES a forbidden string
# runs none of it; walls_cmd_words drops that quoted prose, so the act-gate
# screens it out. Real acts of every class must still fire.
allowed "decide rationale quoting rm -rf"   '{"tool_input":{"command":"scrumux decide new --rationale \"we refuse rm -rf outside temp\""}}'
allowed "issue summary quoting drop table"  '{"tool_input":{"command":"scrumux issue new --summary \"guard against drop table\""}}'
allowed "coreutils truncate -s 0"           '{"tool_input":{"command":"truncate -s 0 build.log"}}'
allowed "prose mentioning truncate"         '{"tool_input":{"command":"echo \"remember to truncate the table later\""}}'
blocked "real rm -rf still fires under gate" '{"tool_input":{"command":"rm -rf /Users/x/project"}}'
blocked "real DROP TABLE still fires"        '{"tool_input":{"command":"sqlite3 app.db \"DROP TABLE users\""}}'
blocked "real TRUNCATE TABLE still fires"    '{"tool_input":{"command":"mysql -e \"TRUNCATE TABLE events\""}}'
blocked "real force push still fires"        '{"tool_input":{"command":"git push --force origin main"}}'

# --- CLI-4 augment: wrapped and shell-payload acts the act-gate had lost -----
# 078c3a9's act-gate correctly stopped judging QUOTED PROSE, but in doing so it
# stopped seeing the real program behind a non-mutating prefixer (nice/timeout/
# xargs/...) and inside a `sh -c "..."` payload — the old raw-grep wall caught
# both. walls_cmd_words now steps over the prefixer flag group, and the hook
# folds a shell interpreter's -c payload into the string the class regexes read
# (SCAN). Each case here exited 0 on the pre-augment hook and must exit 2 now.
#
# prefixer-wrapped rm -rf outside temp: the wrapper must not swallow the rm slot
blocked "xargs rm -rf"                        '{"tool_input":{"command":"find /Users/x | xargs rm -rf"}}'
blocked "bare xargs rm -rf"                   '{"tool_input":{"command":"xargs rm -rf"}}'
blocked "nice rm -rf"                         '{"tool_input":{"command":"nice rm -rf /Users/x/p"}}'
blocked "nice -n 10 rm -rf (flag+value)"      '{"tool_input":{"command":"nice -n 10 rm -rf /Users/x/p"}}'
blocked "timeout 5 rm -rf (numeric value)"    '{"tool_input":{"command":"timeout 5 rm -rf /Users/x/p"}}'
blocked "ionice rm -rf"                       '{"tool_input":{"command":"ionice rm -rf /Users/x/p"}}'
# shell-interpreter -c payloads are commands, not data
blocked "sh -c leading-space rm -rf"         '{"tool_input":{"command":"sh -c \" rm -rf /Users/x/p\""}}'
blocked "sh -c quote-adjacent rm -rf"        '{"tool_input":{"command":"sh -c \"rm -rf /Users/x/p\""}}'
blocked "sh -c chained cd; rm -rf"           '{"tool_input":{"command":"sh -c \"cd /Users/x; rm -rf .\""}}'
blocked "bash -c make && rm -rf"             '{"tool_input":{"command":"bash -c \"make && rm -rf /Users/x/p\""}}'
blocked "sh -c wrapping a DROP TABLE"        '{"tool_input":{"command":"sh -c '"'"'mysql -e \"DROP TABLE x\"'"'"'"}}'
# bundled short-flag -c (bash -lc, sh -cx, ...) — 2nd adversarial pass; the -c
# hides in a flag group and the payload wraps a program with its own -c
blocked "bash -lc rm -rf"                    '{"tool_input":{"command":"bash -lc \"rm -rf /Users/x/p\""}}'
blocked "sh -cx rm -rf"                      '{"tool_input":{"command":"sh -cx \"rm -rf /Users/x/p\""}}'
blocked "bash -xc rm -rf"                    '{"tool_input":{"command":"bash -xc \"rm -rf /Users/x/p\""}}'
blocked "sh -ce rm -rf"                      '{"tool_input":{"command":"sh -ce \"rm -rf /Users/x/p\""}}'
blocked "bash -lc git push --force"          '{"tool_input":{"command":"bash -lc \"git push --force\""}}'
blocked "bash -lc wrapping psql -c DROP"     '{"tool_input":{"command":"bash -lc \"psql -c \\\"DROP TABLE x\\\"\""}}'
allowed "python -c is not a shell (out of scope)" '{"tool_input":{"command":"python -c \"import os\""}}'
allowed "benign bash -lc build"              '{"tool_input":{"command":"bash -lc \"npm run build\""}}'
allowed "sh -c snippet as a verify arg"      '{"tool_input":{"command":"scrumux task order --verify \"sh -c grep -q X file\""}}'
# and the augment must NOT reintroduce the prose false-positives it exists past
allowed "prefixer name in prose stays allowed" '{"tool_input":{"command":"scrumux decide new --rationale \"run nice rm -rf only in temp\""}}'
allowed "sh -c named inside governance prose"  '{"tool_input":{"command":"scrumux issue new --summary \"never sh -c rm -rf on prod\""}}'
allowed "sh -c deleting temp space"            '{"tool_input":{"command":"sh -c \"rm -rf /tmp/scratch\""}}'
# a wrapped/payload block still records a SAFE subject, never the raw command (CLI-5)
WEV4="$SANDBOX/.scrumux/events.jsonl"
rm -f "$WEV4"
printf '%s' '{"tool_input":{"command":"nice rm -rf /Users/x/data --secret=sk-live-xyz"}}' | node "$HOOK" >/dev/null 2>&1
ref=$(jq -r '.refused' "$WEV4" 2>/dev/null | tail -n 1)
if printf '%s' "$ref" | grep -q 'sk-live\|rm -rf'; then bad "CLI-4 augment: wrapped block leaked raw cmd/secret into .refused: '$ref'"; else ok; fi
rm -f "$WEV4"
printf '%s' '{"tool_input":{"command":"sh -c \"rm -rf /Users/x/data --secret=sk-live-xyz\""}}' | node "$HOOK" >/dev/null 2>&1
ref=$(jq -r '.refused' "$WEV4" 2>/dev/null | tail -n 1)
if printf '%s' "$ref" | grep -q 'sk-live'; then bad "CLI-4 augment: shell-payload block leaked a secret into .refused: '$ref'"; else ok; fi

# --- CLI-5: a block records a SAFE subject, never the raw command ------------
# The refused subject on the event stream must be the target path (or program
# word), not the command line, which can carry a secret (walls-lib.sh:250-253).
WEV5="$SANDBOX/.scrumux/events.jsonl"
rm -f "$WEV5"
out=$(printf '%s' '{"tool_input":{"command":"rm -rf /Users/x/data --secret=sk-live-abc"}}' | node "$HOOK" 2>&1); rc=$?
if [ $rc -eq 2 ]; then ok; else bad "CLI-5 setup: rm -rf outside temp should block, rc=$rc: '$out'"; fi
ref=$(jq -r '.refused' "$WEV5" 2>/dev/null | tail -n 1)
if [ "$ref" = "/Users/x/data" ]; then ok
else bad "CLI-5: events .refused should be the target path '/Users/x/data', got '$ref'"; fi
if printf '%s' "$ref" | grep -q 'rm -rf\|sk-live'; then
  bad "CLI-5: events .refused leaked the raw command / secret: '$ref'"
else ok; fi
# a blocked force-push records the program word, not the command line
rm -f "$WEV5"
printf '%s' '{"tool_input":{"command":"git push --force origin main"}}' | node "$HOOK" >/dev/null 2>&1
ref=$(jq -r '.refused' "$WEV5" 2>/dev/null | tail -n 1)
if [ "$ref" = "git" ]; then ok
else bad "CLI-5: blocked force-push .refused should be 'git', got '$ref'"; fi
# and the DISPLAYED stderr still carries the full command for the agent to read
out=$(printf '%s' '{"tool_input":{"command":"rm -rf /Users/x/data --secret=sk-live-abc"}}' | node "$HOOK" 2>&1)
if printf '%s' "$out" | grep -q 'sk-live-abc'; then ok
else bad "CLI-5: stderr should still show the full command to the agent: '$out'"; fi


# --- OQ-17 (D-0085): GNU long flags and the -rd spelling ----------------
# The short-flag matrix above is macOS-shaped: this machine's `rm` rejects
# --recursive, so nobody hit the gap. GNU coreutils accepts it, and the
# TS port's entire purpose is running on platforms this shell never did --
# a Linux or Windows user's `rm --recursive --force` performs exactly the
# act this wall names and walked straight past it (measured rc=0).
blocked "OQ-17: rm --recursive --force"        '{"tool_input":{"command":"rm --recursive --force /Users/x/project"}}'
blocked "OQ-17: rm --force --recursive (order)" '{"tool_input":{"command":"rm --force --recursive /Users/x/project"}}'
blocked "OQ-17: long flags with a path between" '{"tool_input":{"command":"rm --recursive -v --force /Users/x/project"}}'
blocked "OQ-17: rm -rd"                        '{"tool_input":{"command":"rm -rd /Users/x/project"}}'
blocked "OQ-17: rm -dr"                        '{"tool_input":{"command":"rm -dr /Users/x/project"}}'

# the temp exemption applies to the new spellings too -- temp space is what
# temp space is for, whichever flag spelling got there.
allowed "OQ-17: rm --recursive --force in /tmp" '{"tool_input":{"command":"rm --recursive --force /tmp/scratch"}}'
allowed "OQ-17: rm -rd in /tmp"                 '{"tool_input":{"command":"rm -rd /tmp/scratch"}}'

# --no-preserve-root stays unconditional on the long spelling as well.
blocked "OQ-17: long flags + --no-preserve-root" '{"tool_input":{"command":"rm --recursive --force --no-preserve-root /"}}'

# UNCHANGED: a single flag is still not this class. `rm -r` and `rm -f`
# alone were never blocked and D-0085 does not widen that.
allowed "OQ-17: rm -r alone unchanged"          '{"tool_input":{"command":"rm -r /Users/x/project"}}'
allowed "OQ-17: rm -f alone unchanged"          '{"tool_input":{"command":"rm -f /Users/x/project"}}'
allowed "OQ-17: rm --recursive alone unchanged" '{"tool_input":{"command":"rm --recursive /Users/x/project"}}'
allowed "OQ-17: rm --force alone unchanged"     '{"tool_input":{"command":"rm --force /Users/x/project"}}'

# prose still runs no rm (the CLI-4 act-gate is untouched by this widening)
allowed "OQ-17: prose quoting the long form" \
  '{"tool_input":{"command":".claude/scripts/scrumux decide new --title t --decision d --rationale \"never run rm --recursive --force on a repo\" --by x"}}'

printf 'hook-destructive-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "hook-destructive-tests: error: $FAIL case(s) wrong — fix .claude/hooks/block-destructive.sh patterns before trusting the hold" >&2
  exit 1
fi
exit 0
