#!/bin/sh
# Every command the skills and rules TELL an agent to run must survive
# every wall, in a repo the harness was deployed into.
#
# This suite exists because I-0132 and I-0134 were both shipped by a
# hook whose own unit tests were green. Those tests asserted what their
# author thought of; nothing asserted the obvious invariant — that the
# machine does not refuse its own documented instructions. I-0134 was
# precisely a skill (session-open: "if a query fails, say so in the
# order") requiring a sentence a wall forbade.
#
# The corpus is EXTRACTED from the shipped prose, not hand-written, so a
# command added to a skill is covered the day it is added.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

command -v jq >/dev/null 2>&1 || { echo "deployed-session-corpus-tests: jq absent, skipping"; exit 0; }

TMPD=$(mktemp -d) || exit 1
trap 'rm -rf "$TMPD"' EXIT
DEPLOYED="$TMPD/deployment"
mkdir -p "$DEPLOYED/.claude" "$DEPLOYED/governance"
printf '{"source_remote":"https://github.com/LBDavid98/scrumux-cli-public.git","files":{}}\n' > "$DEPLOYED/.claude/DEPLOYED"

WALLS="block-upstream-edit block-direct-llm block-destructive block-secret-reads"

# Run one command string through every wall. Any exit 2 is a refusal.
# The walls are the shipped .mjs bundles, not the bash .sh they replaced —
# there is no dispatcher shim left to drive by path.
refuses() { # refuses <command-string> -> prints the refusing wall(s)
  _r=""
  for w in $WALLS; do
    _out=$(printf '%s' "$(jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}')" \
      | GOV_ROOT="$DEPLOYED" node "$ROOT/.deploy-claude/dist/$w.mjs" 2>/dev/null)
    [ $? -eq 2 ] && _r="$_r $w"
  done
  printf '%s' "$_r"
}

# --- 1. the extracted corpus ------------------------------------------
# Every line in the shipped skills and rules that invokes a harness
# script, with continuations joined and placeholders left as written —
# the walls read strings, not arguments.
{
  cat "$ROOT"/.deploy-claude/skills/*/SKILL.md
  cat "$ROOT"/.deploy-claude/rules/*.md
} 2>/dev/null \
  | sed 's/\\$//' \
  | grep -oE '(\.claude/scripts/)?(scrumux|status|harness|backlog|graph|task-brief|task-lint|task-verify|records-check|session-check|readonly-sh) [^`|]*' \
  | sed 's/[[:space:]]*$//' \
  | sort -u > "$TMPD/corpus"

CORPUS_N=$(wc -l < "$TMPD/corpus" | tr -d ' ')
[ "$CORPUS_N" -ge 15 ] \
  && ok || bad "the corpus extracted only $CORPUS_N command(s) from the shipped prose — the grep has drifted from how the skills are written, and this suite is asserting nothing"

while IFS= read -r c; do
  [ -n "$c" ] || continue
  r=$(refuses "$c")
  if [ -z "$r" ]; then ok; else
    bad "a documented command is refused by$r: $c"
  fi
done < "$TMPD/corpus"

# --- 2. prose that NAMES the machinery (I-0134) -----------------------
# session-open: "If a query fails, say so in the order rather than
# leaving the gap silent." An order cannot say which query failed if
# naming the script is refused.
for c in \
  '.claude/scripts/scrumux task new --title "t" --check "mentions .claude/scripts/scrumux graph in a string"' \
  '.claude/scripts/scrumux task order T-0001 --scope "graph is unavailable in this deployment" --verify ".claude/scripts/scrumux task verify T-0001" --file ".claude/dist/block-direct-llm.mjs | the wall under test"' \
  '.claude/scripts/scrumux issue new --type harness --source claude --summary "block-upstream-edit.sh refuses .claude/scripts/scrumux" --fix "read the command word"' \
  '.claude/scripts/scrumux log new --title "close" --did "ran .claude/scripts/scrumux records check and it exited 0"' \
  '.claude/scripts/scrumux decide new --title "d" --decision "call OpenAI direct" --rationale "see .claude/project-walls.conf" --by User' \
  '.claude/scripts/scrumux task new --title "t" --check "no credentials appear anywhere in the notebook"' \
  '.claude/scripts/scrumux task order T-0001 --scope "scan for leaked keys" --verify "grep -c credentials notebook.ipynb" --out "never read authorized_keys"' \
  '.claude/scripts/scrumux decide new --title "d" --decision "declare the exemption" --rationale "api.openai.com is called directly by this coursework" --by User' \
  'git commit -m "wired .env loading via dotenv, key never printed"' \
  'git commit -m "store SERPAPI_KEY through scrumux secret rather than credentials.json"'
do
  r=$(refuses "$c")
  [ -z "$r" ] && ok || bad "prose naming the machinery is refused by$r: $c"
done

# --- 3. the walls still hold ------------------------------------------
# The corpus must not become an argument for a wall that never fires.
for c in \
  'echo x >> .claude/scripts/scrumux' \
  'cp /tmp/x .claude/scripts/scrumux' \
  'sed -i "" s/a/b/ .claude/dist/block-destructive.mjs' \
  'cat /tmp/x > .claude/scripts/scrumux records check' \
  '.claude/scripts/scrumux log new --title x --did y && echo z >> .claude/schemas/task.schema.json'
do
  r=$(refuses "$c")
  case "$r" in *block-upstream-edit*) ok ;; *) bad "a real write to the machinery was NOT refused: $c" ;; esac
done

printf 'deployed-session-corpus-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && { echo "deployed-session-corpus-tests: error: the machine refuses its own instructions" >&2; exit 1; }
exit 0
