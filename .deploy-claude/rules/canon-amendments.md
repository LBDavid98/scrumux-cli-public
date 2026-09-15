---
name: canon-amendments
paths: [".claude/rules/**", ".claude/skills/**", ".claude/schemas/**", ".claude/project-walls.conf"]
skills: []
scripts: [".claude/scripts/scrumux"]
hooks: [".claude/dist/block-upstream-edit.mjs"]
---

# Rule: amend canon beside it, never inside it

Canon is owned upstream and republished. A repo that needs a local
deviation records it **beside** the canon document, in a separate
appendable record that carries a reason. It never edits the canon
document itself.

Publishing then has one behaviour, and it is the same every time:

> **Overwrite, then re-apply approved amendments.**

That makes an approved amendment **durable** — it survives a republish
rather than surviving by luck — while an unapproved edit does not,
because nobody approved it. Destroying unapproved drift on publish is
correct, not collateral damage.

## Why this shape and not the obvious ones

**Not "never overwrite."** A canon update that has to negotiate with
every repo's local edits stops being canon. Worse, it puts a decision in
front of a person once per repo per file, which is how a governance
layer turns into a tax nobody pays.

**Not "overwrite and let people re-add their edits."** That loses the
reason. Six months later nobody remembers whether a deviation was
deliberate or a mistake, so it gets re-added defensively or dropped
carelessly. The reason is the durable part; the diff is not.

**Not "record it in the canon file as a comment."** Then the canon file
differs from upstream and every repo drifts by construction, which
destroys the one signal drift detection exists to give.

## The record

One file per layer, per repo. One amendment per line. A reason on the
same line, or the line is ignored — **an exemption nobody can read is an
exemption nobody can audit.**

`.claude/project-walls.conf` is the reference implementation and predates
this rule:

```
allow  <extended-regex> | why this repo permits it
refuse <extended-regex> | why this repo refuses it
```

It survives every `harness deploy` because deploy never touches it, it
carries its reason inline, and a line without a `|` reason is dropped on
the floor. Any new amendable layer copies that shape rather than
inventing a second one.

## What this buys, beyond not losing edits

Amendments are **analysis data**. A rule that half the fleet has excepted
is not being enforced — it is being routed around, and that is worth
knowing. Reading the amendment records across repos answers a question
that no single repo can:

- which rules hold everywhere,
- which are excepted constantly and should be reconsidered or deleted as
  unenforceable,
- and which exceptions were one-offs that could now be withdrawn.

A rule nobody can follow is a bad rule. This is how it becomes visible
instead of becoming folklore.

## Cost

Deliberately near zero: one file, one line, one reason. If amending canon
ever costs more than that, the amendment record has grown into the thing
it exists to prevent.
