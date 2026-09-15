# Promises-Kept Audit — bash codebase vs the harness manifesto (now `RULINGS.md` Part I)

> Pinned at 5d823b1 — file:line references resolve against `git show 5d823b1:<path>`; the tree may have moved.

Performed by the orchestrator (Claude, session of 2026-08-31), per the approved
TS-migration plan Phase 0. Every line of the bash CLI, the four walls,
readonly-sh, settings.json, and the three Python libraries was read against the
Prime Article and Articles 1–10. The plan itself carries its own
manifesto-compliance section.

**Verdict up front: the codebase keeps its promises.** Every blocking surface
binds the agent, never the user (Prime); refusals name their fix with cited
incidents (Art. 5); evidence is script-written (Art. 6); checks claim only what
they compute, with the attested/verified split stated at the point of recording
(Art. 4); deliberate loosenesses are documented at their decision sites. The
findings below are edge deviations and hygiene, not structural breaks.

Validation status: **all ten NEW findings CONFIRMED** by an independent
validator (2026-08-31) with file:line and git-blame intent evidence; none is
contradicted by any ruling, comment, or commit. Two corrections the validator
made to this register's own claims are folded in below. KNOWN findings are
already in the governance record or the approved plan.

---

## Findings

| # | Finding | Article | Where | Status |
|---|---|---|---|---|
| PK-1 | `scrumux <unknown-noun> --json` emits prose + exit 2, not the one-object envelope every other refusal produces | 5 (consistency of the instruction channel) | `.claude/scripts/scrumux:196-200` | KNOWN — plan OBSERVABLE proposal |
| PK-2 | `CLI_ARGV` is captured via `jq -R -s 'split("\n")…'`, so an argument containing a newline (a `--rationale` paragraph) is recorded as multiple argv entries — the envelope's `.argv` misstates what was run. Also drops an EMPTY argument outright, via the same expression's `select(length > 0)`: `--title ''` was recorded as `["--title"]` | 6 (the record misdescribes the act) | `.claude/scripts/scrumux:215` | **RATIFIED and FIXED (2026-09-01)** — on the PK-1 precedent, the correct behaviour wins on BOTH sides at once. bash now captures with `jq -nc '$ARGS.positional' --args -- "$@"`, which takes the list as a list and rebuilds nothing; the TypeScript side has recorded argv verbatim since Wave 1A (`src/cli/argv.ts`) and is unchanged. Held by the differential at `t2-awkward-argv`, whose `.argv` comparison is literal precisely so this class cannot be canonicalised away |
| PK-3 | session check's stray/secret scan is gated on `[ -d "$ROOT/.git" ]`; a worktree's `.git` is a file, so the scan skips (with a WARN) there | 6 | `cmd-session.sh:145-154` | NEW — CONFIRMED. Correction: I-0052 does NOT cover this (it is about test-fixture teardown); **no recorded issue covers either gate** |
| PK-4 | `status session`'s git-position line has the same `-d .git` gate and no else — a HAND session in a worktree (no GOV_ROOT) opens with a brief silently missing its commit line; dispatched sessions are unaffected (GOV_ROOT points ROOT at main). Commit 8b8516a moved the body to WORK_ROOT and forgot the gate; the right predicate is `git -C "$WORK_ROOT" rev-parse --git-dir` | 5 | `cmd-status.sh:272-274` | NEW — CONFIRMED (oversight proven by blame; D-0063 ratifies worktree operation) |
| PK-5 | `sprint ratify` usage line shows `[--by WHO]` optional AND omits `--authority` entirely; the code requires both (the internal die at :165 even carries the correct full form — two usage strings in one file disagree) | 5 | `cmd-sprint.sh:207` vs `:165-167` | NEW — CONFIRMED, worse than first stated |
| PK-6 | Stranded comment blocks describing absent code: cmd-secret's `env_drop` rationale sits in cmd-memory.sh; cmd-task's acceptance/`acceptance_target_guard` comments sit in cmd-rank.sh | 7 (a comment is a record; these misdirect the next reader) | `cmd-memory.sh` (~:780), `cmd-rank.sh` (~:928) | NEW — cosmetic |
| PK-7 | `exception resolve` calls `write_json` then `reseal_one` — write_json already reseals; harmless double work | simplify | `cmd-exception.sh:463-466` | NEW — builder simplify list |
| PK-8 | Dead jq no-op `+ (if $why=="" then "" else "" end)` in task status write | simplify | `cmd-task.sh` (status write filter) | NEW — builder simplify list |
| PK-9 | `task accept`: `[ -n "$AVERIFY" ]` guard immediately after the die that guarantees it — dead branch | simplify | `cmd-task.sh` (accept re-run block) | NEW — builder simplify list |
| PK-10 | `capture_report` redirects a report function's stderr to /dev/null under `--json` — a partially-failing report's diagnostics vanish exactly when a machine consumer is reading | 6 (evidence discarded in one mode) | `.claude/scripts/lib/cli.sh` (`capture_report`) | NEW — port question, not a bash fix |
| PK-11 | `PREFIX_JOURNAL`/`JOURNALS` still name `reviews.json`, removed with the panel (D-0076) | 7 | `agents/lib/governance_graph.py:31-41` | KNOWN — pre-approved port divergence |
| PK-12 | `_walk_tree` carries an `if True:` vestige from its extraction out of build() | simplify | `agents/lib/code_graph.py` (`_walk_tree`) | NEW — builder simplify list |
| PK-13 | `.env` lines are split at the first `=` with no export/whitespace normalization. Beyond the mis-listing: `secret set FOO` against a hand-written `export FOO=old` APPENDS a second FOO= line (silent duplicate; loader decides which wins), and `secret remove FOO` refuses while FOO is plainly there. scrumux itself never writes `export`, so the trigger is a hand-written .env | 5/6 | `cmd-secret.sh:47-53, :118, :124` | NEW — CONFIRMED, low-moderate |
| PK-14 | PROJECT_SPEC.MD Vision says the harness "ensures … by enforcing …" — both banned verbs in one sentence. Validator's judgment: an overclaim to correct — Art. 2's scope is unbounded ("any harness document"), PROJECT_SPEC nowhere marks itself superseded, DESIGN_SPEC (which supersedes its governance sections) is not reachable from it, and DESIGN_SPEC:308 explicitly mandated the hunt that missed this sentence | 2 | `PROJECT_SPEC.MD:7-11` | NEW — CONFIRMED |
| PK-15 | `permissions.allow` has node/pnpm but not npm/npx — needed for the TS toolchain | plan item | `.claude/settings.json` | KNOWN — plan, User-sanctioned |

## Prime Article check — explicit

No surface blocks the user. The four walls bind agent tool calls; every
operator lever exists and is documented at its site: `ALLOW_ENTRY_REMOVAL=1`,
`HARNESS_BACKUP_DONE=1` (recorded, never trusted), `project-walls.conf` allow
lines, `scrumux repair journal` (the sanctioned hand-edit path), `rmdir` for a
stale lock, `--allow-unsprinted` for User-directed bootstrap. Laundering via
seal deletion is *recorded*, not blocked (`seal_bootstrap`), which is the Prime
Article and Article 3 agreeing. **Compliant.**

## Validator's adjacent work

One adjacent claim was raised and REFUTED by the validator before reaching this
register: cmd-rank.sh's F-* branch appears to fall through into the task path,
but `emit` ends in `exit` (cli.sh:176), so it terminates correctly — not a
defect. Recorded here so no later session chases it.

## Dispositions

- PK-3, PK-4, PK-5, PK-13, PK-14: small bash fixes; candidates for Phase 1a's
  bash window (they are Article-5/6 surface, i.e. parity spec) — User rules.
- PK-6, PK-7, PK-8, PK-9, PK-12: feed the builder's per-module simplify
  assessment (BEHAVIOR-PRESERVING).
- PK-10: a port design question — the TS `capture_report` equivalent should
  carry a report's stderr into the envelope (e.g. `.data.stderr`) as a
  proposal, not silently; flagged into PROPOSALS.md.
- PK-1, PK-2: OBSERVABLE proposals in the plan, both since ratified and fixed
  on BOTH sides at once — PK-1 on 2026-09-01 (`scrumux:279-289`: help and
  version go through `cli_init`/`emit`, human mode byte-unchanged), PK-2 on
  2026-09-01 (`scrumux:328-352`). PK-1's row above still reads as a proposal
  and has not been restated; the fix is in the tree and the dispatcher records
  the ruling at its call site.
- PK-11, PK-15: already tracked; no new action.
