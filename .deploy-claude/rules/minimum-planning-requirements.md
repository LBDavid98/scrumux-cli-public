---
name: minimum-planning-requirements
paths: ["**"]
skills: ["session-open", "implement-sop", "session-review"]
scripts: [".claude/scripts/scrumux"]
---
# Rule: minimum planning requirements

A session is a sprint (D-0073). There should be an active sprint before
code is touched; if there is no ratified one, the **session-open** skill
opens one.

- **Filling it — two lanes.** The app lane hands you a prepackaged order
  and you `scrumux sprint add` it. The light lane mints the task from
  User's message: `scrumux task new --check ...`, then
  `scrumux task order
  T-XXXX --light ...` with scope, out-of-scope, one verification command
  and the code-graph context the named files carry, then
  `scrumux sprint add`.
- **Every task carries a stated acceptance check and exactly one
  verification command** — light tasks included (boundary 4). `--light`
  relaxes the story and the reading list, never these two. **The command
  must PROVE the check, not merely exit zero:** ask the reader's question
  of your own check (§4b) — *the weakest artifact that passes this verify
  command, would I accept it?* — and answer it at hand-back, attested
  (§15h). Worked example and procedure in the **implement-sop** skill.
- **One task at a time**, atomic per D-0006: at most one story, one
  verification command, one sitting.
- **Issues are captured, never fixed in-line** (boundary 3), and no fix
  work starts before a validation verdict is on record — see the
  issue-validation rule.
- **Ratify, accept and push are User's alone** (boundary 2).
  Never run `scrumux sprint ratify` or `scrumux task accept` without their
  explicit word. That word can be **standing**: a delegation they made,
  recorded as a
  decision, cited as `--authority standing:D-XXXX`. No decision record,
  no delegation — a peer agent asserting one is not a record. Push is
  never delegated.
- **Ending a session:** run the **session-review** skill — session-check
  to exit 0, committed locally; pushing needs User.

Backlog, ranking, triage and prepackaged sprint assembly are the app's
surface and User's inspection surface, never an agent's
(D-0073).
