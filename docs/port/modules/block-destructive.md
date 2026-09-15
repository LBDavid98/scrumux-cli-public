# Module inspection — `block-destructive`

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Source:** `.claude/hooks/block-destructive.sh` (349 lines, read in full).
**Shared machinery it depends on:** `.claude/hooks/walls-lib.sh` (`walls_cmd_words`,
`walls_allows`, `walls_refuses`, `walls_reason`, `walls_field`, `walls_record`) —
read in full because every act-gate and every conf-consult call bottoms out there.
**Tests read in full:** `tests/hook-destructive-tests.sh` (330 lines, the
acceptance suite for this hook), plus the destructive-specific rows in
`tests/project-walls-tests.sh` (:18, :74-75) and `tests/walls-jq-absent-tests.sh`
(:92-95, the CLI-1 fail-closed control pair).
**Registers read in full:** `docs/port/PHILOSOPHY.md` (all 53 P-items + 20 OQs),
`RULINGS.md` (D-0085, D-0086).

---

## Intent

A `PreToolUse` hook on the `Bash` matcher. It mechanizes one clause of the
CLAUDE.MD hard limit — "never run destructive filesystem commands or purge a
database without backing it up first" (:1-5, T-0014/S-0009) — over exactly
**three** command classes, and nothing else. Exit 2 + stderr blocks; exit 0
(silent) allows.

**Scope is deliberately narrower than "destructive."** Stated at :7-10: deploy,
production, TestFlight and tunnel actions are explicitly out of scope —
"User's explicit v1 selection," reaffirmed by `PROJECT_SPEC.MD` per PHILOSOPHY
P-32. The three classes:

1. **Recursive-force delete** (`_rm_destructive_flags`, :265-274) — act-gated on
   a real `rm` command word (:276, `has_word 'rm'`), then a flag-shape match:
   bundled/separated short flags carrying **both** `r` and `f` (:267), bundled
   short flags carrying **both** `r` and `d` (:269 — `-d` deletes directories,
   so `-rd`/`-dr` is this class without an `f`), or GNU **long** flags
   `--recursive` and `--force` both present anywhere in the scanned string,
   any order, other args allowed between them (:271-273). A single flag alone
   (`-r`, `-f`, `--recursive`, `--force`) is never this class (comment :263-264,
   tests :313-318).
   - `--no-preserve-root` is blocked **unconditionally**, before any exemption
     check runs — no attestation and no temp target opens it (:277-284,
     tested :56, :138, :311).
   - Everything else routes through a **temp-space exemption**
     (`rm_targets_temp`, :202-251) built on a hand-rolled lexical `..`
     resolver (`lex_resolve`, :162-186) and a literal-form temp-root test
     (`is_temp`, :188-200). This is I-0103: the exemption tests the
     **resolved delete target**, never the raw command string, because an
     earlier version keyword-matched the whole `$cmd` and a trailing comment
     (`# /tmp/`) or a path component (`mktemp-archive`, `scratchpad-old`)
     could disarm a real root-outside-temp delete (comment :148-158, nine
     regression cases at tests :64-84).
2. **Database purge** (:301-311) — act-gated on a real DB-client command word
   (`DB_CLIENTS`, :98) **and** a SQL/command keyword match
   (`drop database|table|schema|collection`, `truncate table` — the word
   `table` is now required, so coreutils `truncate -s 0 file` no longer
   matches — `flushall`, `flushdb`, `db.dropDatabase`, :305).
3. **Git history destruction** (:313-328) — bare force-push (`--force`/`-f`
   with no `--force-with-lease`, :317-321), `reset --hard`, `clean -f*`
   (:322-328).

**The refusal matrix, measured against the live hook (not inferred):**

| Input shape | Result |
|---|---|
| `rm -rf`, `rm -fr`, bundled/split `-r -f` | blocked |
| `rm -rd`, `rm -dr` | blocked (D-0085 fix) |
| `rm --recursive --force`, either order, flag between | blocked (D-0085 fix) |
| `rm -r` alone, `rm -f` alone, `rm --recursive` alone, `rm --force` alone | allowed — never this class |
| `rm -rf --no-preserve-root /`, incl. attested or long-flag form | blocked, unconditionally |
| `rm -rf` under `/tmp`, `/private/tmp`, `/var/folders`, `$TMPDIR`, `${TMPDIR`, `$SANDBOX`, `$(mktemp` (literal, unexpanded) | allowed |
| `rm -rf` where **any** operand resolves outside temp (incl. `..`-traversal out of `/tmp`) | blocked |
| `rm -rf` outside temp, prefixed `HARNESS_BACKUP_DONE=1` | allowed, one attestation row |
| DB client + DROP/TRUNCATE TABLE/FLUSHALL/dropDatabase | blocked (attestable) |
| DB keyword in prose with no DB client word (`scrumux issue new --summary "...drop table..."`) | allowed — CLI-4 act-gate |
| `truncate -s 0 file` (coreutils, no `table` word) | allowed |
| bare `git push --force`/`-f` | blocked |
| `git push --force-with-lease` | allowed, unconditionally (OQ-1) |
| `git reset --hard`, `git clean -f*` | blocked (attestable) |
| `git reset --soft` | allowed |
| any class wrapped in `nice`/`timeout N`/`xargs`/`ionice`/... | blocked, same as unwrapped (CLI-4 augment) |
| any class inside `sh -c "..."` / `bash -lc "..."` / other POSIX shells, `-c` bundled or separate | blocked, same as unwrapped (CLI-4 augment) |
| any class **quoted as prose** in a `scrumux decide/issue` argument | allowed — CLI-4 act-gate |
| a comment tail supplying a fake `HARNESS_BACKUP_DONE=1` or `--force-with-lease` | still blocked — judged on `$cmd_nc`, comment stripped first |

**Non-obvious mechanisms, cited:**

- **Fail-closed on missing `jq`** (:23-29): a required dependency, and waving
  the call through on its absence would silently turn every wall into a
  no-op (CLI-1). Verified live at `tests/walls-jq-absent-tests.sh:92-95` —
  jq-absent still exits 2 and names jq; the jq-present control on the same
  payload also exits 2, proving the payload is genuinely dangerous and not
  a coincidental match.
- **Trailing-comment strip before every detection** (`cmd_nc`, :44-49, CLI-3):
  every class regex and every exemption test reads `$cmd_nc`/`SCAN`, never
  raw `$cmd`, so `rm -rf /x # HARNESS_BACKUP_DONE=1` cannot disarm itself and
  `git push --force origin main # --force-with-lease` cannot fake the lease
  (tests :193-200).
- **Act-gate, not string-gate** (`CMD_WORDS`, :51-56, CLI-4): a destructive
  keyword only fires when a command that can perform it actually runs.
  `walls_cmd_words` (walls-lib.sh:162-231) is a quote-aware awk tokenizer —
  quoted text is data and never yields a command word, so
  `scrumux decide new --rationale "...rm -rf..."` names no `rm` (tests
  :208-219).
- **Shell `-c` payload extraction is unique to this hook** (:58-88, "CLI-4
  augment," landed in `24bd3d6` and `970277e`). When a real shell-interpreter
  word (`sh|bash|zsh|dash|ksh|ash`) appears in `CMD_WORDS` **and** a `-c` is
  present as a standalone or bundled short flag (`-lc`, `-cx`, `-xc`, `-ce`),
  the payload after the interpreter's flag group is de-quoted (stopping at
  the first `"` so an inner client's own `-c`, e.g.
  `bash -lc "psql -c \"DROP…\""`, is not over-stripped, :80-83) and folded
  into both `CMD_WORDS` (so `has_word` sees the real program) and `SCAN` (so
  the class regexes read the de-quoted text). This closes the exact bypass
  class the two commits above were written for (tests :221-266). **Verified:
  no sibling wall does this** — `grep -n "sh -c\|CMD_WORDS\|_payload" .claude/hooks/{block-secret-reads,block-direct-llm,block-upstream-edit}.sh`
  shows none of the three walls extracts a `-c` payload. `block-secret-reads`
  still blocks `sh -c "cat /app/.env"` (measured, rc=2), but for an unrelated
  reason — its separate Bash-arm word-split scan over the *raw* command
  string (P-24) happens to see the literal `.env` substring regardless of
  quoting. **`block-direct-llm` has no such fallback and does not block it:**
  measured live, `sh -c "curl https://api.openai.com/v1/chat"` through
  `block-direct-llm.sh` returns **rc=0**. See Open Questions.
- **Exactly one attestation row per invocation** (:111-125, :336-346): every
  branch calls `attest()`, which is a no-op once `attested_class` is set —
  first matching branch wins — and the single write happens after every class
  check has run. An `rm -rf` that also drops a table produces **one** row
  (tested at :124-127), not two.
- **Two different sinks, two different privacy policies** (P-31): `block()`
  (:137-146) records a pre-extracted **safe subject** (a path or a program
  word) to `.scrumux/events.jsonl` via `walls_record` — never the raw
  command, which can carry a secret (CLI-5, tests :257-290) — while the
  attestation write (:339-344) records the **full `$cmd`** into
  `governance/attestations.jsonl`, because it is a deliberate audit sink for
  an act a person attested to (:14-19).
- **The attestation write is fully swallowed** (:336-345): the `mkdir -p` and
  the `jq -n -c … >>` append sit inside `{ … } >/dev/null 2>&1`, and nothing
  after it inspects an exit status. A failed write leaves the hook silent at
  exit 0 (comment :333-335, matches PHILOSOPHY P-10 exactly).

---

## Deliberate looseness

Every entry below is a **behaviour**, not a defect. None is proposed for
tightening.

1. **A single `-r` or `-f` (short or long) is not the recursive-force class.**
   Only both together, or `-rd`/`-dr`. → **P-32**, block-destructive.sh:263-274.
2. **`rm --recursive --force` (GNU long flags) and `-rd`/`-dr` now block.**
   This *was* PHILOSOPHY's own recorded gap (OQ-17: measured rc=0 for both,
   as of the 2026-08-31 register). **Confirmed closed in the current tree**:
   D-0085 (`RULINGS.md:27`) scheduled this as a bash-first Phase-1a fix
   ("Phase 1a fixes bash FIRST so the parity spec is correct"), and the
   source now implements it (:270-274, comment :219-221 in `rm_targets_temp`
   dated D-0085) with dedicated regression coverage
   (`tests/hook-destructive-tests.sh:293-322`). The port target is the
   **fixed** matrix, not the gap PHILOSOPHY.md describes historically.
3. **`--no-preserve-root` blocks unconditionally, before any exemption.** No
   attestation and no temp target opens it — "there is no sanctioned use of
   this flag here." → **P-32** port note, block-destructive.sh:277-284.
4. **The temp exemption is pure string matching, never real path
   resolution.** `is_temp` (:194-200) matches a fixed set of resolved-path
   prefixes and a fixed set of **literal, unexpanded** variable-reference
   strings (`'$TMPDIR'`, `'$SANDBOX'`, `'$(mktemp'`) — it does not, and must
   not, actually expand a variable or touch the filesystem, because "the
   paths a PreToolUse hook judges must not be touched and mostly do not
   exist yet" (:156-158). A temp path referenced through any other variable
   name is not recognized and the command blocks (safe direction, never
   silently permissive). Related to **P-26** (data-driven paths are an
   accepted inherent limit) — this is the destructive wall's specific
   instance of that limit.
5. **A destructive keyword in quoted prose is never the act.** `scrumux
   decide new --rationale "...rm -rf outside temp..."`,
   `--summary "...drop table..."` and `echo "...truncate the table..."` all
   pass, because `walls_cmd_words` drops quoted text and the class checks are
   act-gated on `has_word` first. → shares the mechanism family of **P-27**
   (heredoc/wrapper handling in `walls_cmd_words`) and the I-0132 family
   named at :93-97; tests :208-219, :253-256.
6. **Heredoc bodies are yielded as command words; non-mutating wrappers and
   `busybox`/`toybox` are stepped over.** Both strengthen the wall and can
   only make it see MORE, never less. → **P-27** exactly, shared
   `walls-lib.sh:139-232`; the wrapper step-over is exercised here at tests
   :229-235 (`xargs`, `nice`, `nice -n 10`, `timeout 5`, `ionice`).
7. **The shell `-c` payload extraction (CLI-4 augment) exists only in this
   hook.** `sh -c "rm -rf …"`, `bash -lc "…"` and psql-in-bash-lc are folded
   into the scan here (:58-88); the equivalent extraction is absent from
   `block-secret-reads.sh`, `block-direct-llm.sh` and
   `block-upstream-edit.sh`. → **NEW** — no PHILOSOPHY entry or ruling
   addresses why this augmentation is destructive-only rather than shared
   lib. See Open Questions; this is not a defect in *this* module (its own
   coverage is what the two commits `24bd3d6`/`970277e` were written to
   close) but the asymmetry with its siblings is unexplained.
8. **`HARNESS_BACKUP_DONE=1` is an attestation, not a verification.** The
   wall never checks a backup exists — it records the syntactic claim.
   → **P-30** exactly, block-destructive.sh:12-16, :127-135.
9. **The attestation write never blocks and never prints; a failed write is
   silent.** → **P-08**/**P-10** exactly, block-destructive.sh:330-345.
10. **Exactly one attestation row per invocation, first matching class
    wins.** → **P-10**'s port note, block-destructive.sh:111-125; tests
    :124-127.
11. **`attestations.jsonl` carries the full `$cmd`; the event stream carries
    only a pre-extracted safe subject.** → **P-31** exactly,
    block-destructive.sh:137-146 (CLI-5) vs :339-344; tests :257-290.
12. **`walls_allows`/`walls_refuses` (project-walls.conf) are consulted
    first, and `allow` wins even over a built-in destructive pattern.**
    → **P-29** exactly, block-destructive.sh:100-109; tested at
    `tests/project-walls-tests.sh:77-83` (`allow rm -rf ./build` wins over a
    repo's own stricter `refuse rm -rf`).
13. **`--force-with-lease` unconditionally exempts a force-push; only bare
    `--force`/`-f` blocks.** → **OQ-1**, now **ruled deliberate**:
    `RULINGS.md:52-53` — "the force-with-lease split is the intended
    Prime-Article reading (deliberate)." Not open; port as the settled
    behaviour. block-destructive.sh:317-321; tests :101, :200, :206.
14. **`git reset --hard` and `git clean -f*` are attestable (not
    unconditional like `--no-preserve-root`).** Backing up with
    `git stash -u` first is the sanctioned path, same as filesystem
    deletes. → part of **P-32**'s described git scope,
    block-destructive.sh:322-328.
15. **A DB purge/git-history attestation records an empty
    `attested_path`** (`attest db-purge ''`, `attest git-history ''`,
    :307, :324) — there is no filesystem target for those classes; only
    `rm-rf`'s row names a path. Data-shape note, not a gap: the row's
    `class` field still distinguishes it, and `RM_TARGET`/`attested_path`
    is documented as "a record field, never a gate" (:288-291).

---

## Simplify/perf

**BEHAVIOR-PRESERVING** (safe to apply in the port; each reproduces the exact
same accept/refuse decisions, just without a bash-specific mechanism):

- **No subprocess `awk` per invocation.** `walls_cmd_words` is a hand-written
  quote-aware tokenizer; the TS port implements the same state machine
  in-process (already the plan's stated approach, and the specific
  character-class rules — VAR= prefix skip, wrapper step-over, bare-numeric
  flag-value skip at `walls-lib.sh:198-200` — must be reproduced exactly, not
  just "similarly").
- **`project-walls.conf` compiled once per process, not once per call.**
  Today a single hook invocation re-reads and re-compiles the conf file **up
  to four separate times**: `walls_allows` (:104), `walls_refuses` (:105),
  and `walls_reason` (:106, :107 — called twice, once for the subject and
  once for the message text). Each of those is its own `walls_field` call,
  which itself re-parses the whole file and re-`grep`s every pattern against
  empty input to validate it. A TS port that parses/validates once per
  process and reuses the compiled pattern list changes nothing observable —
  same skip-and-name behaviour for an invalid pattern, same fail-closed
  behaviour for a corrupted set — while removing three redundant file reads
  and up to a dozen redundant `grep -Eq` subprocess spawns per Bash call.
- **No subprocess `jq` for the attestation write.** The final write is a
  single flat object (`{date,class,command,attested_path}`), not a journal —
  it never goes through `write_json`/`_write_json_body` (P-50's sibling
  exemption). An in-process JSON serializer reproduces it directly; the
  jq-vs-JS number-formatting divergence (P-49/OQ-9, Spike A) does not apply
  here because none of the four fields is a number.
- **No subprocess `grep`/`printf` pipelines for `has_word`, `first_word`,
  `is_temp`, `_rm_destructive_flags`, or the git/DB regex tests.** Each is a
  `printf | grep -q` pipeline today (a fresh process per test); once
  `CMD_WORDS`/`SCAN` are computed, in-process regex evaluation is a pure
  perf win with an identical result, **provided** each POSIX ERE is
  translated through the port's `ere.ts` layer (OQ-8) rather than assumed to
  mean the same thing as the equivalent-looking `RegExp` literal.
- **`cmd_nc` and `SCAN` computed once, reused everywhere** — already true in
  bash (:49, :74, :86) and trivially true in TS; no behaviour change, noted
  only so a port does not accidentally recompute the comment-strip per call
  site and risk a subtly different regex between two computations.

**OBSERVABLE** (would change what an operator sees; proposal only, User
rules):

- **Extend the CLI-4 shell `-c` payload extraction to `block-direct-llm.sh`
  (and, more debatably, `block-upstream-edit.sh`).** Measured live:
  `sh -c "curl https://api.openai.com/v1/chat/completions"` passes
  `block-direct-llm.sh` at **rc=0** today — the same bypass class that
  `24bd3d6`/`970277e` closed for this hook, unpatched on a sibling wall that
  guards a comparably sensitive act (a direct provider call). If applied: an
  operator who currently gets a silent pass on a shell-wrapped direct-LLM
  call would instead see `BLOCKED by no-direct-llm-calls: …`. `block-secret-reads.sh`
  does **not** need this — it already blocks the equivalent case
  (`sh -c "cat /app/.env"`, measured rc=2) through its own raw-string Bash
  arm (P-24), independent of the act-gate. Not proposing a port-time fix
  (that would be silent tightening of a sibling module this doc does not
  own) — surfacing it because it is exactly the class of gap this register
  exists to catch, and it is closer to `block-direct-llm`'s module boundary
  than to this one's.

---

## Open questions

1. **The shell `-c` extraction is destructive-only, and no ruling explains
   why.** (See Deliberate looseness #7 and the Simplify/perf OBSERVABLE
   item above.) Three readings, none I can distinguish from the tree: (a) it
   was scoped to destructive because that is what the adversarial validation
   round happened to probe; (b) it is deliberately narrow because a
   shell-wrapped secret read or LLM call is already caught by a different
   mechanism on those walls (true for secret-reads, **not measured true**
   for direct-llm); (c) oversight. **Question for User:** generalize the
   extraction into `walls-lib.sh` as a fourth shared primitive (an
   OBSERVABLE behaviour change on `block-direct-llm` and, if it applies,
   `block-upstream-edit`), or leave it destructive-only and record why here?

2. **POSIX ERE → JS RegExp, specific to this module's own patterns, not just
   the shared `walls_cmd_words`/conf layer (OQ-8 covers that layer
   generally).** This hook's own inline regexes lean on `[[:space:]]`
   POSIX bracket-class syntax throughout (:75-76, :267-273, :283, :305,
   :318-322) — JS `RegExp` has no `[[:space:]]` token and needs a translated
   `\s`-equivalent class; a literal port of the ERE string into `new RegExp()`
   will throw or silently mismatch, not just behave slightly differently.
   Route through the port's `ere.ts` translator (OQ-8's designated answer)
   rather than hand-translating each pattern inline.

3. **`rm_targets_temp`'s flag-group stripper is BRE, not ERE, and is the most
   syntactically dense line in the file.** `sed -n
   's/.*rm\([[:space:]]\{1,\}--\{0,1\}[a-zA-Z][a-zA-Z-]*\)\{1,\}[[:space:]]\{1,\}//p'`
   (:222) uses backslash-escaped interval quantifiers (`\{1,\}`, `\{0,\}`),
   which are BRE syntax valid because `sed` defaults to BRE, not the ERE
   `grep -E` uses everywhere else in the file. A porter translating "the
   regexes" as one dialect will mistranslate this one. It is the mechanism
   that strips `rm`'s flag group (`-rf`, `--recursive --force`, `-v -rf`,
   any mix) so `is_temp` sees only the delete operands — get it wrong and
   either a real flag is misread as an operand (spurious block) or an
   operand is swallowed as a flag (spurious allow). D-0085's comment at
   :219-221 explicitly flags the `--\{0,1\}` clause as load-bearing for the
   long-flag fix.
4. **`lex_resolve`'s handling of a leading `..` with no `/` prefix is
   unspecified by any comment.** (:166-186) `lr_acc=${lr_acc%/*}` on an
   empty accumulator is a no-op (bash parameter-expansion suffix removal
   finds no `/*` to strip), so a leading `..` segment is silently dropped
   rather than producing an error or an out-of-bounds marker. This is safe
   in practice — it cannot make a non-temp path *look* temp — but a port
   that "fixes" this into raising or into `..`-climbing past the resolved
   root would diverge from bash's literal behaviour. Not verified as
   deliberate (no comment addresses this specific sub-case); behaviour
   should be ported as measured, not as reasoned-from-first-principles.
5. **`is_temp`'s glob patterns are shell `case` globs, not regexes** —
   `/tmp/?*` requires *at least one* character after `/tmp/` (a bare `/tmp`
   with nothing after does not match). A port using a regex equivalent must
   reproduce the `?*` semantics (one-or-more, not zero-or-more) exactly,
   including the component-boundary property already called out in the
   source comment (:189-193): `/tmpfoo` and `/private/tmpfoo` must **not**
   match, tested live at `tests/hook-destructive-tests.sh:77`.
6. **`date +%F` is local-timezone, not UTC**, and lands in every attestation
   row (:340). A TS port using `new Date().toISOString().slice(0,10)` would
   silently shift the recorded date near a timezone boundary. Not flagged by
   any comment in this file; worth confirming the intended replacement is
   local-date, not UTC-date, before Phase 4 writes the attestation sink.
7. **Case-sensitivity of `has_word` is unexamined.** `has_word()`
   (:90) is `grep -qxE` with no `-i`, so `RM -rf` or `GIT push --force`
   would not act-gate (though the DB-purge **keyword** regex at :305 is
   `grep -Eiq`, case-insensitive, and text-only). Not verified as
   deliberate — plausible reasoning is "program names are case-sensitive on
   the platforms this ships to," but that reasoning was not found written
   down anywhere, and the TS port runs on Windows too. Recorded as a
   question, not changed.
