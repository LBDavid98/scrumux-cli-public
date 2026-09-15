#!/bin/sh
# ungoverned-repo-tests.sh — the self-governance refusal.
#
# The tool must never govern the repo that BUILDS it. A repo carrying a
# committed `.scrumux-ungoverned` at its root is outside the harness, and
# the dispatcher refuses the record-writing and workflow surface there
# with exit 2 while leaving the delivery and read-only surface intact.
#
# Why it is a wall and not a rule: a governance record written about the
# harness's own construction freezes whatever policy the tool happened to
# hold that afternoon, and every later session reads those transient,
# half-finished rules as settled law. The record then defends the gaps
# instead of exposing them. Nothing an agent reads can be relied on to
# prevent that, so the CLI decides it.
#
# The blocked roster is READ FROM THE DISPATCHER, never listed here: it is
# the noun registry minus UNGOVERNED_ALLOWED_NOUNS. A noun added to the
# CLI is therefore blocked by default and this suite proves it, rather
# than a hand-written list here silently going stale (T-0202's lesson).
#
# Run: sh tests/ungoverned-repo-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
# The dispatcher is TypeScript; the exemption list and the noun registry
# are read from source, as they were read from the shell dispatcher before it.
DISPATCH="$ROOT/src/cli/ungoverned.ts"
REGISTRY="$ROOT/src/cli/usage-text.ts"
MARKER_NAME=.scrumux-ungoverned

SANDBOX=$(mktemp -d) || { echo "ungoverned-repo-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT

# Two disposable roots, identical but for the marker. GOV_ROOT is what
# names the repo whose records would be written, and it is what the
# dispatcher scans from — so it is the axis this suite varies.
UNGOV="$SANDBOX/ungoverned"
GOVED="$SANDBOX/governed"
mkdir -p "$UNGOV/nested/deeper" "$GOVED"
printf 'builds the tool; governing it here would bake this afternoon into law\n' > "$UNGOV/$MARKER_NAME"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# The nouns the dispatcher itself declares, and the ones it exempts.
ALLOWED=$(sed -n "s/^export const UNGOVERNED_ALLOWED_NOUNS = '\(.*\)';$/\1/p" "$DISPATCH")
[ -n "$ALLOWED" ] && ok \
  || bad "the dispatcher no longer declares UNGOVERNED_ALLOWED_NOUNS — this suite reads the exemption list from the source and cannot run without it"

ALL_NOUNS=$(sed -n "/^export const NOUN_SUMMARY/,/^\];$/p" "$REGISTRY" | grep -o "^  \['[a-z]*'" | tr -d "[' ")
[ "$(printf '%s\n' "$ALL_NOUNS" | grep -c .)" -ge 15 ] && ok \
  || bad "could not read the noun registry out of $REGISTRY — got: $(printf '%s' "$ALL_NOUNS" | tr '\n' ' ')"

BLOCKED=''
for _n in $ALL_NOUNS; do
  case " $ALLOWED " in *" $_n "*) continue ;; esac
  BLOCKED="$BLOCKED $_n"
done

# ---------- 1. the shipped marker -------------------------------------
# This repo is the source of the harness, so it carries the marker itself.
# It is COMMITTED — a marker that a clone does not receive protects only
# this working copy, and the next clone quietly governs itself.
[ -f "$ROOT/$MARKER_NAME" ] && ok \
  || bad "$ROOT/$MARKER_NAME is missing — the repo that builds scrumux must declare itself outside the harness"
[ -s "$ROOT/$MARKER_NAME" ] && ok \
  || bad "$MARKER_NAME must carry a one-line reason; an exemption nobody can read is one nobody can audit"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" check-ignore -q "$MARKER_NAME" \
    && bad "$MARKER_NAME is gitignored — it must travel with the repo, or a clone governs itself" || ok
else
  ok
fi

# ---------- 2. the governance surface is refused ----------------------
# `__probe` is not a verb anywhere. The guard sits above verb validation on
# purpose, so a blocked noun refuses before argv can reach a module — which
# is also what makes this probe safe: nothing can write.
for _n in $BLOCKED; do
  out=$(GOV_ROOT="$UNGOV" "$GOVCMD" "$_n" __probe 2>&1); rc=$?
  [ "$rc" -eq 2 ] && ok || bad "noun '$_n' exited $rc in an ungoverned repo, want 2 — the command could not run, which is what 2 means"
  printf '%s' "$out" | grep -qF -- "$MARKER_NAME" && ok \
    || bad "noun '$_n' was refused without naming $MARKER_NAME — a wall says no AND says why, and the reader has to know which file made the decision"
done

# The rationale, not merely a refusal. Every clause below is a thing the
# reader needs in order to stop rather than route around.
REF=$(GOV_ROOT="$UNGOV" "$GOVCMD" sprint new 2>&1)
printf '%s' "$REF" | grep -qF -- "$UNGOV/$MARKER_NAME" && ok \
  || bad "the refusal must name the marker's PATH, so the reader can read the reason for themselves: '$REF'"
printf '%s' "$REF" | grep -qF 'builds the tool; governing it here would bake this afternoon into law' && ok \
  || bad "the refusal must quote the marker's own one-line reason — that line is why THIS repo is exempt, and it differs per repo"
printf '%s' "$REF" | grep -qi 'transient' && ok \
  || bad "the refusal must give the reason self-governance is refused: transient, often flawed policy baked into the record"
printf '%s' "$REF" | grep -qF 'RULINGS.md' && ok \
  || bad "the refusal must say where rulings for this repo DO go (RULINGS.md at the repo root) — a refusal with no sanctioned path is one an agent works around"
printf '%s' "$REF" | grep -qi 'not a wall to route around' && ok \
  || bad "the refusal must say it is working as intended; an agent that reads it as a defect will try to defeat it"

# The drumbeat contract: the unindented lines are the answer, everything
# after is indented advisory.
ANSWER=$(printf '%s\n' "$REF" | grep -v '^  ' | sed '/^$/d')
[ "$(printf '%s\n' "$ANSWER" | grep -c .)" -eq 1 ] && ok \
  || bad "the refusal must have exactly ONE unindented answer line; the rationale is advisory and indented — got: '$ANSWER'"
case "$ANSWER" in "scrumux sprint new: error: "*) ok ;; *) bad "the answer line must name the command it refused, in the CLI's error shape — got '$ANSWER'" ;; esac

# --json is not a way past it, and the envelope reports the same verdict.
JOUT=$(GOV_ROOT="$UNGOV" "$GOVCMD" --json task new --title X --check Y 2>/dev/null); jrc=$?
[ "$jrc" -eq 2 ] && ok || bad "--json exited $jrc, want 2 — the exit rule does not change with the output mode"
[ "$(printf '%s' "$JOUT" | jq -r '.exit')" = "2" ] && ok || bad "--json envelope must carry exit 2: $JOUT"
[ "$(printf '%s' "$JOUT" | jq -r '.ok')" = "false" ] && ok || bad "--json envelope must carry ok:false: $JOUT"
[ "$(printf '%s' "$JOUT" | jq -r '.command')" = "task new" ] && ok || bad "--json envelope must name the refused command: $JOUT"
printf '%s' "$JOUT" | jq -e '.error.message | test("'"$MARKER_NAME"'")' >/dev/null 2>&1 && ok \
  || bad "--json error.message must carry the same rationale a human gets; a machine consumer that only sees 'refused' cannot report why"

# ---------- 3. the walk finds a marker above the scan root ------------
# The marker sits at the REPO root. A session working two directories down
# is in the same ungoverned repo and must get the same answer.
rc=0; GOV_ROOT="$UNGOV/nested/deeper" "$GOVCMD" sprint new >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] && ok || bad "a scan root below the marker exited $rc, want 2 — the guard must walk UP, or every subdirectory is a hole in it"

# ---------- 4. the delivery and read-only surface still works ---------
# The harness has to be buildable, deployable and inspectable from its own
# source tree. None of these writes a governance record.
for _n in $ALLOWED; do
  out=$(GOV_ROOT="$UNGOV" "$GOVCMD" "$_n" __probe 2>&1)
  printf '%s' "$out" | grep -qF -- "$MARKER_NAME" \
    && bad "noun '$_n' is on the allow list but was refused as ungoverned: $out" || ok
done

for probe in version --version help; do
  out=$(GOV_ROOT="$UNGOV" "$GOVCMD" "$probe" 2>&1); rc=$?
  [ "$rc" -eq 0 ] && ok || bad "'scrumux $probe' exited $rc in an ungoverned repo — the help surface never writes anything and must never be refused"
  printf '%s' "$out" | grep -qF -- "$MARKER_NAME" && bad "'scrumux $probe' was refused as ungoverned" || ok
done

# `<blocked-noun> help` prints the manual. A refusal that also hides the
# documentation teaches the reader less than the documentation would.
out=$(GOV_ROOT="$UNGOV" "$GOVCMD" sprint help 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "'scrumux sprint help' exited $rc in an ungoverned repo — usage is read-only"
printf '%s' "$out" | grep -q 'scrumux sprint' && ok || bad "'scrumux sprint help' did not print the sprint usage: $out"

# status session is on the SessionStart hook. Refusing it would turn every
# session in the source repo into a hook failure, teaching nothing.
rc=0; GOV_ROOT="$UNGOV" "$GOVCMD" status session >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] && ok || bad "'scrumux status session' exited $rc in an ungoverned repo — it always exits 0 and the SessionStart hook depends on it"

rc=0; GOV_ROOT="$UNGOV" "$GOVCMD" records check >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 2 ] && ok || bad "'scrumux records check' could not run in an ungoverned repo — a read-only validator is how you inspect a repo you do not govern"

# ---------- 5. a repo WITHOUT the marker is untouched -----------------
# The whole guard must be inert where no marker exists. This is the control:
# if these fail, the refusal is not scoped to the marker at all.
[ ! -f "$GOVED/$MARKER_NAME" ] && ok || bad "the control root must not carry a marker"

out=$(GOV_ROOT="$GOVED" "$GOVCMD" feature new --name Feat --desc Desc 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "'feature new' exited $rc in a repo with no marker — got: $out"
[ "$(printf '%s\n' "$out" | grep -v '^  ' | sed '/^$/d')" = "F-0001" ] && ok \
  || bad "'feature new' must answer F-0001 in an ungoverned-marker-free repo — got: $out"

out=$(GOV_ROOT="$GOVED" "$GOVCMD" task new --title T1 --check AC1 --feature F-0001 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "'task new' exited $rc in a repo with no marker — got: $out"

out=$(GOV_ROOT="$GOVED" "$GOVCMD" log new --title L --did "evidence" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "'log new' exited $rc in a repo with no marker — got: $out"

# Every blocked noun must reach its own module there — the failure it gives
# is "unknown verb", not the ungoverned refusal.
for _n in $BLOCKED; do
  out=$(GOV_ROOT="$GOVED" "$GOVCMD" "$_n" __probe 2>&1)
  printf '%s' "$out" | grep -qF -- "$MARKER_NAME" \
    && bad "noun '$_n' was refused as ungoverned in a repo carrying NO marker — the guard is not scoped to the marker" || ok
done

# ---------- 6. the guard runs before the noun runs --------------------
# It asserted ORDER IN THE SHELL DISPATCHER: the guard had to sit above the
# `ts-owns.sh` flip, or a flipped verb walked past it into the bundle. There
# is one dispatcher now and the ordering is a statement in it, so the claim is
# asserted where it lives — the refusal is reached before any noun module is.
G_LINE=$(grep -n 'isAllowed' "$ROOT/src/cli/dispatch.ts" | head -1 | cut -d: -f1)
R_LINE=$(grep -n 'MODULE.run\|mod.run(' "$ROOT/src/cli/dispatch.ts" | head -1 | cut -d: -f1)
[ -n "$G_LINE" ] && [ -n "$R_LINE" ] && [ "$G_LINE" -lt "$R_LINE" ] && ok \
  || bad "the ungoverned guard (line ${G_LINE:-?}) must be reached before a noun module runs (line ${R_LINE:-?})"

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
