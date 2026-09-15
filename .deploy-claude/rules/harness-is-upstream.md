---
name: harness-is-upstream
paths: ["**"]
skills: []
scripts: [".claude/scripts/scrumux"]
hooks: [".claude/dist/block-upstream-edit.mjs"]
---
# Rule: the harness is upstream — never patch it from here

Scope: bites in a repo carrying `.claude/DEPLOYED`, where the harness
machinery was installed from elsewhere and is a dependency, not the work.

- **Never edit the machinery here** — `.claude/scripts/`,
  `.claude/dist/`, `.claude/schemas/`. Editing what judges you changes the
  thing under test.
- **Capture it instead**, so it is not lost:

```
scrumux issue new --type harness --source <you> --summary "<what it does wrong>" \
  --fix "<what it should do>"
```

  The `harness` type keeps these apart from this repo's own defects.
- **The fix lands upstream.** The upstream is a **git repository**, named
  in `.claude/DEPLOYED` as `source_remote` — not a sibling directory.
  Clone it anywhere, fix it, `scrumux harness deploy <this repo>`; the clone is
  then disposable.
- **A denied call is a stop, not an obstacle.** Surface it and wait;
  never re-route the same change through another tool (I-0121).
- **So is a Claude Code permission or trust denial.** Never retry with
  `dangerouslyDisableSandbox`; record the command and the exact denial text
  as a `harness` issue and set the task `blocked` with that reason — the
  operator widens the allow-list or trusts the repo, you cannot.

`.claude/rules/` and `.claude/skills/` are NOT blocked — a repo localises
there. Their drift is reported by `scrumux harness verify` to whoever owns the
harness, never to you (boundary 7).

The wall that refuses it: `.claude/dist/block-upstream-edit.mjs`, on the
edit tools and Bash alike (D-0078).
