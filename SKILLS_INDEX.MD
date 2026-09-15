# SKILLS_INDEX.MD

In-repo skills (`.deploy-claude/skills/`), in lifecycle order:

Every skill drives a deterministic script (D-0010) — the script's exit
code decides; the skill interprets.

| Skill | Script it drives | When | What it does |
|---|---|---|---|
| `session-start` | `scrumux status session` (auto-injected by SessionStart hook on startup/resume; never on in-process subagents) | Session open, after /clear, "where do we pick up?" | Deterministic orientation from journals + git; routes to the right skill |
| `session-open` | `scrumux sprint new` / `scrumux task order --light` / `scrumux sprint add` | No ratified sprint, or User asks to start work | A session IS a sprint (D-0073): open a thin one, fill it from app-packaged orders or light tasks minted from User's messages, attach graph context at mint; User ratifies |
| `implement-sop` | `scrumux task brief` (gates + graph context, exit 2 = don't start) + `scrumux task verify` (writes the receipt, exit = verdict) | Implementing any sprint task | Scope-bound implementation, docs, after-tests, and a close that logs receipts — verify output, diffstat, refusals — not narration |
| `session-review` | `scrumux session check` (loop to exit 0, then commit) | End of every session | The six-check close — receipt present, green, fresh, matching, ran something, nothing mid-flight; local commit; push only on User's word |
| `source-implement` **(source-only)** | `tools/parity-suites.sh --impl bash\|flip` + `npm test` (no scrumux verb — they are refused in this repo) | Implementing any change HERE, in the repo that builds scrumux | Understand before editing, match the house style, name the command that PROVES the change (weakest artifact that passes it — would I accept it?), run the suites, keep `/docs` true, commit locally, never push. Listed in `.claude/payload-exclude.list` and never deployed; a governed repo gets `implement-sop` |

Supporting machinery — every file in `.deploy-claude/scripts/` (T-0142; the
roster is checked against disk by `scrumux records check` section 10, so a script
added without a row here fails the sweep):

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

- **`graph code`** — "what calls what", by query instead of by search
  (D-0009). `scrumux graph code build`, `index`, `callers`, `callees`, `symbols`,
  `find`, `near`, `stats`, over symbol ids of the form `<path>::<name>`
  (a file id is the repo-relative path). `scrumux graph code callers <path>::<name>`
  feeds the task-breakdown context pack's blast-radius reading.
- **`graph gov`** — the journals traversed as a graph. `scrumux graph gov build`,
  `index`, `provenance`, `inbound`, `outbound`, `impact`, `orphans`,
  `dangling`, `stats`, `bearing`, over record ids (T-/S-/F-/D-/I-/E-/C-).
  `scrumux graph gov bearing [--file] <path>...` answers "which decisions bear on
  these files" — the question a task order used to answer only by the
  order-writer remembering (T-0153). `--file` is a synonym for a bare
  path; any other flag is refused rather than read as a filename (I-0118).
  `scrumux graph gov provenance T-XXXX` is the fastest route to a task's refs.
- **`debugger`** (`.deploy-claude/agents/debugger.md`) — read-only failure
  investigator; dispatch on non-obvious failures, implement its fix yourself.
- Both graph `index` commands self-heal: a stale index rebuilds and exits 0,
  failing only when the rebuild cannot be done (D-0043) — never treat a stale
  graph as a blocker. Since T-0152 every `graph code` QUERY self-heals too.
- Since T-0149 a single `scrumux` symlinked onto PATH works from any subdirectory
  of a managed repo: the scripts resolve `$0` through symlinks, and ROOT comes
  from the caller's git toplevel rather than from where the file sits.

Cross-repo skills the rules point to (user-level, not in this repo):
`get-llm-key`, `pick-llm-model`, `submit-llm-change-request`,
`check-llm-gateway` — see `.deploy-claude/rules/no-direct-llm-calls.md`.
