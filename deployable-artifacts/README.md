# deployable-artifacts

**Versioned, delivery-ready cuts of the harness.** This folder holds what
gets handed to a repo, frozen at a point in time — not the working tree it
was cut from.

It is a **convention with no machinery behind it yet.** Nothing here is
generated, nothing consumes it automatically, and the packaging step that
will produce these cuts is follow-on work (the port's Phase 6). What exists
today is the shape, written down so the first real cut does not have to
invent one.

## The shape

One subfolder per cut, named for its version. Each carries a
`manifest.json` at its root, plus the files the manifest lists:

```
deployable-artifacts/
  README.md
  manifest.schema.json     the shape a manifest must have
  example/manifest.json    a filled-in one, for reading
  <version>/
    manifest.json
    ...the files
```

A manifest names the version, the commit it was cut from, when it was cut,
and every file with its SHA-256. The hashes are the point: a cut you cannot
verify byte-for-byte is a cut you are trusting rather than checking
(Article 6 — evidence is written by programs).

## How this relates to the canon pin store

**Cuts FEED `~/.scrumux/canon/canon-NNN`. They do not replace it.**

The canon store is the machine-local, numbered pin store a session resolves
against. It is per-machine state. This folder is the tracked, reviewable
source those pins are cut from — the difference between a release artifact
and an installed one. A cut lands here first and is promoted into the pin
store; the promotion never runs the other way, and nothing here is edited
to reflect what a pin store happens to hold.

## What this folder is not

**Nothing in here is authority over any session.** A cut is a frozen copy
of product, not a ruling and not a policy. The governance of this repo is
`RULINGS.md` at the root, and the governance of a repo the harness is
deployed into is that repo's own `.claude/`. A file appearing in a cut
gives it no standing it did not already have.

It is also not a backup, not an archive of removed material (that has its
own manifest elsewhere), and not a place to stage work in progress. A cut
is made from a commit, or it is not made.
