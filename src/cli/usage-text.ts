/**
 * The 21 noun usage blocks, verbatim. Article 5 — the error message is the
 * instruction set — makes these product surface held to the same review
 * standard as code, so they are kept byte-for-byte rather than paraphrased.
 * One table, read by `nounKnown`/`usageNoun` in `usage.ts` and by every noun
 * module's own `usage()`.
 */

/** noun -> the exact bytes `scrumux help <noun>` writes to stdout. */
export const NOUN_USAGE: Readonly<Record<string, string>> = {
  backlog: `scrumux backlog — open work in priority order.

  scrumux backlog tasks    [--full]
  scrumux backlog features [--full]

A number means a rank someone DECIDED. Work that has never been
prioritised is listed separately, without numbers, so an absent decision
can never read as a priority decision.

--full prints untruncated descriptions — the description is where the
ranking rationale lives.

Move an item: scrumux rank set <#|T-0001|F-0001> <new-#>
`,
  decide: `scrumux decide — record a decision; a person ratifies, rejects or acknowledges it.

  scrumux decide new --title T --decision TEXT --rationale TEXT --by WHO
                     [--authority direct|app:<session>|standing:D-XXXX]
                     [--scope repo|cross-repo] [--supersedes D-0001]
                     [--task T-0001] [--issue I-0001] [--push-hold <sha>]
  scrumux decide ratify D-0001 --by WHO --authority direct|app:<session>|standing:D-XXXX
  scrumux decide reject D-0001 --by WHO --reason TEXT
  scrumux decide acknowledge D-0001 --by WHO [--note TEXT]

\`new\` never refuses for authority (D-S039). With an --authority that
resolves, the decision is recorded status "ratified" with that authority.
Without one — or with one that does not resolve — it is recorded status
"proposed", authority "none": it binds nothing, retires nothing it
supersedes, and cannot be cited as standing:D-XXXX until a person ratifies
it. --by names who ran the command (recorded_by). Prints the new id.

An operator's message inside a session is not a ratification. Record what
you were told as a proposed decision and say so; the person acts in the app.

ratify, reject and acknowledge are a PERSON's acts (scrumux-app runs them
under the acting person's identity). ratify needs an authority that resolves;
reject records why and the decision binds nothing; acknowledge keeps a
proposed or authority-less record as it is and records who saw it. A record
written before D-S039 has no status and reads as ratified, authority unknown.

WRITING THE FREE TEXT. A decision is read by the session that is about to
undo it, so it carries the ruling and what was weighed. Real examples:

  --title      "Parallel dispatch admission: a per-sprint cap declared at
                planning"                                          (D-0084)
               The ruling, in one line. NOT "sprint changes".

  --decision   "A sprint carries parallel (integer >= 1, default 1), declared
                at scrumux sprint new --parallel N. The CLI admits a task to
                in_progress while the same RATIFIED sprint has fewer than
                parallel tasks in_progress ... The cap may be changed only
                while the sprint is proposed; changing it after ratification
                is a re-ratification, not an edit"                 (D-0084)
               The rule as it will be applied. NOT "we will allow parallel
               work" — every surface would invent its own version.

  --rationale  "Three shapes were put to User. A: a per-sprint cap declared
                at planning. B: per-worktree admission. C: the app is the
                gate. User ruled A ... B ties a governance rule to a git
                detail no journal models; C would leave a hand-driven session
                ungated entirely"                                  (D-0084)
               What was weighed, including the REJECTED options and what was
               wrong with each. That is the part a later session needs.
`,
  epic: `scrumux epic — epics.

  scrumux epic new --name N --desc TEXT [--feature F-0001]...
  scrumux epic update E-0001 [--add-feature F-0001]... [--remove-feature F-0001]...

WRITING THE FREE TEXT. Real examples from this repo:

  --name  "Self-knowledge: the harness sees its own code and its own
           governance"                                             (E-0005)
          The destination, said as a claim. NOT "Improvements".

  --desc  "The harness stands alone: it installs into any repo, proves it is
           live there, refuses only what is dangerous, runs its gates in
           seconds, and records enough about its own behaviour that the next
           round of priorities comes from data. Everything in this epic comes
           from the deep-dive review of 2026-08-20 and D-0058..D-0061"
                                                                   (E-0006)
          What changes when it lands, and where the scope came from — so a
          later reader can tell what belongs in it. NOT "various fixes".
`,
  exception: `scrumux exception — process findings on a session, NOT code discoveries.

  scrumux exception new --lens NAME --ref WHAT --finding TEXT
                        [--severity red|yellow]
                        [--disposition accept_and_track|requires_ratification|
                                       correct_the_record|reject_the_task]
                        [--source WHO] [--session ID] [--task T-0001]
                        [--sprint SP-0001] [--rule ID]
  scrumux exception resolve X-0001 --status tracked|ratified|corrected|
                        rejected|withdrawn --by WHO [--note TEXT]
                        [--authority direct|app:<session>|standing:D-XXXX]
  scrumux exception list
  scrumux exception ratify X-0001 --by WHO --authority direct|app:<session>|standing:D-XXXX
  scrumux exception reject X-0001 --by WHO --reason TEXT
  scrumux exception acknowledge X-0001 --by WHO [--note TEXT]

A resolution without an --authority that resolves is recorded
resolution_status "proposed" (D-S039) and listed until a person ratifies,
rejects (which reopens the finding) or acknowledges it.

An ISSUE is a code-level discovery: the schema is wrong, the gateway needs
another parameter, I am blocked by Y. An EXCEPTION is a finding about whether
the WORK FOLLOWED THE RULES — did the agent use the skills, did the scripts
run, were exceptions raised to it, did it act on them, did the actions
translate to resolution. Do not file one as the other.

Two exceptions, so the line has anchors and not only a definition (User,
2026-08-27):
  - a session CLOSED with a bad lint report
  - a tool call that VIOLATED a pre-tool hook check
Both are about how the work went, not about what the code is. A defect you
found in a file is an issue however serious it is.

A REVIEWER IS NEVER A BLOCKER. --disposition is a recommendation and defaults
to accept_and_track; nothing here moves a task, ratifies a sprint or corrects a
record. \`resolve\` records what a PERSON did — it does not do it.

correct_the_record means a bounded mechanical repair that must not require an
LLM call. Whatever performs it does so through its own verb, with its own
authority, and this journal records that it happened.

WRITING THE FREE TEXT. The person who decides was not in the session, so a
finding carries what happened AND what is still unproven. Real examples:

  --lens     "Repo standards" (X-0001), "scripts_run" (X-0002) — the question
             the reviewer was asking. NOT "review": it groups nothing.

  --ref      "harness .claude/scripts/lib/cmd-records.sh:264"      (X-0001)
             The exact thing, with a line number where there is one.
             NOT "the CLI" — nobody can open it.

  --finding  "Running records check through the control plane appended
              'printf: write error: Broken pipe' to the output the app
              displayed. The cause is believed to be grep -q closing the pipe
              under printf ... Eleven call sites were hardened and 497
              harness tests stay green, but the symptom was NOT reproduced in
              eight attempts, so the fix is not confirmed to address it"
                                                                  (X-0001)
             What happened, what is believed to explain it, what is still
             unproven. NOT "the session did not follow the rules".

  --note     on resolve: what the PERSON did and on what basis, since resolve
             records an act it did not perform. "Tracked against T-0219; the
             repro is the deliverable before any further hardening."
`,
  feature: `scrumux feature — one verb, \`new\`.

  scrumux feature new --name N --desc TEXT [--dep F-0001]...

Prints the new id.

WRITING THE FREE TEXT. Real examples from this repo:

  --name  "Gate integrity" (F-0009), "Deployability" (F-0013) — the
          capability, in two or three words. NOT "Phase 2 improvements".

  --desc  "No gate reports a pass it did not earn. The four cross-script
           dependencies fail closed instead of open; the destructive-command
           attestation leaves a record; the issue source field is a
           constrained enum so drift data has a reliable who-raised-this
           dimension"                                              (F-0009)
          What it makes possible and how you can tell. NOT "makes deploys
          better" — no mechanism, and no story can be written against it.
`,
  graph: `scrumux graph — the two derived graphs. No LLM in either path (D-0001):
both are repo fact, and a fact a model guessed at is not a fact.

  scrumux graph code build [--repo <path>]   (re)build the code index
  scrumux graph code index                   the freshness check
  scrumux graph code callers <id>            who calls this symbol or file
  scrumux graph code callees <id>            what this calls
  scrumux graph code symbols <file>          symbols defined in a file
  scrumux graph code find <name>             symbol ids matching a bare name
  scrumux graph code near <id> [n]           within n call-hops, both ways
  scrumux graph code stats                   counts, coverage, provenance

  scrumux graph gov build                    (re)build the governance index
  scrumux graph gov index                    exit 0 if current, rebuild if stale
  scrumux graph gov provenance <id>          what bears on a task, both directions
  scrumux graph gov inbound|outbound <id>    records pointing at / pointed at
  scrumux graph gov impact <id> [n]          what changing this touches
  scrumux graph gov orphans [kind]           records nothing points at
  scrumux graph gov dangling                 refs naming a record that is gone
  scrumux graph gov stats                    node and edge counts by kind
  scrumux graph gov bearing [--task T-0001] [--file <path>] [<path>...]
                                             the decisions and issues that
                                             BIND a file set (T-0153)

READER / BUILDER. Every \`graph code\` query answers from
governance/code-graph.json with NO tree-sitter and NO rebuild, stamped
with the commit it was built from and how far behind HEAD that is now.
Only \`build\` needs the grammars, it takes an explicit --repo, and
\`scrumux harness deploy\` runs it into every target it installs — so a
deployed repo has a working code graph without ever carrying a parser.

Nothing here depends on the scrumux-app. The app is one more optional
refresher and reader of the same on-disk file.

LANGUAGE-AGNOSTIC. The grammar set is a registry in
src/nouns/graph/code-build.ts, not a branch. A file whose language has no
installed grammar is COUNTED AND NAMED by \`stats\` and by \`build\` — never
skipped in silence, because a silently skipped file looks exactly like a
file with nothing in it.

A code symbol id is "<path>::<name>"; a code file id is the repo-relative
path. A governance id is a record id.
`,
  harness: `scrumux harness — install the machinery into a repo, and prove it is
installed there.

  scrumux harness deploy <target> [--json]
  scrumux harness verify <target> [--json]

deploy reports every item as CREATED, UPDATED, UNCHANGED, REMOVED or
KEPT by byte comparison (never timestamp) and fails if \`records check\`
does not come back clean against the target. It prunes payload files a
previous manifest claims and this one no longer ships, so a rename cannot
leave a stale runnable command behind — but never a file it SEEDS for the
repo to own, which is reported KEPT and dropped from the new manifest.

verify answers the one question a session cannot answer about itself: is
.claude/settings.json at the repo ROOT, where Claude Code resolved it at
launch? Anywhere else it is silently inert, and every hook chain in it is
dead while the repo looks entirely normal from the inside.

verify also EXECUTES every command surface it ships. Checks about files
can only confirm the copy happened; I-0104 is what that costs.

INSTALLED IS NOT LIVE. Every check is about the TARGET; whether a session
is governed by what is installed there is decided by the project root that
session was LAUNCHED with, and no command running inside it can change
that. When $CLAUDE_PROJECT_DIR names a different repo, verify says so in a
session-topology WARN — advisory, never part of the exit code.
`,
  health: `scrumux health — one verb, \`add\`.

  scrumux health add --name N --command CMD
                     [--type build|test|run|lint|other] [--timeout SECONDS]

Registers a repo-health check. The command runs from the repo root and
exit 0 means healthy. A \`lint\`-typed check that goes red is a TELL and
never fails a run (D-0072 boundary 7).

A CHECK IS KEYED BY ITS NAME. Adding a name that is already registered
REPLACES that entry and prints old -> new, so a typo in --command is
corrected by re-running \`add\` with the same --name. There is no \`remove\`
verb: nothing on this noun deletes a row, so a name that already sits on
two entries keeps both — the first is replaced and the stray is named.
`,
  issue: `scrumux issue — defects, drift, harness problems and ideas.

  scrumux issue new --type defect|harness --source WHO
                    (drift|idea|governance: User/human only)
                    --summary TEXT --fix TEXT
                    [--severity low|medium|high|critical]
                    [--task T-0001] [--file PATH]... [--waives T-0001]...
  scrumux issue update I-0001 [--status open|accepted|resolved|rejected]
                    [--severity low|medium|high|critical] [--task T-0001]
                    [--fix TEXT] [--waives T-0001]...
  scrumux issue validate I-0001
                    --verdict reproduced|evidenced|invalidated|duplicate
                    --evidence TEXT [--repro-cmd CMD] [--by WHO]
                    [--duplicate-of I-0001|T-0001] [--revalidate]
  scrumux issue authorize I-0001 --by WHO [--note TEXT]
  scrumux issue list [--status open|accepted|resolved|rejected|all]
                    [--type TYPE] [--task T-0001]
  scrumux issue find TEXT [--status ...] [--type TYPE] [--task T-0001]

Before filing, look: \`issue find 'receipt fresh'\` searches ids, summaries,
fix text, tasks and files (all statuses); \`issue list\` shows open issues.
The journal is governance/issues.json under GOV_ROOT — in a dispatched
worktree that is the main checkout, not the worktree's stale copy — so read
it through these verbs. \`issue new\` TELLs (never refuses) when an open
issue names the same file or most of the same summary words.

A verdict is write-once: both promotion gates read it, so a second
validate REFUSES rather than erasing the first validator's evidence.
--revalidate supersedes one deliberately and keeps the prior verdict in
.validation_history.

--waives names the task this issue is a knowing exception to; it must
resolve, so a waiver can never be anonymous. Hotfix promotion needs
validation OR authorization, and authorization never counts as
validation (I-0010).

WRITING THE FREE TEXT. A report is read by a validator who was not there.
Real examples from this repo, in the shape to copy:

  --summary   "harness deploy seeds no .gitignore lines for the views scrumux
               writes, so running a report dirties a deployed repo's tree.
               Repro: deploy into a git repo, commit, run scrumux views
               render, git status shows four untracked generated files"
                                                                    (I-0153)
              NOT "deploy is broken" — no site, no repro, nothing to confirm
              or refute.

  --fix       "deploy appends the ignore lines for exactly what views render
               writes into the target's .gitignore, once: append-only and
               append-if-absent, so a second deploy adds nothing"   (I-0153)
              It BOUNDS the work. NOT "fix it" / "investigate".

  --evidence  "cmd-session.sh:146 tests for a .git DIRECTORY; inside a
               worktree .git is a file, so the stray scan is silently skipped"
              Reproduced, or the line that makes it true. NOT "confirmed".
`,
  log: `scrumux log — the append-only work log.

  scrumux log new --title T --did TEXT [--task T-0001] [--verified TEXT]
                  [--pending TEXT]... [--actor NAME]
  scrumux log show L-0001 [L-0002]...
  scrumux log show --task T-0001

\`new\` appends one entry and prints the new id. \`show\` reads entries by id,
or every entry logged under a task — an order that cites L-XXXX means that
entry; \`scrumux task brief\` inlines the ones its order cites.

WRITING THE FREE TEXT. The log is the receipt a cold session reads, so it
carries evidence rather than narrative. Real examples from this repo:

  --title     "The prune stopped eating the two files deploy promises never
               to overwrite (I-0152, I-0153)"                       (L-0285)
              NOT "fixed hook" — names neither the hook nor what changed.

  --did       "harness deploy's seeding lane creates project-standards.md and
               project-walls.conf create-if-absent; the I-0143 prune then
               removed any path the previous manifest names that payload.list
               lacks. Fixed by writing each seeded path into seeded.list and
               skipping it in the prune. sh tests/harness-tests.sh rc=0;
               3 files changed, 61 insertions"                      (L-0285)
              The verify command and its rc, the diffstat, every refusal hit
              and what was done about it. NOT "created X, verified Y".

  --verified  "Planted first: 11 new assertions in tests/harness-tests.sh
               shown FAILING against 444dfd1 in a detached worktree,
               including 'deploy DESTROYED .claude/rules/project-standards.md
               because a previous manifest claimed it'. After the fix:
               harness-tests exits 0"                               (L-0285)
              The EVIDENCE block verbatim. A check planted before it passed
              is worth more than one that was green from the start.

  --pending   "seals.json is a record records-check reads and is correctly
               left out, so the first views render on a never-sealed target
               still leaves that one file untracked"
              What is knowingly not done, and why it is safe to leave.
`,
  memory: `scrumux memory — one verb, \`add\`.

  scrumux memory add --by WHO [--file PATH]

Appends a read-only agent's memory block to governance/validator-memory.md,
creating that file with its header on first use. Reads stdin when --file
is absent. The agent cannot write it itself — that is the point of it
being read-only — so scrumux does.

Append-only: nothing already in the file is ever rewritten. A file that
EXISTS and is empty has lost its header and is refused rather than
recreated — restore it from git, or delete it and run this again.
`,
  rank: `scrumux rank — backlog priority. A rank means someone DECIDED this
priority; an absent rank is not a low priority, it is no decision.

  scrumux rank set <#|T-0001|F-0001> <new-#>
  scrumux rank clear <#|T-0001|F-0001>

An F-XXXX ranks a FEATURE, in its own list: scrumux backlog features
Current numbering: scrumux backlog tasks
`,
  records: `scrumux records — the repo validator.

  scrumux records check                    the governance sweep (default)
  scrumux records check --structure        the same, named explicitly
  scrumux records check --standards [dir]  the mechanical D-0012 corpus rules
  scrumux records check --all              both, structure first

Exit 0 clean, 1 with one instructive line per finding, 2 if it could not
run. WARNings never affect the exit code.

--standards is silent where no matching code exists, so language-agnostic
and non-code trees stay clean. A repo's own standards live in
.claude/rules/project-standards.md, and anything mechanical about them is
registered with \`scrumux health add\`. That is the one extension pathway
for this layer.

There is no --porcelain. --json carries every finding as a row with its
own tier, name and fix; a second machine format for one finding set is
the drift this validator exists to catch.
`,
  repair: `scrumux repair — the one sanctioned correction with no other scrumux path.

  scrumux repair journal <name.json> --apply '<jq>' --why TEXT --by WHO

The write and its log entry are ONE operation, so the record cannot be
forgotten (T-0100), and the journal is resealed so the edit is not
reported as tampering afterwards.
`,
  secret: `scrumux secret — credentials for this repo's own code, stored never printed.

  printf %s '<value>' | scrumux secret set NAME
  scrumux secret set NAME VALUE       (discouraged — see below)
  scrumux secret list
  scrumux secret remove NAME

VALUE as an argument lands in shell history, in the agent transcript and
in the JSON every PreToolUse hook receives, so pipe it on stdin instead.

.env is gitignored BEFORE the value is written, chmod 600, and the write
is refused outright if git already tracks it.

There is no \`scrumux secret get\`. Nothing prints a value back.
`,
  session: `scrumux session — the session close.

  scrumux session check

Exit 1 if any check FAILS. WARNs print and never change the exit code.

The six checks are the ways a green receipt can lie, plus the two
irreversible states:
  1. every task claiming done carries a receipt
  2. the receipt ran the command the order names
  3. the receipt is newer than the last edit it covers
  4. the receipt actually ran something
  5. no secret-shaped file in the working tree
  6. nothing left in_progress

Sprint discipline and live stubs print as WARNs: worth seeing, not worth
stopping for.
`,
  sprint: `scrumux sprint — sprints.

  scrumux sprint new --epic E-0001 [--parallel N] | --hotfix --issue I-0001
  scrumux sprint add SP-0001 T-0001
  scrumux sprint update SP-0001 --parallel N
  scrumux sprint descope SP-0001 T-0001 --reason TEXT
  scrumux sprint ratify SP-0001 --by WHO --authority direct|app:<session>|standing:D-0001
  scrumux sprint status SP-0001 complete|abandoned

--parallel N (default 1) is how many of this sprint's tasks may be
in_progress at once (D-0084). It is declared at planning because the sprint
is what User ratifies, and it can be changed only while the sprint is still
\`proposed\` -- changing it afterwards is a re-ratification, not an edit.

Ratification is User's alone. A task with log entries is
refused by descope: it was worked, and descoping does not erase that —
retire it with \`scrumux task status <id> superseded --reason ...\` instead.

A SPRINT CARRIES NO OBJECTIVE FIELD, and that is deliberate: what this
sprint is FOR is the epic's description plus the titles and acceptance
checks of the tasks in it. So the objective is only ever as clear as those
are — see \`scrumux help task\` for the shape a title and a check take here.

WRITING THE FREE TEXT. The one prose field on this noun:

  descope --reason  "I-0112's read-side self-heal on staleness is a NEW
                     capability and the freeze holds; the issue stays
                     documented and nothing here depends on it landing this
                     sprint"
                    What changed, and where the work went. NOT "out of
                    scope" — the plan already said what was in scope, so
                    that only restates the act.
`,
  status: `scrumux status — journal reports.

  scrumux status session     orientation block; ALWAYS exits 0
  scrumux status planning    sprint report + decision queue + validation sweep
  scrumux status sprint      the sprint report alone
  scrumux status sweep       the validation sweep alone

\`session\` is wired to the SessionStart hook and answers "where do we pick
up?" from the journals and git alone — never from chat memory. It cannot
exit nonzero: a failure to brief would be a failure to start work.

\`sprint\` and \`planning\` are User-inspection surface (D-0073). Nothing in
an agent's path gates on either. T-0144 retired the exit-3 hard stop: an
unfinished ratified sprint prints a TELL, and whether to plan alongside it
is User's call, not a script's.
`,
  story: `scrumux story — one verb, \`new\`.

  scrumux story new --feature F-0001 --narrative TEXT
                    --criterion TEXT [--criterion TEXT]...

At least one --criterion is required (acceptance_criteria, minItems 1).
Prints the new id.

WRITING THE FREE TEXT. Real examples from this repo:

  --narrative  "As User, I accept a task directly — my documented approval
                is the review — and acceptance refuses any task whose verify
                receipt is red, so a false close cannot recur"      (S-0069)
               "As the <specific who>, I <do what> so that <outcome>". The
               who is named. NOT "As a user, I want acceptance to work".

  --criterion  "scrumux accept T-XXXX --authority refuses a red or missing
                receipt and is write-once"                          (S-0069)
               "harness verify executes every registered surface"   (S-0070)
               One observable behaviour each, confirmable by looking at the
               running thing or its record. A criterion with "and" in it is
               usually two. NOT "acceptance is reliable".
`,
  task: `scrumux task — the work items, from new through accepted.

  scrumux task new    --title T --check "acceptance check"
                      [--feature F-0001] [--story S-0001] [--desc TEXT]
                      [--issue I-0001]
  scrumux task order  T-0001 --scope TEXT --verify CMD [--story S-0001] [--light]
                      [--fails-when TEXT]
                      [--out TEXT]... --file "path | why [| expected diff]"
                      [--ref D-0001]... [--command CMD]... [--interface TEXT]...
                      [--shape TEXT]... [--artifact PATH]...
  scrumux task status T-0001 proposed|ready|in_progress|in_review|blocked|accepted|superseded
                      (superseded needs --reason TEXT, optionally --by T-0002;
                       blocked takes an optional --reason TEXT: what it waits on)
  scrumux task update T-0001 [--feature F-0001] [--story S-0001] [--title TEXT]
  scrumux task lint   T-0001 [T-0002 ...] | --feature F-0001 [--hotfix]
  scrumux task brief  T-0001 [--allow-unsprinted]
  scrumux task verify T-0001
  scrumux task accept T-0001 --by WHO --authority direct|standing:D-0001
  scrumux task reject T-0001 --by WHO --reason TEXT

task order REPLACES the order rather than amending it: every flag left
off is a field emptied, and omitting --artifact drops the key entirely.
Restate the whole order each time; scrumux task brief T-0001 reads back
what it currently carries.

--artifact names a file the task must PRODUCE; --file names one it reads
or changes, and \`scrumux graph gov bearing\` reads the split.

WRITING THE FREE TEXT. These fields are what a cold session reads a week
from now, so they are written for that reader. Real examples from this
repo, in the shape to copy:

  --title   "The close is not blocked by bytecode"                (T-0217)
            "The graph does not crash on a repo it has never seen" (T-0213)
            NOT "fix session-check" — a file and a verb, and nothing about
            what was wrong or how anyone would know it stopped being wrong.

  --check   "A tree containing __pycache__ or .pyc files closes session-check
             exit 0 when everything else traces to a worked task, an
             unauthorised source file still FAILs by name, and
             tests/session-check-tests.sh exits 0"                (T-0217)
            NOT "works" / "tests pass" — neither says what would have to be
            false for the check to fail.

  --scope   "Add build and OS artefacts to session-check's scope exemption at
             :202, alongside governance/*, *.MD and .claude/*. Reproduced in
             canon acceptance run 4 — the close FAILed on
             agents/__pycache__/*.pyc"                            (T-0217)

  --verify  "sh tests/session-check-tests.sh"                     (T-0217)
            ONE command, stating how to run it. A bare tests/*.sh path exits
            126 on the 27 suites that are mode 644 (D-0041).

  --fails-when "the vault is unreachable, or the probe gets a 404 instead of
             the folder listing"
            The broken state the verify command must catch. A check that
            skips, cannot fail, or writes into real shared data is green and
            proves nothing; saying what must turn it red is how a reviewer
            (and the app, at acceptance) tells the difference.

  --out     "Any other exemption. Only build and OS artefacts — a file an
             agent wrote is still a file an order must own"       (T-0217)

  --file    ".claude/scripts/session-check | :202, the exemption case"
            "agents/lib/governance_graph.py | the writer I-0111 traces to"
            The why is what to look FOR in that file, never what the file is.

--light marks an order minted from User's message rather than
prepackaged: lint drops its story and context-files findings to TELL, and
\`sprint add\` takes it storyless. The acceptance check and the ONE
verification command are required in both lanes (D-0072 boundary 4).

Acceptance is final authority's alone and is write-once. It refuses a
missing or red receipt, and it RE-RUNS the order's verification command
rather than reading the receipt: a receipt records what happened when the
agent ran it, and cannot record whether the command still proves what the
order asked.

Exit: 0 the assertion held, 1 it did not, 2 the command could not run.
`,
  views: `scrumux views — the generated MD views of the journals.

  scrumux views render

AI_LOG.MD, DECISIONS.MD and BACKLOG.MD are GENERATED. The sources of
truth are the JSON journals under governance/ (D-0002); the MD files are
projections and are never hand-edited.

Rendering also rebuilds governance/governance-graph.json, which is a
generated view of the same journals (I-0063). T-0187 took this OFF the
write path — every gov write was re-rendering three files and rebuilding
the whole graph, ~0.15s of a ~0.19s write, for views nobody reads
mid-session — so it happens on demand and at the session close.
`,
};

/** The registry line for each noun: the one-line summary in the noun table. */
export const NOUN_SUMMARY: ReadonlyArray<readonly [string, string]> = [
  ['backlog', "open work in priority order, tasks or features"],
  ['decide', "ratified decisions"],
  ['epic', "epics"],
  ['exception', "process findings on a session, never code discoveries"],
  ['feature', "features"],
  ['graph', "the two derived graphs: code (what calls what) and gov (the journals)"],
  ['harness', "install the machinery into a repo, and prove it is installed there"],
  ['health', "this repo's registered health checks"],
  ['issue', "defects, drift, harness problems and ideas"],
  ['log', "the append-only work log"],
  ['memory', "a read-only agent's memory block"],
  ['rank', "backlog priority"],
  ['records', "the repo validator: journal schemas, refs, rule chains, rosters"],
  ['repair', "a bounded correction with no other scrumux path"],
  ['secret', "credentials for this repo's own code, stored never printed"],
  ['session', "the session close"],
  ['sprint', "sprints"],
  ['status', "journal reports: session, planning, sprint, sweep"],
  ['story', "user stories"],
  ['task', "the work items, from new through accepted"],
  ['views', "regenerate the MD views from the journals"],
];
