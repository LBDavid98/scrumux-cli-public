#!/bin/sh
# scrumux secret — a secret reaches the repo's .env and reaches nothing else.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

command -v git >/dev/null 2>&1 || { echo "scrumux-secret-tests: git absent, skipping"; exit 0; }
TMPD=$(mktemp -d) || exit 1
trap 'rm -rf "$TMPD"' EXIT
R="$TMPD/repo"; mkdir -p "$R"; (cd "$R" && git init -q)
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$R" >/dev/null 2>&1 || { echo "scrumux-secret-tests: deploy failed" >&2; exit 1; }
G="$R/.claude/scripts/scrumux"
SEC='sk-live-DO-NOT-LEAK-abc123'

# --- 1. the stdin form, which is the one an agent must use -------------
printf %s "$SEC" | (cd "$R" && "$G" secret set SERPAPI_KEY >/dev/null) \
  && ok || bad "stdin form failed"
grep -q "^SERPAPI_KEY=$SEC\$" "$R/.env" && ok || bad "the value did not reach .env"

# --- 2. gitignored BEFORE the value is written, and mode 600 ----------
grep -qE '^\.env$' "$R/.gitignore" && ok || bad ".env was not added to .gitignore"
[ "$(ls -l "$R/.env" | cut -c1-10)" = "-rw-------" ] && ok || bad ".env is not mode 600"
(cd "$R" && git status --porcelain --ignored=no | grep -q '\.env') \
  && bad ".env shows as untracked-and-committable — the ignore did not take" || ok

# --- 3. the value reaches NOTHING else --------------------------------
# The whole point. Journals, logs, gitignore, git objects: none of them.
HITS=$(grep -rl "$SEC" "$R" 2>/dev/null | grep -v "^$R/\.env$" | wc -l | tr -d ' ')
[ "$HITS" -eq 0 ] && ok || bad "the value appears outside .env in $HITS file(s): $(grep -rl "$SEC" "$R" 2>/dev/null | grep -v "^$R/\.env$" | tr '\n' ' ')"

# --- 4. --list shows names, never values ------------------------------
OUT=$(cd "$R" && "$G" secret list)
printf '%s' "$OUT" | grep -q 'SERPAPI_KEY' && ok || bad "--list did not name the secret"
printf '%s' "$OUT" | grep -q "$SEC" && bad "--list PRINTED THE VALUE" || ok

# --- 5. there is no way to read a value back --------------------------
# And `secret get NAME` must not quietly store a secret called "get".
(cd "$R" && "$G" secret set get SERPAPI_KEY 2>&1 | grep -q "there is no 'get'") \
  && ok || bad "'scrumux secret get' was not refused — it stores a secret named 'get'"
grep -q '^get=' "$R/.env" && bad "'scrumux secret get' created a secret named get" || ok

# --- 6. replace keeps one line, and keeps the neighbours --------------
printf %s 'second' | (cd "$R" && "$G" secret set SERPAPI_KEY >/dev/null)
printf %s 'neighbour' | (cd "$R" && "$G" secret set OTHER_KEY >/dev/null)
[ "$(grep -c '^SERPAPI_KEY=' "$R/.env")" -eq 1 ] && ok || bad "replace left duplicate lines"
grep -q '^SERPAPI_KEY=second$' "$R/.env" && ok || bad "replace did not take"
grep -q '^OTHER_KEY=neighbour$' "$R/.env" && ok || bad "replace clobbered another secret"

# grep -v exits 1 when it selects nothing, which is exactly the
# only-one-secret case. That broke the first cut silently.
R2="$TMPD/solo"; mkdir -p "$R2"; (cd "$R2" && git init -q)
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$R2" >/dev/null 2>&1
printf %s 'one' | (cd "$R2" && "$R2/.claude/scripts/scrumux" secret set ONLY >/dev/null)
printf %s 'two' | (cd "$R2" && "$R2/.claude/scripts/scrumux" secret set ONLY >/dev/null)
[ "$(grep -c '^ONLY=' "$R2/.env")" -eq 1 ] && ok || bad "replacing the ONLY secret left a duplicate"
grep -q '^ONLY=two$' "$R2/.env" && ok || bad "replacing the only secret did not take"

# --- 7. no temp file is ever left behind ------------------------------
[ "$(find "$R" "$R2" -name '.env.tmp.*' 2>/dev/null | wc -l | tr -d ' ')" -eq 0 ] \
  && ok || bad "a .env.tmp.* file survives — it holds every other secret and no gitignore rule covers it"

# --- 8. --remove takes one and leaves the rest ------------------------
(cd "$R" && "$G" secret remove SERPAPI_KEY >/dev/null)
[ "$(grep -c '^SERPAPI_KEY=' "$R/.env")" -eq 0 ] && ok || bad "--remove did not remove"
grep -q '^OTHER_KEY=' "$R/.env" && ok || bad "--remove took a neighbour with it"

# --- 9. refusals ------------------------------------------------------
(cd "$R" && "$G" secret set my-key val 2>&1 | grep -q 'environment variable name') \
  && ok || bad "a name that is not a valid env var was accepted"
(printf %s '' | (cd "$R" && "$G" secret set EMPTYV) 2>&1 | grep -q 'is empty') \
  && ok || bad "an empty value was accepted"
(printf 'a\nb\n' | (cd "$R" && "$G" secret set MULTI) 2>&1 | grep -q 'contains a newline') \
  && ok || bad "a multi-line value was accepted into a one-line-per-name file"

# A tracked .env is worse than an un-ignored one: gitignore does not
# apply to it, so the next commit ships the secret.
R3="$TMPD/tracked"; mkdir -p "$R3"; (cd "$R3" && git init -q)
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$R3" >/dev/null 2>&1
printf 'X=1\n' > "$R3/.env"
(cd "$R3" && git add -f .env >/dev/null 2>&1 && git -c user.name=t -c user.email=t@t commit -qm t >/dev/null 2>&1)
(printf %s 'v' | (cd "$R3" && "$R3/.claude/scripts/scrumux" secret set NEWONE) 2>&1 | grep -q 'ALREADY TRACKED') \
  && ok || bad "writing into a git-tracked .env was allowed"


# --- PK-13 (D-0085): an `export NAME=` line is the same secret ----------
# .env files are commonly written with an export prefix -- many tools emit
# it and `source .env` needs it in some shells. Every match here was
# `^NAME=`, so an export-prefixed line was invisible to all three verbs,
# and the SET case is the dangerous one: the old line is not dropped, the
# new one is appended, and the OLD SECRET VALUE SURVIVES in the file beside
# it. list also rendered the name as "export NAME".
OLDSEC='sk-OLD-VALUE-must-not-survive-xyz'
printf 'export EXPORTED_KEY=%s\n' "$OLDSEC" >> "$R/.env"

# list: the name is the variable, not "export NAME"
LOUT=$(cd "$R" && "$G" secret list 2>&1)
printf '%s' "$LOUT" | grep -qE '(^|[[:space:]])EXPORTED_KEY[[:space:]]' \
  && ok || bad "PK-13: secret list must name an export-prefixed key as EXPORTED_KEY; got: $LOUT"
printf '%s' "$LOUT" | grep -q 'export EXPORTED_KEY' \
  && bad "PK-13: secret list rendered the name as 'export EXPORTED_KEY' — the prefix is syntax, not part of the name" || ok

# set: replacing it must REMOVE the old line, value and all
NEWSEC='sk-NEW-VALUE-abc'
printf %s "$NEWSEC" | (cd "$R" && "$G" secret set EXPORTED_KEY >/dev/null 2>&1)
grep -q "$OLDSEC" "$R/.env" \
  && bad "PK-13: the OLD secret value survived in .env after set — an export-prefixed line was not dropped" || ok
[ "$(grep -c 'EXPORTED_KEY' "$R/.env")" = 1 ] \
  && ok || bad "PK-13: EXPORTED_KEY appears $(grep -c 'EXPORTED_KEY' "$R/.env") times in .env — set must replace, not duplicate"

# remove: it must find an export-prefixed line
printf 'export REMOVE_ME=%s\n' 'sk-remove-me' >> "$R/.env"
(cd "$R" && "$G" secret remove REMOVE_ME >/dev/null 2>&1) \
  && ok || bad "PK-13: secret remove must find an export-prefixed key"
grep -q 'REMOVE_ME' "$R/.env" \
  && bad "PK-13: REMOVE_ME still in .env after remove" || ok

printf 'scrumux-secret-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
