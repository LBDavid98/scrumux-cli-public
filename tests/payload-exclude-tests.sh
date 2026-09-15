#!/bin/sh
# payload-exclude-tests.sh — the source-only exclusion from the payload.
#
# `harness deploy` ships everything the walk finds under .claude/scripts,
# schemas, rules, hooks, skills and agents. Dot-prefixed FILES are skipped,
# but the walk tests the BASENAME only, so a file inside a dot-prefixed
# directory ships too — there was no way at all to keep a file out.
#
# That is fine for machinery and wrong for guidance about BUILDING the
# harness. A rule telling a session that root RULINGS.md is its only
# governance document is true here and actively harmful in a repo the
# harness governs, where the whole loop applies. `.claude/payload-exclude.list`
# is the mechanism; this suite is the proof that it holds on all three
# surfaces that read the roster — deploy, verify and the manifest — because
# one of them silently disagreeing is exactly the class of drift the derived
# roster exists to prevent (I-0143).
#
# The four things proved here, in one real deploy:
#   1. an excluded file is not in the roster,
#   2. deploy does not install it into a target,
#   3. verify does not demand it of that target,
#   4. a non-excluded NEIGHBOUR in the same directory still ships.
#
# Section 7 covers the OTHER way a path leaves the roster — the retirement
# of `governance/enforcement-posture.md` from MACHINERY_DOCS — because
# stop-shipping and reclaiming the installed copies are two decisions and
# this file is the case that separates them.
#
# Run: sh tests/payload-exclude-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
# The roster and its one filter live in the harness noun now; it was
# lib/cmd-harness.sh until the bash CLI was retired.
SRC="$ROOT/src/nouns/harness/payload.ts"
LIST="$ROOT/.deploy-claude/payload-exclude.list"

SANDBOX=$(mktemp -d) || { echo "payload-exclude-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
TARGET="$SANDBOX/target"
mkdir -p "$TARGET"
export GOV_ROOT="$SANDBOX"

# A probe file INSIDE an excluded skill directory, to prove the trailing-`/`
# form excludes the whole prefix rather than the one file that was listed
# when it was written. It is created in the repo on purpose and removed on
# exit — the same short-lived-probe pattern payload_files' own comment
# describes, and safe under a concurrent health run precisely because the
# directory it lands in can never enter any roster.
PROBE="$ROOT/.deploy-claude/skills/source-implement/probe-$$.md"
trap 'rm -rf "$SANDBOX"; rm -f "$PROBE"' EXIT
printf 'transient probe written by tests/payload-exclude-tests.sh\n' > "$PROBE"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# The listed paths, parsed the way the implementation parses them: leading
# whitespace stripped, `#` lines dropped, the line cut at the first space.
LISTED=$(sed -e 's/^[[:space:]]*//' -e '/^#/d' -e '/^$/d' -e 's/[[:space:]].*$//' "$LIST" | grep .)

# ---------- 1. the list itself ----------------------------------------
[ -f "$LIST" ] && ok \
  || bad ".claude/payload-exclude.list must exist — it is the only way to keep a file under a PAYLOAD_DIR out of the payload"
grep -q '^#' "$LIST" && ok \
  || bad "the list must carry its own reason in comments; an exclusion nobody can read is one nobody can audit"
[ -n "$LISTED" ] && ok \
  || bad "the list names no paths — this suite proves a mechanism that is not being used, which is a green over nothing"

# It must sit ABOVE every PAYLOAD_DIR, for the same reason .claude/DEPLOYED
# does: a file that decides the roster must not be able to enter it.
case "$LIST" in
  */.deploy-claude/payload-exclude.list) ok ;;
  *) bad "the list must live directly under .deploy-claude/, outside every PAYLOAD_DIR — got $LIST" ;;
esac
for d in scripts schemas rules hooks skills agents; do
  case "$LIST" in */.deploy-claude/$d/*) bad "the list is inside PAYLOAD_DIR '$d', so it would ship and could exclude itself" ;; *) ok ;; esac
done

# ---------- 2. every listed path names something real ------------------
# An exclusion with a typo in it is inert, and inert in the direction that
# SHIPS the file it was written to hold back.
for p in $LISTED; do
  case "$p" in
    */) [ -d "$ROOT/.deploy-claude/${p#.claude/}" ] && ok || bad "excluded directory '$p' does not exist at $ROOT — a stale exclusion is one that has stopped protecting anything" ;;
    *)  [ -f "$ROOT/.deploy-claude/${p#.claude/}" ] && ok || bad "excluded path '$p' does not exist at $ROOT — a typo here is silently inert and the file ships" ;;
  esac
  case "$p" in
    .claude/scripts/*|.claude/hooks/*|.claude/schemas/*)
      bad "'$p' is machinery and must never be excluded: verify's surface-coverage table is derived from the SAME roster this list filters, so an excluded script is one nothing probes and nothing reports — I-0104 by a new route" ;;
    .claude/*) ok ;;
    *) bad "'$p' is not under .claude/ — the list only filters the PAYLOAD_DIRS walk, so a line outside it excludes nothing" ;;
  esac
done

# ---------- 3. the filter is in the ONE walk ---------------------------
# deploy installs from this roster, verify requires it, and the prune spares
# only what it still names. Filtering anywhere else would let the three come
# to disagree — the drift the derived roster exists to prevent.
grep -q 'payload-exclude.list' "$SRC" && ok \
  || bad "payload.ts must read payload-exclude.list — the list has to be resolved from the payload SOURCE, never from GOV_ROOT"
grep -q 'if (payloadExcluded(rel, rules)) continue;' "$SRC" && ok \
  || bad "payloadFiles must consult payloadExcluded inside its walk; a filter applied at a call site instead lets deploy, verify and the prune disagree"
# The DEFINITION line matches this pattern too, so one call site is two hits.
[ "$(grep -c 'payloadExcluded(rel' "$SRC")" -eq 2 ] && ok \
  || bad "payloadExcluded is called from more than one place in payload.ts — there is exactly one derived roster and exactly one filter on it"

# ---------- 4. deploy ---------------------------------------------------
DOUT=$("$GOVCMD" harness deploy "$TARGET" 2>&1); drc=$?
[ "$drc" -eq 0 ] && ok || bad "harness deploy into a fresh target exited $drc — the rest of this suite is not evidence of anything. Output: $(printf '%s' "$DOUT" | tail -5)"

# 4a. NOT INSTALLED. The whole point.
for p in $LISTED; do
  case "$p" in
    */) [ -e "$TARGET/${p%/}" ] \
          && bad "deploy installed the excluded directory '$p' into the target" || ok ;;
    *)  [ -e "$TARGET/$p" ] \
          && bad "deploy installed the excluded file '$p' into the target — the exclusion did not hold" || ok ;;
  esac
done

# 4b. the trailing-`/` form covers the WHOLE prefix, not the files that
# happened to exist when the line was written.
[ -e "$TARGET/.claude/skills/source-implement/probe-$$.md" ] \
  && bad "a file added inside an excluded directory shipped anyway — the trailing-/ form must exclude the prefix, or every new file in a source-only skill leaks" || ok

# 4c. deploy never even MENTIONS an excluded path. `items` is the payload
# inventory an operator and the Control app both read; a REMOVED or KEPT
# line for a source-only file would be a claim about a file that is not
# payload at all.
JOUT=$("$GOVCMD" --json harness deploy "$TARGET" 2>/dev/null)
printf '%s' "$JOUT" | jq -e . >/dev/null 2>&1 && ok || bad "harness deploy --json did not emit one object: $(printf '%s' "$JOUT" | head -3)"
for p in $LISTED; do
  printf '%s' "$JOUT" | jq -e --arg p "$p" '[.items[].path] | any(startswith($p))' >/dev/null 2>&1 \
    && bad "deploy's item inventory names '$p' — an excluded path is not payload and has no status to report" || ok
done

# 4d. THE NEIGHBOUR STILL SHIPS. Without this the suite passes just as well
# against a deploy that installs nothing at all.
for n in .claude/rules/parallel-work-isolation.md \
         .claude/agents/issue-validator.md \
         .claude/skills/implement-sop/SKILL.md; do
  [ -f "$ROOT/.deploy-claude/${n#.claude/}" ] || { bad "$n is gone from this repo — the neighbour control needs a real unexcluded file beside each excluded one"; continue; }
  [ -f "$TARGET/$n" ] && ok \
    || bad "deploy did not install '$n', which is NOT excluded — the filter is eating more than its list"
done

# 4e. the manifest describes what landed, so it must agree in both
# directions. A hash map that claims a file the target does not have turns
# every later `verify` red for a file that was never meant to be there.
MAN="$TARGET/.claude/DEPLOYED"
[ -f "$MAN" ] && ok || bad "deploy wrote no .claude/DEPLOYED into the target"
for p in $LISTED; do
  jq -e --arg p "$p" '.files | keys | any(startswith($p))' "$MAN" >/dev/null 2>&1 \
    && bad "the manifest claims excluded path '$p' — the manifest is built from the same roster and cannot list what was never shipped" || ok
done
jq -e '.files | has(".claude/rules/parallel-work-isolation.md")' "$MAN" >/dev/null 2>&1 && ok \
  || bad "the manifest does not claim .claude/rules/parallel-work-isolation.md — an unexcluded payload file must be hashed like any other"

# ---------- 5. verify does not demand them -----------------------------
# The roster check derives its requirement from the same walk, so a target
# missing a source-only file must still be LIVE. If this fails, every
# deployed repo goes red for files it was never sent.
VOUT=$("$GOVCMD" harness verify "$TARGET" 2>&1); vrc=$?
printf '%s' "$VOUT" | grep -qE '^ *ok +scripts-roster' && ok \
  || bad "scripts-roster did not pass against a freshly deployed target: $(printf '%s' "$VOUT" | grep -i 'scripts-roster')"
for p in $LISTED; do
  printf '%s' "$VOUT" | grep -qF -- "$p" \
    && bad "harness verify names excluded path '$p' — it is demanding a file deploy is never going to send" || ok
done
[ "$vrc" -eq 0 ] && ok \
  || bad "harness verify exited $vrc against a freshly deployed target — deploy and verify read one roster and must agree: $(printf '%s' "$VOUT" | grep -E '^ *FAIL' | head -3)"

# ---------- 6. the source repo still holds them ------------------------
# Excluded is not deleted. The files exist here and are what a session in
# THIS repo reads; only the shipping is refused.
for p in $LISTED; do
  case "$p" in
    */) [ -d "$ROOT/.deploy-claude/${p#.claude/}" ] && ok || bad "'$p' vanished from the source repo — exclusion keeps a file HERE and out of targets, not out of both" ;;
    *)  [ -f "$ROOT/.deploy-claude/${p#.claude/}" ] && ok || bad "'$p' vanished from the source repo — exclusion keeps a file HERE and out of targets, not out of both" ;;
  esac
done

# ---------- 7. retired MACHINERY_DOCS: stop shipping, do not reclaim ----
# governance/enforcement-posture.md shipped as MACHINERY_DOCS until
# 2026-09-01 and no longer does. Retiring it is TWO decisions, and this
# section pins both halves apart because conflating them deletes a target's
# own governance record:
#
#   a fresh target must not receive one       — it stopped shipping,
#   an existing copy must survive redeploy    — it was target-editable, so
#                                               that copy is the target's.
#
# The prune deletes any old-manifest path the new roster drops, which is
# right for machinery (a stale script still RUNS) and wrong here. The
# exemption is the deploy lane's seeded() declaration; this proves it.
EPREL="governance/enforcement-posture.md"

# 7a. it is not in the roster and not in a fresh target.
printf '%s' "$LISTED" | grep -qxF "$EPREL" \
  && bad "$EPREL is in payload-exclude.list — it is not under a PAYLOAD_DIR; it left through MACHINERY_DOCS, and listing it here would be a second mechanism for one decision" || ok
grep -qE '^export const MACHINERY_DOCS: readonly string\[\] = \[\];' "$SRC" && ok \
  || bad "MACHINERY_DOCS is not empty in $SRC — the census stopped shipping on 2026-09-01"
[ -f "$TARGET/$EPREL" ] \
  && bad "a freshly deployed target received $EPREL — it no longer ships" || ok
jq -e --arg p "$EPREL" '.files | has($p)' "$TARGET/.claude/DEPLOYED" >/dev/null 2>&1 \
  && bad "the fresh target's manifest claims $EPREL — nothing was installed to claim" || ok

# 7b. a target from the shipping era, with its own edits in the file.
# Reconstructed rather than mocked: the copy on disk AND the manifest entry
# that names it, which together are what the prune reads.
OLD="$SANDBOX/oldtarget"
mkdir -p "$OLD"
"$GOVCMD" harness deploy "$OLD" >/dev/null 2>&1 \
  || bad "harness deploy into $OLD failed — section 7 is not evidence of anything"
mkdir -p "$OLD/governance"
EPBODY='# Enforcement posture

This target wrote its own gates here, which is what the shipping comment invited.
'
printf '%s' "$EPBODY" > "$OLD/$EPREL"
OLDMAN="$OLD/.claude/DEPLOYED"
jq --arg p "$EPREL" '.files[$p] = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$OLDMAN" > "$OLDMAN.tmp" && mv "$OLDMAN.tmp" "$OLDMAN" \
  || bad "could not stage a shipping-era manifest entry for $EPREL"
jq -e --arg p "$EPREL" '.files | has($p)' "$OLDMAN" >/dev/null 2>&1 && ok \
  || bad "the staged manifest does not claim $EPREL — the prune reads the manifest, so the precondition of this test is not met"

ROUT=$("$GOVCMD" harness deploy "$OLD" 2>&1); rrc=$?
[ "$rrc" -eq 0 ] && ok || bad "redeploy over the shipping-era target exited $rrc: $(printf '%s' "$ROUT" | tail -5)"

# The file survives, byte for byte. This is the assertion that matters: a
# prune that deleted it would destroy a governance record this repo never
# wrote and cannot reconstruct.
[ -f "$OLD/$EPREL" ] && ok \
  || bad "redeploy REMOVED $EPREL from a target that had one — stop-shipping is not the same act as reclaiming; the file was target-editable, so that copy is the target's own record"
[ "$(cat "$OLD/$EPREL" 2>/dev/null)" = "$(printf '%s' "$EPBODY")" ] && ok \
  || bad "redeploy altered the target's own $EPREL — a retired document is walked away from, not rewritten"

# And it is dropped from the NEW manifest, so the KEPT line appears once per
# stale manifest rather than on every deploy forever.
jq -e --arg p "$EPREL" '.files | has($p)' "$OLDMAN" >/dev/null 2>&1 \
  && bad "the new manifest still claims $EPREL — it is no longer shipped, so nothing should reconsider it on the next deploy" || ok
printf '%s' "$ROUT" | grep -q "$EPREL" && ok \
  || bad "redeploy said nothing about $EPREL — the operator is being told the installer chose not to delete their file, per the prune's own KEPT contract"

# 7c. the counter-case, so 7b cannot pass by the prune being broken.
# A machinery path the old manifest claims and the roster no longer names
# IS reclaimed. Same manifest, same deploy, opposite outcome.
STALE=".claude/scripts/retired-$$"
mkdir -p "$OLD/.claude/scripts"
printf '#!/usr/bin/env node\nprocess.exit(0);\n' > "$OLD/$STALE"
jq --arg p "$STALE" '.files[$p] = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$OLDMAN" > "$OLDMAN.tmp" && mv "$OLDMAN.tmp" "$OLDMAN"
"$GOVCMD" harness deploy "$OLD" >/dev/null 2>&1
[ -f "$OLD/$STALE" ] \
  && bad "the prune left stale machinery '$STALE' in the target — a script one version out of date still RUNS, and reclaiming it is the prune's default" || ok

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
