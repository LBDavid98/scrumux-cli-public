#!/bin/sh
# graph-wiring-tests.sh — T-0151: the agent-facing files are wired to the
# two graphs, and stay wired to the REAL query surface.
#
# Two directions, because either alone rots:
#   forward  — each of the four files (context-gatherer, task-breakdown,
#              SKILLS_INDEX.MD, PROJECT_SPEC.MD) names at
#              least one concrete graph command, so an agent that reads
#              only its own definition knows the graphs exist (S-0063).
#   backward — every "<script> <subcommand>" pair those files name is a
#              real subcommand of that script. A doc naming a command
#              that does not exist is worse than no doc: it sends the
#              agent back to grep, having burned a turn.
#
# The accepted list is parsed from each script's own usage line, so
# renaming a subcommand fails this suite instead of silently diverging.
# `fresh` is deliberately NOT accepted: it survives in the dispatch as a
# back-compat alias, D-0044 named `index`, and docs teach one name.
#
# Run: sh tests/graph-wiring-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPTS="$ROOT/.deploy-claude/scripts"
# The command that RUNS the graph and the file that DECLARES its
# subcommand lists are two different things: `scrumux graph …` is the
# surface, src/nouns/graph.ts is where CODE_CMDS and GOV_CMDS live. It was
# lib/cmd-graph.sh until the bash CLI was retired; the assignment kept the
# same name and the same pipe-joined shape, so the parse below did not move.
GRAPH_SCRIPT="$ROOT/src/nouns/graph.ts"

# The agent-facing files this task wires up (repo-relative, no spaces).
# T-0186 deleted reviewer-panel.md with the panel it defined.
FILES=".deploy-claude/agents/context-gatherer.md
SKILLS_INDEX.MD
PROJECT_SPEC.MD"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# Scratch space only — this suite never writes inside the repo, so it
# runs unchanged under readonly-sh (D-0007).
SCRATCH=$(mktemp -d) || { echo "graph-wiring-tests: error: cannot create scratch dir" >&2; exit 1; }
trap 'rm -rf "$SCRATCH"' EXIT

# --- accepted subcommand lists, from the scripts themselves -----------
# Each script dies with `usage: <name> a|b|c — see the header`; that
# pipe-joined list is the contract these docs must match.
# T-0141 collapsed the two scripts into one, so the usage NAME is now two
# tokens: `usage: graph code build|index|...`. Parsing it as one token
# silently returned an empty list, which made the backward check accept
# every doc claim — a vacuous pass, not a failure.
# T-0141 collapsed the two scripts into one and its usage line
# interpolates a variable — `usage: graph code $CODE_CMDS` — so the list
# is not literal there any more. It IS literal in the assignment near the
# top of the script, which is the contract these docs must match. Parsing
# the usage line instead returned an empty list, and an empty list makes
# the backward check accept every doc claim: a vacuous pass, not a fail.
subcommands() { # <script-path> <domain: code|gov>
  _var=$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]')_CMDS
  grep -o "${_var} = '[a-z|]*" "$1" 2>/dev/null | head -1 |
    sed "s/^${_var} = '//" | tr '|' ' ' |
    # `fresh` is a live back-compat alias in the dispatch, but D-0044
    # named `index` and docs teach ONE name — so it is dropped from the
    # ACCEPTED list here rather than removed from the script. T-0141 put
    # both in the same variable, which is right for dispatch and wrong
    # for what a doc may say.
    # BSD sed has no \b, so pad and match on spaces.
    sed 's/^/ /; s/$/ /; s/ fresh / /g'
}

[ -f "$GRAPH_SCRIPT" ] && ok || bad "missing source $GRAPH_SCRIPT — the four files point at the graph it implements"

CG_CMDS=$(subcommands "$GRAPH_SCRIPT" code)
GG_CMDS=$(subcommands "$GRAPH_SCRIPT" gov)

# A failed parse must fail loud, not vacuously accept every doc claim.
case " $CG_CMDS " in
  *" build "*|*" callers "*) ok;;
  *) bad "could not parse 'graph code's subcommand list from its usage line — got '$CG_CMDS'; the backward check would accept anything";;
esac
case " $GG_CMDS " in
  *" build "*|*" provenance "*) ok;;
  *) bad "could not parse 'graph gov's subcommand list from its usage line — got '$GG_CMDS'; the backward check would accept anything";;
esac

# is_real <script-name> <subcommand> — exit 0 if that script exposes it.
is_real() {
  case "$1" in
    code)       _list=$CG_CMDS;;
    gov) _list=$GG_CMDS;;
    *) return 1;;
  esac
  case " $_list " in *" $2 "*) return 0;; esac
  return 1
}

# named_pairs <file> — every "<graph-script> <word>" the file writes, one
# "script subcommand" per line. Prose that says `code-graph` without a
# following lowercase word makes no claim about the query surface and is
# not checked.
named_pairs() { # <file>
  grep -oE 'graph (code|gov) [a-z][a-z-]*' "$1" 2>/dev/null | sort -u
}

# --- forward + backward, per file ------------------------------------
OLDIFS=$IFS
IFS='
'
set -- $FILES
IFS=$OLDIFS

for REL in "$@"; do
  F="$ROOT/$REL"
  if [ ! -f "$F" ]; then
    bad "$REL missing — it is one of the four files T-0151 wires to the graphs"
    continue
  fi

  named_pairs "$F" > "$SCRATCH/pairs"

  # forward: this file names at least one concrete graph command
  if [ -s "$SCRATCH/pairs" ]; then ok
  else bad "$REL names no graph command — an agent reading it cannot know the graphs exist (S-0063); name a concrete one, e.g. 'graph code callers <path>::<name>'"; fi

  # backward: every command it names is real
  while read -r _graph domain cmd; do
    [ -n "${domain:-}" ] || continue
    if is_real "$domain" "$cmd"; then
      ok
    else
      case "$domain" in
        code) REALS=$CG_CMDS;;
        *)    REALS=$GG_CMDS;;
      esac
      bad "$REL names 'graph $domain $cmd', which graph $domain does not expose — real subcommands: $REALS"
    fi
  done < "$SCRATCH/pairs"

  # the D-0043 self-heal statement travels with the commands, so a stale
  # index is never read as a blocker
  if [ -s "$SCRATCH/pairs" ]; then
    grep -q 'D-0043' "$F" && ok \
      || bad "$REL names a graph command but not D-0043 — say the index self-heals, or an agent will treat a stale graph as a blocker"
  fi
done

# --- both graphs are represented across the set -----------------------
: > "$SCRATCH/all"
for REL in "$@"; do
  [ -f "$ROOT/$REL" ] && named_pairs "$ROOT/$REL" >> "$SCRATCH/all"
done
grep -q '^graph code ' "$SCRATCH/all" && ok \
  || bad "no file names a 'graph code' subcommand — the blast-radius question stays unanswerable (I-0018)"
grep -q '^graph gov ' "$SCRATCH/all" && ok \
  || bad "no file names a 'graph gov' subcommand — provenance stays hand-reconstructed"

# --- mutation probe: the backward check must catch a fake command -----
# An oracle nobody has tried to break is a guess (T-0086/I-0021); the
# mutation lives on a scratch file, never a tracked one.
printf 'run .claude/scripts/scrumux graph code blastradius <path>::<name>\n' > "$SCRATCH/fake.md"
MPAIRS=$(named_pairs "$SCRATCH/fake.md")
[ "$MPAIRS" = "graph code blastradius" ] && ok \
  || bad "mutation probe: the pair extractor missed the invented command (saw '$MPAIRS') — the backward check proves nothing"
is_real code blastradius \
  && bad "mutation probe: is_real accepted 'graph code blastradius', which does not exist — the backward check proves nothing" || ok
is_real code callers && ok \
  || bad "mutation probe: is_real rejected the real 'graph code callers' — the check is inverted"
is_real gov provenance && ok \
  || bad "mutation probe: is_real rejected the real 'graph gov provenance' — the check is inverted"
is_real code fresh \
  && bad "the accepted list includes the retired 'fresh' alias — D-0044 named index; docs teach one name" || ok

printf 'graph-wiring-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "graph-wiring-tests: error: $FAIL assertion(s) failed — an agent-facing file lost its graph wiring or names a command its script does not have; fix the file, or the script's usage line if a subcommand was renamed" >&2
  exit 1
fi
exit 0
