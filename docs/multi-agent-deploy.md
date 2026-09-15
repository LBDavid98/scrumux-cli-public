# Deploying the harness to Cursor and GitHub Copilot — design, not yet built

**Status: NOT IMPLEMENTED.** `harness deploy` installs `.claude/` only. This
file is the research and the design behind adding Cursor and Copilot targets,
written 2026-09-03 so the work is not re-derived from scratch. A tech-debt
sweep that finds this file should raise it as outstanding work, not as drift.

## The goal

`harness deploy` installs the harness into a target repo as `.claude/`. It
should also be able to install the equivalent governance for **Cursor** and
**GitHub Copilot** agents. Claude stays the default. Where a piece of the
harness cannot map to a tool, the gap is stated in `README.MD` rather than
faked.

## What was verified (2026-09-03, primary sources)

These tools move fast — re-check before building, especially anything marked
Preview.

**Cursor reads Claude Code's config natively.**

- Hooks: loads `.claude/settings.local.json`, `.claude/settings.json`,
  `~/.claude/settings.json`. Maps `PreToolUse`→`preToolUse`,
  `SessionStart`→`sessionStart`, and tool names `Bash`→`Shell`,
  `Write`/`Edit`→`Write`, `Read`→`Read`, `Task`→`Task`. **Exit 2 = deny.**
  Gated behind Settings → Rules, Skills, Subagents → "Include third-party
  Plugins, Skills, and other configs".
  <https://cursor.com/docs/reference/third-party-hooks>
- Subagents: loads `.claude/agents/` (project + user); `.cursor/agents/` wins
  on a name conflict. Frontmatter is `name, description, model, readonly,
  is_background` — **no `tools` field.** <https://cursor.com/docs/subagents>
- Skills: loads `.claude/skills/`. <https://cursor.com/docs/skills>
- Native hook config is `.cursor/hooks.json`:
  `{version:1, hooks:{preToolUse:[{command, matcher, timeout, failClosed}]}}`.
  `preToolUse` input `{tool_name, tool_input, tool_use_id, cwd}`; output
  `{permission:"allow"|"deny", user_message, agent_message, updated_input}`.
  <https://cursor.com/docs/hooks>

**GitHub Copilot.**

- Hook config: `.github/hooks/*.json` (repo — **must be on the default branch**
  for the cloud agent), `~/.copilot/hooks/*.json`, inline in
  `.github/copilot/settings.json`, plus machine policy dirs. Schema
  `{version:1, hooks:{...}}`. Accepts PascalCase `PreToolUse` with a
  Claude-shaped payload: `{hook_event_name, session_id, cwd, tool_name
  (Claude-mapped, e.g. "Bash"), tool_input}`. Output `{permissionDecision,
  permissionDecisionReason, modifiedArgs}`. **Exit 2 = deny; other non-zero
  also fails closed for `preToolUse`; timeout always fails OPEN (30s
  default).** <https://docs.github.com/en/copilot/reference/hooks-reference>
- Copilot CLI reads `CLAUDE.md` directly, alongside
  `.github/copilot-instructions.md` and `.github/instructions/**/*.instructions.md`.
  **No defined precedence between them** — contents are merged.
- Skills load from `.github/skills`, **`.claude/skills`**, `.agents/skills`.
  <https://docs.github.com/en/copilot/concepts/agents/about-agent-skills>
- VS Code Copilot hooks are **Preview** ("configuration format and behavior
  might change"); they read `.github/hooks/*.json` **and `.claude/settings.json`**,
  PascalCase events, exit 2 = block.
  <https://code.visualstudio.com/docs/agent-customization/hooks>
- Custom agents are `.github/agents/*.md`, frontmatter `name, description,
  tools, model, handoffs`. **No evidence Copilot reads `.claude/agents`.**

**Not verified, and only settleable by probing** (all four CLIs — `cursor`,
`cursor-agent`, `copilot`, `gh` — are installed on the dev box, so this is
cheap when someone picks it up):

- Whether Cursor's mapped `tool_input` preserves the `command` / `file_path`
  keys the walls read. If it does not, **the walls load and silently never
  match** — enforcement that looks present and is not.
- Whether the harness's matcher strings (`Bash|PowerShell`,
  `Edit|Write|NotebookEdit`) are matched against Claude or Cursor tool names.
- Whether Cursor's third-party hook loading works at all — there are open
  forum reports claiming `.claude/settings.json` hooks never load.
- Cursor CLI (`cursor-agent`) hook support is not covered in the docs.

## Mapping

| Payload piece | Cursor | Copilot |
|---|---|---|
| Root `CLAUDE.md` | Loaded via the third-party toggle (unreliable) — add `.cursor/rules/scrumux.mdc`, `alwaysApply:true`, pointing at it | CLI reads it natively; add a `.github/copilot-instructions.md` pointer for VS Code / cloud |
| `.claude/rules/*.md` | No native equivalent either side — they are reached by prose from the constitution, so they **ship unchanged, zero port** | same |
| `.claude/skills/*/SKILL.md` | Read from `.claude/skills` natively | Read from `.claude/skills` natively |
| `.claude/agents/*.md` | Read from `.claude/agents` natively, but `tools:` is ignored — the D-0007 read-only guarantee needs `readonly: true` | **No equivalent path.** Must generate `.github/agents/*.md` |
| The four PreToolUse walls | Mapped from `.claude/settings.json`; safer to also emit `.cursor/hooks.json` | Generate `.github/hooks/scrumux.json` (CLI + cloud); VS Code reads `.claude/settings.json` |
| SessionStart guard | `sessionStart` is mapped — **but not supported on Cursor cloud agents** | `sessionStart` supported (new sessions only) |
| `schemas/`, `scripts/scrumux`, `dist/`, `governance/*.json` | Tool-agnostic, ship as-is | same |

## Design: canonical `.claude/`, generated pointers

Keep `.claude/` as the single installed payload for every target, and emit only
small generated adapter files, each hashed into `.claude/DEPLOYED` like any
other payload entry:

- **Cursor:** `.cursor/hooks.json` (four chains, `command: node
  ${CURSOR_PROJECT_DIR}/.claude/dist/*.mjs`, `failClosed: true`) and
  `.cursor/rules/scrumux.mdc` (~10 lines, `alwaysApply: true`, pointing at
  `CLAUDE.md` and `.claude/rules/`).
- **Copilot:** `.github/hooks/scrumux.json` (PascalCase `PreToolUse`, `exec:
  node`, args → `.claude/dist/*.mjs`) and a `.github/copilot-instructions.md`
  pointer.

Nothing is duplicated except the Copilot agent briefs — no second copy of the
bundles, rules, skills, schemas or the CLI. Only configuration points at them.

Explicit config is preferred over relying on each tool's third-party
auto-discovery even though that exists, because it is toggle-gated on Cursor
and reportedly flaky. Roughly 40 lines removes the dependency.

Rejected: symlinks (Windows), and per-tool copies of the payload — that is the
D-0010 failure this repo already applies to itself, a second copy being a
second thing to keep in step.

`.claude/DEPLOYED` gains a top-level `"targets": ["claude", "cursor"]`.
`harness verify` reads it and runs the existing `settings-hook-chains` /
`settings-hook-commands` checks once per target against that target's config.
`SURFACE_PROBES` are tool-agnostic and unchanged.

## Command surface

`scrumux harness deploy <repo> [--for claude|cursor|copilot|all] [--json]`,
repeatable or comma-separated, defaulting to `claude`. One verb; `<repo>` keeps
its meaning. `verify` takes the same flag, defaulting to whatever
`DEPLOYED.targets` says. Separate verbs would triple the surface for one
dimension of one verb.

## Decisions taken (2026-09-03)

- **Build against the docs; do not probe first.** Accepted risk: the unverified
  `tool_input` key question above. Mitigation when built — `harness verify
  --for cursor` should actually exercise a hook and report honestly, so the
  assumption is testable in one command rather than silently wrong.
- **Generate `.github/agents/*.md` for Copilot**, derived at deploy time from
  the same authored `.claude/agents/*.md`, so the one duplicated artifact
  cannot drift.
- **Cloud agents are in scope**, with their constraints documented (below).

## The gap list — for README.MD when this ships

1. Copilot hook **timeouts always fail open**, including `preToolUse`: a slow
   wall silently allows.
2. VS Code Copilot hooks are **Preview**; the format may change.
3. Cursor `preToolUse` does not cover `NotebookEdit`, `PowerShell`, `Glob`,
   `WebFetch`, `WebSearch` — so `block-upstream-edit` misses notebook edits on
   Cursor.
4. Cursor **cloud agents do not run `sessionStart`** — no session brief, no
   session guard there. Cannot be closed.
5. Cursor subagents ignore `tools:`; the D-0007 read-only guarantee becomes
   `readonly: true` and does not carry `Bash`-scope semantics.
6. Copilot has no `.claude/agents` path — the agent roles are regenerated,
   the one genuinely duplicated artifact.
7. Copilot's **cloud agent requires hooks on the default branch**, so a
   feature-branch deploy does not govern it.
8. Repo-level hooks on all three tools are alterable by anything with repo
   write access — weaker than centrally-managed policy (Copilot `policy.d/`,
   Cursor enterprise `hooks.json`).
9. Copilot merges `CLAUDE.md` with `.github/*` instructions with **no defined
   precedence**.
10. The unverified items listed above, until someone probes them.
