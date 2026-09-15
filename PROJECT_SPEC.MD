# PROJECT_SPEC.md

Everything in this spec was decided by User in session on 2026-08-17.
Items not yet decided are listed under **Open items** — they are not to be
invented by an agent; they get decided and moved up.

## Vision

A governance harness for AI coding agents. It ARRANGES design, review
and communication practices so a workflow runs them — text in places the
agent reads, scripts at points the workflow invokes — and it is inert
until the agent follows them. It raises the floor on a stochastic system;
it does not promise perfection.

Stated in the three verbs (CLAUDE.MD, RULINGS.md Article 2): it
AIMS TO CONSTRAIN through rules and skills, it REFUSES destructive acts
through four PreToolUse hooks and only those, and it DOCUMENTS AND RAISES
exceptions without adjudicating them. It does not "ensure" and it does
not "enforce" outside those four hooks — corrected here 2026-08-31
(D-0085/PK-14) because a spec that overclaims teaches every reader
downstream to overclaim too.

This project replaces scrumux, which is abandoned. Do not read or reuse
scrumux code.

## Architecture of governance

Stated once, in `CLAUDE.MD` (its one home — T-0080). Summary for this
spec: CLAUDE.MD → rules → skills → deterministic scripts; hooks hold
the safety line and monitor passively; schemas enforce record shapes
with issues that point at the fix.

## Scope

- **In scope (this build):** the harness in CLI — governance documents,
  rules, agents, skills, schemas & contracts, hooks, deterministic
  scripts, setup script. Built and dogfooded in this repo first.
- **Out of scope:** the webapp and its mesh; the Foreman interface.
  Both will exist later. Core requirement carried by this spec: **the
  harness must work with or without the webapp.** When the webapp is not
  running, the coding agents and local scripts are sufficient to support
  all required governance activities.
- **Target repos:** language-agnostic core. The harness's own scripts
  make no assumptions about the governed repo's language or toolchain.

## Distribution

Clone from git, run the setup script. (Later: deployable by the app —
out of scope.) The setup script, on a fresh clone or new target repo:

1. Scaffolds any missing MD-suite files, `governance/` data files, and
   `.claude/` structure — idempotent, never overwrites existing content.
2. Installs the hooks into the repo's Claude settings so safety holds
   are active from the first session.
3. Runs the governance self-check immediately, so a broken harness is
   caught at install, not mid-task.
4. Registers the repo's declared build/test/run command (if any) so the
   tiered health check knows what "able to run" means for this repo.

## Repo layout

- **Root:** the human-facing document suite — CLAUDE.source.md, README.MD,
  PROJECT_SPEC.MD, AI_LOG.MD, DECISIONS.MD, BACKLOG.MD,
  SKILLS_INDEX.MD.
- **`.deploy-claude/`:** harness machinery (the deployable payload; it
  lands in a governed repo as `.claude/`) — rules, agents, skills, hooks,
  schemas, scripts.
- **`governance/`:** machine-readable data — tasks, issues, design
  artifacts.

## Document suite

- **CLAUDE.source.md** — top-level authority, scope, hard limits, pointers to
  rules.
- **AI_LOG.MD** — generated human view of `governance/log.json`, the
  append-only journal of what happened, written by agents per
  task/session (D-0002). No silent finishes: every completed task
  appends an entry.
- **DECISIONS.MD** — generated human view of
  `governance/decisions.json`: ratified choices only (ratified by
  User, or made under a delegation he granted), each with rationale.
  The precedent file (D-0002).
- **BACKLOG.MD** — human-readable view of open work, maintained from the
  schema'd tasks file. Not the source of truth.
- **SKILLS_INDEX.MD** — index of skills. (Content conventions: open item.)
- **PROJECT_SPEC.MD** — this file.

## Task lifecycle (mandatory gates, v1)

An acceptance check is stated before work starts; the task is done when
the check passes, not when the output looks done. The gates:

1. **Design before code.** Minimum: features list, user stories.
   Preferred: surface list, control contracts. Ideal: wireframe /
   Claude design.
2. **Break down** features and user stories into atomic tasks (one
   story, one verification command, one sitting — D-0006), each with a
   complete task order (D-0005).
3. **Open the session.** A session IS a sprint (D-0073): the
   session-open skill opens a thin epic-bounded one and fills it, either
   from prepackaged app orders or from light tasks minted out of User's
   messages (`scrumux task order --light`), and it is active only once User
   (User) ratifies (D-0004). Hotfix lane: single-task sprint
   promoted from a validated issue. Session gate = planning rule +
   session-review backstop.
4. **Execute one task at a time** and review before done.
5. **Decision capture** — choices made during work that weren't in the
   task definition are recorded via `scrumux decide new`.
6. **Log on completion** — structured entry via `scrumux log new`.
7. **Capture issues** — anything noticed outside scope goes to the
   issues file via `scrumux issue new`, not into the current task.
8. **Close the session** with the session-review skill: governance
   completeness + code health, local commit, push on User's word.

### Review gate

The review-before-done gate is a **review record with four lenses** —
**scope**, **governance**, **code diff**, **blast radius** — written via
`gov review`. User is the final authority; his acceptance closes the
task. (T-0186 deleted the LLM reviewer panel: documented approval IS the
review, D-0072 boundary 2.)

## Enforcement posture

Tiered:

- **Block:** hard limits and safety holds block via hooks.
- **Log:** compliance drift is logged and raised as issues in the
  schema'd issues file, with resolution pointers; work continues.

## Rules (v1 roster)

Loaded rules are binding. Agents state which rules loaded before
starting work; "no rules loaded" is said explicitly. **Loading reality
(D-0008):** the CLI loads all `<harness-dir>/rules/*.md` unconditionally
(probe-verified, frontmatter stripped as native metadata); v1 accepts
always-load and keeps rules terse — path-scoping revisit tracked as
I-0001. Every rule carries frontmatter per rule-frontmatter.schema.json.

1. **minimum-planning-requirements**
   (`.deploy-claude/rules/minimum-planning-requirements.md`, built) — sessions
   need a ratified sprint; task/issue sources; hotfix promotion; task
   orders mandatory; ratification reserved to User.
2. **no-direct-llm-calls** (`.deploy-claude/rules/no-direct-llm-calls.md`,
   built) — all LLM calls via the declared LLM gateway; access via
   get-llm-key, model choice via pick-llm-model, gaps via
   submit-llm-change-request.
3. **issue-validation** (`.deploy-claude/rules/issue-validation.md`, built) —
   no fix work on an issue until a validation verdict is recorded
   (reproduced/evidenced/invalidated/duplicate); the hotfix gate
   enforces it deterministically.
4. **enforcement-posture** (`.deploy-claude/rules/enforcement-posture.md`,
   built) — refuse only what is irreversible: the constitution names the
   only walls, a repo extends them through `.claude/project-walls.conf`
   rather than forking a hook, and anything short of irreversible damage
   is a tell. The per-site census that once backed this rule
   (`governance/enforcement-posture.md`, cross-checked by `records check`
   section 11 until T-0184 deleted that sweep) stopped shipping to targets
   on 2026-09-01 and is archived at `docs/history/enforcement-posture.md`.
5. **harness-is-upstream** (`.deploy-claude/rules/harness-is-upstream.md`,
   built) — in a repo carrying `.claude/DEPLOYED` the machinery is a
   dependency, not the work: never edit it there, capture the problem
   with `scrumux issue new --type harness`, fix it upstream and redeploy.
   Enforced by `block-upstream-edit.sh`, the fourth wall (D-0078).
6. **parallel-work-isolation** (`.deploy-claude/rules/parallel-work-isolation.md`,
   built 2026-08-23) — work that runs alongside other work gets its own
   `git worktree`, and the task that spawned it removes it. Deliberately
   unenforced: no check fails on it. It is a rule because the failure it
   prevents is silent — a diff neither agent authored and a receipt
   covering work nobody reviewed. User's call is to ship it as guidance
   and strengthen it only if the record shows it being ignored.
7. **canon-amendments** (`.deploy-claude/rules/canon-amendments.md`, built) —
   canon is owned upstream and republished, so a repo that needs a local
   deviation records it BESIDE the canon document in an appendable record
   with its reason, never by editing the document. Publish overwrites,
   then re-applies the approved amendments.
8. **source-session** (`.deploy-claude/rules/source-session.md`, built
   2026-09-01, SOURCE-ONLY) — how a session in THIS repo works: governed
   entirely by root `RULINGS.md` with the user's instruction as final
   authority; every finding validated by `finding-validator` before it
   drives anything (this repo's validation rule, superseding the
   operator's global default); a permission-classifier denial is not a
   wall; technical rulings are the session's to make and record. Listed
   in `.deploy-claude/payload-exclude.list` and never deployed — it contradicts
   the constitution a governed repo is given.
9. **Governance-docs rule** (planned) — entry formats, append-only
   conventions, no hand-editing generated views.
10. **Schemas & data rule** (planned) — contract validation; schema
    changes require a decision record.
11. **Scripts rule** (planned) — POSIX-only, deterministic, self-check
    before done, instructive errors (T-0021 shape).

## Agents (roster — `.deploy-claude/agents/`)

Specialized workers that reduce context burden and build useful memories
of the project. All of them share one read-only contract (T-0076): tools
exactly Read/Glob/Grep/Bash, the canonical D-0007 protocol paragraph,
output advisory — the orchestrator records. The roster below is
mechanically checked against the directory by `scrumux records check`
(T-0080/T-0140); update both together.

- **context-gatherer** — given a task, gathers the relevant files,
  loaded rules, prior decisions, related log entries and open issues
  into a pre-task context pack for the working agent.
- **visual-inspector** — any-surface visual verifier: visually verifies
  whatever the repo runs (TUI, CLI output, web) against expectations,
  with or without design docs.
- **debugger** — read-only investigator (D-0007): reproduces the
  failure, evidences root cause, hands the proposed fix to the main
  agent. Never takes the error at face value.
- **issue-validator** — evidence-based verdicts (reproduced/evidenced/
  invalidated/duplicate) on open issues before planning weighs them.
- **finding-validator** (SOURCE-ONLY) — per-claim CONFIRMED / REFUTED
  verdicts with `file:line` evidence on findings about THIS codebase,
  REFUTED by default where direct evidence cannot be found, plus an
  intent check on whatever survives (a ruling, comment or commit may show
  the "defect" is deliberate). No scrumux record shapes and no journal
  reads — this repo has none. Listed in `.deploy-claude/payload-exclude.list`
  and never deployed; a governed repo gets `issue-validator` instead.

## Skills (v1 roster, built — `.deploy-claude/skills/`)

`session-start`, `session-open`, `task-breakdown`, `implement-sop`,
`session-review`, `scrumux backlog`, and the SOURCE-ONLY
`source-implement` (the coding SOP for this repo with the governance loop
taken out; in `.deploy-claude/payload-exclude.list`, never deployed) — see
SKILLS_INDEX.MD. Each encodes its
decisions (D-0004/5/6) as checkable steps and drives all records
through `scrumux`. This roster is mechanically checked against the
directory by `scrumux records check` (T-0080/T-0140).

## Hooks (v1)

- **Block secret/credential reads** — enforces the existing hard limit
  mechanically.
- **Block destructive commands** — rm -rf / db-purge class commands
  without the backup step.
- **Block direct LLM provider calls**
  (`.deploy-claude/hooks/block-direct-llm.sh`, built) — PreToolUse on Bash;
  blocks shell commands targeting provider API domains and points the
  agent to the no-direct-llm-calls rule. Enforces: no LLM calls outside
  the LLM-gateway.

The deploy/production/TestFlight/tunnel hard limit remains documented
policy in CLAUDE.MD; it is **not** hook-enforced in v1 (deliberate —
User's selection).

## Schemas & contracts

v1 roster (D-0003), schema files in `.deploy-claude/schemas/` (drafted):

1. **Task** (`task.schema.json`) — atomic work unit; required
   acceptance_check; status lifecycle; at most one in_progress.
2. **Issue** (`issue.schema.json`) — required resolution_pointer so the
   agent is pointed to the fix without scope creep.
3. **Decision entry** (`decision.schema.json`) — ratified choices,
   append-only, supersedes instead of edits.
4. **Log entry** (`log-entry.schema.json`) — what happened; a task
   cannot reach accepted without a log entry referencing it.
5. **Review record** (`review.schema.json`) — separate reviews file;
   four required lenses (scope, governance, code_diff, blast_radius)
   plus User's acceptance.
6. **Design artifacts** (`design.schema.json`) — feature, story,
   surface, control with stable B-statement ids; tiers match the design
   gate (minimum/preferred/ideal).
7. **Repo health** (`repo-health.schema.json`) — the declared health
   commands registered at setup.
8. **Rule frontmatter** (`rule-frontmatter.schema.json`) — validated
   rule headers (paths, skills, scripts, hooks) so the self-check can
   verify the CLAUDE.MD→rules→skills→scripts chain mechanically.
9. **Sprint** (`sprint.schema.json`, D-0004) — epic-bounded or hotfix,
   ratification block recorded only on User's word; task entry gated
   on complete task orders. Epics (E-) live in design.schema.json;
   task orders (D-0005) on task.schema.json.

**Data format:** JSON. Validation scripts use `jq`, the one declared
dependency; setup verifies jq is present. JSON keeps the files directly
consumable by the future webapp/Foreman interface.

**Sources of truth (D-0002):** the schema'd JSON files in `governance/`
are the source of truth for all governance data — tasks, issues,
`log.json`, `decisions.json`, reviews, design, repo-health. BACKLOG.MD,
AI_LOG.MD, and DECISIONS.MD are generated human views, never edited by
hand. Cross-cutting contract: stable ids, and every ref must resolve
(dangling pointers are drift findings).

## Deterministic scripts

Bash/POSIX only (plus jq).

**`scrumux`** (`.deploy-claude/scripts/scrumux`, built) — the record writer. One
subcommand per schema'd record type (log, decide, issue, task
new/status, review, accept, feature, story, surface, control, health,
views). Ids and dates are automatic; required fields, enums, and refs
are checked at write time with errors that show the fix; the lifecycle
gates are mechanical (one task in_progress; accepted requires a log
entry and an accepted review); every write regenerates the MD views.
Agents never hand-edit governance JSON or MD views — they run scrumux.

The remaining scripts implement the "always up to date and able to run"
promise, tiered:

- **Governance self-check** (always runs): rules/skills/schema pointers
  and data files valid and consistent.
- **Repo health** (runs where the repo defines it): the repo's declared
  build/test/run command, registered at setup.
- **The two graphs** (built): the queryable answers to "what depends on
  this" and "what already ruled on this", so context is assembled, not
  searched (D-0005, D-0009).
  - **`code-graph`** (`.deploy-claude/scripts/scrumux graph`) — tree-sitter index
    over the python and shell sources (D-0042). Subcommands: `build`,
    `index`, `callers`, `callees`, `symbols`, `find`, `near`, `stats`.
    A symbol id is `<path>::<name>`; a file id is the repo-relative
    path. `scrumux graph code callers` is the blast-radius answer the review's
    blast-radius lens needs (I-0018).
  - **`governance-graph`** (`.deploy-claude/scripts/scrumux graph`) — the
    journals as a graph of records and refs. Subcommands: `build`,
    `index`, `provenance`, `inbound`, `outbound`, `impact`, `orphans`,
    `dangling`, `stats`, `bearing`, over record ids. `scrumux graph gov bearing
    <path>...` returns the decisions and issues reached through a task
    order's file edges, splitting paths a task CHANGES from ones it only
    READS (T-0153); `scrumux task lint` fails an order that changes a source file
    while citing no refs. `scrumux graph gov provenance`
    returns every decision, issue and review bearing on a task;
    `scrumux graph gov dangling` and `scrumux graph gov orphans` are the
    mechanical forms of the ref-drift failures.
  - Both `index` commands self-heal per D-0043: a stale index rebuilds
    itself and exits 0, and fails only when the rebuild cannot be done,
    so a stale graph is a build concern and never a governance blocker.
    No LLM anywhere in either path (D-0001) — the graphs are repo fact.


### The full script roster

Every file in `.deploy-claude/scripts/`. `scrumux records check` section 10 checks this list
against disk in one direction — a script on disk that no roster names is
drift, because an undocumented script is a tool the agent cannot find.

| File | Kind | What it does |
|---|---|---|
| `scrumux` | THE command | The one executable. argv, `--json`, exit-code normalisation, dispatch — and nothing else. It replaced eleven top-level scripts that were the same program written eleven times. Design record: `CLI-CONSOLIDATION.md`. |
| `lib.sh` | shared bootstrap | Sourced, never run. Root resolution, journal locking, id allocation, schema-guarded writes, ref resolution, the seal-hash cache and the health-check runner. Widest blast radius in the repo. |
| `lib/cli.sh` | the cross-cutting layer | Sourced. The `--json` envelope, the result-row vocabulary (`pass`/`fail`/`warn`/`tell`/`note`), the error shape and the ONE exit rule. Written once so it cannot drift nineteen ways. |
| `lib/journal.sh` | record helpers | Sourced by the writer nouns: `ref_exists`, `design_ensure`, `render_views`, `seal_bootstrap`, the drumbeat, and `emitted` (the writer's one exit). |
| `lib/cmd-<noun>.sh` | one file per noun | One module per noun, each declaring exactly `<noun>_verbs`, `<noun>_usage` and `<noun>_run`. The dispatcher sources only the one an invocation needs. Adding a noun is one file plus one line in the `NOUNS` registry. |
| `readonly-sh` | read-only shell | `sandbox-exec` / `bwrap` wrapper giving the read-only agents a structurally read-only shell (D-0007). Deliberately does NOT source `lib.sh` and does not need `jq`: it must work in a repo whose harness is broken, so it is the ONE thing not folded into `scrumux`. |

The nouns, and the verbs each owns:

| Noun | Verbs |
|---|---|
| `task` | `new`, `order`, `status`, `update`, `lint`, `brief`, `verify`, `accept`, `reject` |
| `issue` | `new`, `update`, `validate`, `authorize` |
| `sprint` | `new`, `add`, `descope`, `ratify`, `status` |
| `epic` | `new`, `update` |
| `feature` `story` `log` `decide` | `new` |
| `health` `memory` | `add` |
| `secret` | `set`, `list`, `remove` |
| `rank` | `set`, `clear` |
| `repair` | `journal` |
| `views` | `render` |
| `records` | `check` |
| `session` | `check` |
| `status` | `session`, `planning`, `sprint`, `sweep` |
| `backlog` | `tasks`, `features` |
| `graph` | `code build\|index\|callers\|callees\|symbols\|find\|near\|stats`, `gov build\|index\|provenance\|inbound\|outbound\|impact\|orphans\|dangling\|stats\|bearing` |
| `harness` | `deploy`, `verify` |

Every verb takes `--json` and emits exactly ONE object carrying `ok`, an
`exit` code and a per-check array. **Exit 0** the assertion held, **1** it
did not, **2** the command could not run. Advisories never move it.

Root resolution (T-0149): `GOV_ROOT` outranks everything (the only
sanctioned test override), then the git toplevel of the CALLER's working
directory, then two levels up from the script itself. Each script resolves
`$0` through symlinks before sourcing `lib.sh`, so both deployment shapes
work — the whole `.deploy-claude/scripts` directory symlinked in, or a single
`scrumux` on `PATH` with only `governance/*.json` in the repo.

## Working agreements

- The user is the final authority. When uncertain, ask and stop; never
  proceed on an assumption about anything irreversible.
- When asking User questions, analyze all the choices and recommend one
  with reasons.
- User sets boundaries explicitly (rosters, hook selections, scope);
  agents do not move them on their own judgment.

## Code standards (User's, starting set — he flagged this list as partial)

These apply to the code User builds with the harness. They do not
change the harness core's language-agnostic requirement: the harness
must govern any repo, while User's own repos follow these.

1. Python & TypeScript.
2. Azure for cloud deployments.
3. LangGraph for agent building.
4. Graceful error handling.
5. Rich logging & tracing.
6. No mock LLM calls — we do it real all the time, or skip them once
   they're working.
7. Unit testing on everything, updated after each task if needed.

## Open items

Not yet decided — do not invent. Open work lives in the backlog
(BACKLOG.MD / governance/tasks.json — the ranked view is
`.deploy-claude/scripts/scrumux backlog tasks`); this list holds only what is NOT yet
tasked anywhere (refreshed 2026-08-18, T-0080 — the previous list
cited tasks accepted sprints ago):

- Governance-docs / schemas-and-data / scripts rules (planned in the
  rules roster).
- Foreman interface contract shapes (future).
- Webapp / mesh design (future).
- Harness update flow beyond re-running setup after a pull.
- The rest of the code standards list (marked partial), and how the
  standards get enforced (rule, reviewer lens, or both).
