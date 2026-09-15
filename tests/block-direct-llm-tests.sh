#!/bin/sh
# block-direct-llm-tests.sh — T-0188 acceptance: the third wall
# (constitution boundary 1, "no LLM call outside the gateway") is
# exercised. Commands that name a provider API domain are blocked
# (exit 2 + instructive stderr) and leave one gate row; gateway-host
# commands and ordinary shell work pass silently and leave none.
#
# Two hooks already had suites; this one did not, so the only wall with
# no test was the one whose whole content is a single domain regex —
# the shape most likely to rot silently when a provider is added.
#
# Run: sh tests/block-direct-llm-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
HOOK="$ROOT/.deploy-claude/dist/block-direct-llm.mjs"
LIVE_GATES="$ROOT/governance/gates.json"

[ -f "$HOOK" ] || { echo "block-direct-llm-tests: error: missing $HOOK" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || {
  echo "block-direct-llm-tests: error: jq is required — the hook degrades to exit 0 without it, so every case would vacuously pass" >&2
  exit 1
}

# I-0090 kept this suite sandboxed because the hook used to write a gate
# row per denial into the live journal. The emission is gone; the sandbox
# stays, because a hook under test must never touch the real repo
# — shape-indistinguishable from real firings, exactly the noise that
# made the first gate-cost ranking meaningless. Sandbox first, before the
# first hook invocation.
SANDBOX=$(mktemp -d) || { echo "block-direct-llm-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT INT TERM
mkdir -p "$SANDBOX/governance"
GOV_ROOT="$SANDBOX"; export GOV_ROOT
GATES="$SANDBOX/governance/gates.json"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

clear_rows() { :; }   # the wall writes no journal; nothing to reset

# blocked <desc> <json> — exit 2 and the instructive message. A wall says
# no AND why, and points at the right standard: the message must name the
# rule and carry a NEXT MOVE, or the agent is refused with nowhere to go.
#
# D-0086: the remedy no longer names one installation's private gateway, so
# this no longer greps for one. The generic contract has two halves that
# fail for different reasons, so they are asserted separately -- the
# PRINCIPLE (traffic goes through a declared gateway) and the SANCTIONED
# ESCAPE (the project-walls.conf allow line). A refusal missing the second
# is the Article 5 failure this check exists to catch. Strictly looser than
# the trademark string it replaces: a common word and a payload-relative
# path, neither of which assumes whose infrastructure this is.
#
# It no longer writes a gate row. 251 rows accumulated and nothing ever
# read one; not a single row came from any wall's denial being useful.
blocked() {
  clear_rows
  out=$(printf '%s' "$2" | node "$HOOK" 2>&1); rc=$?
  if [ $rc -ne 2 ]; then bad "$1 — want exit 2, got rc=$rc: '$out'"; return; fi
  if ! printf '%s' "$out" | grep -q 'BLOCKED by no-direct-llm-calls'; then
    bad "$1 — stderr does not name the rule: '$out'"; return; fi
  if ! printf '%s' "$out" | grep -q 'gateway'; then
    bad "$1 — stderr does not name the gateway principle, so the refusal reads as arbitrary: '$out'"; return; fi
  if ! printf '%s' "$out" | grep -q 'project-walls\.conf'; then
    bad "$1 — stderr does not name the sanctioned escape, so the agent has no next move: '$out'"; return; fi
  ok
}

# allowed <desc> <json> — silent exit 0. A wall that speaks on traffic it
# permits is a wall the agent learns to ignore.
allowed() {
  clear_rows
  out=$(printf '%s' "$2" | node "$HOOK" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then bad "$1 — want exit 0, got rc=$rc: '$out'"; return; fi
  if [ -n "$out" ]; then bad "$1 — want silence, got: '$out'"; return; fi
  ok
}

# --- provider API domains: blocked -----------------------------------
# One case per alternative the regex actually claims, so adding a
# provider without a case, or dropping one, shows up here.
blocked "anthropic messages"    '{"tool_input":{"command":"curl -s https://api.anthropic.com/v1/messages -d @body.json"}}'
blocked "openai chat"           '{"tool_input":{"command":"curl https://api.openai.com/v1/chat/completions"}}'
blocked "google gemini"         '{"tool_input":{"command":"curl https://generativelanguage.googleapis.com/v1beta/models"}}'
blocked "google vertex"         '{"tool_input":{"command":"curl https://aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m:predict"}}'
blocked "mistral"               '{"tool_input":{"command":"curl https://api.mistral.ai/v1/chat/completions"}}'
blocked "cohere .ai"            '{"tool_input":{"command":"curl https://api.cohere.ai/v1/generate"}}'
blocked "cohere .com"           '{"tool_input":{"command":"curl https://api.cohere.com/v2/chat"}}'
blocked "groq"                  '{"tool_input":{"command":"curl https://api.groq.com/openai/v1/chat/completions"}}'
blocked "openrouter"            '{"tool_input":{"command":"curl https://openrouter.ai/api/v1/chat/completions"}}'
blocked "together .xyz"         '{"tool_input":{"command":"curl https://api.together.xyz/v1/completions"}}'
blocked "together .ai"          '{"tool_input":{"command":"curl https://api.together.ai/v1/completions"}}'
blocked "x.ai"                  '{"tool_input":{"command":"curl https://api.x.ai/v1/chat/completions"}}'
blocked "deepseek"              '{"tool_input":{"command":"curl https://api.deepseek.com/chat/completions"}}'
blocked "perplexity"            '{"tool_input":{"command":"curl https://api.perplexity.ai/chat/completions"}}'
blocked "bedrock-runtime"       '{"tool_input":{"command":"curl https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3/invoke"}}'
blocked "bedrock control plane" '{"tool_input":{"command":"curl https://bedrock.eu-west-2.amazonaws.com/foundation-models"}}'

# --- the same domains reached other ways ------------------------------
blocked "wget not curl"         '{"tool_input":{"command":"wget -qO- https://api.openai.com/v1/models"}}'
blocked "uppercase host"        '{"tool_input":{"command":"curl https://API.ANTHROPIC.COM/v1/models"}}'
blocked "chained after cd"      '{"tool_input":{"command":"cd /app && curl -X POST https://api.anthropic.com/v1/messages"}}'
blocked "piped into jq"         '{"tool_input":{"command":"curl -s https://api.openai.com/v1/models | jq .data"}}'
blocked "url in a shell var"    '{"tool_input":{"command":"URL=https://api.mistral.ai/v1/chat/completions; python3 client.py"}}'
blocked "key in env prefix"     '{"tool_input":{"command":"ANTHROPIC_API_KEY=$KEY curl https://api.anthropic.com/v1/models"}}'
blocked "heredoc body"          '{"tool_input":{"command":"curl https://api.anthropic.com/v1/messages -d @- <<EOF\n{}\nEOF"}}'

# --- the gateway is the sanctioned path, and must stay open ------------
allowed "gateway prod chat"     '{"tool_input":{"command":"curl -s https://your-gateway.example.com/v1/chat/completions -H \"Authorization: Bearer $GATEWAY_API_KEY\""}}'
allowed "gateway prod health"   '{"tool_input":{"command":"curl https://your-gateway.example.com/v1/health"}}'
allowed "gateway local dev"     '{"tool_input":{"command":"curl http://localhost:7071/v1/models"}}'
allowed "gateway via env base"  '{"tool_input":{"command":"curl -s \"$GATEWAY_URL/v1/chat/completions\" -d @body.json"}}'

# --- ordinary work is not network work --------------------------------
allowed "git status"            '{"tool_input":{"command":"git status --short"}}'
allowed "ls scripts"            '{"tool_input":{"command":"ls .claude/scripts"}}'
allowed "read the rule itself"  '{"tool_input":{"command":"cat .claude/rules/no-direct-llm-calls.md"}}'
allowed "run this suite"        '{"tool_input":{"command":"sh tests/block-direct-llm-tests.sh"}}'

# --- provider WORDS are not provider DOMAINS --------------------------
# The wall is on egress, not on vocabulary. Blocking the word would make
# every grep of this repo's own rules a denial.
allowed "grep vendor word"      '{"tool_input":{"command":"grep -rn anthropic .claude/rules"}}'
allowed "pip install sdk"       '{"tool_input":{"command":"pip install openai"}}'
allowed "model id in payload"   '{"tool_input":{"command":"echo {\"model\":\"claude-opus-4-20250514\"} > body.json"}}'
allowed "docs mention bedrock"  '{"tool_input":{"command":"grep -n bedrock governance/llm-gateway-intel.md"}}'

# --- neighbouring hosts that are not provider APIs --------------------
allowed "github api"            '{"tool_input":{"command":"curl -s https://api.github.com/repos/x/y"}}'
allowed "s3, not bedrock"       '{"tool_input":{"command":"curl https://s3.us-east-1.amazonaws.com/bucket/key"}}'
allowed "non-LLM googleapis"    '{"tool_input":{"command":"curl https://storage.googleapis.com/bucket/object"}}'
# The regex escapes its dots. If it ever stops, this hyphenated token
# starts matching and an ordinary echo becomes a denial.
allowed "dots are literal"      '{"tool_input":{"command":"echo api-anthropic-com"}}'

# --- degradation: nothing to inspect is not a denial -------------------
allowed "empty json"            '{}'
allowed "no command key"        '{"tool_input":{"file_path":"/app/main.py"}}'
allowed "empty command"         '{"tool_input":{"command":""}}'

# --- the wall writes nothing ------------------------------------------
# It refuses and explains; it does not keep books. The old ledger reached
# 251 rows with no reader, and no row ever came from a wall firing on
# real traffic. A denial that also writes a record is a denial that can
# fail for a bookkeeping reason.
BEFORE=$(find "$SANDBOX" -type f 2>/dev/null | sort)
# The LIVE ledger, snapshotted around the same probe. Sandbox-clean is not
# leak-free: a hook that resolved its root from the cwd rather than from
# GOV_ROOT would write outside the sandbox and leave it pristine (I-0090).
LIVE_BEFORE=$([ -f "$LIVE_GATES" ] && cat "$LIVE_GATES" 2>/dev/null || printf '<absent>')
printf '{"tool_input":{"command":"curl https://api.anthropic.com/v1/messages"}}' | node "$HOOK" >/dev/null 2>&1
AFTER=$(find "$SANDBOX" -type f 2>/dev/null | sort)
LIVE_AFTER=$([ -f "$LIVE_GATES" ] && cat "$LIVE_GATES" 2>/dev/null || printf '<absent>')
# NOT `diff <(...) <(...)`. Process substitution is a bashism, and the
# parity runner drives every suite with `sh` -- which is dash on Debian and
# Ubuntu. dash rejects it at PARSE time, so this line, on a branch that only
# runs when the assertion FAILS, aborted the whole suite at startup: rc=2,
# zero assertions, 53 real checks silently not run on every Linux lane of
# the first CI run (2026-09-02). A diagnostic that only a green machine can
# parse is worse than no diagnostic.
if [ "$BEFORE" = "$AFTER" ]; then ok; else
  bad "the wall wrote a file on denial; the sandbox gained: $(printf '%s\n' "$AFTER" | grep -vxF "$BEFORE" | head -3 | tr '\n' ' ')"
fi
# WAS `grep -q "$MARK"`, and MARK has been unassigned since 76e0d0d removed
# the probe-row mechanism it belonged to. Under `set -u` that is an abort,
# not a check -- dormant only because the live gates.json this dereferences
# behind no longer exists on any checkout. Snapshot comparison instead: it
# needs no marker, and it catches a leak the grep never could, since a leaked
# row need not carry this suite's string at all.
if [ "$LIVE_BEFORE" = "$LIVE_AFTER" ]; then ok; else
  bad "the live governance/gates.json changed while this suite ran — the I-0090 sandbox leaked; do not trust the gate ledger until it is cleaned"
fi
clear_rows

# --- naming a provider is not calling one (I-0140) --------------------
# scrumux decide new --rationale "...api.openai.com..." records WHY an exemption
# was declared. It reaches nothing. The wall refused it for the string,
# which is the same defect as I-0132/I-0134/I-0135 in a fourth wall:
# matching a literal that appears in prose as though it were the act.
cj() { jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }

allowed "scrumux decide whose rationale names the provider" \
  "$(cj '.claude/scripts/scrumux decide new --title d --decision x --rationale "we declare api.openai.com in project-walls.conf" --by User')"
allowed "scrumux log whose narrative names the provider" \
  "$(cj '.claude/scripts/scrumux log new --title x --did "swapped OpenAIServerModel off api.openai.com onto the gateway"')"
allowed "a commit message naming the provider" \
  "$(cj 'git commit -m "stop calling api.openai.com directly"')"

# The wall still holds wherever a call is actually possible.
blocked "curl at a provider" "$(cj 'curl https://api.openai.com/v1/models')"
blocked "curl at anthropic"  "$(cj 'curl -s https://api.anthropic.com/v1/messages -d @body.json')"
blocked "python reaching a provider" \
  "$(cj 'python3 -c "import requests; requests.post(\"https://api.openai.com/v1/chat\")"')"
blocked "a provider call on the far side of a chain" \
  "$(cj 'echo starting && curl https://api.openai.com/v1/models')"

# --- the shell dials too (I-0142) -------------------------------------
# /dev/tcp is the shell's own network client: no binary, so no command
# word for the classifier to catch.
blocked "shell socket to a provider" "$(cj 'exec 3<>/dev/tcp/api.openai.com/443')"
blocked "shell socket, redirect form" "$(cj 'echo hi > /dev/tcp/api.openai.com/443')"

printf 'block-direct-llm-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "block-direct-llm-tests: error: $FAIL case(s) wrong — fix .claude/hooks/block-direct-llm.sh before trusting the third wall (constitution boundary 1)" >&2
  exit 1
fi
exit 0
