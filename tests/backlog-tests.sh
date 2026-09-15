#!/bin/sh
# backlog-tests.sh — T-0035/T-0092/T-0096: the backlog renderer.
# .claude/scripts/scrumux backlog tasks splits open work into ranked (a priority
# someone set with scrumux rank, numbered) and never-ranked (unnumbered,
# under its own heading), annotates live sprint membership, and never
# shows accepted tasks. scrumux rank set promotes or reorders exactly one task
# and leaves unranked work alone.
# GOV_ROOT sandbox. Run: sh tests/backlog-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
BACKLOG="$ROOT/.deploy-claude/scripts/scrumux"
BACKLOG_CMD="backlog tasks"
SANDBOX=$(mktemp -d) || { echo "backlog-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- empty sandbox: no tasks.json ------------------------------------
OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1); rc=$?
[ $rc -eq 0 ] && printf '%s' "$OUT" | grep -q 'nothing to rank' \
  && ok || bad "empty repo message — rc=$rc: $OUT"

# --- fixtures: three tasks, one accepted -----------------------------
"$GOVCMD" feature new --name F --desc D >/dev/null 2>&1
"$GOVCMD" story new --feature F-0001 --narrative N --criterion C >/dev/null 2>&1
"$GOVCMD" task new --title Alpha --check A --feature F-0001 --story S-0001 >/dev/null 2>&1
"$GOVCMD" task new --title Beta --check B >/dev/null 2>&1
"$GOVCMD" task new --title Gamma --check C >/dev/null 2>&1
"$GOVCMD" task status T-0001 in_progress >/dev/null 2>&1
"$GOVCMD" log new --task T-0001 --title L --did D --verified V >/dev/null 2>&1
# Acceptance targets the TASK (D-0076). This fixture used to mint an
# R- record and accept that; `gov review` and reviews.json are gone, and
# the fixture had been silently failing since acceptance re-homed —
# leaving T-0001 unaccepted and leaking it into the backlog view.
# Acceptance refuses work that was never verified, and a receipt needs an
# order to name a command — so the fixture has to earn its acceptance the
# way real work does.
"$GOVCMD" task order T-0001 --story S-0001 --scope S --verify true --out O \
  --file "alpha.txt | the file this fixture task owns" >/dev/null 2>&1
"$GOVCMD" task status T-0001 in_review >/dev/null 2>&1
"$ROOT/.deploy-claude/scripts/scrumux" task verify T-0001 >/dev/null 2>&1
"$GOVCMD" task accept T-0001 --by tester --authority direct >/dev/null 2>&1

# --- never-ranked render: id order, UNNUMBERED (I-0040) ---------------
# These two assertions previously demanded '^1. T-0002' / '^2. T-0003',
# pinning the defect in place: tasks nobody had ever ranked rendered as
# numbered priorities. Numbers now mean rank and nothing else.
OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "renderer exits 0 — rc=$rc: $OUT"
printf '%s\n' "$OUT" | grep -q '^- T-0002 \[proposed\] Beta' \
  && ok || bad "unranked line 1 — got: $(printf '%s' "$OUT" | grep T-0002)"
printf '%s\n' "$OUT" | grep -q '^- T-0003 \[proposed\] Gamma' \
  && ok || bad "unranked line 2 — got: $(printf '%s' "$OUT" | grep T-0003)"
printf '%s' "$OUT" | grep -q 'T-0001' \
  && bad "accepted task leaked into backlog view" || ok

# --- rank promotes ONE task; the rest stay unranked (I-0044) ----------
# The second assertion previously demanded '^2. T-0002' — it required a
# rank move to stamp a rank on a task nobody had ranked, which is the
# defect I-0044 describes.
"$GOVCMD" rank set T-0003 1 >/dev/null 2>&1
OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1)
printf '%s\n' "$OUT" | grep -q '^1\. T-0003 \[proposed\] Gamma' \
  && ok || bad "ranked task renders at its rank — got: $(printf '%s' "$OUT" | sed -n '2p')"
printf '%s\n' "$OUT" | grep -q '^- T-0002 \[proposed\] Beta' \
  && ok || bad "an unrelated task must stay unranked after a move — got: $(printf '%s' "$OUT" | grep T-0002)"

# --- feature/story annotation ----------------------------------------
"$GOVCMD" task update T-0002 --feature F-0001 --story S-0001 >/dev/null 2>&1
OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1)
printf '%s' "$OUT" | grep -q 'T-0002.*'"(F-0001/S-0001)" \
  && ok || bad "feature/story annotation — got: $(printf '%s' "$OUT" | grep T-0002)"

# --- I-0040: task new leaves rank unset -------------------------------
# rank means "someone decided this priority". Manufacturing one at
# creation would sort brand-new work above never-prioritised work, which
# is the same falsehood the old numbered view told.
"$GOVCMD" task new --title Delta --check D >/dev/null 2>&1
R=$(jq -r '[.entries[] | select(.id=="T-0004")][0].rank // "unset"' "$SANDBOX/governance/tasks.json")
[ "$R" = unset ] \
  && ok || bad "task new must leave rank unset — got '$R'"

# --- I-0040: never-ranked work is listed, not numbered -----------------
# It must appear under its own heading, WITHOUT a position number, so an
# absent priority decision can never be read as a priority decision.
OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1)
printf '%s' "$OUT" | grep -q 'Never ranked (2)' \
  && ok || bad "unranked section header missing — got: $OUT"
printf '%s\n' "$OUT" | grep -q '^- T-0004 \[proposed\] Delta' \
  && ok || bad "unranked task must render unnumbered — got: $(printf '%s' "$OUT" | grep T-0004)"
printf '%s\n' "$OUT" | grep -qE '^[0-9]+\. T-0004' \
  && bad "unranked task was given a priority number" || ok

# --- I-0040: live sprint membership is annotated ----------------------
# One run must answer both "what is committed" and "what is merely
# captured"; without this the reader has to cross-check sprint-status.
cat > "$SANDBOX/governance/sprints.json" <<'EOF'
{"entries":[{"id":"SP-0001","status":"ratified","epic":"E-0001","tasks":["T-0003"]},
            {"id":"SP-0002","status":"complete","epic":"E-0001","tasks":["T-0002"]}]}
EOF
OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1)
printf '%s' "$OUT" | grep -q 'T-0003.*\[SP-0001 ratified\]' \
  && ok || bad "ratified sprint annotation missing — got: $(printf '%s' "$OUT" | grep T-0003)"
printf '%s' "$OUT" | grep -q 'T-0002.*SP-0002' \
  && bad "completed sprint must not annotate as live work" || ok

# --- I-0044: a rank move must not stamp ranks on unranked work --------
# cmd_rank previously densified across EVERY open task, so ranking one
# item converted the whole never-prioritised backlog into false
# priorities — undoing the split above with a single command.
"$GOVCMD" task new --title Epsilon --check E >/dev/null 2>&1   # T-0005, unranked
"$GOVCMD" task new --title Zeta    --check Z >/dev/null 2>&1   # T-0006, unranked
BEFORE=$(jq -r '[.entries[] | select(.status != "accepted" and .rank == null)] | length' "$SANDBOX/governance/tasks.json")
"$GOVCMD" rank set T-0003 1 >/dev/null 2>&1   # already ranked — a pure reorder
AFTER=$(jq -r '[.entries[] | select(.status != "accepted" and .rank == null)] | length' "$SANDBOX/governance/tasks.json")
[ "$BEFORE" = "$AFTER" ] \
  && ok || bad "rank move stamped ranks on unranked tasks — unranked went $BEFORE -> $AFTER"
jq -e '[.entries[] | select(.id=="T-0005" or .id=="T-0006") | select(.rank != null)] | length == 0' \
  "$SANDBOX/governance/tasks.json" >/dev/null \
  && ok || bad "untouched tasks gained a rank from an unrelated move"

# --- I-0044: ranking an unranked task promotes only that one ----------
"$GOVCMD" rank set T-0005 1 >/dev/null 2>&1
jq -e '[.entries[] | select(.id=="T-0005")][0].rank == 1' "$SANDBOX/governance/tasks.json" >/dev/null \
  && ok || bad "ranking an unranked task by id must place it at the requested position"
jq -e '[.entries[] | select(.id=="T-0006")][0].rank == null' "$SANDBOX/governance/tasks.json" >/dev/null \
  && ok || bad "promoting one unranked task must leave the others unranked"

# --- T-0093: features rank in the same address space ------------------
# Same semantics as task ranks, in their own list: absent means never
# prioritised and must never render as a priority decision.
"$GOVCMD" feature new --name FeatB --desc DB >/dev/null 2>&1
"$GOVCMD" feature new --name FeatC --desc DC >/dev/null 2>&1
FB=$(jq -r '[.entries[] | select(.kind=="feature" and .name=="FeatB")][0].id' "$SANDBOX/governance/design.json")
FC=$(jq -r '[.entries[] | select(.kind=="feature" and .name=="FeatC")][0].id' "$SANDBOX/governance/design.json")
TASKRANKS_BEFORE=$(jq -c '[.entries[] | {id, rank}]' "$SANDBOX/governance/tasks.json")

expect_ok() { out=$("$@" 2>&1); rc=$?; [ $rc -eq 0 ] && ok || bad "$* — rc=$rc: $out"; }
expect_ok "$GOVCMD" rank set "$FB" 1
expect_ok "$GOVCMD" rank set "$FC" 2
FR=$(jq -r --arg b "$FB" --arg c "$FC" '[.entries[] | select(.id==$b or .id==$c) | .rank] | tostring' "$SANDBOX/governance/design.json")
[ "$FR" = "[1,2]" ] && ok || bad "feature ranks should be [1,2] — got $FR"
# ranking a FEATURE must not disturb any task rank
TASKRANKS_AFTER=$(jq -c '[.entries[] | {id, rank}]' "$SANDBOX/governance/tasks.json")
[ "$TASKRANKS_BEFORE" = "$TASKRANKS_AFTER" ] \
  && ok || bad "ranking a feature must leave task ranks untouched"
# the features view renders ranked first, then an unranked heading
FOUT=$("$BACKLOG" backlog features 2>&1)
printf '%s\n' "$FOUT" | grep -q "^1\. $FB " && ok || bad "the features view must number the rank-1 feature — got: $(printf '%s' "$FOUT" | head -3)"
printf '%s\n' "$FOUT" | grep -q 'Never ranked' && ok || bad "the features view needs its own never-ranked heading"
printf '%s\n' "$FOUT" | grep -q 'stories=' && ok || bad "the features view must carry story and task counts"
# --clear works in the feature address space too, and re-densifies
expect_ok "$GOVCMD" rank clear "$FB"
FR2=$(jq -r --arg c "$FC" '[.entries[] | select(.id==$c) | .rank] | tostring' "$SANDBOX/governance/design.json")
[ "$FR2" = "[1]" ] && ok || bad "clearing a feature rank must re-densify the rest — got $FR2"
HASF=$(jq -r --arg b "$FB" '.entries[] | select(.id==$b) | has("rank")' "$SANDBOX/governance/design.json")
[ "$HASF" = "false" ] && ok || bad "a cleared feature must lose the rank KEY — has(rank)=$HASF"
# a CORRUPT design.json must not read as an empty one (panel finding)
CORRUPT=$(mktemp -d)
mkdir -p "$CORRUPT/governance"
printf '{broken' > "$CORRUPT/governance/design.json"
OUTX=$(GOV_ROOT="$CORRUPT" "$BACKLOG" backlog features 2>&1); rcx=$?
[ "$rcx" -ne 0 ] && printf '%s' "$OUTX" | grep -q 'not valid JSON' \
  && ok || bad "a corrupt design.json must be reported, not rendered as no features — rc=$rcx: $OUTX"
printf '%s' "$OUTX" | grep -q '(no features)' \
  && bad "a corrupt design.json must NOT print '(no features)' — that reads as 'there are none'" || ok
rm -rf "$CORRUPT"

# an unknown feature id is refused, actionably
OUTF=$("$GOVCMD" rank set F-9999 1 2>&1); rcf=$?
[ "$rcf" -ne 0 ] && printf '%s' "$OUTF" | grep -q 'not found in design.json' \
  && ok || bad "an unknown feature id must be refused — rc=$rcf: $OUTF"

# --- T-0097: a rank can be CLEARED, not only moved --------------------
# cmd_rank could place and reorder but never delete, so returning a task
# to never-prioritised needed a direct jq write during the SP-0017/0018
# repair. Deletion must remove the KEY: backlog partitions on rank ==
# null and task.schema.json declares rank as an integer with minimum 1,
# so null or 0 would be both wrong and schema-illegal.
"$GOVCMD" task new --title Rankable1 --check A >/dev/null 2>&1
"$GOVCMD" task new --title Rankable2 --check A >/dev/null 2>&1
"$GOVCMD" task new --title Rankable3 --check A >/dev/null 2>&1
R1=$(jq -r '[.entries[] | select(.title=="Rankable1")][0].id' "$SANDBOX/governance/tasks.json")
R2=$(jq -r '[.entries[] | select(.title=="Rankable2")][0].id' "$SANDBOX/governance/tasks.json")
R3=$(jq -r '[.entries[] | select(.title=="Rankable3")][0].id' "$SANDBOX/governance/tasks.json")
"$GOVCMD" rank set "$R1" 1 >/dev/null 2>&1
"$GOVCMD" rank set "$R2" 2 >/dev/null 2>&1
"$GOVCMD" rank set "$R3" 3 >/dev/null 2>&1
UNRANKED_BEFORE=$(jq '[.entries[] | select(.status != "accepted" and .status != "superseded" and .rank == null)] | length' "$SANDBOX/governance/tasks.json")

OUT=$("$GOVCMD" rank clear "$R2" 2>&1); rc=$?
[ $rc -eq 0 ] && printf '%s' "$OUT" | grep -q 'rank cleared' \
  && ok || bad "scrumux rank set --clear should succeed — rc=$rc: $OUT"
HASKEY=$(jq -r --arg t "$R2" '.entries[] | select(.id==$t) | has("rank")' "$SANDBOX/governance/tasks.json")
[ "$HASKEY" = "false" ] \
  && ok || bad "--clear must DELETE the rank key, not null it — has(rank)=$HASKEY"
# the survivors re-densify with no gap
RANKS=$(jq -r --arg a "$R1" --arg c "$R3" '[.entries[] | select(.id==$a or .id==$c) | .rank] | sort | tostring' "$SANDBOX/governance/tasks.json")
[ "$RANKS" = "[1,2]" ] \
  && ok || bad "remaining ranks must re-densify 1..K with no gap — got $RANKS"
# exactly one task joined the unranked set: never-prioritised work is untouched
UNRANKED_AFTER=$(jq '[.entries[] | select(.status != "accepted" and .status != "superseded" and .rank == null)] | length' "$SANDBOX/governance/tasks.json")
[ "$UNRANKED_AFTER" = "$((UNRANKED_BEFORE + 1))" ] \
  && ok || bad "--clear must move exactly one task to unranked — $UNRANKED_BEFORE -> $UNRANKED_AFTER"
# and it renders unnumbered under the Never ranked heading
printf '%s\n' "$("$BACKLOG" $BACKLOG_CMD 2>&1)" | grep -q "^- $R2 " \
  && ok || bad "a cleared task must render unnumbered under Never ranked"
# clearing something that has no rank is refused, actionably
OUTC=$("$GOVCMD" rank clear "$R2" 2>&1); rcc=$?
[ "$rcc" -ne 0 ] && printf '%s' "$OUTC" | grep -q 'no rank to clear' \
  && ok || bad "clearing an unranked task must be refused with a reason — rc=$rcc: $OUTC"

# --- T-0103/I-0048: the description is rendered -----------------------
# User was asked to rank 22 tasks off a view that showed him none of the
# reasoning. A row now carries its description as ONE continuation line,
# truncated by default and complete under --full.
LONG="RULING: this is post-MVP and stays unranked until User says otherwise. It carries enough prose to be truncated in the default view, which is the whole point of the flag, so it must run well past the one-hundred-and-fifty character cut to prove the elision is real."
"$GOVCMD" task new --title Delta --check D --desc "$LONG" >/dev/null 2>&1
"$GOVCMD" task new --title Epsilon --check E >/dev/null 2>&1   # no description at all

OUT=$("$BACKLOG" $BACKLOG_CMD 2>&1)
printf '%s\n' "$OUT" | grep -q 'RULING: this is post-MVP' \
  && ok || bad "default mode must show the start of the description"
printf '%s\n' "$OUT" | grep -q 'scrumux backlog tasks --full' \
  && ok || bad "a truncated description must name the flag that shows the rest"
printf '%s\n' "$OUT" | grep -q 'prove the elision is real' \
  && bad "default mode must NOT print the untruncated tail" || ok

# exactly one row line and one description line for the described task,
# and NO empty continuation line for the task that has no description
DESCN=$(printf '%s\n' "$OUT" | grep -c '^     ')
WITH=$(jq '[.entries[] | select(.status != "accepted" and .status != "superseded")
            | select((.description // "") | length > 0)] | length' "$SANDBOX/governance/tasks.json")
[ "$DESCN" = "$WITH" ] \
  && ok || bad "one description line per described task — $DESCN lines for $WITH described tasks"
# id-agnostic: earlier scrumux rank set cases in this suite decide whether a task
# renders numbered or dashed, so pin the property, not the address
printf '%s\n' "$OUT" | grep -q 'Epsilon' \
  && ok || bad "a task with no description still renders its row"
printf '%s\n' "$OUT" | grep -A1 'Epsilon' | tail -1 | grep -q '^     ' \
  && bad "a task with no description must emit NO continuation line" || ok

# --- --full prints the whole thing ------------------------------------
OUTF=$("$BACKLOG" $BACKLOG_CMD --full 2>&1)
printf '%s\n' "$OUTF" | grep -q 'prove the elision is real' \
  && ok || bad "--full must print the untruncated description"
printf '%s\n' "$OUTF" | grep -q 'scrumux backlog tasks --full' \
  && bad "--full must not advertise itself as the way to see more" || ok

# --- T-0156/I-0078: a corrupt journal must not read as an empty one ----
# The main view had the blind spot the features view already closed: an
# unparseable journal made jq fail, LIST came back empty and the view
# printed "(no open tasks)" and exited 0 — "there are none" when the
# truth is "I could not read it". Two journals feed this view, so both
# are asserted; the missing-file cases above must stay distinct, because
# absent is fine and unreadable is not.
CORRUPT=$(mktemp -d)
mkdir -p "$CORRUPT/governance"
printf '{broken' > "$CORRUPT/governance/tasks.json"
OUTT=$(GOV_ROOT="$CORRUPT" "$BACKLOG" $BACKLOG_CMD 2>&1); rct=$?
[ "$rct" -ne 0 ] && printf '%s' "$OUTT" | grep -q 'tasks.json is not valid JSON' \
  && ok || bad "a corrupt tasks.json must be reported, not rendered as no open tasks — rc=$rct: $OUTT"
printf '%s' "$OUTT" | grep -q 'restore it from git' \
  && ok || bad "a corrupt tasks.json must say how to recover — got: $OUTT"
printf '%s' "$OUTT" | grep -q '(no open tasks)' \
  && bad "a corrupt tasks.json must NOT print '(no open tasks)' — that reads as 'there are none'" || ok
# a MISSING tasks.json is a different outcome: the empty-repo message, rc 0
printf '%s' "$OUTT" | grep -q 'nothing to rank' \
  && bad "a corrupt tasks.json must not borrow the missing-file message" || ok

# sprints.json is optional, so absent is fine — but a corrupt one is
# slurped into --argjson and kills the same jq, telling the same lie
cp "$SANDBOX/governance/tasks.json" "$CORRUPT/governance/tasks.json"
printf '{broken' > "$CORRUPT/governance/sprints.json"
OUTS=$(GOV_ROOT="$CORRUPT" "$BACKLOG" $BACKLOG_CMD 2>&1); rcs=$?
[ "$rcs" -ne 0 ] && printf '%s' "$OUTS" | grep -q 'sprints.json is not valid JSON' \
  && ok || bad "a corrupt sprints.json must be reported, not rendered as no open tasks — rc=$rcs: $OUTS"
printf '%s' "$OUTS" | grep -q 'restore it from git' \
  && ok || bad "a corrupt sprints.json must say how to recover — got: $OUTS"
printf '%s' "$OUTS" | grep -q '(no open tasks)' \
  && bad "a corrupt sprints.json must NOT print '(no open tasks)'" || ok
# and an ABSENT sprints.json still renders the list, unannotated
rm -f "$CORRUPT/governance/sprints.json"
OUTA=$(GOV_ROOT="$CORRUPT" "$BACKLOG" $BACKLOG_CMD 2>&1); rca=$?
[ "$rca" -eq 0 ] && printf '%s' "$OUTA" | grep -q 'T-' \
  && ok || bad "an absent sprints.json must stay optional, not fatal — rc=$rca: $OUTA"
rm -rf "$CORRUPT"

# --- an unknown flag is refused, actionably ---------------------------
OUTB=$("$BACKLOG" $BACKLOG_CMD --bogus 2>&1); rcb=$?
[ "$rcb" -ne 0 ] && printf '%s' "$OUTB" | grep -q 'usage: scrumux backlog' \
  && ok || bad "unknown flag must exit non-zero with a usage line — rc=$rcb: $OUTB"


# --- OQ-16 (D-0085): --features guards tasks.json as it guards design ---
# The branch already refuses an unreadable design.json with the one shared
# wording, then two lines later cat'd tasks.json unchecked into --argjson.
# That is the I-0102 shape exactly -- a parse error leaks to stderr and the
# caller gets an empty string, so the view renders as though the journal
# were empty. ABSENT is still fine; UNREADABLE is not.
SB_CORRUPT=$(mktemp -d) || exit 1
mkdir -p "$SB_CORRUPT/governance"
printf '{"entries":[]}\n' > "$SB_CORRUPT/governance/design.json"
printf 'NOT JSON AT ALL\n' > "$SB_CORRUPT/governance/tasks.json"
OUTC=$(GOV_ROOT="$SB_CORRUPT" "$BACKLOG" backlog features 2>&1); rcc=$?
[ "$rcc" -ne 0 ] \
  && ok || bad "OQ-16: backlog features must REFUSE an unreadable tasks.json, not render around it; rc=$rcc, out: $OUTC"
printf '%s' "$OUTC" | grep -q 'tasks.json is not valid JSON' \
  && ok || bad "OQ-16: the refusal must name tasks.json and its repair (the one shared wording); got: $OUTC"

# ABSENT is still normal -- the guard must not turn a fresh repo into an error.
rm -f "$SB_CORRUPT/governance/tasks.json"
OUTA=$(GOV_ROOT="$SB_CORRUPT" "$BACKLOG" backlog features 2>&1); rca=$?
[ "$rca" -eq 0 ] \
  && ok || bad "OQ-16: an ABSENT tasks.json is a normal state and must not refuse; rc=$rca, out: $OUTA"
rm -rf "$SB_CORRUPT"

printf 'backlog-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
