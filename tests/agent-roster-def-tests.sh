#!/bin/sh
# agent-roster-def-tests.sh — T-0017: the workforce definitions
# hold their contracts (frontmatter, read-only where the role demands,
# role keywords, recordable return shapes).
# Run: sh tests/agent-roster-def-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
AG="$ROOT/.deploy-claude/agents"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- shared frontmatter contract — EVERY DEF (T-0076/I-0025) ---------
# The tools assertion is POSITIVE: the exact read-only toolset must be
# present. The old negative grep passed when the tools line was deleted
# entirely — which grants every tool, including writes.
# T-0186 deleted reviewer-panel, governance-auditor, prompt-engineer,
# simplicity-engineer and planning-agent with the inspection tier.
ROSTER="context-gatherer visual-inspector debugger issue-validator"
for a in $ROSTER; do
  DEF="$AG/$a.md"
  [ -f "$DEF" ] && ok || { bad "$a.md missing"; continue; }
  FM=$(sed -n '/^---$/,/^---$/p' "$DEF")
  printf '%s' "$FM" | grep -q "^name: $a$" && ok || bad "$a: frontmatter name"
  printf '%s' "$FM" | grep -q '^model: ' && ok || bad "$a: model pinned"
  printf '%s' "$FM" | grep -q '^tools: Read, Glob, Grep, Bash$' \
    && ok || bad "$a: tools must be exactly 'Read, Glob, Grep, Bash' — absence or extras grant write access (I-0025)"
  printf '%s' "$FM" | grep '^tools:' | grep -qi 'edit\|write\|notebookedit' && bad "$a: tools line leaks a write tool" || ok
  # THE GUARANTEE IS THE TOOL SCOPE, and the definition has to SAY so. It
  # used to be an OS sandbox (`readonly-sh`, sandbox-exec/bwrap) named in
  # every one of these files; that was POSIX-only, so on Windows — the
  # platform these agents actually run on — it named a protection that was
  # not there. The tools line above is the real boundary and it holds on
  # every platform; this asserts the prose has stopped promising the other.
  grep -q 'TOOL SCOPE' "$DEF" \
    && ok || bad "$a: the read-only paragraph must name the TOOL SCOPE as the guarantee"
  grep -q 'readonly-sh\|sandbox wrapper' "$DEF" \
    && bad "$a: names the retired OS sandbox — the guarantee is the tools line, on every platform" || ok
  grep -q 'Read-only protocol (D-0007)' "$DEF" \
    && ok || bad "$a: canonical read-only protocol paragraph missing (T-0076 — one phrasing, every home)"
  grep -qiw 'honest\|honestly' "$DEF" \
    && bad "$a: honest/honestly phrasing — banned candor-filler (D7, cross-project writing rule)" || ok
done

# --- mutation probe: a deleted tools line MUST fail (I-0025) ---------
# Runs against a SCRATCH copy — never the working tree (I-0021 cause 3).
MUT=$(mktemp -d); trap 'rm -rf "$MUT"' EXIT
grep -v '^tools:' "$AG/debugger.md" > "$MUT/mutant.md"
MFM=$(sed -n '/^---$/,/^---$/p' "$MUT/mutant.md")
printf '%s' "$MFM" | grep -q '^tools: Read, Glob, Grep, Bash$' \
  && bad "mutation probe: positive assertion passed a def with no tools line" || ok
printf '%s' "$MFM" | grep '^tools:' | grep -qi 'edit\|write' \
  && bad "(unreachable)" || : # the OLD weak form scores ok here — that is the hole
printf '%s' "$MFM" | grep -q '^tools:' \
  && bad "mutation probe: tools line survived deletion — probe broken" || ok

# --- role contracts ---------------------------------------------------
# The reviewer-panel and governance-auditor contracts left with their
# definitions (T-0186): the panel is deleted outright and post-hoc record
# policing is no longer a CLI surface (D-0072 boundary 7).
CG="$AG/context-gatherer.md"
grep -q 'scrumux task order' "$CG" && ok || bad "context-gatherer: pack targets scrumux task order"
grep -q 'D-0005' "$CG" && ok || bad "context-gatherer: cites the assembled-not-searched ruling"
grep -q 'Open,' "$CG" && ok || bad "context-gatherer: open-don't-recall protocol"

VI="$AG/visual-inspector.md"
grep -q 'UNVERIFIED' "$VI" && ok || bad "visual-inspector: unverified is a first-class outcome"
grep -q 'scratch space' "$VI" && ok || bad "visual-inspector: evidence lands in scratch space"
grep -qi 'error state' "$VI" && ok || bad "visual-inspector: state coverage demanded"

# --- no agent records governance itself ------------------------------
for a in $ROSTER; do
  grep -qi 'orchestrator' "$AG/$a.md" && ok || bad "$a: recording routes through the orchestrator"
done

printf 'agent-roster-def-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
# --- T-0086/I-0021: mutation testing runs on a scratch copy ------------
# An oracle nobody has tried to break is a guess. I-0025 was found by
# deleting the tools line from a real agent definition to see whether the
# assertion noticed — proving the oracle weak, but editing a TRACKED file
# during a read-only analysis turn (I-0021 cause 3). Mutations belong on
# a copy: the assertion is pointed at the copy, and the working tree is
# never the experiment.
SCRATCH=$(mktemp -d) || { echo "agent-roster-def-tests: cannot create scratch dir" >&2; exit 1; }
trap 'rm -rf "$SCRATCH"' EXIT

# tools_assertion <file> — the positive check from the roster loop,
# factored out so the same code runs against a definition and against a
# mutant of it. Exit 0 = contract held, 1 = violation detected.
tools_assertion() {
  sed -n '/^---$/,/^---$/p' "$1" | grep -q '^tools: Read, Glob, Grep, Bash$'
}

# mutate_on_copy <file> <sed-expr> — apply a mutation to a COPY and echo
# the copy's path. The original is never opened for writing.
mutate_on_copy() {
  _src=$1; _expr=$2
  _dst="$SCRATCH/$(basename "$_src").mutant"
  sed "$_expr" "$_src" > "$_dst"
  printf '%s' "$_dst"
}

MUTTARGET="$AG/context-gatherer.md"
if [ -f "$MUTTARGET" ]; then
  # sanity: the real definition satisfies the assertion
  tools_assertion "$MUTTARGET" && ok || bad "context-gatherer.md should satisfy the tools assertion before mutation"

  # mutation 1 — delete the tools line entirely. This is the exact edit
  # that exposed I-0025, and the shape that grants every tool.
  MUT=$(mutate_on_copy "$MUTTARGET" '/^tools: /d')
  tools_assertion "$MUT" && bad "oracle missed a DELETED tools line — the I-0025 shape, which grants write access" || ok

  # mutation 2 — widen the toolset. A weaker oracle (substring match)
  # would pass this; the anchored assertion must not.
  MUT=$(mutate_on_copy "$MUTTARGET" 's/^tools: Read, Glob, Grep, Bash$/tools: Read, Glob, Grep, Bash, Write/')
  tools_assertion "$MUT" && bad "oracle missed a WIDENED tools line granting Write" || ok

  # the point of the whole exercise: the tracked file is untouched
  if [ -z "$(git -C "$ROOT" status --porcelain -- "$MUTTARGET" 2>/dev/null)" ]; then ok
  else bad "mutation testing modified the tracked file $MUTTARGET — mutations belong on a copy (I-0021)"; fi
else
  bad "mutation target $MUTTARGET missing"
fi

if [ "$FAIL" -gt 0 ]; then
  echo "agent-roster-def-tests: error: $FAIL assertion(s) failed — an agent definition broke its contract; fix .claude/agents/<name>.md before dispatching that agent" >&2
  exit 1
fi
exit 0
