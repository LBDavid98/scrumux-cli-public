# RULINGS.md

**The one governance document this repo has.** There is no
`decisions.json` here, no scrumux journal, no sprint and no mirror. A
repo that builds the governance tool cannot be governed by it — the CLI
refuses that outright (see the first ruling below) — so everything that
would otherwise be a record is written here, by hand, in one file.

It reads in three parts. The **manifesto** is the standard. The
**bridge** says how the standard is applied to a session in this repo.
The **rulings** are the exceptions: each one names what was allowed, and
why, against a principle it bends.

---

# Part I — The harness manifesto

*This is the standard every addition to the harness is measured against.
It was `HARNESS_MANIFESTO.MD` until 2026-09-01; that file is now a
pointer, because two copies of a standard are two standards.*

## EXSUM

The shortest form of the whole document: **the governance supports the agent; the agent does not exist to support the governance.** A mechanism that cannot be traced to that sentence is the thing that is wrong.

Two things distinguish this manifesto from the genre. First, the evidence holds the same rank as the principles — every article carries the measured incident that ratified it, because this record is unusually rich in counted failures (six-of-six correct runs, 870 self-referential records, a green receipt asserting a run that never happened), and a manifesto that cites its data cannot drift into slogan. Second, Article 5 is the signature of the system: most governance tools treat error text as chrome; here the refusal message is the primary instruction channel — the agent is steered by what the scripts print at the moment of the mistake, and that text is product surface held to the same review standard as code.

**The Prime Article: the harness does not block the user.** Then the ten:

1. **The agent is not the failing component.**
2. **The harness is inert until followed.**
3. **Force is reserved for destruction, and the forceful surface stays minimal.**
4. **A check may claim only what it computes.**
5. **The error message is the instruction set.**
6. **Evidence is written by programs.**
7. **Records exist to change future action, not to describe past work.**
8. **A mechanism pays for itself in incidents prevented, not incidents imaginable.**
9. **Every layer is complete without the layer above it.**
10. **Irreversible acts belong to a person.**

---

This file states the beliefs that produced scrumux. Every ruling in DESIGN_SPEC.MD is an application of one of these articles. Read it to predict what the harness will do before asking; read it before proposing a mechanism, because most proposals die against Article 8.

None of this is aspiration. Each article was ratified after evidence, and the evidence is cited. Where an article and a convenient feature conflict, the article wins until User supersedes it.

---

## Prime Article — The harness does not block the user.

Every constraint in this system — the four hooks, the write-time validations, the lifecycle gates — binds the **agent**. None of it binds the person. The harness may ask the user for a confirmation before an irreversible act, and rarely it may need the user to run a command themselves (an interactive login, a permission boundary the agent cannot cross); both are the full extent of what it may ask. Its job with respect to the user is to carry out instructions, not to evaluate them.

The reason is the CLI's purpose. With the CLI, the app is no longer an intermediary between the user and the agent — the user speaks directly, and what they say is authority, not input to be adjudicated. An instruction given **is** the approval; a prompt that asks the user to confirm their own instruction is a defect twice over — it delays the work, and it trains the user to click through confirmations, which destroys the one gate that matters at the one moment it matters.

Therefore: every blocking surface answers the question "who is being stopped?" before it ships. A hook that refuses the agent's autonomous `rm -rf` is doing its job; the same refusal against the user's explicit, stated decision is the harness exceeding its office. Where a user decision conflicts with a recorded rule, the harness records the decision with its provenance and executes it — the record is for auditability, never for veto. And where the harness genuinely needs the user's hand, it asks once, in one confirmation or one script, and treats the answer as final.

## Article 1 — The agent is not the failing component.

Six acceptance runs produced correct code six times out of six: right implementation, tests written, nothing out of scope, harness byte-identical every time. Four runs failed, every one on bookkeeping, on four different files — two `__init__.py` files the product needed and bytecode the harness itself generated. Zero prevented damage.

Therefore: when a session goes wrong, the first suspect is the instruction set, the order, or the harness — not the agent. The triage rule is fixed: repair what misdirected the agent, not what failed to police it.

## Article 2 — The harness is inert until followed.

It is text in places the agent reads and scripts at points the workflow invokes. It is not a runtime, not an authority, not a decision-maker. Any sentence in any harness document claiming it "enforces," "ensures," or "decides" — outside the four hooks — is an overclaim and gets corrected on sight.

Therefore: a rule followed most of the time is doing its job. A rule that must be guaranteed is not a rule; it is either one of the four hooks or it does not exist.

## Article 3 — Force is reserved for destruction, and the forceful surface stays minimal.

Exactly four hooks may stop a tool call: secret reads, destructive commands, direct LLM provider calls, upstream edits in deployed repos. That is the complete list. Everything else in the system advises, records, or refuses a malformed write with an explanation. Noted plainly in the record: no hook has ever recorded a real firing — and they stay anyway, because the class of act they cover is irreversible.

Therefore: a proposal that adds a fifth blocking surface carries the burden of proving an irreversible act it prevents. "Would probably catch something real, at the cost of stopping work that is probably fine" is a declined trade — ruled 2026-08-22 on the stale-receipt case: acceptance refuses a red receipt and does not refuse a stale one, because the log keeps the evidence either way and only the interruption would be lost.

**Amended 2026-09-02 (R-012).** That ruling is about ACCEPTANCE, and it stands there unchanged. It was read for a year as though it retired the freshness check altogether, and it does not: the check moved rather than went, and it lives at the CLOSE as a **FAIL** — `src/nouns/session.ts` (`mtimeOf`), check 3 of `session check`. That placement is ratified, not tolerated. It costs nothing this article is protecting: a hook stops a tool call mid-flight and cannot be argued with, whereas a close-side FAIL is one command an agent has already chosen to run, at the moment the session is being handed back, with every file still on disk and every remedy one `task verify` away. "Only the interruption is lost" is the argument for not blocking the ACCEPT; it is not an argument for never computing the fact. See R-012 for the incident that ratified it and for what it supersedes in `docs/port/PHILOSOPHY.md`.

## Article 4 — A check may claim only what it computes.

The harness measures what is derivable from the file tree and the record without interpreting meaning: a receipt's exit code, a hash against a manifest, a ref that resolves, a task left in_progress. Everything requiring the work to be read — do the tests cover the change, is the verification command real — is asked of the agent and stored as attested, never verified. The failure that ratified this: `execution_count` is a hand-settable integer, it was read as "the notebook was executed," and a green receipt then asserted that hand-written cell output was a real run. Nothing lied. The check reported something it could not compute.

Therefore: the test for any proposed check is not "would this catch something" but "what is the weakest artifact that passes this, and would I accept it?" If the answer is no, either compute the real thing or direct the agent to answer and mark it attested. Keeping the proxy and reporting it as verification is the one option that is prohibited.

## Article 5 — The error message is the instruction set.

The agent is steered by what the scripts print, at the moment of the mistake. `task brief` exits 2 with one FAIL line per unmet gate, each naming its fix. `sprint add` refuses an incomplete order by naming the missing fields. Every write verb validates enums, refs, and required fields at write time and shows the correction. `status session` runs at every session start so the agent's first message is written already knowing its sprint, its task, and the state of the record.

Therefore: refusal text and FAIL lines are load-bearing product surface, held to the same review standard as code. A refusal that states a fact without naming the next action is a defect. And guidance is judged on cost: the correct action must take fewer tool calls than any incorrect one, or the guidance is decoration.

## Article 6 — Evidence is written by programs.

A receipt records the command, the exit code, and what ran — written by `task verify`, not narrated by the agent. The conditions on a receipt are real, but they do not all live at one surface, and this article names where each one is: an article that puts a gate at the wrong verb sends the next reader to repair code that is already correct.

**Acceptance** — `src/nouns/task.ts` (`taskAccept`) — refuses a task with no receipt, refuses a red one (`rc != 0` or `checks_failed != 0`), and refuses one whose order carries no `verification_command`, because a task with nothing to re-run cannot be accepted and a silent skip reporting success was the measured failure. It then **re-runs that command itself** and refuses on non-zero. Re-running rather than reading is the whole of it: a receipt records what happened when the agent ran it, and cannot record whether the command still proves what the order asked (I-0139 — T-0010 arrived green with its check narrowed from ten required sections to eight, and nothing in the machine noticed).

**The close** — `src/nouns/session.ts` (`mtimeOf`) — holds the two conditions acceptance does not compute: that the receipt ran the command the order names, and that the receipt is newer than the last edit to the files it covers. Both are FAILs, not warnings. The freshness check reads the task order's `context.files` **and** its `context.expected_artifacts`, the files a task PRODUCED being the ones most likely to be edited after the receipt.

Each of those conditions exists because its absence produced a specific observed false green.

Therefore: an agent's claim of completion is an input; the receipt is the record. Where a fact can come from a script or from prose, it comes from the script, and the prose is not collected.

## Article 7 — Records exist to change future action, not to describe past work.

The audited harness contained 870 records whose only subject was another record: 251 gate rows written by no hook, 452 triage dispositions, 159 reviews of a ceremony already deleted, 8 rows counting how often a record was shown to User. 62 of 131 issues were the machinery reporting its own condition. All of it was removed. What remains earns its place by use: decisions travel inside task orders so settled questions are not re-derived; issues carry a repro and a proposed fix because a validator who was not present will read them; the log holds evidence blocks that parse.

Therefore: before writing a record, name the future reader and the action it changes. A record with neither is not written. A completed task's documentation is the task and its close review — no separate narration.

## Article 8 — A mechanism pays for itself in incidents prevented, not incidents imaginable.

The failure mode this system was rebuilt to escape is compounding self-governance: governance notices something, files an issue, the resolution needs a decision, the decision needs ratification, the ratification produces records, the records drift, and governance notices something. Each step defensible; the sum was three units of effort spent describing code per unit spent writing it.

Therefore: every proposed rule, check, gate, or record type is presumed unnecessary. The feature freeze (D-0079) is the standing form of this: only a fix that a real session would fail, lie, or stall without. Removal is always in scope, and removed material is archived with a manifest so recovery is a lookup.

## Article 9 — Every layer is complete without the layer above it.

The CLI performs every governance activity with the app absent; that configuration is the one under test. Hooks emit events knowing nothing about listeners; the event file is valid with zero consumers. The app reaches through the CLI and adds what the CLI ruled out — cross-session observation, validation of attested answers, context assembly, review support — and the CLI does not know the app exists. A component that requires its consumer before it functions has the dependency pointing the wrong way and is wrong regardless of how well it works.

Therefore: no capability lands in the CLI that assumes the app, and no CLI capability is moved appward if an agent driving a terminal alone would lose it.

## Article 10 — Irreversible acts belong to a person.

Accept, reject, ratify, decide, authorize: these verbs execute only on User's word or under a delegation he granted, and the record names the authority each time. The separation that matters is producer from verifier — ruled precisely: the verifier need not be a person, but it must hold a distinct issued identity, because the constraint is "the verifier is not the producer," nothing more.

Therefore: the harness never approves its own work product, an agent never accepts its own task, and a validator's finding is itself unvalidated until a different party confirms it. Post-action ceremony around an approval already given is prohibited by Article 7.

---

# Part II — How this repo is governed

**First, the line that separates this repo from every repo the manifesto
describes.** The manifesto's motto — *the governance supports the agent;
the agent does not exist to support the governance* — is the **product's**
motto, and it is about the repos scrumux governs. It is not this repo's.
Here the bottom line is one step further out:

> **`RULINGS.md` and the `.claude` settings exist to guide the agent. The
> user's instructions are the final authority.**

Nothing below outranks a thing User says in session. Where this file and
his instruction disagree, his instruction wins and this file is what gets
amended. Do not read the manifesto as constraining him — read it as the
standard the product is held to.

**Every addition to the harness is assessed against the principles above,
first.** A mechanism that does not survive them does not go in — Article 8
declines most of them before they are built. The rulings in Part III are
the **exceptions**: each records something admitted despite a principle it
bends, and why. Nothing is an exception because it is already in the tree.

**A session in this repo is governed entirely by this file — nothing
else.** scrumux-cli exists to support independent agent coding sessions;
that is the product. But *building* a governance system carries one
structural requirement the product does not: the user's decisions in a
governance-building session must never be contradicted by the governance
he is in the middle of altering. A tool that answers "you may not do that"
from the very rules under revision has made the revision impossible. So
the governance that applies here is limited, entirely and deliberately, to
the rulings below.

**The user supervises these sessions.** The implementing agent still
receives guidance — skills, subagents, rules for good coding and code
hygiene — and should use it. The most important of them is the
**`finding-validator`** subagent: every finding is validated by a second,
read-only agent, with `file:line` evidence, before it drives an edit, a
plan item or a reported conclusion. REFUTED is the default where the
evidence cannot be found, and anything confirmed is checked for intent
before it counts — a mechanism that looks unfinished is often finished
and waiting. What the agent does *not* owe is governance work. Beyond two
things, there is none to do:

1. **Adhere to the rulings** in Part III.
2. **Document any user decision that amends them**, here, in the same
   window it was made.

**One documentation duty comes with a session in this repo: keep `/docs`
current on the shape of the harness and its dependencies.** The rules and
SOPs in this repo lean on that duty. A session that changed the harness's
shape and left `/docs` describing the old one is not finished, whatever
its tests say.

---

# Part III — The rulings

**Numbering.** Rulings made here mint **R-numbers** — `R-001`, `R-002`, … —
native to this file and issued by it. The `D-0085`…`D-0090` entries below
are **migrated port rulings**: they were recorded in the `scrumux decide`
journal before it was retired, and their old identifiers are preserved as
provenance because the port's code comments cite them
(`APPROVED-DIVERGENCE: D-0085`). The D-series never increments again. A new
ruling that continued it would be this file re-adopting the journal's
identifier space — the exact contamination R-001 exists to end.

## R-001 — 2026-09-01 — The harness repo is never governed by the harness

Ratified by: User (in session). Scope: repo.

**The repo that builds scrumux can never be subject to scrumux's own
governance.** It leads this list because it is the ruling that makes the
rest of the file necessary.

A tool that writes governance records about its own construction freezes
whatever policy it happened to hold that afternoon. The records outlive
the afternoon; the policy does not. Every later session then reads
transient, half-finished rules as settled law, and the gaps in them become
the gaps the record defends. Self-governance does not surface the flaws in
a governance system under construction — it launders them into precedent.

**The CLI enforces this rather than asking for it**, because nothing an
agent reads can be relied on to hold. A repo declares itself outside the
harness with a committed `.scrumux-ungoverned` file at its root, carrying
a one-line reason. The dispatcher scans for it before anything else and
refuses the record-writing and workflow surface with exit 2 — every noun
except `backlog`, `graph`, `harness`, `records` and `status`, which are
the delivery and read-only surface and write nothing. `help` and `version`
always answer. The refusal carries its own rationale, per Article 5.

The marker is **committed**, not local: one that a clone does not receive
protects a single working copy and lets the next clone govern itself.
`scrumux-cli` and `scrumux-app` both carry it.

Rulings for this repo go in this file. There is no journal to write to,
and the refusal is not a wall to route around.

Enforced at: `.deploy-claude/scripts/scrumux` (the guard above the noun
registry and above the TypeScript flip) · proved by
`tests/ungoverned-repo-tests.sh` · carried into the Node entrypoint by
`docs/port/UNGOVERNED-GUARD.md`.

---

## The bash → TypeScript port rulings

The rulings below govern the port. They were recorded on the days their
`D-` numbers say, and they are reproduced here unchanged; their migrated
identifiers stay put because the port's code comments cite them
(`APPROVED-DIVERGENCE: D-0085`, `D-0089`, `D-0090` appear at the sites they
rule).

They are written down HERE, and nowhere else. Every ruling about this repo
lands in this file in the window the decision is made — that is the whole
convention, and R-001 is why there is no second place for it to go.

---

## D-0085 — 2026-08-31 — TS-migration Phase 0 gate signed

Ratified by: User (in session). Scope: repo.

**Phase 1a fixes bash FIRST so the parity spec is correct** (all red-first —
the failing assertion lands before the fix):

- Secret-wall residuals: cp/mv source-operands-only; `walls_can_read_file` +=
  dd nl tac bat vim view ex, busybox/toybox step-over; STRONG regex: ≥1
  dot-segment after `.env`, `~` terminator, `<name>.env` forms.
- OQ-17: `rm --recursive/--force` long flags and `-rd` join block-destructive.
- PK-3/PK-4: the worktree `.git`-file gates in `cmd-session.sh:145-154` and
  `cmd-status.sh:272-274` → `git -C "$WORK_ROOT" rev-parse --git-dir`.
- PK-5: `sprint ratify` usage line gains required `--by` and `--authority`.
- PK-13: `.env` export-prefix normalization in secret set/list/remove.
- PK-14: PROJECT_SPEC Vision sentence restated in Article-2 vocabulary.
- OQ-2: `unsupported_keywords` wired into the schema sweep as WARNs.
- OQ-4: a conf rule with an empty reason is skipped and named (the conf header
  already promises this).
- OQ-13: `repair journal`'s refusal carries jq's first stderr line.
- OQ-15: a TIMEOUT outranks the `type=lint` carve-out in run_health_checks.
- OQ-16: backlog exit 2 confirmed intended; stale lib.sh comment fixed; the
  `--features` bare `cat` gains the corrupt-journal guard.
- OQ-19: `records check` WARNs on a sealed-listed journal absent from the map.
- Doc appends: CLI-CONSOLIDATION §12 staleness note; enforcement-posture
  wording per OQ-5.

**Approved TS divergences** (each site carries `// APPROVED-DIVERGENCE:
D-0085`): OQ-7 TS `nextId` refuses a malformed id instead of allocating a
duplicate at rc 0 · OQ-9 the TS writer matches jq's lone-surrogate refusal
during coexistence · OQ-14 repair writes the already-checked bytes, filter runs
once · OQ-18 a failed reseal adds a warn row to the envelope, exit code
unchanged · OQ-20 general rule: a diagnostic computed and suppressed under
`--json` goes into the envelope, never nowhere.

**Design rulings:** OQ-1 the force-with-lease split is the intended
Prime-Article reading (deliberate) · OQ-3 design.json's absence from schema
PAIRS is deliberate (polymorphic journal); per-kind validation is a Phase 5
proposal · OQ-5 the event stream is the log disposition tier · OQ-8 an
untranslatable ERE fails closed on refuse lines, is skipped-and-named on allow
lines; Phase 7's wall verb validates at write time · OQ-10 `ref_resolve` learns
amended-by rendering in Phase 7 · OQ-12 allow-list pruning is a Phase 6 deploy
proposal.

**Log ceremony is AUTOMATED, not dropped:** the machinery composes the
work-log entry from the receipt and evidence capture at acceptance; verify's
"Log it" instruction and implement-sop step 6 retire. Designed as a Phase 7
proposal for sign-off.

**Spike verdicts adopted:** TS serializer reproduces `jq .` byte-for-byte
carrying numbers as raw text · `repair --apply` embeds jq compiled to WASM ·
both graphs port to web-tree-sitter with grammars loaded from in-memory bytes.

---

## Orchestrator rulings on the builder's Phase-0-close questions (2026-08-31)

1. **Where port rulings live:** in `governance/decisions.json` via `decide new`
   — the repo's own convention, unchanged — mirrored here. The builder's
   premise that self-recording violates "building the harness, not operating
   within it" is refuted by the repo's record: 84 prior decisions about
   building the harness, PROJECT_SPEC's dogfooding declaration, and the
   gitignore comment naming governance/ the build diary. Its tracked-survival
   point was right, and this file is the adoption. The fixture-tier point is
   absorbed by design: the corpus snapshot is regenerable and will track the
   live journals throughout the port.
2. **Looseness census, adopted:** the ~116 error-swallowing sites (`|| :`,
   `2>/dev/null`, `|| true`) get a mechanically derived inventory
   (`tools/lint/looseness-census`), and every TS counterpart must cite its
   bash origin site or carry an APPROVED-DIVERGENCE — the same derived-never-
   hand-listed discipline as SURFACE_PROBES. Joins the anti-strictness
   backstops in the plan.
3a. **Performance reference numbers (Phase 1 gate, orchestrator):** a verb's
   bash reference time is the MEDIAN of 5 unloaded runs on the dev machine,
   captured by the sandbox transcript; the TS gate is that median +20%. The
   plan's `status session` ≤150ms budget reads as a median budget — bash
   itself ranges 112–192ms across runs, so a worst-case reading would fail
   the incumbent.
3. **Graph-over-grep, adopted:** who-calls questions during the port are
   answered with `scrumux graph code callers`, not grep — two of the
   validator's four refutations were exactly this class.

---

## D-0086 — 2026-08-31 — Portability: the wall stays, the destination changes

Ratified by: User (in session). Scope: repo.

`block-direct-llm` ships **active, everywhere** — blocking exactly as today.
Its remedy text goes generic: `project-walls.conf` allow-line as the
documented escape, plus a repo's own declared gateway where one exists; the
the declared gateway and the three non-payload skills leave the shipped text and
move to this installation's own project-standards layer. The operator's name
becomes a deploy-time value in seeded prose (records already carry identity
via `--by`/`--authority`). Phase 6 packaging gains a **portability scan**
derived from the payload roster (personal names, private services, phantom
skills, absolute home paths — fails the build, never a deployed repo).
Text fixes join the Phase 1a bash window; the scan lands in Phase 6.

Alternatives declined: inert-until-declared (loosens boundary 1 for every
undeclared repo); opt-in (four walls become three on a fresh install).
Precedent: DESIGN_SPEC §12's cut of the three hardcoded stack rules — the
gateway rule survived it only because the wall behind it made an
infrastructure opinion look like canon.

---

## D-0087 — 2026-08-31 — Findings triage under the app division; batch approvals never loop

Ratified by: User (in session). Scope: repo.

Two rules for the TS-port findings pipeline:

1. **Every claimed CLI looseness is evaluated against scrumux-app's role
   before it becomes a register entry or a proposal.** The CLI never blocks
   or validates direct user input — it guides the agent toward the most
   compliant execution and records what happened — and observation/surfacing
   of the resulting state (dangling refs, duplicate members, unverified
   files) is the app's job under Article 9. A looseness whose counterpart is
   app-side monitoring is registered as deliberate division of labor, not
   proposed as a CLI fix.
2. **Batch-approvable governance fixes get ONE approval from User and are
   then executed by script or orchestrator without per-item agent
   ceremony.** User's approval in chat IS the ratification — recorded with
   provenance and acted on. An agent must never bounce an authority error
   back to him for something he already approved in session.

User's words, same day: *"we can't block direct user input at CLI, we
should guide the agent in the most compliant way to execute it and track
the results"* — and batch-approvable fixes must not enter *"a governance
circle-jerk where the agent keeps trying to ratify a decision and keeps
getting told it doesn't have the authority to approve something I'm clearly
approving in chat."*

(Housekeeping note: D-0088 in the local journal is a junk entry from an
orchestrator shell mistake, queued for removal via `repair journal`; D-0087
is the real record.)

---

## D-0089 — 2026-08-31 — Phase 1 gate rulings: parser split; memory add creates on first use

Ratified by: User (in session). Scope: repo.

1. **JSON parser lands split.** The TS parser accepts a top-level value
   stream (`1 2`) exactly as jq does — the one reachable
   bash-passes/TS-fails case is closed. For `+1`, `Infinity` and `NaN` the
   TS parser stays stricter than jq as an `APPROVED-DIVERGENCE: D-0089`:
   unreachable via any CLI verb (every field arrives via `--arg`), pinned as
   ts-STRICTER rows in `test/unit/jqformat-parser.test.ts`.
2. **`memory add` creates `governance/validator-memory.md` when absent**,
   reversing the refusal at `cmd-memory.sh:22`. Bash first (red-first test),
   then the sandbox scenario step flips from expected-refusal to
   expected-creation and the baseline regenerates. User on the code comment
   that called the refusal deliberate: it wasn't his — a comment asserting
   deliberateness is not a ruling, and this one had none behind it.

---

## D-0090 — 2026-08-31 — Phase 2 gate rulings: attestation ordering, ERE dialect, hook budget

Ratified by: User (in session). Scope: repo.

1. **Attestation precedes the act.** The destructive wall requires
   `HARNESS_BACKUP_DONE` to appear BEFORE the destructive segment of a
   compound command. `rm -rf X && HARNESS_BACKUP_DONE=1 …` attests for an rm
   that already ran and drives a false row into the attestations sink
   (Article 6). Fixed in BOTH implementations, bash first, red-first. Newly
   refuses commands that passed before — intended. Same class as CLI-3.
2. **ERE dialect: BSD-compat ratified.** `grep -E` is not one thing (BSD vs
   ugrep disagree on `\b`, backreferences, `a{`, the last two failing to
   compile → `walls_field` skips them fail-open). `ere.ts` translates to the
   widest-compat reading so a `project-walls.conf` rule never silently
   deactivates by machine — one documented dialect everywhere, which is the
   Windows thesis in miniature.
3. **Hook performance gate is ABSOLUTE: median ≤50ms** per hook (median of 5,
   unloaded, reference machine), replacing bash+20% for hooks only. A
   relative gate over a sub-20ms bash baseline gates Node's ~22ms startup
   floor, not the port; every wall doing real work is level or faster than
   bash. Verbs keep bash-median+20% (ruling 3a). 50ms over the recommended
   35ms for headroom on slower machines and CI.

### AMENDMENT to §2 — 2026-09-02 — the ratified dialect binds the TESTS on every libc

Ratified by: User (supervisor ruling, in session). Scope: the port's test
suite. **The walls' runtime behaviour does not change, and that is the point.**

§2 ratified one ERE dialect — BSD-compatible, C-locale — so a
`project-walls.conf` rule can never activate or deactivate by machine. It said
what `ere.ts` must implement. It did not say what a TEST may assert, and two
tests had quietly written the REFERENCE MACHINE's grep into the contract:

- `test/unit/walls-posix-classes.test.ts` asserted that a UTF-8 locale treats
  U+00A0 as `[[:space:]]`. True of BSD libc, whose class derives from
  `iswspace`; **false of glibc in EVERY locale**, `en_US.UTF-8` and `C.UTF-8`
  alike, because U+00A0's POSIX class in glibc's charmap deliberately excludes
  it. Neither is a bug and no test can make them agree.
- `test/unit/ere.test.ts`'s property run asserted the translator against
  whatever the box's greps agree on. A duplication symbol with **nothing to
  duplicate** (`{2}a`, `*_`, `+env`) and **two of them adjacent** (`a{2}?`) are
  both UNDEFINED in POSIX ERE, and the implementations took different
  readings: BSD and ugrep exit 2 on the first kind, GNU compiles it as a
  literal and warns; on the second, BSD (and V8's lazy form) do not make the
  braced atom optional and GNU does, so `a{2}?` matches every line there.
  Darwin masked both because its two greps DISAGREE, which the run already
  classified as `platformDependent`; Ubuntu, where `/bin` and `/usr/bin` are
  the same GNU binary, has them agree — and the run went red on 91 patterns
  this machine never even compiled.

**The extension.** The ratified dialect is ratified EVERYWHERE, so a test
asserts the RATIFIED answer on every host and treats the host grep's
disagreement as an **expected, classified condition with the diverging libc
named** — never as evidence that the wall should change. The
`platformDependent` mechanism already did this for two greps on one box; it is
widened to two libcs on two boxes, and the classification is decided by the
PATTERN before any grep is consulted, so both boxes classify the same pattern
the same way. On a BSD-family host nothing is set aside: the host IS the
ratified dialect there, so the whole class stays under the oracle and the
claim keeps being checked against the implementation it is named after.

**"BSD-family" is MEASURED, not read off a `--version` banner**, and the
distinction earns its line. The property that matters is whether the host
refuses a leading `{n}` at rc 2, so that is what is asked. ugrep calls itself
neither "BSD grep" nor "GNU grep" and refuses the construct exactly as BSD
does; a banner test would file a BSD-compatible box as unknown and quietly
stop comparing several hundred pairs on it — the same failure this amendment
exists to correct, one level up. Measured on the reference checkout, Darwin
with two BSD greps: 1536 compared, 464 both-rejected, **0 set aside**.

**Why this is not the port bending to the host.** Nothing in `src/walls`
moved. `ere.ts` refused the first kind and read the second BSD's way before
this amendment and does the same after; a conf rule carrying either is
skipped-and-named, or matched, identically on every machine. What changed is
that the suite stopped asking a glibc box to confirm a BSD box's measurement.
The opposite resolution — teaching `ere.ts` to follow the host's grep — is the
thing §2 exists to forbid: it would make a repo's active rule set a property
of which grep the box has.

Enforced at: `test/unit/ere.test.ts` (`adjacentQuantifier`, `HOST_IS_BSD`, and
the `dialectDivergence` bucket) · `test/unit/walls-posix-classes.test.ts`
(the per-libc arm of "PINS the locale divergence"). Both measured on Darwin
(BSD grep 2.6.0-FreeBSD) and Debian bookworm (GNU grep 3.8, glibc), green on
each.

---

## The ratified port divergences — R-002 … R-009

Ratified by: User (2026-09-01, direct in session). Scope: the port.

**Eight places where the TypeScript CLI does not do what bash does, and the
TypeScript answer is the ratified one.** They are collected here because they
share a shape and a disposition, not because they were found together.

A divergence is not a defect and it is not a licence. The port's default is
reproduction — `docs/port/PHILOSOPHY.md` is fifty-odd entries about the damage
done by "the TypeScript felt uncomfortable, so it refuses now" — and the
differential compares stdout, stderr, exit code, `.argv` and the whole
post-state precisely so a port cannot quietly become a different program.
Every entry below therefore had to answer the same question before it could be
ratified: **what does bash's behaviour actually give the operator, and is it
something anyone chose?** In six of the eight the honest answer was that bash's
behaviour is an artefact — of the shell, of the interpreter, of what happened
to be installed — that nobody designed and no record defends. In the other two
it is a fail-closed path whose WORDING is new because the mechanism reaching it
is new.

**What ratification changes.** Each divergence stops being a debt marker in a
test file and becomes a recorded decision. The two that were carried as
`NO_BASH_COUNTERPART` rows in `test/unit/refusal-parity.test.ts` — the unruled
form, deliberately more annoying than a marker — move to
`APPROVED-DIVERGENCE: R-008` / `R-009` markers at their sites
(`src/journal/lock.ts:108` and `src/journal/guards.ts:126`), which is the
ruled form. The meta-test's rows shrink accordingly, and its site counts stay
exact in both directions, so a twelfth `needs a value` still turns it red.

---

## R-002 — 2026-09-01 — A flag with no value refuses at exit 2, in the CLI's own words

Ratified by: User (in session). Scope: the port.

**What diverges.** `scrumux decide new --title` — a flag ending the command
line with nothing after it. bash takes a flag's value with the shell
parameter expansion `${2?}`, which is not this CLI's refusal path at all: the
SHELL prints its own diagnostic and kills the process. The TypeScript side
refuses at **2** with the noun's own wording — `decide: --title needs a value
— see: scrumux help decide`.

**Amended 2026-09-02: the bash half of this is HOST-DEPENDENT, in both the text
and the exit code.** This entry used to state, as fact, that `sh` prints
`<absolute path>/lib/cmd-issue.sh: line 128: 2: parameter null or not set` and
exits **1**. That is true where `/bin/sh` is bash and false everywhere else.
Measured on 2026-09-02 against one deployed target, one command
(`scrumux issue new --type defect --source User --summary`):

| shell | exit | stderr |
|---|---|---|
| `/bin/bash` | **1** | `<abs path>/lib/cmd-issue.sh: line 128: 2: parameter null or not set` |
| `/bin/dash` | **2** | `.claude/scripts/scrumux: 128: eval: 2: parameter not set` |

`.claude/scripts/scrumux` is `#!/bin/sh`, so the SAME command exits 1 on macOS
and 2 on every Linux host — including the ones this repo's own CI runs on.
Nothing in `test/`, `tests/`, the differential corpus or `tools/` asserts
either, which is exactly why it went unnoticed; and nothing should, because
pinning it would be pinning whose machine you are on.

**This makes the ruling STRONGER, not weaker.** The argument below is that
reproducing bash here would mean printing a message that names a bash source
file by line number, from TypeScript, forever. It now turns out there is no
single such message to reproduce: the "bash behaviour" this side would be
copying is two different behaviours wearing one name. A divergence from a
constant is a choice; a divergence from a host-dependent artefact is the only
option there is.

**No guard was added, and that is the finding.** Commit `87c62f0` fixed the
LEADING-position `shift 2 2>/dev/null || true` class — where a failed special
builtin makes dash exit and the CLI dies in silence — and named the in-loop
`shift 2` as unswept. It is not a defect: at every one of those sites the value
is taken with `${2?}` on a SEPARATE command that runs FIRST, so with a flag as
the last word the expansion kills the process before `shift 2` is reached, and
if the expansion succeeds then `$# >= 2` by definition. Verified by running the
CLI and by enumerating every `shift 2` in the payload: the three not fronted by
a `${2?}`/`${4?}` expansion are `scrumux:380` (`cli_argv_capture`, one call
site, two quoted leading arguments), `cmd-records.sh:108` (`count_sweep`, seven
call sites, all two quoted arguments) and `cmd-sprint.sh:123`, which carries
the arity guard `87c62f0` gave it. None can underflow.

**Where pinned.** The generic helper is `src/nouns/lib/writers.ts:192`
(`flagValue`), whose refusal is `:194`; the eleven sites are that one plus ten
per-noun parses (`decide.ts:89`, `feature.ts:52`, `health.ts:59`,
`memory.ts:68`, `epic.ts:97`, `epic.ts:173`, `story.ts:56`, `task.ts:80`,
`log.ts:73`, `task/lint.ts:49`). The TypeScript wording is asserted at
`test/unit/nouns-wave3e.test.ts:315`, and the exact site COUNT is held at
`test/unit/refusal-parity.test.ts:69-70` — a twelfth site turns that file red.

**Why the TypeScript answer is the ratified one.** Reproducing bash here would
mean printing a message that names a bash source file BY LINE NUMBER, from
TypeScript, forever — pinning a rough edge as contract by accident, and lying
about where the code is. It would also emit exit 1, which the CLI contract
reserves for "the assertion did not hold": a caller that gets 1 has a real
answer and should show it, and a truncated command line is not an answer. This
is exit 2's whole reason for existing (`lib/cli.sh:33-48`). The three sites
where bash DID write a message into its `${1:?…}` reproduce it verbatim and
match; only the wordless ones diverge.

**This closes `docs/port/modules/cmd-task.md` open question 1**, which asked
whether the raw shell diagnostic is the intended contract, across all eleven
sites. It is not. That document stated the shell exit as **127**; re-measured
against a deployed target on 2026-09-01 it is **1** (`scrumux decide new
--title` → `…/lib/cmd-decide.sh: line 9: 2: parameter null or not set`, rc 1)
— **on macOS, where `/bin/sh` is bash; the 2026-09-02 amendment above measures
1 under bash and 2 under dash, so this figure is host-scoped too.**
The 127 came from a bare `sh -c`, which is a different invocation from a
sourced module under the dispatcher. The correction is written into the
register beside the closure; the ruling is unaffected either way, because 1 is
the code the contract reserves for "the assertion did not hold" and a truncated
command line is not an assertion that failed.

Enforced at: `src/nouns/lib/writers.ts:192-195` · proved by
`test/unit/nouns-wave3e.test.ts:315` · counted by
`test/unit/refusal-parity.test.ts:68-82`.

---

## R-003 — 2026-09-01 — An unparseable journal is ONE finding per file, not one per reader

Ratified by: User (in session). Scope: the port.

**What diverges.** `records check` over a `governance/*.json` that does not
parse. bash runs many independent `jq` pipelines over each journal, and each
one fails on its own and emits its own complaint, so a single corrupt file
produces several near-identical FAIL rows. The TypeScript side parses each file
once and emits exactly one: `validator internal: jq failed on <path>: could not
parse — records-check itself needs fixing; do not trust this run`.

**The count, measured** (2026-09-01, Harden E, against a freshly deployed repo
— this paragraph read "a dozen" until it was run). A corrupt `tasks.json`:
**four** rows in bash, one here. `issues.json` and `decisions.json`: **two**,
one here. `sprints.json`: one on both sides, because only its own section
reads it. The shape of the claim was right and the magnitude was prose; the
numbers are now pinned, per side, so the ruling cannot outlive the behaviour
it describes.

**Where pinned.** `src/nouns/records.ts:361` (the `sweep` closure), with the
divergence written up at `:337-360`. Held at
`test/unit/records-unparseable.test.ts` — one finding per file, the exit code,
and the section-0 "is not valid JSON" row. Its bash half (four/two/one
findings, one per reader) went with the cutover, which made it inert.

**Why the TypeScript answer is the ratified one.** The count is not cosmetic:
`records check --porcelain` feeds `scrumux issue`, so bash's shape mints one
issue per reader for one broken file, and the operator's backlog fills with a
dozen rows describing the same byte. The number of times a file was read is a
fact about the implementation, not about the repo, and Article 4 says a check
may claim only what it computes — there is one defect here and the record
should say one. The message is unchanged and still names itself as a validator
internal, which is the part that tells the reader not to trust the run.

**Closed in Harden E:** the dangling pointer this ruling named is repaired.
`src/nouns/records.ts:332` cited `test/unit/records-unparseable.test.ts` and
that file did not exist; the live pin was one `toHaveLength(1)` three hundred
lines into `test/unit/nouns-wave1b.test.ts`. The repair went the direction the
citation pointed — the file was written and the assertions moved into it —
because a ruled divergence deserves a file of its own, and because bending the
pointer to match where the assertion happened to live would have kept the
weaker half. The move also bought the bash half: the old assertion pinned this
side and took bash's on trust from the word "dozen".

Enforced at: `src/nouns/records.ts:339` · proved by
`test/unit/records-unparseable.test.ts`.

---

## R-004 — 2026-09-01 — The schema sweep is native, so it needs no interpreter

Ratified by: User (in session). Scope: the port.

**What diverges.** bash's schema sweep shells out to
`agents/lib/schema_check.py`, so it has an arm for "there is no usable
python3": a fail-closed FAIL row carrying the first line of the interpreter's
stderr. The TypeScript sweep is native (`src/schema/check.ts:302`), so that arm
has nothing to be about — the sweep answers with no interpreter on the machine
at all.

**Where pinned.** `test/unit/schema-wave5i.test.ts:462-475` runs the sweep with
`PATH` emptied and `agents/` absent and still gets the violation and rc 1. The
bash half was asserted in `tests/fail-closed-tests.sh` until bash itself was
retired (2026-09-03); nothing asserts a bash half now because there is no
bash left to have one.

**Why the TypeScript answer is the ratified one.** The python-absent arm is a
correct response to a dependency, and the point of Wave 5I was to remove the
dependency. A sweep that cannot run is a sweep that reports nothing about the
journals, and a repo whose validator goes quiet because an interpreter moved is
the failure the arm was written to make visible — not a behaviour worth
preserving once it cannot happen. The fail-closed DISPOSITION is unchanged and
still carried on `SweepResult.failure` (`src/schema/check.ts:282-292`) for the
failures that remain reachable.

Enforced at: `src/schema/check.ts:302` · proved by
`test/unit/schema-wave5i.test.ts:462`.

---

## R-005 — 2026-09-01 — The code graph indexes the committed grammar set, not the installed one

Ratified by: User (in session). Scope: the port.

**What diverges.** `graph code build`. The bash implementation is Python and
imports `tree_sitter_<language>` from the interpreter, so it can only index the
languages whose pip packages happen to be present — `pyproject.toml` declares
`tree-sitter-python` and `tree-sitter-bash` and nothing else, and everything
else is reported as skipped with an install hint. The TypeScript implementation
loads the thirteen `.wasm` grammars COMMITTED under `tools/grammars/`, so it
indexes every one of them on every machine with nothing to install. The
TypeScript set is a strict SUPERSET.

**Where pinned.** `test/unit/code-build-wave5j.test.ts:294-302` — a tree of
`.sh`, `.go` and `.rs` indexes three languages with `coverage.skipped`
empty, which the Python side cannot do on a stock checkout. The differential's
own exposure is declared and ASSERTED rather than waived at
`tools/differential/env-divergence.mjs:52-89` (case `sb-076`), which is why the
sandbox tier reports it green with the reason attached instead of hiding it.

**Why the TypeScript answer is the ratified one.** An index whose contents
depend on what someone pip-installed is not a fact about the repository. Two
agents on two machines get two different answers to "who calls this symbol",
neither is wrong, and neither can be reproduced by the other — which makes the
graph unusable as evidence. Committing the grammars was the point of Wave 5J:
the answer is now a property of the checkout, and the same checkout gives the
same graph everywhere.

Enforced at: `src/nouns/graph/code-build.ts` (grammar loading) · proved by
`test/unit/code-build-wave5j.test.ts:294` · declared for the differential at
`tools/differential/env-divergence.mjs:52`.

---

## R-006 — 2026-09-01 — A failed `graph gov build` prints one named exception, never a traceback

Ratified by: User (in session). Scope: the port.

**What diverges.** When the governance graph cannot be built, bash's Python
path lets the interpreter print its traceback. The TypeScript side catches and
prints exactly one line: `graph gov: error: build failed — <exception>`.

**Where pinned.** `src/nouns/graph.ts:555-562`, with the reasoning and the
marker at `:538-554`. The marker carried the approval word and no id until
Harden G — it was written in Wave 5J, before the R-series existed — and now
names `R-006` at the site, because `test/unit/refusal-parity.test.ts` stopped
accepting a marker that licenses no refusal and names no ruling.

**The gap this ruling declared is closed** (Harden E). It read "**There is no
dedicated test**, and that is stated rather than implied: no test file imports
`src/nouns/graph.ts`, so this rests on the refusal-parity backstop's marker
window and on review." A divergence whose only defence is review is a
divergence that can close behind your back — bash could grow a `try/except`
and the port a stack dump, and nothing in the repo would move. It is now held
by `test/unit/rulings-hardenE.test.ts`, which drives a corrupt
`decisions.json` and asserts: exactly one `graph gov: error: build failed — …`
line, with no `Traceback`, no ` at ` frame and no `.ts:` in it; exit 1 and the
`FAIL gov-graph` envelope row alongside it; and that a HEALTHY repo builds at
rc 0, without which the other assertions are satisfied by a CLI that fails
unconditionally.

The test carried a second half that ran the bash CLI and asserted the CPython
traceback it printed. The cutover made that half inert and it is gone
(`Flip follow-up`, 2026-09-03): what is ruled here is what THIS CLI prints,
and that is what is pinned.

The refusal-parity backstop could never have covered this one, and that is
worth saying rather than leaving as an implication: `graph gov` writes its
diagnostics with `sayAlways`, not `cli.die`, so it is not in that corpus's
population at all.

**Why the TypeScript answer is the ratified one.** A traceback from a
TypeScript process would have to be a FABRICATION — there are no CPython frames
to print — and inventing plausible ones is a worse failure than a stated gap.
The alternative considered and rejected was printing nothing, which leaves the
fail row's "see the message above" pointing at nothing at all. One line naming
the exception is what an operator can act on, and Article 5 asks for the
instruction, not the stack.

Enforced at: `src/nouns/graph.ts:555` · proved by
`test/unit/rulings-hardenE.test.ts`.

---

## R-007 — 2026-09-01 — Paths are derived LOGICALLY, the way the shell derives them

Ratified by: User (in session). Scope: the port.

**What diverges.** How the CLI works out where it is. Node's ESM loader
realpaths the module it loads, so `import.meta.url` is the PHYSICAL path. On
macOS `/var` is a symlink to `/private/var`, so a harness deployed under
`mktemp -d` printed `/private/var/…/.venv` where bash — which resolves with
`cd -L`, lexically — printed `/var/…/.venv`, in the SAME refusal. Measured on
`records check` with no python3. `logicalDirOf`
(`src/nouns/lib/context.ts:157`) resolves lexically and refuses
`import.meta.url` as an input (`:191-193`).

**Where pinned.** `test/unit/nouns-wave3e.test.ts:101-118` — an intermediate
symlinked directory survives the derivation, and `defaultScriptsDir` answers
under the link rather than under its target.

**Why the TypeScript answer is the ratified one.** This one is not really a
divergence at all: it is bash's behaviour, restored. The physical path is what
Node happened to hand over, not a choice anyone made, and it is user-visible in
refusal text and in written state. An operator who deployed to a path and is
shown a different path has to work out for themselves that the two are the same
place. Ruled explicitly all the same, because the fix reads like a workaround
at the site and is in fact the contract.

Enforced at: `src/nouns/lib/context.ts:157-193` · proved by
`test/unit/nouns-wave3e.test.ts:101`.

---

## R-008 — 2026-09-01 — A lock path whose parent does not exist fails fast, and says so

Ratified by: User (in session). Scope: the port.

**What diverges.** bash's `journal_lock` is `until mkdir "$f.lock"`, which
treats every failure alike. A MISSING PARENT DIRECTORY therefore spins a
hundred times over ten seconds and then earns the generic "timed out waiting
for the journal lock". The TypeScript side short-circuits `ENOENT` and refuses
immediately: `cannot take the journal lock <path> — its parent directory does
not exist`. Everything else is still treated as contention, exactly as bash
does.

**Where pinned.** `src/journal/lock.ts:119-122` (the `ENOENT` arm and its
refusal string at `:121`), with the marker and its reasoning at `:108-118`.
Carried in
`test/unit/refusal-parity.test.ts` as a `NO_BASH_COUNTERPART` row until this
ruling; the row is now retired and the site carries
`APPROVED-DIVERGENCE: R-008`.

**Why the TypeScript answer is the ratified one.** A wrong path is not
contention. Waiting ten seconds for a directory that will never appear helps
nobody, and the message the wait finally produces — "timed out waiting for the
lock" — is actively misleading: it tells the operator to look for another
process when the fault is in the path they passed. Both the timing and the text
are visible only to a caller pointed at a directory that does not exist, so
nothing that works today changes.

Enforced at: `src/journal/lock.ts:121` · marked `APPROVED-DIVERGENCE: R-008`
at `:108`, thirteen lines above the throw and well inside the forty-line
marker window.

---

## R-009 — 2026-09-01 — A journal that cannot be read fails admission in the CLI's own words

Ratified by: User (in session). Scope: the port.

**What diverges.** `admissionState` computes how many of a sprint's tasks may
be in flight (D-0084). bash computes it with `jq --slurpfile` / `--argjson
"$(cat …)"`, so an unreadable or corrupt `tasks.json` or `sprints.json` makes
jq exit non-zero having printed ITS OWN diagnostic, and the caller sees an empty
result. The TypeScript side refuses in its own words: `cannot read <path> —
admission cannot be computed`.

**Where pinned.** `src/journal/guards.ts:143` (tasks.json) and `:154`
(sprints.json), with the disposition written up at `:121-124` and the marker at
`:126`. Carried in
`test/unit/refusal-parity.test.ts` as a two-site `NO_BASH_COUNTERPART` row
until this ruling; the row is now retired and both sites are covered by one
`APPROVED-DIVERGENCE: R-009` marker.

**Why the TypeScript answer is the ratified one.** Both implementations FAIL
CLOSED here and always did — the divergence is only in whose words the operator
reads. Shelling out to jq purely to reproduce its stderr would add a dependency
to a fail-closed path in order to make the message worse: jq's diagnostic names
a filter, not the journal, and says nothing about admission. Article 5 wants
the refusal to name the file and the consequence, which is what these two do.

Enforced at: `src/journal/guards.ts:143,154` · marked
`APPROVED-DIVERGENCE: R-009` once at `:126`, which covers both throws below
it — seventeen and twenty-eight lines down, both inside the forty-line
window.

---

## The Harden E rulings — R-010, R-011

Ratified by: User (2026-09-01, direct in session). Scope: the port, and — for
R-010 — bash with it.

Two entries with nothing in common except the wave that found them. R-010 is a
SECURITY FIX landed on both sides at once, in the lineage of User's Harden C
secret ruling; R-011 is a divergence the Harden C hotfix-gate fix made visible
and did not create — and, underneath it, two fail-open defects that the same
inspection turned up and that are repaired rather than ruled.

---

## R-010 — 2026-09-01 — `secret set` names the position of a bad argument, never the argument

Ratified by: User (in session). Scope: the port and bash together (PK-1).

**This extends the Harden C secret ruling** — the one that took the credential
out of `.argv` (commit `8f55436`, recorded in its message and in
`src/cli/argv.ts`'s `redactArgv`) — **to the refusal text, and to one argv slot
the first fix did not reach.** It is one ruling because it is one defect: the
value comes back out, on the one noun whose stated contract is that nothing
prints a value back.

**What was wrong, in two places.**

1. **THE REFUSAL ECHOED THE OPERAND.** `scrumux secret set TOKEN
   -sup3r-s3cret` refused with `secret set: unknown flag -sup3r-s3cret —
   usage: …` — the credential on stderr in human mode, and in the envelope's
   `summary` AND `error.message` under `--json`. `redactArgv` never saw it:
   `secret set`'s own parse refuses a leading-dash argument as a flag long
   before the envelope is composed, and the redaction it does perform is on a
   different field. A value is not required to look like a value.

2. **THE NAME SLOT WAS NEVER REDACTED.** `redactArgv` kept `args[0]` verbatim
   on the reasoning that it is the NAME and a NAME is not a secret. True of
   every argv that HAS a name; `scrumux secret set -sup3r-s3cret` does not —
   the value was typed one slot early — and `.argv` recorded it in full. Found
   by the grep-everything assertions written for (1), which is what a
   whole-stream grep is for: the field-by-field version of the same test had
   been green since Harden C.

**The answer.** For `secret set`, and only for `secret set`:

- the unknown-flag refusal names the ORDINAL and withholds the operand —
  `secret set: unknown flag in argument 2 (not echoed — on this noun an
  argument may be the secret itself) — usage: scrumux secret set NAME [VALUE]
  | scrumux secret list | scrumux secret remove NAME`, identical bytes on both
  sides;
- a NAME-slot argument beginning with `-` is redacted in `.argv` too.

**Why the POSITION and not the text.** The refusal fires BEFORE the parse has
decided which slot is which: the arm that fires on argument 1 cannot tell a
mistyped NAME from a value typed early. Withholding it in every position is the
only rule that does not require the seam to re-decide what `secretSet` decides
— the same reasoning `redactArgv` already settled once, applied harder. The
ordinal is what makes the withholding acceptable: it is enough to fix the
command line and nothing a transcript can leak. And a leading dash can never
be a usable NAME (`requireUsableName` allows letters, digits and underscore
only, never a leading digit), so redacting that slot loses no record at all —
the ENTRY COUNT and the POSITION survive, which is the whole of what `.argv`
is for (PK-2, restated for the third time).

**Why BOTH SIDES.** The PK-1 mechanism, exactly as Harden C: the behaviour
bash had was wrong, so bash and TypeScript change together and the pair stays
byte-comparable. A port that had corrected this on its own would have been
certifying its own divergence, and `.argv` and stderr are compared LITERALLY by
the differential precisely so it cannot make that call.

**Where it stops, and why that is written down.** `secret remove` keeps the old
wording. Its one operand is a NAME, it has no value in its argv to leak, and
its refusal is one of the matched pairs the refusal-parity corpus counts;
redacting it would buy nothing and cost a matched pair. A security fix with no
recorded boundary is a security fix that spreads until something breaks.

Enforced at: `src/nouns/secret.ts` (`parsePositional`) and
`src/cli/argv.ts` (`redactArgv`) · matched byte-for-byte against bash's
`.deploy-claude/scripts/lib/cmd-secret.sh:41-57` (the reasoning at `:41-53`,
the refusal at `:57`) and `cli_argv_capture` when both sides were ratified,
proved by the five cases in `test/fixtures/tier2-hardenE.mjs` (both modes) —
all retired with bash (2026-09-03) · grep-everything unit cover in
`test/unit/dispatch.test.ts` ("R-010: `secret set` never echoes the operand")
and `test/unit/argv.test.ts`.

---

## R-011 — 2026-09-01 — A `.validation` that is not an object fails admission in each side's own words

Ratified by: User (in session). Scope: the port.

**What diverges.** `sprint new --hotfix --issue I-XXXX`, on an issue whose
`.validation` is a NON-OBJECT scalar — a string, a number, a boolean. bash
computes the verdict with `jq -r '… if .validation == null then "none" else
.validation.verdict end'`, and jq **cannot index a string with "verdict"**: the
filter errors, jq exits non-zero having printed its own diagnostic — naming the
journal's ABSOLUTE PATH and a line number — and the shell variable is the empty
string, so bash's refusal reads `(verdict: )`. The port has the value in hand,
so it renders it: `(verdict: yes)`.

**Both sides refuse, at exit 2, in the same sentence.** Only the quoted verdict
and the presence of jq's line differ. Same fail-closed class as R-009, and the
same disposition: the mechanism reaching the refusal is new, so the WORDING is.

**Made visible by Harden C, not created by it.** Before the default arm landed
(`8f55436`), a verdict neither side could read fell through and OPENED the
hotfix sprint — on both sides — so there was nothing to disagree about. The
gate becoming a gate is what turned an identical hole into a text divergence.
That is the ordinary shape of a hardening pass and it is worth naming: closing
a hole surfaces the divergences the hole was hiding.

**The measured renderings**, all seven of them: `"yes"` → `(verdict: yes)`;
`42` → `(verdict: 42)`; `3.5` → `(verdict: 3.5)`; `true` → `(verdict: true)`;
`false` → `(verdict: false)`; `["reproduced"]` → `(verdict: ["reproduced"])`;
`["evidenced"]` → `(verdict: ["evidenced"])`. bash reads `(verdict: )` for
every one of them, with a jq diagnostic above it. Both sides exit 2 in all
seven shapes.

**Why the TypeScript answer is the ratified one.** Reproducing bash would mean
shelling out to jq on a fail-closed path purely to reproduce jq's stderr — a
dependency added to make the message worse, which is R-009's argument
unchanged. jq's diagnostic names a filter and a byte offset, not the gate;
Article 5 wants the refusal to name what was read and what it costs, and the
port's does. Printing an empty verdict to match bash would be reproducing an
ARTEFACT of a failed subprocess as though someone had chosen it.

**THE DEFECT THIS RULING REFUSED TO ABSORB, and what happened to it.** The
first draft of this entry had to carve out the ARRAY shape, because
`{"validation": ["reproduced"]}` did **not** fail closed on the TypeScript
side: it exited 0 and allocated the sprint, where bash refused at exit 2 — a
fail-OPEN on a security gate. That was never a divergence and the carve-out
was never going to be tenable: a ruling whose first paragraph says "both sides
fail closed" cannot also contain a paragraph saying one of them does not.

It was a PORTING MISS, not a design. `jqRaw`'s own docstring said "anything
else as its JSON text" and its last line was `String(v)` — and
`String(['reproduced'])` is the bare word `reproduced`, which matched the
passing verdict. The correct implementation had been in the tree since Wave 4G
at `src/nouns/task/shared.ts:24-31`; `sprint.ts` was the un-updated copy. The
same miss opened a SECOND gate: `sprintUpdate` reads `status !== 'proposed'`
to decide whether changing `--parallel` is an edit or a re-ratification
(D-0084), and `"status": ["proposed"]` rendered as `proposed`, passed the
guard, and let a ratified plan be widened. Both reproduced end to end against
bash, both validated independently, both closed in this wave by giving `jqRaw`
the JSON-text fallback and unboxing `RawNumber` — and by excluding `RawNumber`
from `obj()`, which is the same one-line correction `task/shared.ts:43`
already carried.

**No input got stricter.** There is no shape on which the old rendering agreed
with bash and the new one does not; every changed output moves the port toward
bash, and two of them move it from rc 0 to bash's rc 2. So this is not an
APPROVED-DIVERGENCE and does not want a marker — it is the port becoming
faithful, which is the default the port never needed permission for.

**What still differs, and is ruled here.** jq pretty-prints a composite with
`jq -r`, so bash renders an array `duplicate_of` or `status` across three
lines; `JSON.stringify` is compact. Text only, fail-closed on both, same exit
code, reachable only from a hand-edited or corrupt journal. Ruled with the
rest of R-011 rather than chased: matching jq's line breaks would mean routing
a refusal string through the journal formatter to reproduce whitespace nobody
reads.

Enforced at: `src/nouns/sprint.ts` (`hotfixGate`, the `vstate` computation) ·
marked `APPROVED-DIVERGENCE: R-011` TWICE — at `:216`, over the computation,
and again directly above the refusal it is about at `:269`, because the two
are fifty-three lines apart and `tools/refusal-corpus.mjs`'s marker window is
forty (the window never asks this site, which has a bash counterpart, so the
second marker is written by hand rather than enforced) · the repaired `jqRaw`
is immediately below it at `:306`; the repaired `obj` is at `:99`, ABOVE
`hotfixGate` and the file's only definition of it, each carrying the reasoning
at the code ·
proved by
`test/unit/rulings-hardenE.test.ts` — which asserts the rendered verdict and
the absent jq line, exit 2 across all seven shapes, that NOTHING is written,
that `["proposed"]` can no longer widen a ratified sprint, and that a proper
`reproduced` validation still opens the lane (without which every assertion
above is satisfied by a gate that refuses everything).

**Not fixed, and named rather than left:** `src/journal/refs.ts:96-100` carries
the same `String(v)` fallback, byte for byte. It feeds `ref_resolve`'s DISPLAY
text — titles, summaries, a supersession id — and gates nothing, so a
one-element array there renders a wrong title rather than opening a lane. It
should move with this fix; it did not move in this wave because a display
change with no gate behind it is not what a security repair should be carrying,
and `ref_resolve` learns amended-by rendering in Phase 7 (D-0085/OQ-10), which
is the window that already has to touch these lines.

---

## The E2E cycle ruling — R-012

Ratified by: User (2026-09-02, direct in session, during the first end-to-end
operator run of the deployed harness). Scope: doctrine only — no code moved for
this entry, which is the point of it.

---

## R-012 — 2026-09-02 — Receipt freshness is a CLOSE-side FAIL, and that placement is ratified

**What this settles.** Article 3's stale-receipt ruling (2026-08-22) and P-46's
port note (`docs/port/PHILOSOPHY.md`) had between them been read as retiring
receipt freshness from the harness. They do not, and P-46's sentence — *"Receipt
staleness is deliberately not a close blocker any more"* — is **superseded** by
this entry to the extent that it speaks about the CLOSE. Everything P-46 says
about ACCEPTANCE stands untouched and is now restated in Article 6.

The distinction the two documents lost is between the two surfaces:

- **`task accept` does not gate on freshness**, and must not. That is the
  2026-08-22 ruling and it is correct: acceptance is an irreversible act
  (Article 10) taken on User's word, and interrupting it over a mtime is the
  "probably fine work stopped" trade Article 3 declines. What acceptance does
  instead is stronger than any staleness test — it **re-runs the command**
  (`src/nouns/task.ts` (`taskAccept`)), so a receipt that has gone stale in a
  way that matters fails the re-run rather than a heuristic.
- **`session check` does gate on freshness**, as check 3 of six, as a **FAIL**
  (`src/nouns/session.ts` (`mtimeOf`)). It compares every covered file's mtime
  against the receipt's `at_epoch`, and an unstamped receipt WARNs rather than
  passing quietly, because "cannot be judged" and "judged clean" are different
  facts (Article 4).

**Why the close is the right home, in the vocabulary of the articles this repo
already has.** Article 3 reserves FORCE for the four hooks — surfaces that stop
a tool call the agent is in the middle of, with no way to argue. A close-side
FAIL is not that. It is one command the agent has already chosen to run, at the
one moment the work is being handed back, with the tree still on disk and the
remedy one `task verify` away. Article 8 asks what a mechanism prevents, and
Article 9 asks whether the layer below is complete without the layer above: a
freshness check at the close needs no app, no listener and no person, and it is
the only thing in the system that notices a file edited after the receipt that
covers it.

**The incident that ratified it.** On this end-to-end cycle — the first time the
deployed harness was driven as a product rather than as a test — the close-side
freshness check FAILED on **two** receipts whose files had been edited after the
receipt was written. Both would have closed green under a reading that took
P-46's sentence at face value, and both were real: the receipts no longer
covered the code. That is the Article 8 test met with an observed incident
rather than an imagined one, on the first session that could produce one.

**What this does NOT do.** It does not add a blocking surface: there are still
exactly four hooks, and `session check` was already a FAIL-bearing verb before
this entry. It does not move any code. It corrects two documents that described
the machine wrongly — Article 6 named four acceptance conditions the acceptor
does not all compute, and P-46's port note read as forbidding a check that had
already been ported and was already earning its place. Article 1's triage rule
applied to documentation: the instruction set was the failing component.

**Pinned material is not edited.** `docs/port/PHILOSOPHY.md` is a HISTORICAL
register of the port and is left byte-for-byte as it was; P-46 is superseded
here, in the live constitution, which is where a reader looks for what is
currently true.

## R-013 — 2026-09-02 — A redirect glued to its path, and a protected directory, are both refusals

**What this settles.** Two holes in `block-upstream-edit`, both found by the
PowerShell adversarial round, both **dialect-independent**, and both now closed
on the bash master and the TypeScript port together.

**1. The glued redirect.** `echo x 2>.claude/schemas/task.schema.json` and
`echo x &>.claude/hooks/y.sh` are writes into the machinery. Neither
implementation saw them: the token is not one of the bare redirect operators
and it does not begin with `>`, so it fell through to the ordinary operand test
with a benign command word (`echo`) in front of it and was allowed. The SPACED
forms (`2> path`) were always caught.

**This retires a pinned known limit, and that is why it is a ruling rather than
a bug fix.** `test/unit/walls-hardenE.test.ts` carried the gap as a deliberate
reproduction — *"A SHARED GAP, REPRODUCED NOT REPAIRED"* — asserting **exit 0**
for both forms, on the standing rule that an evasion which works against bash
too is a finding about the WALL rather than about the port, and that widening
one side alone is a silent divergence this repo does not take unilaterally.
That reproduction was correct while it stood and is **superseded** here. The
rule it rested on is not weakened: what the rule always pointed at is a ruling
that closes both sides at once, which is this one. The assertion keeps its
shape — still about the PAIR, so closing or REOPENING it in one implementation
alone turns it red — and only the expected code moved.

Written once per side and mirrored: `redirGluedTarget` in
`src/walls/block-upstream-edit.ts`, `redir_glued_target` in
`.deploy-claude/hooks/block-upstream-edit.sh`. `2>&1` yields `1` — a dup, not a
file — and is not protected, so it needs no special case.

**A consequence worth recording, because it is a widening nobody asked for.**
The scanner has never been quote-aware, deliberately: every token is scanned,
which is what keeps the I-0121 heredoc route caught. So `echo "x
2>.claude/hooks/y.sh"` — a redirect inside a quoted string, which writes
nothing — now refuses. That is not new strictness introduced here: the spaced
form in quoted prose refused before this change and still does, measured both
ways at the previous HEAD. What this ruling removed is an INCONSISTENCY between
the two spellings, not a permission.

**2. The protected directory.** Every pattern in `is_protected` required a
trailing `/` with something after it, so a path that NAMED a machinery
directory and stopped — `Expand-Archive -DestinationPath .claude/scripts`,
`mv evil .claude/hooks` — wrote into the machinery without ever naming a
protected FILE. Fixed at the shared predicate, once, so both dialects inherit
it.

**The boundary is a SEGMENT boundary, not a string prefix**, and that is the
care in it: `.claude/scripts` and `.claude/scripts/` are protected while
`.claude/scriptsomething` — a name a repo may legitimately own — is not. A
`startsWith` test would have refused both. The PREFIX side stays generous
(I-0133): `/abs/repo/.claude/scripts/x` and `open.claude/scripts/x` still hit.
The Python arm keeps its `.py` anchor for the reason recorded at the site —
unanchoring it newly refused `helper.py.bak`, `.pyc`, `.pyi` and `.py.orig` —
and the `agents/lib` directory arms END at the directory, so they cannot reach
any of those.

**Enforcement.** `test/unit/walls-hardenE.test.ts` holds both halves and asserts
each case against BOTH implementations, so a divergence in either direction is
red. The PowerShell matrix (`test/fixtures/ps-dialect-matrix.mjs`) carries the
same two rules in the other dialect, including the prefix-boundary
false-positive rows, which are the half most easily broken by a later widening.

---

## The improvement-cycle rulings — R-014 … R-017

Ratified by: User (2026-09-13; the scrumux super-repo decision log, D-S016..D-S020),
implemented by the Opus improvement-cycle agent. Evidence: super-repo
`reports/OBSERVATIONS-LOG.MD` (the supervised Rover build), `ISSUES.MD` SX-003,
SX-011..SX-013, validations in `reports/VALIDATIONS-REPORT.MD`. The principle
(D-S016): the harness guides and the app surfaces variance; a finding is not
answered by wiring the CLI tighter. R-016 is the one new refusal, and it is
User's explicit choice (D-S017).

---

## R-014 — 2026-09-13 — Hollow greens are named, a failure case can be stated, and the verify output is kept for review

**What changed.** (1) `task lint`'s READER note (still a NOTE, moving no
counter) names the three hollow greens the Rover build shipped — a test that
skips when its dependency is down, an assertion that cannot fail, a test that
writes into real shared data — and echoes the order's declared failure case or
says none was declared (`src/nouns/task/reader.ts`). (2) `task order
--fails-when TEXT` records `task_order.fails_when`; `task brief` prints it as
`MUST FAIL WHEN`. Optional: nothing refuses an order without it. (3) `task
verify` writes the verification command's last 40 output lines, with command,
rc and date, to `governance/.evidence/<TID>.verify.txt` (or
`.post-acceptance.txt`), a directory that ignores itself (`src/nouns/task/evidence.ts`).
(4) The implement-sop and session-open skills carry the three patterns.

**Why a sidecar and not the receipt.** The receipt is committed and pushed; a
command's output can carry anything it prints. The same tail already reaches
the session transcript. A local, gitignored file beside the records is what
the control plane on this host reads at acceptance; its absence (older
receipts) is "no recorded output", which the app shows as unknown.

**Not a gate.** D-S016 rules the weak-check finding guidance + visibility.
The acceptance re-run is unchanged.

---

## R-015 — 2026-09-13 — The scope scan does not read URLs, HTTP routes or host strings as files

`task lint`'s I-0130 scan stays recall-first and TELL-only
(`src/nouns/task/scope-paths.ts`). URL and `host:port` spans are removed before
tokenising; a token starting `//`, one led by an ALL_CAPS env-var name, and a
leading-`/` token with no extension (a route) are not files unless they exist;
an extensionless relative token counts only when it exists under the work root.
Anything with an extension is still a path whether or not it exists. A
sentence-ending period is not part of a path. Traded: an extensionless
directory the order means to create is no longer flagged — the close authorises
files, not directories, so nothing it would have caught is lost.

---

## R-016 — 2026-09-13 — An addition to a ratified sprint waits for its own ratification (D-S017)

`sprint add` on a ratified sprint is allowed and records
`additions: [{task, date, ratified: null}]` (`src/nouns/sprint-additions.ts`).
`task brief` FAILs its sprint gate for an unratified addition, so the app does
not dispatch it; the tasks ratified with the sprint brief as before. `sprint
ratify` on a sprint with pending additions ratifies THOSE and leaves the
sprint's own `ratified` block untouched. Backwards compatible: a sprint with no
`additions` field (every journal before this, including past additions) has
none pending. This is the cycle's one new refusal, and it is User's explicit
choice.

---

## R-017 — 2026-09-13 — An accepted task's acceptance receipt is frozen; later runs are post-acceptance checks (D-S018)

`task accept` copies the receipt it gated on into `acceptance.receipt`. `task
verify` on an accepted task leaves `receipt` and `acceptance` untouched and
appends the run to `post_acceptance_checks` (newest last, 10 kept)
(`src/nouns/task/receipt-freeze.ts`). A red newest post-acceptance check is
DRIFT: `session check` WARNs (never FAILs) and the app surfaces it. Backwards
compatible: an accepted row with no `acceptance.receipt` freezes its live
`receipt`, which is simply no longer overwritten. **Supersedes** the receipt
schema's "overwritten on every run" for accepted tasks only; for an open task
the last receipt still wins.

---

## R-018 — 2026-09-13 — A block records what it waits on

`task status T-XXXX blocked --reason TEXT` records `blocked: {reason, date}` on
the task (the reason is optional; `--by` stays superseded's alone), and any
later status change removes it. Before, `--reason` was refused on every status
but `superseded`, so a session blocked on a step only the operator could take
(Rover T-0008: "awaiting operator deploy") could say so only in prose, and the
app had nothing to show (SX-006). The SX-010 guidance tells a session denied a
permission to set the task blocked with the denial as the reason. Additive: no
command that worked before refuses now.

---

## R-019 — 2026-09-13 — Schema differences from the manifest are variance, like rules and skills (D-S027)

`harness verify` classes `.claude/schemas/**` as TRACKED (`driftClass`): a
schema whose bytes differ from `.claude/DEPLOYED`, or one the manifest never
claimed, is reported in `machinery-drift` as variance and never fails verify or
counts as tampering. Schemas reach a deployed repo through the operator's canon
publish (scrumux-app, D-S024), a recorded act, not evasion. Walls, scripts and
`dist` stay FROZEN and unclaimed files there still fail `machinery-orphans`. A
MISSING manifest file still fails, whichever lane. **Not changed:** the
upstream-edit wall still refuses an AGENT writing `.claude/schemas` — the
operator's publish never passes through it. **Supersedes** D-0072 boundary 7's
"rules and skills only" and this file's earlier "schemas are frozen machinery"
wording for verify alone.

---

## R-020 — 2026-09-13 — `harness deploy --json` names what to commit (D-S029, SX-017)

The deploy envelope gains `commit_paths`: every path this run CREATED, UPDATED,
SEEDED or REMOVED according to its own inventory, plus writes no inventory row
names (`CLAUDE.pre-harness.md` when it preserves one) and
`governance/code-graph.json` when the build changed it — the index is derived,
but a worktree session reads it from git with no grammars to rebuild it.
Rendered views and `.scrumux/events.jsonl` are never listed; the `.gitignore`
lane ignores them. A caller committing a deploy on the operator's behalf stages
exactly this list and is left with a clean checkout (the journals deploy seeds
included — the SX-017 gap). Additive: no field changed or removed; an older CLI
simply has no `commit_paths`, and a caller must say so rather than guess.

---

## R-021 — 2026-09-13 — The pointer to a preserved CLAUDE.md is kept on every deploy (D-S030, SX-018)

The root constitution is a desired state (`src/nouns/harness/constitution.ts`):
the payload constitution, plus the "This repo had its own CLAUDE.md" pointer
exactly once whenever `CLAUDE.pre-harness.md` exists. Every deploy compares the
target to that and writes it whole — CREATED where there is none, UNCHANGED when
equal, UPDATED for a constitution a deploy wrote that differs (an older payload,
or a pointer lost or doubled), and the preserve-then-install arm for a repo's
own. Before, the pointer was appended only on the deploy that preserved the
file, and the next deploy copied the bare payload over it. A repo an earlier
deploy left without the pointer is repaired on its next deploy. Refusal
messages unchanged.

---

## R-022 — 2026-09-13 — The code index is listed for commit only when it differs apart from its build stamp (D-S031)

`commit_paths` (R-020) lists `governance/code-graph.json` only when the rebuilt
index differs from `git show HEAD:governance/code-graph.json` once
`provenance.built_at` and `provenance.built_at_epoch` are removed from both
(`src/nouns/harness/index-commit.ts`); an index with no committed version is
always listed. The index FORMAT is unchanged — `isStaleGraph` compares source
mtimes against `built_at_epoch`, so the stamp stays in the file and stale
detection is untouched. **Supersedes** R-020's "when the build changed it".
**Amended by D-S033 (same day):** `provenance.commit` and `provenance.dirty` are
ignored too — committing an index always moves HEAD past the commit it names, so
without this a redeploy after any commit still listed the index. Neither field
judges staleness; `built_at_epoch` stays in the file and `isStaleGraph` reads it.
**Amended by D-S034 (same day):** deploy does not rebuild the index when the
file on disk is the committed one (`HEAD:governance/code-graph.json`) and
`isStaleGraph` says it is fresh: it is reused (`REUSED`, `code-graph-built` ok),
nothing is written and nothing listed. A missing, uncommitted, modified,
unreadable or stale index is rebuilt and listed as above. Format and stale
detection unchanged. Four real deploy-and-commit cycles: 48 paths, then 0, 0, 0,
with a clean checkout after each; an in-place upgrade then listed exactly its two
UPDATED files and an app delivery merged cleanly. D-S035 accepts one extra index
listing on a first redeploy should a census change cause it.


---

## The second improvement-cycle rulings — R-023 …

Ratified by: User (2026-09-14; the scrumux super-repo decision log, D-S038 and
D-S039..D-S046), implemented by the Opus cycle-2 CLI agent. Evidence: super-repo
`reports/OBSERVATIONS-LOG.MD` § "Run 2", `ISSUES.MD` SX-019..SX-042, validations in
`reports/VALIDATIONS-REPORT.MD`. The principle is still D-S016: the CLI guides,
the app surfaces variance, new checks fail passively. Where a ruling touches a
wall, it makes an existing hard gate more precise and never adds a refusal;
every true positive the validators named stays refused and is pinned in
`test/unit/cycle2-walls.test.ts`.

---

## R-023 — 2026-09-14 — Three walls judge more precisely (SX-021, SX-023, SX-026 / D-S040)

**block-upstream-edit: a heredoc body ends at its terminator (SX-021).**
`scanCommand` scanned every token after any `<<` as heredoc body for the rest
of the command, so a harness path named in a later argument (`--verified
"(run via .claude/scripts/scrumux task verify T-0017)"` after a `--did
"$(cat <<'EOF' … EOF)"`) was refused as a write — and so was the `issue new`
reporting it. `src/walls/lib/heredoc.ts` reads each `<<`/`<<-` word (quoted,
double-quoted, escaped or bare) and closes the body on the line a shell closes
it on: the word alone, or after leading tabs for `<<-`. Bodies opened together
are read in order. A body line is still scanned in full (I-0121). A word it
cannot read keeps the old latch; an indented `<<` terminator or `EOF)` does
not close a body, because closing early would hand body text to the command
scanner. A here-string `<<<` opens no body.

**block-secret-reads: what a shell-level read licenses (SX-023).** A segment
whose only read is the shell's (`shellReads`, deliberately quote-blind) now
contributes only its input-redirect targets (`shellReadTargets`), not every
word — a doc placeholder `<app-root>/generated/<name>` in quoted prose used to
open the whole segment. `AMBIG_CMD`'s first alternation is anchored to a word
start, so `test_credentials.py` is not a credential file while
`credentials.json` and `my-credentials.yaml` still are. The refusal names
`.claude/scripts/scrumux secret list` for learning variable names.

**block-destructive: `<WORK_ROOT>/.scratch/` is temp space (D-S040, SX-026).**
`rmTargetsTemp` accepts an operand that resolves to `<WORK_ROOT>/.scratch` or
under it (`src/walls/lib/scratch.ts`), with WORK_ROOT from the env or two
levels up from the hook (the checkout or worktree whose `.claude/dist` runs
it) and relative operands resolved against the payload's `cwd`, moved by a
`cd DIR` segment; a `cd` it cannot follow refuses. String work only — no git
and no filesystem call. `harness deploy` appends `.scratch/` to the target's
`.gitignore` lane; the refusal names `.scratch/`. The PowerShell arm is
unchanged (still refuses), which is the safe direction.

---

## R-024 — 2026-09-14 — A decision without authority is recorded proposed, never refused (D-S039, SX-020)

**Recording never refuses.** `decide new` asks `authorityGuard` the question
the reserved acts ask and records the answer instead of enforcing it: with an
`--authority` that resolves, the entry is `status: "ratified"`, `authority`,
`ratified_by`, `recorded_by`; without one — or with one that does not
resolve — it is `status: "proposed"`, `authority: "none"`, `recorded_by`, no
`ratified_by`, and a non-empty unresolved value kept as `authority_claimed`.
A TELL on stderr says so (stdout stays the bare id). `exception resolve`
does the same in `resolution_status` (the finding's `status` is its own
lifecycle) — `src/journal/standing.ts` (`standingOf`).

**A person acts on it.** `decide ratify D-XXXX --by WHO --authority …`,
`decide reject D-XXXX --by WHO --reason …`, `decide acknowledge D-XXXX --by
WHO [--note …]`, and the same three verbs on `exception`
(`src/nouns/lib/standing-acts.ts`). Ratify refuses an authority that does not
resolve, and a decision citing itself; reject records why (and reopens an
exception); acknowledge keeps the standing and records who saw it. A rejected
record is not revived; a ratified-with-authority record changes only by a
successor.

**A proposed decision binds nothing.** It does not stamp `superseded_by` on
what it supersedes (ratify stamps it; rejecting a legacy successor removes
it), every reader ignores a non-binding `supersedes` (`bindingSupersedes`:
views, `status session`, `refResolve`), and `authorityGuard` refuses
`standing:D-XXXX` naming a proposed or rejected decision.

**Legacy reads as ratified, authority unknown — never bad.** A record with no
`status`/`resolution_status` renders exactly as before; `records check`
requires `ratified_by` for ratified or legacy, `recorded_by` for proposed,
`rejected_by` for rejected. `status session` prints `awaiting User:
proposed-decisions[…]` only when there are any.

**Guidance.** The payload's Authority section and `enforcement-posture.md`
name the four irreversible acts (ratify, accept, rule, decide) plus push;
session-review step 1 no longer tells a session to `decide new --by "User (in
session)"` — `--by` is the recorder, `--authority direct` only for what User
said directly, and a dispatched session's record lands proposed.
**Supersedes** the decision schema's `ratified_by` as a required field.

---

## R-025 — 2026-09-14 — Receipts compare content, acceptance is bounded and fingerprinted, a fixing task names its issue (SX-024, SX-027, SX-028, SX-029, SX-034, SX-036 / D-S041, SX-041 / D-S045)

**Receipt fresh compares content (SX-024).** `task verify` writes
`receipt.file_hashes` — sha256 of every covered file that exists — and
`session check` check 3 compares hashes: a differing hash, or a covered file
present now and not hashed, is a change; a moved mtime with identical bytes is
not (`src/nouns/session-fresh.ts`). A receipt with no hashes keeps the mtime
test, so nothing that passed turns red. A changed file on a task that is
ACCEPTED reports `WARN post-acceptance drift` (D-S018), never a FAIL of the
closing session; only a task awaiting acceptance FAILs.

**Run history before acceptance (SX-034).** Each pre-acceptance verify run is
appended to `receipt_history` (`{date, at_epoch, command, rc, checks_run,
checks_failed}`, newest last, 10 kept, `RECEIPT_HISTORY_KEEP`); `receipt`
stays the last run. Post-acceptance runs still go to `post_acceptance_checks`.

**The verdict an accepted task gets (SX-028).** `task verify` on an accepted
task ends "recorded as a post-acceptance check … no log entry or status change
is needed", or "recorded as post-acceptance DRIFT" when red — never the
pre-acceptance "log it, move it to in_review".

**Timeouts stop the process group; acceptance is bounded (SX-029).**
`runWithTimeout` runs `sh -c` under a small node supervisor that starts it
detached and, on timeout, sends SIGTERM to the whole group and SIGKILL after
5 s (`taskkill /t /f` on Windows); the exit-code contract is unchanged (142 on
timeout, 127, 128+N). `task accept`'s re-run goes through it with
`VERIFY_TIMEOUT_SECONDS` (600, the ceiling `task verify` gives an order's
command) and a timeout refuses in words (`src/nouns/task/accept-extras.ts`).

**Check fingerprint (D-S045, SX-041).** `task accept` records
`acceptance.check_fingerprint = {algo: "sha256", files: {path: hex}}` for the
path-shaped words of the verification command that exist in the repo, tried
under each directory the command works in; a directory hashes its sorted
regular files (dependency/VCS directories skipped, over 2000 files not hashed)
(`src/nouns/task/fingerprint.ts`). Absent on older acceptances: unknown.

**Issue link (D-S041, SX-036).** `task new --issue I-XXXX` stores `issue` on
the task. `task accept` TELLs "T-XXXX fixes I-XXXX — resolve it with scrumux
issue update I-XXXX --status resolved" and writes nothing to the issue;
`session check` WARNs `fixed issue open` while an accepted task's issue is
open or accepted.

**Lint path suffixes (SX-027).** A scope-prose token is listed when it equals
a listed path, sits under a directory the verify command works in (`cd X`,
`--directory X`, `-C X`, `--cwd X`), or is a `/`-bounded suffix of a listed
path (a bare file name only when exactly one listed path ends with it). The
TELL says to list a read path (`--file '<path> | read: …'`) and not to delete
it from the prose. `task order --ref` accepts `L-XXXX`, and `refResolve` reads
log entries (SX-037).

---

## R-026 — 2026-09-14 — The journals are read through the CLI, and the brief carries the forms that run (SX-025, SX-026 / D-S040, SX-030, SX-031, SX-032, SX-037, SX-038, SX-041 / D-S045)

**Find before filing (SX-025).** `issue list [--status open|accepted|resolved|
rejected|all] [--type T] [--task T-XXXX]` (default open) and `issue find TEXT
[same filters]` (default all statuses; case-insensitive over id, summary, fix,
task and files) are read-only; `--json` carries `data.issues: [{id, type,
status, severity, summary, resolution_pointer, task, files, created_at}]`
(`src/nouns/issue-read.ts`). `issue new` TELLs on stderr (and a
`possible duplicate` row under `--json`) when an open issue names one of its
files or shares at least 3 — and at least half — of its summary words; it
never refuses and stdout stays the id.

**Log entries are readable and carried (SX-037).** `log show L-XXXX [...]` and
`log show --task T-XXXX` print entries; `--json` carries `data.entries` (as
recorded) and `data.missing`. `task brief` inlines every `L-XXXX` its order
names — scope, fails_when, file whys and paths, refs — from the whole log,
each field capped at 600 characters (`src/nouns/task/brief-notes.ts`).

**Guidance that matches what runs (SX-030, SX-031, SX-032, SX-038, D-S040).**
The brief's MUST FAIL WHEN names the runnable forms (a test that sets the bad
value itself, `bash scripts/<wrapper>`) and the forms no allow rule matches
(`VAR=value cmd`, `env`, `export`, `bash -c`), and says to stop rather than
try variants. A "Working here" block names the root and `.claude/scripts/
scrumux` (never `../`), `.scratch/`, the T-0016 probing sequence as probing,
the snapshot-and-diff rule for nothing-remains checks and empty inputs, and
background processes at close. `task lint`'s READER names two more hollow
greens (enumerate-instead-of-diff, assertion over empty input). The canon
allow-list seeds `Bash(sh scripts/*)` and `Bash(bash scripts/*)` beside the
`tests/*` pair (additive union on deploy); `env *`, `export`, `bash -c *` and
`xargs` are never seeded. implement-sop, session-open, session-review and the
payload constitution carry the same text, plus: the journals are
`governance/*.json` under GOV_ROOT (the main checkout from a dispatched
worktree) and are read through `issue find/list` and `log show`; close only
after background processes have ended; a sprint that touches compose or a
Dockerfile plans a deployed check (D-S045).
