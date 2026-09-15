#!/bin/sh
# hook-upstream-tests.sh — T-0199 acceptance for the fourth wall
# (D-0078, boundary 1): in a repo carrying .claude/DEPLOYED, harness
# machinery is refused to the edit tools AND to Bash; in a repo without
# the marker nothing is refused; prose is never refused either way.
#
# The two-arm requirement is I-0121: a denied Edit was re-applied through
# a python3 heredoc via Bash. A suite that only tested the Edit arm would
# certify exactly the wall that failed.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
HOOK="$ROOT/.deploy-claude/dist/block-upstream-edit.mjs"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# Two sandboxes: one that looks like a deployment, one that looks like
# the harness's own checkout. GOV_ROOT is how the hook resolves which
# repo it is speaking about (the same resolution its three siblings use).
DEPLOYED=$(mktemp -d) || { echo "hook-upstream-tests: cannot mktemp" >&2; exit 1; }
SOURCE=$(mktemp -d)   || { echo "hook-upstream-tests: cannot mktemp" >&2; exit 1; }
trap 'rm -rf "$DEPLOYED" "$SOURCE"' EXIT INT TERM
mkdir -p "$DEPLOYED/.claude/scripts" "$DEPLOYED/governance" "$SOURCE/.claude/scripts" "$SOURCE/governance"
printf '{"source_remote":"https://github.com/LBDavid98/scrumux-cli-public.git","source_commit":"deadbeef","deployed_at":"2026-08-21","files":{}}\n' \
  > "$DEPLOYED/.claude/DEPLOYED"

# edit_json <file_path> — a PreToolUse payload as the Edit/Write tools shape it
edit_json() { printf '{"tool_input":{"file_path":"%s"}}' "$1"; }
# bash_json <command> — as the Bash tool shapes it
bash_json() { printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; }

# run <root> <payload> — sets HOOK_ERR (stderr) and HOOK_RC (exit code)
run() {
  HOOK_ERR=$(printf '%s' "$2" | GOV_ROOT="$1" node "$HOOK" 2>&1 >/dev/null)
  HOOK_RC=$?
}
# blocked <root> <payload> <desc>
# Exit 2 is the contract, not merely "nonzero": the CLI treats 2 as a
# block and anything else as a hook that errored, which does NOT stop
# the call. A wall that exits 1 refuses nothing.
blocked() {
  run "$1" "$2"
  if [ "$HOOK_RC" -eq 0 ]; then
    bad "$3 — the wall allowed it (exit 0)"
  elif [ "$HOOK_RC" -ne 2 ]; then
    bad "$3 — the wall exited $HOOK_RC; only exit 2 blocks a PreToolUse call, anything else is an errored hook and the write proceeds"
  elif printf '%s' "$HOOK_ERR" | grep -q 'BLOCKED by block-upstream-edit'; then
    ok
  else
    bad "$3 — refused, but the message does not identify the wall: '$HOOK_ERR'"
  fi
}
allowed() { # allowed <root> <payload> <desc>
  run "$1" "$2"
  if [ "$HOOK_RC" -eq 0 ]; then ok; else bad "$3 — the wall refused it (exit $HOOK_RC): '$HOOK_ERR'"; fi
}

# --- 1. the edit arm, in a deployment ---------------------------------
for f in .claude/scripts/scrumux .claude/dist/block-destructive.mjs .claude/schemas/task.schema.json .claude/agents/debugger.md; do
  blocked "$DEPLOYED" "$(edit_json "$DEPLOYED/$f")" "Edit of $f in a deployment"
done

# --- 2. the Bash arm, in a deployment (I-0121, the whole point) --------
# The exact evasion I-0121 recorded: a python3 heredoc carrying the same
# edit the Edit tool was denied.
blocked "$DEPLOYED" "$(bash_json "python3 - <<'PY'
open('$DEPLOYED/.claude/scripts/scrumux','a').write('# smuggled')
PY")" "python3 heredoc writing .claude/scripts/scrumux (the I-0121 evasion)"
blocked "$DEPLOYED" "$(bash_json "echo x >> $DEPLOYED/.claude/scripts/scrumux")" "shell redirect into .claude/scripts/scrumux"
blocked "$DEPLOYED" "$(bash_json "sed -i '' s/a/b/ $DEPLOYED/.claude/dist/block-secret-reads.mjs")" "sed -i against a hook"
blocked "$DEPLOYED" "$(bash_json "cp /tmp/x $DEPLOYED/.claude/scripts/scrumux" records check)" "cp over a shipped script"
blocked "$DEPLOYED" "$(bash_json "rm $DEPLOYED/.claude/schemas/issue.schema.json")" "rm of a schema"

# --- 3. reading is never refused --------------------------------------
# An agent that cannot read the machinery cannot understand why it is
# being refused.
allowed "$DEPLOYED" "$(bash_json "cat $DEPLOYED/.claude/scripts/scrumux")" "cat of a shipped script"
allowed "$DEPLOYED" "$(bash_json "grep -n usage $DEPLOYED/.claude/scripts/scrumux")" "grep of a shipped script"
allowed "$DEPLOYED" "$(bash_json "git diff $DEPLOYED/.claude/scripts/scrumux")" "git diff of a shipped script"

# --- 4. prose is tracked, never blocked (boundary 7) ------------------
allowed "$DEPLOYED" "$(edit_json "$DEPLOYED/.claude/rules/project-standards.md")" "Edit of a rule in a deployment"
allowed "$DEPLOYED" "$(edit_json "$DEPLOYED/.claude/skills/session-open/SKILL.md")" "Edit of a skill in a deployment"
allowed "$DEPLOYED" "$(bash_json "echo x >> $DEPLOYED/.claude/rules/project-standards.md")" "Bash append to a rule"

# --- 5. the app's own files are none of the wall's business -----------
allowed "$DEPLOYED" "$(edit_json "$DEPLOYED/src/main.py")" "Edit of application code"
allowed "$DEPLOYED" "$(edit_json "$DEPLOYED/scripts/deploy.sh")" "Edit of the app's own scripts/ directory"
allowed "$DEPLOYED" "$(bash_json "python3 scripts/build.py")" "running the app's own script"
allowed "$DEPLOYED" "$(edit_json "$DEPLOYED/governance/notes.md")" "Edit of a governance file (records are the target's own)"

# --- 6. no marker, no wall --------------------------------------------
# The harness's own checkout. Editing the machinery here IS the work.
for f in .claude/scripts/scrumux .claude/dist/block-destructive.mjs .claude/agents/debugger.md; do
  allowed "$SOURCE" "$(edit_json "$SOURCE/$f")" "Edit of $f in a NON-deployed repo"
done
allowed "$SOURCE" "$(bash_json "python3 - <<'PY'
open('$SOURCE/.claude/scripts/scrumux','a').write('x')
PY")" "Bash heredoc against .claude/scripts/scrumux in a NON-deployed repo"

# --- 7. the refusal is actionable -------------------------------------
run "$DEPLOYED" "$(edit_json "$DEPLOYED/.claude/scripts/scrumux")"
printf '%s' "$HOOK_ERR" | grep -q 'scrumux issue new --type harness' \
  && ok || bad "the refusal must name the capture command 'scrumux issue new --type harness'; got: $HOOK_ERR"
printf '%s' "$HOOK_ERR" | grep -q 'github.com/LBDavid98/scrumux-cli-public' \
  && ok || bad "the refusal must name the upstream remote READ FROM THE MARKER, not a hardcoded or local path; got: $HOOK_ERR"
printf '%s' "$HOOK_ERR" | grep -q 'I-0121' \
  && ok || bad "the refusal must say a denied call is a stop, not an obstacle (I-0121); got: $HOOK_ERR"
printf '%s' "$HOOK_ERR" | grep -qE '~/tools|/Users/[A-Za-z0-9_.-]+/tools' \
  && bad "the refusal names a machine-specific harness path — it must read the same on any host" || ok

# --- 9. RUNNING the machinery is not writing to it (I-0132) -----------
# The regression this suite did not have. Every Bash case allowed above
# is a read or a non-harness path; nothing executed a shipped script. The
# first wall tested every token, so argv[0] refused 100% of scrumux, status,
# harness, task-verify and backlog usage in every deployed repo — and the
# refusal text named `scrumux issue`, which the same rule refused.
for c in scrumux status harness task-verify task-brief backlog graph records-check session-check readonly-sh; do
  allowed "$DEPLOYED" "$(bash_json ".claude/scripts/$c")" "bare invocation of .claude/scripts/$c"
done
allowed "$DEPLOYED" "$(bash_json ".claude/scripts/scrumux sprint new --epic E-0001")" "scrumux with arguments"
allowed "$DEPLOYED" "$(bash_json "./.claude/scripts/scrumux status session")" "a ./-prefixed invocation"
allowed "$DEPLOYED" "$(bash_json "$DEPLOYED/.claude/scripts/scrumux task new --title x --check y")" "an absolute-path invocation"
allowed "$DEPLOYED" "$(bash_json "cd $DEPLOYED && .claude/scripts/scrumux epic new --name x --desc y")" "a && chain, where the script is not the first token"
allowed "$DEPLOYED" "$(bash_json ".claude/scripts/scrumux log new --title x --did y && .claude/scripts/scrumux task verify T-0001")" "two harness commands chained"
allowed "$DEPLOYED" "$(bash_json ".claude/scripts/scrumux status --json | jq .ok")" "a harness command piped into a reader"
allowed "$DEPLOYED" "$(bash_json "GOV_ROOT=$DEPLOYED .claude/scripts/scrumux" records check)" "an invocation behind a VAR=value prefix"
blocked "$DEPLOYED" "$(bash_json "sh .claude/scripts/scrumux")" "an interpreter naming a protected path (deliberate: the I-0121 route)"

# The exemption is command position ONLY. A protected path anywhere else
# is refused exactly as before — including on the far side of a chain,
# which is where an evasion would sit.
blocked "$DEPLOYED" "$(bash_json ".claude/scripts/scrumux log new --title x && echo y >> .claude/scripts/scrumux")" "a write hidden behind a legitimate command"
blocked "$DEPLOYED" "$(bash_json ".claude/scripts/scrumux status | tee .claude/dist/block-destructive.mjs")" "a write through tee on the far side of a pipe"
blocked "$DEPLOYED" "$(bash_json "cp .claude/scripts/scrumux /tmp/x && cp /tmp/x .claude/scripts/scrumux")" "copy out, edit, copy back"
blocked "$DEPLOYED" "$(bash_json "sudo sed -i '' s/a/b/ .claude/scripts/scrumux")" "a mutating command behind a wrapper"

# --- 9b. the I-0121 evasion with a RELATIVE path (I-0133) -------------
# Section 2's heredoc interpolates an absolute fixture path, so the
# anchored patterns matched and the hole stayed invisible. Arm 2 strips
# ( and ' before testing, which glues the caller onto the path:
# open('.claude/scripts/scrumux') arrives as open.claude/scripts/scrumux.
blocked "$DEPLOYED" "$(bash_json "python3 - <<'PY'
open('.claude/scripts/scrumux','a').write('# smuggled')
PY")" "python3 heredoc writing a RELATIVE .claude/scripts path"
blocked "$DEPLOYED" "$(bash_json "python3 -c \"open('.claude/dist/block-destructive.mjs','w').write('')\"")" "python3 -c writing a relative hook path"
blocked "$DEPLOYED" "$(bash_json "echo x >> .claude/scripts/scrumux")" "relative redirect into a shipped script"
blocked "$DEPLOYED" "$(bash_json "cp /tmp/x .claude/agents/debugger.md")" "relative cp over a shipped module"

# The app's own scripts/ is still none of the wall's business. The
# '.claude/' component is what distinguishes them, not the leading slash.
allowed "$DEPLOYED" "$(bash_json "echo x >> scripts/deploy.sh")" "redirect into the app's own scripts/"
allowed "$DEPLOYED" "$(bash_json "python3 -c \"open('scripts/build.py','w').write('')\"")" "python writing the app's own scripts/"

# --- 9c. a newline ends a command too (I-0136) ------------------------
# Segments were split on ;/&&/||/| only, so a mutator's class carried
# across the line break and refused the next line's harness command. The
# reported repro: chmod a repo script, then order the task that names it.
allowed "$DEPLOYED" "$(bash_json "chmod +x scripts/verify/t02_setup.sh
.claude/scripts/scrumux task order T-0002 --verify \"scripts/verify/t02_setup.sh\"")" "chmod on one line, scrumux on the next"
allowed "$DEPLOYED" "$(bash_json "mkdir -p scripts/verify
.claude/scripts/scrumux task new --title x --check y
.claude/scripts/scrumux sprint add SP-0001 T-0002")" "three lines, a mutator first"
allowed "$DEPLOYED" "$(bash_json ".claude/scripts/scrumux task order T-0001 --light \\
  --scope \"s\" --file \".claude/dist/block-direct-llm.mjs | the wall\"")" "a backslash-continued order naming a hook"

# Newline splitting must not become an evasion. A continued line is
# still its own segment's arguments, and a heredoc body has no command
# words at all.
blocked "$DEPLOYED" "$(bash_json "cp /tmp/x \\
  .claude/scripts/scrumux")" "a mutator continued onto the next line"
blocked "$DEPLOYED" "$(bash_json "python3 - <<'PY'
open('.claude/scripts/scrumux','a').write('x')
PY")" "the I-0121 heredoc, where line 2 must not get a command position"
blocked "$DEPLOYED" "$(bash_json "echo x >> .claude/scripts/scrumux
ls")" "a redirect on the first of two lines"

# --- 10. the whole shipped command surface, end to end ----------------
# Every executable the manifest installs must be runnable in the repo it
# was installed into. Reads the roster from the payload rather than a
# hardcoded list, so a script added upstream cannot skip this.
for f in "$ROOT"/.deploy-claude/scripts/*; do
  b=$(basename "$f")
  [ "$b" = "lib.sh" ] && continue   # sourced, never invoked
  allowed "$DEPLOYED" "$(bash_json ".claude/scripts/$b --help")" "shipped command $b is invocable in a deployment"
done

printf 'hook-upstream-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "hook-upstream-tests: error: $FAIL assertion(s) failed — the fourth wall is not holding" >&2
  exit 1
fi
exit 0
