# Module inspection — `block-secret-reads`

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Source:** `.claude/hooks/block-secret-reads.sh` (219 lines), sourcing
`.claude/hooks/walls-lib.sh` (341 lines) for shared wall machinery.
**Tests:** `tests/hook-secret-tests.sh` (291 lines, 82+ assertions),
`tests/walls-jq-absent-tests.sh` (jq-fail-closed probe), cross-referenced by
`tests/deployed-session-corpus-tests.sh` (multi-wall sweep) and
`tests/hook-upstream-tests.sh` (protects the hook file itself, not in scope
here). Inspected against the tree as it stands **after** Phase 1a (D-0085) —
the residual fixes are already landed in this source, and this document
treats the fixed behavior as the parity spec per the task brief.

---

## Intent

This is a `PreToolUse` hook matched on the `Read` and `Bash` tools. It is one
of four walls (the others: `block-destructive`, `block-direct-llm`,
`block-upstream-edit`) and its job is narrow: refuse a tool call that reads a
credential or secret file, per the CLAUDE.MD hard limit "never read
credential or secret files" (`:1-4`, citing T-0013/S-0009). Exit 2 + stderr
blocks; exit 0 allows; there is no third outcome.

**jq is a required, fail-closed dependency for this wall specifically.**
`:19-22` checks `command -v jq` before touching the payload and refuses at
exit 2 with a named message if it is absent — explicitly *not* the
fail-open direction, because a missing jq would silently turn every wall
sourcing the same pattern into a no-op (comment cites "CLI-1"). This is
measured behavior, not read from the comment alone:
`tests/walls-jq-absent-tests.sh:88` (`jq_absent "secret-reads: cat
/app/.env, jq absent" block-secret-reads.sh "$SEC_CMD"`) asserts exit 2 with
`jq` stubbed out of `PATH`.

**Two arms, because the two tools hand this hook different kinds of
string** (`:24-51`, design note I-0135). This is the load-bearing structural
decision of the whole module:

- **Read arm** (`$FP`, `:83-109`) — `tool_input.file_path`. The tool has
  already resolved this to a single path, so a bare word here is a filename
  and can match unqualified.
- **Bash arm** (`$CMD`, `:111-218`) — `tool_input.command`. This is a
  *sentence* that may legitimately contain the same words as prose (a
  `--check` string, a commit message, a `--rationale`), so a bare-word match
  here produces false positives that were measured in production
  (`scrumux task new --check "no credentials appear anywhere"` was refused
  before this split existed).

Extraction is two `jq -r` calls (`:52-53`); `target=${FP:-$CMD}` and an
empty target exits 0 immediately (`:55`) — nothing to evaluate, nothing to
block.

### The STRONG regex — distinctive patterns, either arm

`:67` (compiled once, shared by both arms):

```
STRONG='(^|[/ "'\''=<(])\.env(\.[A-Za-z0-9_-]+)*($|[ "'\''<>)~])|(^|[/ "'\''=<(])[A-Za-z0-9_-]+\.env($|[ "'\''<>)~])|id_rsa|id_ed25519|\.pem($|[ "'\''])|\.pfx($|[ "'\''])|(^|[/ "'\''])[^ ]*\.key($|[ "'\''])|keys/apps/[^ ]*\.json|GATEWAY_API_KEYS\.json|secrets?\.(json|ya?ml|env)($|[ "'\''])|\.netrc|\.npmrc|\.pypirc'
```

Three of its clauses were **broadened in Phase 1a (D-0085)** and the comment
at `:60-66` names each: `.env` now takes `(\.[A-Za-z0-9_-]+)*` (zero-or-more
dot segments, was one-or-zero — Next.js ships `.env.production.local`), a
`~` joined the terminator class (an editor backup `.env~` is a secret), and
`[A-Za-z0-9_-]+\.env` is a new clause for the `prod.env` / `staging.env`
form that has no leading dot. These are exercised directly:
`tests/hook-secret-tests.sh:216-227`.

### The ambiguity split — AMBIG_PATH vs AMBIG_CMD

`:70-71`:

```
AMBIG_PATH='credentials(\.(json|ya?ml|txt))?($|[ "'\''])|authorized_keys|known_hosts'
AMBIG_CMD='(credentials|authorized_keys|known_hosts)\.[A-Za-z0-9]+|[/~][^ "'\'']*(credentials|authorized_keys|known_hosts)($|[ "'\''])'
```

`AMBIG_PATH` matches the word bare (Read arm only needs to be a path).
`AMBIG_CMD` requires **path context** — a leading `/` or `~`, or a trailing
extension — before the same words count as a read target in a command
string. This is the mechanism, not just the comment's claim: the two
patterns are lexically different, and a porter cannot merge them into one
predicate without either re-opening the false-positive hole `AMBIG_CMD`
exists to close, or losing the Read arm's bare-word coverage.

### The block message — Article 5 contract, exact text

One copy, shared by both arms (`:76-78`):

> `BLOCKED by block-secret-reads: this targets a credential/secret file
> pattern. CLAUDE.MD hard limit: never read credential or secret files.
> Reference secrets by path, never by value (see
> .claude/rules/no-direct-llm-calls.md token-handling rules). To put a
> secret where this repo's code can USE it, store it: printf %s '<value>' |
> .claude/scripts/scrumux secret NAME — it lands in .env, gitignored and
> mode 600, and is never printed back. Never paste a value into a file, a
> cell, a record or a commit message. If this file is genuinely not a
> secret, rename it out of the secret pattern or declare it in
> .claude/project-walls.conf with an allow line and a reason.`

The jq-missing refusal (`:20`) and the `project-walls.conf` refusal
(`:99`, `:124` — `BLOCKED by project-walls.conf: $(walls_reason refuse
"...")`) are separate, distinct strings. Port all three verbatim; the
message *is* the instruction set (Article 5), and `tests/hook-secret-tests.sh`
asserts substrings of the first one directly (`:27`, `grep -q 'BLOCKED by
block-secret-reads'` and `grep -q 'CLAUDE.MD hard limit'`).

### Read arm — `:83-109`

Order, exactly as coded:

1. `.example`/`.template`/`.sample` exemption on the **whole** `$FP`
   (`:85-88`) — correct here because `$FP` is one resolved path (CLI-2).
2. `walls_allows "$FP"` — this repo's own say, first (`:92`).
3. `walls_refuses "$FP"` — this repo's own addition; records via
   `walls_record` and exits 2 with the conf-sourced reason (`:96-101`).
4. `STRONG|AMBIG_PATH` match against `$FP` → record + `secret_block_msg` +
   exit 2 (`:103-107`).
5. Otherwise exit 0 (`:108`).

### Bash arm — `:111-218`

1. `SAFE=$(walls_cmd_words "$CMD" | head -1)` — the first command word,
   computed once up front so every refusal in this arm records a program
   name, never the raw command (CLI-5, `:114-118`).
2. `walls_allows "$CMD"` / `walls_refuses "$CMD"` on the **whole** command
   string (`:121-126`) — same ordering as the Read arm (repo's own say
   first), but note this runs *before* the read-capability gate and the
   per-operand exemption below, which is a different position relative to
   the exemption than the Read arm has (see Open Questions).
3. **Read-capability gate** (`:128-132`): `! walls_can_read_file "$CMD" &&
   ! walls_shell_reads "$CMD"` → exit 0. A secret word in a command is only
   evidence of a *read* if something in the command can perform one — the
   comment's worked example is `git commit -m "wired .env loading"`, which
   mentions `.env` but opens nothing. This gate runs before any STRONG/AMBIG
   match is even attempted, so it applies to *both* pattern sets, not just
   the ambiguous ones (see Open Questions — this is broader than P-24/P-25
   as separately registered).
4. **`read_operands()`** (`:152-191`) — the per-segment, per-operand
   extraction that CLI-2 requires. Mechanics, each one load-bearing:
   - Splits on `;|&\n` via `tr` into segments (`:159`), never a bare shell
     `for`, so a `*` in the command cannot glob against the cwd.
   - `printf '%s\n' "$1"` — **not** `'%s'** — is required so the loop's
     `read` fires on the final segment too; the file's own comment
     (`:152-157`) documents a real regression here: the `'%s'` form silently
     turned the whole arm into exit 0 for every command, caught by asserting
     the helper directly rather than only end-to-end
     (`tests/hook-secret-tests.sh:230-250`, "41 of 82 went red and the cause
     was invisible from the end-to-end failures").
   - For `cp`/`mv` (`:169-188`): the destination is dropped from the operand
     list **only when positional** — i.e. when no `-t`/`--target-directory`
     flag is present (`:176`) and the segment has ≥3 non-flag words
     (`:179-185`, so `cp .env` alone, with nothing to be a destination, is
     *not* reduced to zero operands). When the destination is flag-carried
     (`cp -t /tmp .env`), every remaining operand is treated as a source.
   - All other operands, flags included, stay candidates — flag-stripping
     happens *only* to locate cp/mv's destination, never generally, so
     `docker run --env-file=.env img` and `cat --file=~/.ssh/id_rsa` still
     match (`:163-167`, tested at `tests/hook-secret-tests.sh:273-276`).
5. Per-operand loop (`:193-208`): each candidate word is tested against
   `STRONG|AMBIG_CMD`; on a match, shell-quote characters are stripped
   (`` tr -d '"'\''`()<>' ``) before testing the exemption suffix
   (`.example`/`.template`/`.sample`) on **that operand alone** — the CLI-2
   fix. First hit wins (`hit=$w; break`).
6. On a hit: record `SAFE` (never `$w`, never `$CMD` — a flag beside the
   read target can carry a token) + `secret_block_msg` + exit 2
   (`:210-215`). Otherwise exit 0 (`:218`).

### Dependencies on `walls-lib.sh` this hook actually calls

`walls_allows`, `walls_refuses`, `walls_field`, `walls_pattern_of`,
`walls_reason` (project-walls.conf machinery, `:33-130`); `walls_cmd_words`
(the awk quote-aware tokenizer, `:162-231`); `walls_can_read_file`,
`walls_shell_reads` (reader/shell-read classifiers, `:245-271`);
`walls_record` (event-stream write, `:298-341`). These are shared with the
other three walls and are not re-derived here — this hook's correctness is
inseparable from theirs, so their contracts are treated as part of this
module's intent, not re-litigated.

---

## Deliberate looseness

Every item below is a **decision**, not a gap. None is described as a bug.

1. **The `.example`/`.template`/`.sample` exemption is a deliberate false
   negative.** `cat .env.example` passes on purpose — "they hold shapes, not
   secrets" (`:6-7`). — **PHILOSOPHY.md P-24.**

2. **Bare `cat credentials` (no path, no extension) passes the Bash arm.**
   `AMBIG_CMD` requires path context; the Read arm still blocks the same
   file. Named as a known, accepted limit in the source itself (`:47-51`).
   — **PHILOSOPHY.md P-25.**

3. **Command substitution and data-driven paths are unreachable.** `$(...)`,
   a filename arriving through a variable, `xargs cat < list` — none of
   these are seen by string matching, and this is explicitly not chased.
   — **PHILOSOPHY.md P-26.**

4. **`walls_cmd_words`'s two "look at MORE, never less" moves apply here
   too:** heredoc bodies are scanned as if they were commands (over-reports,
   never under-reports), and non-mutating wrapper prefixes (`nice`,
   `timeout`, `env`, `sudo`, …) and the `busybox`/`toybox` multiplexers are
   stepped over so the real program surfaces. The busybox/toybox step-over
   and the `dd nl tac bat vim view ex` reader-roster additions are the
   Phase 1a (D-0085) fixes named in the task brief, and they are already
   live in this source (`walls-lib.sh:192-200`, `:270`) and covered end to
   end (`tests/hook-secret-tests.sh:194-211`). — **PHILOSOPHY.md P-27.**

5. **A `project-walls.conf` pattern that will not compile is skipped and
   named on stderr; the rest of the repo's rules still apply.** — shared
   machinery this hook calls through `walls_allows`/`walls_refuses`.
   — **PHILOSOPHY.md P-28.**

6. **`allow` wins, including over every built-in pattern in this hook.**
   Checked first in both arms (`:92`, `:121`). — **PHILOSOPHY.md P-29.**

7. **NEW — the read-capability gate (`:128-132`) shields STRONG matches,
   not only the ambiguous ones.** P-24–P-29 as registered describe the
   `.example` exemption and the AMBIG_PATH/AMBIG_CMD split as the
   mechanisms that keep prose from false-positiving. But `:132`'s
   `walls_can_read_file`/`walls_shell_reads` gate runs *before* the
   STRONG/AMBIG test is even reached, for the whole Bash arm — so a command
   that mentions a STRONG-pattern filename (`.env`, `id_rsa`, `*.pem`, …)
   but contains no reading program and no shell-read idiom exits 0 without
   the pattern ever being tested. The comment's own example
   (`git commit -m "wired .env loading"`, `:129-131`) is exactly this case
   for a STRONG term, not an ambiguous one. This is real, deliberate,
   tested behavior (the same gate is what makes `tests/hook-secret-tests.sh`'s
   "prose" cases pass), but it is not the mechanism named in P-24 or P-25
   and I did not find a PHILOSOPHY.md item that states it as its own thing.
   Flagging as a candidate for the register rather than assuming it is
   already covered by a neighboring entry.

8. **jq-absent fails closed, not open** (`:19-22`). This is a refusal
   behavior, not a permissiveness — listed here only so it is not mistaken
   for an omission. Measured: `tests/walls-jq-absent-tests.sh:88-90`.

---

## Simplify/perf

**BEHAVIOR-PRESERVING**

- **One JSON parse instead of two `jq -r` subprocess calls.** `:52-53`
  shells out to `jq` twice to pull `file_path` and `command` out of the same
  stdin payload. A single `JSON.parse` in the TS port reading both fields
  from one object is identical in outcome and removes two subprocess
  spawns per invocation.
- **Compile the STRONG/AMBIG_PATH/AMBIG_CMD patterns once per process**,
  not per `grep -Eq` call. Bash re-invokes `grep` (and therefore
  re-compiles the ERE) on every match test; a TS port holding compiled
  `RegExp` objects for the process lifetime changes nothing observable.
- **Compute `walls_cmd_words` output once per segment, not twice.** The
  Bash arm currently computes `SAFE` from `walls_cmd_words "$CMD"` (`:118`)
  and `read_operands` independently recomputes `walls_cmd_words` per segment
  (`walls-lib.sh` calls inside `:161`). A TS port that tokenizes once and
  reuses the result for both the safe-subject line and the per-segment
  program-word check produces the same `SAFE` and the same per-segment
  classification, because both call sites feed it the same segment text.
- **Parse `project-walls.conf` once per invocation**, not once per
  `walls_allows`/`walls_refuses`/`walls_reason` call. Each of those
  independently re-reads and re-filters the conf file today
  (`walls-lib.sh:49-130`); this hook alone can call up to four of them in
  one run (Read arm: allow, refuse; Bash arm: allow, refuse, plus a second
  `walls_refuses`/`walls_reason` pair for the message). A TS port parsing
  the conf into an in-memory structure once, then testing `allow`/`refuse`
  against it, produces the same skip-and-name-on-stderr and
  fail-closed-on-uncompilable-pattern behavior (P-28) as long as the
  per-pattern compile-and-name step still runs individually rather than
  against one merged alternation (that merge is exactly the bug P-28
  documents fixing — do not reintroduce it while "optimizing").
- **No temp/spool files in this hook's own logic** — `read_operands`
  streams through pipes and a heredoc rather than writing scratch files, so
  there is nothing to eliminate here; noted for completeness since the task
  brief calls this class out generally.

**OBSERVABLE (proposal only — User rules)**

- If the TS port moves hooks from "spawn fresh per `PreToolUse` call" to a
  long-lived process (a daemon holding hook logic in memory across many
  tool calls), then caching the parsed `project-walls.conf` *across
  invocations* — as opposed to once per invocation, which is
  behavior-preserving — becomes an operator-visible change: today, editing
  `.claude/project-walls.conf` takes effect on the very next tool call,
  because every invocation is a fresh process that reads the file fresh.
  A cross-invocation cache would serve a stale conf until some
  invalidation fires (mtime check, TTL, explicit reload). What an operator
  would see change: an `allow`/`refuse` line just added or edited does not
  take effect immediately; it takes effect after whatever cache-refresh
  policy is chosen. Flagging only because the module's own process model
  (one-shot script) is what currently guarantees immediacy, and the port
  plan's process model is not settled by this document.

---

## Open questions

1. **POSIX ERE vs JS RegExp: case-sensitivity is not uniform across this
   module, and a naive port would flatten it.** The built-in STRONG/AMBIG
   patterns are matched **case-sensitively** — `grep -Eq "$STRONG|$AMBIG_PATH"`
   at `:103` and `grep -Eq "$STRONG|$AMBIG_CMD"` at `:197` carry no `-i`.
   But `walls_allows`/`walls_refuses` (the project-walls.conf patterns this
   same hook calls) use `grep -Eqi` — case-**insensitive**
   (`walls-lib.sh:91`, `:105`). A TS port that applies one case-sensitivity
   policy to "the regex matching in this file" will get one of the two
   families wrong. Port each family's flag separately.

2. **POSIX ERE → JS RegExp translation of the bracket expressions in
   STRONG/AMBIG_PATH/AMBIG_CMD** (`:67`, `:70-71`). These use ordinary
   character classes (no POSIX named classes like `[:space:]` in the hook's
   own patterns — those appear only in `walls-lib.sh`'s `tr -s
   '[:space:]'`), but the exact character sets inside `[/ "'\''=<(]` and
   siblings must be reproduced literally, including the embedded single
   quote (shell-escaped as `'\''` in the source) and the fact that `~` was
   added to one terminator class but not all of them in the D-0085
   broadening (`:60-66` explains which). Do not "harmonize" the terminator
   classes across clauses — the comment names exactly which clauses changed
   and which did not.

3. **`walls_cmd_words`'s awk state machine is the frozen oracle for
   command-word extraction** (`walls-lib.sh:162-231`) and every branch order
   is load-bearing: quote-toggle only when not inside the other quote type;
   `VAR=value` prefix skip while `expect` is still set; wrapper-word skip
   setting `skipargs`; the `skipargs` flag/bare-number skip
   (`^-` or `^[0-9]+[a-zA-Z]?$`) — the comment states the invariant "no real
   program word is a bare number" (`:198-200`) as the safety argument for
   that regex; a JS port must preserve the same numeric-token heuristic
   exactly, including that it would mis-skip a genuinely numeric filename
   argument to a prefixer (existing behavior, not a defect to fix).

4. **Ordering asymmetry between the two arms on exemption vs. repo-declared
   refuse, not addressed by any comment I found.** Read arm: the
   `.example`/`.template`/`.sample` exemption is checked **before**
   `walls_allows`/`walls_refuses` (`:85-92`) — so a repo cannot use
   `project-walls.conf`'s `refuse` to override the built-in exemption for a
   file read directly. Bash arm: `walls_allows`/`walls_refuses` on the whole
   `$CMD` run **before** the per-operand exemption check (`:121-126` vs.
   `:198-203`) — so a repo's `refuse` pattern matching an `.env.example`-ish
   command *would* block it, before the exemption is ever consulted. Not
   verified as deliberate; no comment states the ordering choice either
   way. Recommend a ruling before this module's arms are unified in any
   way, since unifying the order changes observable behavior for whichever
   arm currently disagrees.

5. **AMBIG_PATH's extension allowlist for `credentials` is narrower than it
   looks, and the exact set must be ported literally.**
   `credentials(\.(json|ya?ml|txt))?($|[ "'\''])` (`:70`) matches bare
   `credentials`, `credentials.json`, `credentials.yaml`, `credentials.yml`,
   `credentials.txt` — and nothing else with an extension (e.g.
   `credentials.env` would instead be caught, if at all, by the `.env`
   clause of STRONG, not by this clause). Get the `ya?ml` expansion right
   (`yaml|yml`) rather than approximating it.

6. **printf `%.200s` / `%.400s` truncation is byte-oriented in POSIX
   `printf`, not character-oriented** (`walls-lib.sh:304-305`, called from
   this hook's `walls_record` invocations at `:98`, `:104`, `:123`, `:213`).
   A multi-byte UTF-8 character straddling the 200/400-byte boundary can be
   truncated mid-sequence in bash. JS string slicing (`.slice(0, 200)`) is
   UTF-16-code-unit-oriented, not byte-oriented, and will not reproduce the
   same cut point or the same (possibly invalid-UTF-8) tail byte for
   non-ASCII input. Low-probability for this hook specifically (recorded
   subjects are program words and paths, usually ASCII) but worth a
   decision: truncate by byte length in the port to match exactly, or
   accept the divergence and record it.

7. **Subshell/pipe semantics inside `read_operands` are a bash-specific
   hazard with no direct JS analog, but the port must reproduce the same
   *data flow*, not the same mechanism.** The outer match loop
   (`:193-208`) deliberately reads from a heredoc
   (`done <<EOF\n$(read_operands "$CMD")\nEOF`) rather than a pipe, which is
   what lets `hit=$w` set inside the loop survive outside it — the same
   pitfall `walls_can_call_out`'s comment warns about generally
   (`walls-lib.sh:255-261`, "piping into a while puts the loop in a
   subshell"). `read_operands`'s own inner loop *does* pipe into `while
   read` (`walls-lib.sh` pattern via `:159`), but it never needs state to
   escape that subshell — it only `printf`s results, captured by the outer
   command substitution — so it is not actually exposed to the same bug.
   Confirm the TS port's equivalent (a plain loop with early `break` on
   first match) doesn't need to reproduce either shell quirk; it should
   just need to reproduce the *output* of `read_operands` and the
   first-match semantics.

8. **The `git rev-parse`-adjacent portability question does not arise
   here** — this hook makes no worktree/git assumptions, unlike some
   sibling walls; noted only to confirm it was checked and is not a
   silently-missed hazard for this module.
