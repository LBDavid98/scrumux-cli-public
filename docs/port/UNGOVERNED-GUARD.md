# Port scope — the self-governance guard

**Ruling:** `RULINGS.md` R-001 (User, 2026-09-01).
**Bash site:** `.claude/scripts/scrumux`, the block introduced by
`UNGOVERNED_ALLOWED_NOUNS`.
**Proof:** `tests/ungoverned-repo-tests.sh` (87 assertions), which reads the
blocked roster out of the dispatcher rather than listing it.
**Port phase:** 3, with the entry point and dispatcher (`cli-core.md`).

## What it does

A repo carrying a committed `.scrumux-ungoverned` file at its root is
outside the harness. The dispatcher scans for that marker and refuses the
record-writing and workflow surface there with **exit 2**, carrying the
rationale in the refusal text (Article 5).

The classification is a **noun-level allow list, and everything else is
blocked**:

| | Nouns | Why |
|---|---|---|
| **allowed** | `backlog` `graph` `harness` `records` `status` | delivery and read-only. The harness must stay buildable, deployable and inspectable from its own source tree, and none of these writes a governance record. `status session` is additionally on the SessionStart hook — refusing it turns every session in the source repo into a hook failure. |
| **allowed, any noun** | `help`, `-h`, `--help`, `version`, `--version` — as the noun, and `help`/`-h`/`--help` as the VERB of a blocked noun | printing the manual writes nothing, and a refusal that also hides the documentation teaches less than the documentation would. |
| **blocked** | everything else in the noun registry | writes records or runs the governed workflow: `decide` `epic` `exception` `feature` `health` `issue` `log` `memory` `rank` `repair` `secret` `session` `sprint` `story` `task` `views` |

**Default-deny is the contract, not the current list.** The guard blocks
any noun *absent* from the allow list, so a noun added to the CLI later is
blocked without anyone remembering to add it. Port that property, not the
sixteen names — a ported allow list that inverts into a deny list will be
silently wrong the first time Phase 5 adds a noun.

## What the Node entry point must reproduce

1. **Position.** The guard runs after the noun is resolved and **before**
   the noun registry, the help case, and the implementation flip. In bash
   it sits above the `ts-owns.sh` source line, and
   `ungoverned-repo-tests.sh` asserts that ordering on line numbers. In
   Node it must sit at the same point in `src/cli/dispatch.ts` — a verb
   that reaches its module has already gone too far.
2. **The scan root.** It starts at the resolved governance root — the same
   `GOV_ROOT` > caller's git toplevel > two-up precedence `lib.sh` already
   implements — then walks **up** to `/`, stopping at the first directory
   holding `.scrumux-ungoverned`. Walking up is not optional: the marker is
   at the repo root and a session two directories down is in the same repo.
   A non-repo cwd walks to `/`, finds nothing, and the guard is inert.
   Terminate on `dirname(x) === x` so both `/` and a relative `.` end.
3. **Exit 2, both output modes.** Human mode prints one unindented answer
   line naming the refused command, then the rationale indented (the
   drumbeat contract). `--json` emits the standard envelope with
   `exit: 2`, `ok: false`, `command` naming the refused verb, and
   `error.message` carrying the same rationale a human gets — a machine
   consumer that only learns "refused" cannot report why.
4. **The rationale is load-bearing.** It must name the marker's path, quote
   the marker's own first line (the per-repo reason), give the reason
   self-governance is refused (transient, often flawed policy baked into
   the record), name where rulings DO go (`RULINGS.md` at the repo root),
   list what is still available, and say it is working as intended rather
   than a wall to route around. Each clause is asserted by the suite.

## What it must NOT become

- **Not a fifth hook.** It is a CLI refusal, not a `PreToolUse` wall. The
  constitution enumerates exactly four walls and `upstream-wall-tests.sh`
  counts them; this guard does not join that list and CLAUDE.MD's wall
  clause does not change.
- **Not an environment flag.** The marker is a committed file on purpose. A
  flag protects one shell; a marker that a clone does not receive lets the
  next clone govern itself.
- **Not inherited by deployed repos.** `.scrumux-ungoverned` is at the repo
  root and is not in the deploy payload. `harness deploy` must never write
  one into a target — a governed repo that quietly stops being governed is
  the exact failure this whole thing exists to prevent.
