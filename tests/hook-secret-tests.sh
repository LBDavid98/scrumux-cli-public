#!/bin/sh
# hook-secret-tests.sh — T-0013 acceptance: secret-pattern reads blocked
# (exit 2 with instructive stderr), normal reads unaffected (exit 0).
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
HOOK="$ROOT/.deploy-claude/dist/block-secret-reads.mjs"

# T-0133 gave the hooks gate emission, and this suite drives 26 real
# denials — without a sandbox every one of them wrote a row into the LIVE
# the live governance journals. 105 rows of test noise landed there
# before it was
# caught, which made the first real gate-cost ranking meaningless (that
# ranking script left the CLI in T-0186). A suite
# that exercises a writer must redirect the write.
SANDBOX=$(mktemp -d) || { echo "hook-secret-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/governance"
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

blocked() { # blocked <desc> <json>
  out=$(printf '%s' "$2" | node "$HOOK" 2>&1); rc=$?
  if [ $rc -eq 2 ] && printf '%s' "$out" | grep -q 'BLOCKED by block-secret-reads' && printf '%s' "$out" | grep -q 'CLAUDE.MD hard limit'; then ok
  else bad "$1 — want exit 2 + instructive message, got rc=$rc: '$out'"; fi
}
allowed() { # allowed <desc> <json>
  out=$(printf '%s' "$2" | node "$HOOK" 2>&1); rc=$?
  if [ $rc -eq 0 ] && [ -z "$out" ]; then ok
  else bad "$1 — want silent exit 0, got rc=$rc: '$out'"; fi
}

# --- Read tool: blocked patterns -------------------------------------
blocked "Read .env"                  '{"tool_input":{"file_path":"/app/.env"}}'
blocked "Read .env.local"            '{"tool_input":{"file_path":"/app/.env.local"}}'
blocked "Read id_rsa"                '{"tool_input":{"file_path":"/Users/x/.ssh/id_rsa"}}'
blocked "Read id_ed25519"            '{"tool_input":{"file_path":"/Users/x/.ssh/id_ed25519"}}'
blocked "Read cert.pem"              '{"tool_input":{"file_path":"/etc/ssl/cert.pem"}}'
blocked "Read server.key"            '{"tool_input":{"file_path":"/etc/ssl/server.key"}}'
blocked "Read gateway app key file"  '{"tool_input":{"file_path":"/Users/x/gateway/keys/apps/harness.json"}}'
blocked "Read assembled key map"     '{"tool_input":{"file_path":"/x/GATEWAY_API_KEYS.json"}}'
blocked "Read credentials.json"      '{"tool_input":{"file_path":"/x/credentials.json"}}'
blocked "Read secrets.yaml"          '{"tool_input":{"file_path":"/x/secrets.yaml"}}'
blocked "Read .netrc"                '{"tool_input":{"file_path":"/Users/x/.netrc"}}'

# --- Read tool: allowed --------------------------------------------
allowed "Read normal python file"    '{"tool_input":{"file_path":"/app/main.py"}}'
allowed "Read .env.example"          '{"tool_input":{"file_path":"/app/.env.example"}}'
allowed "Read settings template"     '{"tool_input":{"file_path":"/x/local.settings.json.example"}}'
allowed "Read environment.py"        '{"tool_input":{"file_path":"/app/environment.py"}}'
allowed "Read keyboard.py"           '{"tool_input":{"file_path":"/app/keyboard.py"}}'
allowed "Read monkey.json"           '{"tool_input":{"file_path":"/data/monkey.json"}}'

# --- Bash tool: blocked ----------------------------------------------
blocked "Bash cat .env"              '{"tool_input":{"command":"cat /app/.env"}}'
blocked "Bash grep in id_rsa"        '{"tool_input":{"command":"grep key ~/.ssh/id_rsa"}}'
blocked "Bash cat gateway key"       '{"tool_input":{"command":"cat keys/apps/foo.json"}}'
blocked "Bash quoted secret path"    '{"tool_input":{"command":"less \"/etc/app/secrets.json\""}}'

# --- Bash tool: allowed ----------------------------------------------
allowed "Bash normal command"        '{"tool_input":{"command":"cat README.md"}}'
allowed "Bash ls of keys dir"        '{"tool_input":{"command":"ls ~/gateway/keys/apps"}}'
allowed "Bash env command"           '{"tool_input":{"command":"env | sort"}}'
allowed "Bash keyword mention"       '{"tool_input":{"command":"grep -r monkey src/"}}'

# --- no input / no jq degradation ------------------------------------
allowed "empty input"                '{}'

# --- prose is not a path (I-0135) -------------------------------------
# A file_path IS a path, so a bare word there is a filename. A Bash
# command is a sentence that may quote prose, and "credentials" is an
# ordinary English word — as is a task order saying not to read
# authorized_keys. The command arm requires path context; the Read arm
# does not. The wall refused `scrumux task new --check "no credentials appear
# anywhere"`, which is the third false positive of one session.
cmd_json() { jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }

allowed "prose: a check that says no credentials appear" \
  "$(cmd_json '.claude/scripts/scrumux task new --title "t" --check "no credentials appear anywhere in the notebook"')"
allowed "prose: an out-of-scope naming authorized_keys" \
  "$(cmd_json '.claude/scripts/scrumux task order T-0001 --out "never read authorized_keys or known_hosts"')"
allowed "prose: a log entry mentioning credentials" \
  "$(cmd_json '.claude/scripts/scrumux log new --title x --did "scanned the notebook for credentials and found none"')"
allowed "counting the word in a file is not reading a secret" \
  "$(cmd_json 'grep -c credentials notebook.ipynb')"

blocked "cmd: credentials.json"      "$(cmd_json 'cat config/credentials.json')"
blocked "cmd: authorized_keys path"  "$(cmd_json 'cat /Users/x/.ssh/authorized_keys')"
blocked "cmd: known_hosts path"      "$(cmd_json 'cat ~/.ssh/known_hosts')"
blocked "cmd: id_rsa"                "$(cmd_json 'cat ~/.ssh/id_rsa')"
blocked "cmd: .env"                  "$(cmd_json 'cat .env')"
blocked "cmd: gateway app key"       "$(cmd_json 'cat keys/apps/gateway.json')"
blocked "cmd: .netrc"                "$(cmd_json 'cat ~/.netrc')"

blocked "Read arm still matches a bare credentials filename" \
  '{"tool_input":{"file_path":"/repo/credentials"}}'
blocked "Read arm still matches bare authorized_keys" \
  '{"tool_input":{"file_path":"/home/x/.ssh/authorized_keys"}}'

# --- the SHELL reads too (I-0142) --------------------------------------
# I-0141 narrowed this wall to a reader-command allowlist, which made
# `read K < .env` legal — it had NOT been before. These are the idioms
# where the shell opens the file and the program never sees a path.
# Every wall test in this suite before today asserted that prose is not
# falsely blocked; not one asserted that an evasion is still caught.
for c in \
  'read K < .env' \
  'X=$(<.env)' \
  'X=$(< .env)' \
  'while IFS= read -r l; do echo "$l"; done < .env' \
  'source .env' \
  'cat .env'
do
  run_c=$(cmd_json "$c")
  blocked "shell-level read: $c" "$run_c"
done

# --- D-0090: whitespace is the WALL DIALECT's set, on every host ---------
# `cat <NBSP.env` is a shell read wherever it runs, but whether the bash
# wall SAW `.env` as its own operand depended on whose tr was on PATH:
# BSD tr under a UTF-8 locale splits a non-breaking space, GNU tr is
# byte-oriented and never does — so on glibc the operand stayed
# `<NBSP.env`, nothing anchored, and the wall allowed what the TS wall
# refuses (ubuntu walls lane 1594/1600, six seeded cases). The splitter
# now translates the Unicode spaces of the ratified dialect itself,
# byte-sequence under LC_ALL=C, so these hold on every machine. The
# NBSP/em-space payloads carry the RAW bytes; the VT/FF/CR ones carry
# JSON \u escapes (a raw control byte is not valid JSON in either
# implementation, so those decode inside the parser instead).
blocked "posix-space: NBSP beside a redirect" '{"tool_input":{"command":"cat < .env"}}'
blocked "posix-space: NBSP later in the line" '{"tool_input":{"command":"read K < .env"}}'
blocked "posix-space: em space, NOT posix space" '{"tool_input":{"command":"cat < .env"}}'
blocked "posix-space: vertical tab (JSON-escaped)" '{"tool_input":{"command":"cat <\u000b.env"}}'
blocked "posix-space: form feed (JSON-escaped)" '{"tool_input":{"command":"cat <\u000c.env"}}'
blocked "posix-space: carriage return (JSON-escaped)" '{"tool_input":{"command":"cat <\u000d.env"}}'

# --- CLI-2: the .example exemption is PER-OPERAND in the command arm -----
# A whole-command `.example` exemption was a hole: one .example token waved
# the whole line through, so `cp .env.example .env && cat .env` read a real
# secret. Each read operand is now judged on its own — a sibling .env trips
# the wall even when an .env.example sits beside it in the same command.
blocked "CLI-2: cp .env.example .env && cat .env reads a real secret" \
  "$(cmd_json 'cp .env.example .env && cat .env')"
blocked "CLI-2: example + real target in one command" \
  "$(cmd_json 'cat .env.example .env')"
blocked "CLI-2: wrapped read still blocks via the allowlist (nice)" \
  "$(cmd_json 'nice cat /app/.env')"

allowed "CLI-2: cat .env.example (only an example operand)" \
  "$(cmd_json 'cat .env.example')"
allowed "CLI-2: cat config.env.template" \
  "$(cmd_json 'cat config.env.template')"
allowed "CLI-2: cat .env.sample" \
  "$(cmd_json 'cat .env.sample')"

# --- CLI-5: a secret must never reach the event stream -------------------
# The wall used to record $target — in the Bash arm the WHOLE command,
# secret and all. It now records the reading program word only. stderr
# still shows the full command (displayed to the agent, never persisted).
cli5_json=$(cmd_json 'cat /app/.env --token=sk-SECRET')
out=$(printf '%s' "$cli5_json" | node "$HOOK" 2>&1); rc=$?
EV="$GOV_ROOT/.scrumux/events.jsonl"
if [ $rc -ne 2 ]; then bad "CLI-5: blocked cat should exit 2, got rc=$rc"; else ok; fi
if [ ! -s "$EV" ]; then
  bad "CLI-5: expected a wall row in $EV, found none"
else
  refused=$(jq -r 'select(.wall=="block-secret-reads") | .refused' "$EV" | tail -1)
  if [ "$refused" = "cat" ]; then ok
  else bad "CLI-5: .refused must be the program word 'cat', got '$refused'"; fi
  if printf '%s' "$refused" | grep -q 'sk-SECRET'; then
    bad "CLI-5: the secret token leaked into .refused: '$refused'"
  else ok; fi
  if printf '%s' "$refused" | grep -q '/app/.env'; then
    bad "CLI-5: the full secret path leaked into .refused: '$refused'"
  else ok; fi
fi
# stderr DOES carry the full command for the agent (not persisted).
if printf '%s' "$out" | grep -q 'BLOCKED by block-secret-reads'; then ok
else bad "CLI-5: stderr should still instruct the agent, got '$out'"; fi


# =======================================================================
# Phase 1a (D-0085): the secret wall's residuals, RED-FIRST.
# The handoff's §5 names these as the parity spec's known-wrong half: the
# TS port must reproduce the CORRECTED behaviour, so bash is fixed first
# and these assertions are what "fixed" means.
# =======================================================================

# --- 1a-1: cp and mv read their SOURCE operands only --------------------
# The CLI-2 per-operand fix judged EVERY operand, so a benign setup step
# was read as a secret read: `cp .env.example .env` blocks today. A cp/mv
# DESTINATION is written, not read. Sources still count, so exfiltration
# and a sibling reader in the same line are both still caught.
allowed "1a: cp .env.example .env (destination is written, not read)" \
  "$(cmd_json 'cp .env.example .env')"
allowed "1a: mv .env.example .env" \
  "$(cmd_json 'mv .env.example .env')"
allowed "1a: cp -n .env.template .env (a flag does not change the shape)" \
  "$(cmd_json 'cp -n .env.template .env')"

blocked "1a: cp .env /tmp/exfil still blocks (the SOURCE is a read)" \
  "$(cmd_json 'cp .env /tmp/exfil')"
blocked "1a: mv .env /tmp/exfil still blocks" \
  "$(cmd_json 'mv .env /tmp/exfil')"
blocked "1a: cp .env .env.bak (secret source, benign destination)" \
  "$(cmd_json 'cp .env .env.bak')"
blocked "1a: cp .env.example .env && cat .env still blocks on the cat" \
  "$(cmd_json 'cp .env.example .env && cat .env')"

# --- 1a-2: content-revealing readers the allowlist never named ----------
for c in \
  'dd if=.env' \
  'nl .env' \
  'tac .env' \
  'bat .env' \
  'vim .env' \
  'view .env' \
  'ex .env'
do
  blocked "1a reader: $c" "$(cmd_json "$c")"
done

# --- 1a-3: busybox/toybox multiplexers are stepped over -----------------
# Same shape as the nice/timeout step-over already in walls_cmd_words:
# strictly "look at MORE", so it can only strengthen every wall.
blocked "1a: busybox cat .env" "$(cmd_json 'busybox cat .env')"
blocked "1a: toybox cat .env"  "$(cmd_json 'toybox cat .env')"

# --- 1a-4: STRONG broadened -------------------------------------------
# >=1 dot-segment (Next.js ships .env.production.local), a ~ terminator
# (editor backups), and the <name>.env form.
blocked "1a: .env.production.local (two dot-segments)"  "$(cmd_json 'cat .env.production.local')"
blocked "1a: .env.development.local"                    "$(cmd_json 'cat .env.development.local')"
blocked "1a: .env~ (editor backup)"                     "$(cmd_json 'cat .env~')"
blocked "1a: prod.env"                                  "$(cmd_json 'cat prod.env')"
blocked "1a: staging.env"                               "$(cmd_json 'cat staging.env')"
blocked "1a: Read arm .env.production.local"            '{"tool_input":{"file_path":"/app/.env.production.local"}}'

# The exemption must survive the broadening.
allowed "1a: .env.production.example still exempt" "$(cmd_json 'cat .env.production.example')"
allowed "1a: prod.env.template still exempt"       "$(cmd_json 'cat prod.env.template')"
allowed "1a: environment.py is not a <name>.env"   "$(cmd_json 'cat environment.py')"
allowed "1a: Read arm .env.production.example"     '{"tool_input":{"file_path":"/app/.env.production.example"}}'


# --- 1a-5: read_operands, at the HELPER level ---------------------------
# GONE WITH THE BASH WALL. This block sourced walls-lib.sh and `eval`ed
# `split_words` and `read_operands` straight out of the wall's shell source,
# because a one-character defect in read_operands (printf writes no trailing
# newline, so `read` never fired for the final segment) emptied the operand
# list for EVERY command and turned the whole Bash arm into exit 0 while 41 of
# the 82 end-to-end cases above went red with an invisible cause.
#
# The function is TypeScript now and cannot be reached from a shell. The same
# claim is asserted directly against it in test/unit/walls-hardenE.test.ts and
# test/unit/walls-hooks.test.ts, which is where a helper-level assertion
# belongs once the helper is not a shell function.

# --- 1a-6: cp/mv destination is only the last operand when POSITIONAL ---
# GNU `cp -t DIR SRC...` / `--target-directory=DIR` puts the destination in
# a FLAG, so every remaining operand is a SOURCE. Dropping the last one
# there lets `cp -t /tmp .env` exfiltrate.
blocked "1a: cp -t /tmp .env (destination is in the flag)" \
  "$(cmd_json 'cp -t /tmp .env')"
blocked "1a: cp --target-directory=/tmp .env" \
  "$(cmd_json 'cp --target-directory=/tmp .env')"
blocked "1a: cp -rt /tmp .env (bundled short flags)" \
  "$(cmd_json 'cp -rt /tmp .env')"
blocked "1a: mv -t /tmp .env" \
  "$(cmd_json 'mv -t /tmp .env')"
allowed "1a: cp -t /tmp .env.example (flag form, exempt source)" \
  "$(cmd_json 'cp -t /tmp .env.example')"
blocked "1a: cp .env (one operand is not a destination)" \
  "$(cmd_json 'cp .env')"

# --- 1a-7: a flag-attached path is still a read -------------------------
# Flag-stripping is only needed to LOCATE cp/mv's positional destination.
# Applied to every command it drops any path attached to a flag, which is
# a hole D-0085 does not authorise -- both of these block at HEAD.
blocked "1a: docker run --env-file=.env img" \
  "$(cmd_json 'docker run --env-file=.env img')"
blocked "1a: cat --file=/home/x/.ssh/id_rsa" \
  "$(cmd_json 'cat --file=/home/x/.ssh/id_rsa')"

# --- 1a-8: the <name>.env broadening must not eat ordinary sources ------
# D-0085 item 3 asks for `prod.env` / `staging.env`, NOT `<name>.env.<seg>`.
allowed "1a: test.env.js is a source file, not a secret" \
  "$(cmd_json 'cat test.env.js')"
allowed "1a: webpack.env.config.js" \
  "$(cmd_json 'cat webpack.env.config.js')"

printf 'hook-secret-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "hook-secret-tests: error: $FAIL case(s) wrong — fix .claude/hooks/block-secret-reads.sh patterns before trusting the hold" >&2
  exit 1
fi
exit 0
