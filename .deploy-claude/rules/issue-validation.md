---
name: issue-validation
paths: ["**"]
skills: ["session-open", "implement-sop"]
scripts: [".claude/scripts/scrumux"]
---
# Rule: validate an issue before fixing it

Scope: loads whenever work starts from an issue — a hotfix sprint, a
fix task, or "just fix I-XXXX".

No fix work on an issue until a validation verdict is recorded:

```
scrumux issue validate I-XXXX --verdict reproduced|evidenced|invalidated|duplicate \
  --evidence "<what you saw>" [--repro-cmd "<command that shows it>"] \
  [--duplicate-of I-XXXX|T-XXXX]
```

- **reproduced**: you ran something and saw the failure — capture the
  command in `--repro-cmd` so the fix task can rerun it.
- **evidenced**: not directly runnable (e.g. a design gap), but the
  evidence is concrete and cited.
- **invalidated**: the issue does not hold up — close it
  (`scrumux issue update I-XXXX --status rejected`); the recorded disproof
  is the deliverable (D-0011 data), not a fix.
- **duplicate**: same root cause already reported or owned — record
  `--duplicate-of` naming the original issue (I-XXXX) or the backlog
  task that owns the fix (T-XXXX, preferred when one exists); any new
  evidence the report adds goes in `--evidence`.

The gate is deterministic on **both** promotion paths — each refuses an
unvalidated or invalidated issue and prints the exact command to run:

- `scrumux sprint new --hotfix --issue I-XXXX`
- `scrumux task new --title ... --check ... --issue I-XXXX`

The point is no hallucination-chasing and no edge-case chasing — an
agent that cannot show the failure does not get to "fix" it.
