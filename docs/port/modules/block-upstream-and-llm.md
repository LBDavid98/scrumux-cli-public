# Module inspection — `block-upstream-and-llm`

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

Source: `.claude/hooks/block-upstream-edit.sh` (307 lines) and
`.claude/hooks/block-direct-llm.sh` (53 lines). Both are PreToolUse hooks,
two of the exactly-four blocking surfaces named in Manifesto Article 3 and
in D-0078 boundary 1 (`DECISIONS.MD:256`): *"no destructive command without
attested backup; no secret reads; no LLM call outside the gateway; no
writes to harness machinery in a deployed repo."* This doc covers the third
and fourth of those four.

Read in full, line by line, together with `.claude/hooks/walls-lib.sh`
(341 lines — the shared library both hooks draw from, one directly and one
only for `walls_record`), `.claude/rules/no-direct-llm-calls.md`, and the
four test suites that exercise these two hooks:
`tests/hook-upstream-tests.sh` (202 lines, all read),
`tests/block-direct-llm-tests.sh` (191 lines, all read),
`tests/project-walls-tests.sh` (143 lines, all read — exercises both hooks
against `project-walls.conf`), and `tests/walls-jq-absent-tests.sh`
(112 lines, the jq-absent fail-closed cases for both).

---

## Intent

**`block-upstream-edit.sh`** stops an agent from writing to the harness's
own machinery once it has been deployed into a repo. It fires only when
`.claude/DEPLOYED` exists (`:109`) — a marker written by `scrumux harness
deploy` — so the harness's own checkout, which has no marker, is never
touched by this wall (I-0121's whole point: editing the machinery here IS
the work). It runs on two PreToolUse chains, Edit|Write|NotebookEdit and
Bash (`:8-11`), because a denied Edit was once re-applied through a Bash
heredoc (I-0121, restated at `:99-101`).

The protected set (`is_protected`, `:126-134`) is four substring patterns:
`.claude/scripts/`, `.claude/hooks/`, `.claude/schemas/`, and
`agents/lib/*.py`. Matched as a *substring*, not an anchor — the comment at
`:112-116` explains this was chosen deliberately after I-0133: two anchor
forms (`*/.claude/scripts/*` OR `.claude/scripts/*`) both missed a relative
path inside a Python heredoc once arm 2's punctuation-stripping turned
`open('.claude/scripts/scrumux','a')` into
`open.claude/scripts/scrumux,'a'` — no leading slash, so neither anchor
matched. A substring test has no such blind spot.

Arm 1 (`:151-155`) reads `file_path` **or** `notebook_path` — a real
history line at `:147-150`: NotebookEdit sends `notebook_path`, not
`file_path`, and the wall used to look only at the latter, so every
notebook write walked past it silently. Arm 2 (`:157-306`) is a
hand-written classifier over the Bash command string, keyed on **what runs
a token**, not where it sits (`:166-188`). Its central insight, arrived at
after two false positives, is stated at `:27-49`: a path inside an
argument (`scrumux task new --check ".claude/scripts/graph is
unavailable"`) and a path being written to are the same string, and no
position-based rule can tell them apart — only the *command word* can.
`scan_line()` (`:202-271`) is a hand-rolled tokenizer that:

- classifies the first token of each `;`/`&&`/`||`/`|`-separated segment
  into `MUTATOR` (cp, mv, rm, ln, install, tee, dd, truncate, touch, chmod,
  chown, patch, ed, rsync, unzip, tar, shred, mkdir, rmdir — `:244-245`),
  `INTERPRETER` (python, python3, node, nodejs, ruby, perl, php, sh, bash,
  zsh, osascript — `:246-247`), `SED`/`GIT` (decided by their *next* token
  — `-i*` for sed/awk, one of `apply|checkout|restore|rm|mv|clean` for git
  — `:249-262`), or `BENIGN`;
- steps over `VAR=value` prefixes and the exec-wrapper words `env`, `sudo`,
  `time`, `nohup`, `exec`, `command` (`:243`) so the real command word still
  gets classified;
- blocks on a protected path when it is a redirect target (`:210-217`,
  `:225-230`), when the class is `MUTATOR` or `INTERPRETER` and the
  protected path appears anywhere in that segment (`:264-266`), or when the
  segment is inside a heredoc body, where **every** token is scanned
  because there are no command words at all inside program text
  (`:232-237`) — the I-0121 route.
- a newline ends a command exactly like a separator does (I-0136,
  `:273-304`), *except* when the previous line ends in `\` (continuation,
  `:299`) or a heredoc has been opened (`:295`, `:301`), in which case the
  class/position state must carry across the line break rather than reset.

`block()` (`:136-144`) records the denial through `walls_record` (best
effort, silenced — see below) and prints a message naming the wall, the
D-0078 boundary, the repo-local capture command
(`scrumux issue new --type harness ...`), the upstream remote **read out of
the marker file itself** (`jq -r '.source_remote // "the upstream harness
repository"' "$MARKER"`, `:140`) rather than hardcoded, and the I-0121
warning against re-routing.

Two guards run before any of this: a missing `jq` fails closed at
`:90-93` (before the `.claude/DEPLOYED` check — the comment at `:83-89`
explains why: a jq-less host cannot be trusted to have evaluated the
deployment state either, so refuse before even asking); and
`walls-lib.sh` is sourced (`:105`) purely for `walls_record` — this hook
carries **no** `project-walls.conf` logic, which is Deliberate looseness
below, not an oversight.

**`block-direct-llm.sh`** stops a shell command from reaching a known LLM
provider API domain directly. It is the shortest of the four walls — one
domain regex is its entire enforcement content (`:46-51`) — and per D-0086
(`RULINGS.md:95-114`) it **ships active everywhere**, not opt-in and not
inert-until-declared, with generic remedy text: the installation-specific
gateway detail (the declared gateway, three non-payload skills) moved out of
the shipped hook into each repo's own `.claude/rules/project-standards.md`,
while the wall itself and its blocking behaviour are unchanged. The rule
doc (`no-direct-llm-calls.md`) states the same split explicitly:
*"The principle is generic; the destination is this repo's to declare."*

Flow: read `.tool_input.command` (`:27`, exits 0 silently if empty,
`:28`); consult this repo's own `project-walls.conf` **first** —
`walls_allows` then `walls_refuses` (`:30-37`), the wall obeying its
owner before its own built-in judgement (P-29); then a **relevance gate**
at `:44` — `walls_can_call_out` or `walls_shell_dials` must be true before
the domain regex is even tried, so that `scrumux decide new --rationale
"we declare api.openai.com..."` (naming a provider in prose that reaches
nothing) is not treated as a call (the I-0132/I-0134/I-0135 family: match
the act, not the string, restated for a fourth wall at `:39-43`). Only
then is the domain regex run (`:46-51`), matched with `grep -Eqi` (case
insensitive — the test suite's "uppercase host" case at
`block-direct-llm-tests.sh:103` exists specifically for this). A match
records through `walls_record` and refuses with the generic message
template (`:49`) naming the gateway principle, `project-standards.md`,
the secret-set escape hatch, and the sanctioned `project-walls.conf allow`
route.

`walls_can_call_out` and `walls_shell_dials` (`walls-lib.sh:262-265`,
`:251-252`) are both built on `walls_cmd_words`, the shared quote-aware
awk tokenizer (`:162-231`) that is the single most load-bearing piece of
machinery either hook depends on. It:

- respects single- and double-quote state character by character so a
  separator inside a quoted argument is data, not structure (the
  motivating case at `:163-177`: a `--file` value containing a literal
  `|` used to split the command into three fake command words);
- strips a leading path down to its basename (`:202`, `.claude/scripts/x
  → x`) and strips `"'`()<>` punctuation (`:203`);
- steps over exec-wrapper words *and* non-mutating prefixers (`nice`,
  `ionice`, `timeout`, `xargs`, `stdbuf`, `setsid`, `flock`, `chrt`,
  `doas`) **and their own flag/value groups** (`:195-201`), and over
  `busybox`/`toybox` multiplexers, on the reasoning that "no real program
  word is a bare number" (`:198-200`) — this is P-27's "look at MORE,
  never less" strengthening, shared by every wall that sources this file;
- yields every line of a heredoc body as if it were a command line
  (P-27's other half), which is why `block-direct-llm-tests.sh:108`'s
  "heredoc body" case blocks.

`walls_record` (`walls-lib.sh:298-341`) is the shared, fully-swallowed
event-log writer both hooks call on a block: `mkdir -p ... || return 0`,
`command -v jq || return 0`, the jq append itself `... || :`, then an
unconditional `return 0` (P-08). Its subject and reason are the two
things a caller controls the size of: `%.200s` on the refused subject,
`%.400s` on the reason (`:304-305`) — and for both hooks the "subject"
passed is never the raw command line: `block-upstream-edit` passes the
protected path, `block-direct-llm` passes `walls_cmd_words | head -1`
(the leading command word), matching P-31's rule that the general event
stream (`.scrumux/events.jsonl`) gets a **safe subject only**, never a raw
command that could carry a secret in a flag.

---

## Deliberate looseness

1. **`block-upstream-edit` never consults `project-walls.conf`.**
   Registered: **P-23**. Every other conf-consulting wall lets the repo
   exempt itself; this one does not, on the reasoning that
   `project-walls.conf` lives *inside* the deployed repo and is agent-
   writable, and this wall protects the *upstream* from the repo, not the
   repo from the agent — an allow line here would let any agent exempt
   itself from D-0078 boundary 1 by writing one file (`:51-60`). Confirmed
   at the source: the hook sources `walls-lib.sh` (`:105`) purely for
   `walls_record`, never calls `walls_allows`/`walls_refuses`.

2. **`allow` wins over every built-in on `block-direct-llm`, including its
   own domain regex.** Registered: **P-29**. `walls_allows` is checked
   before the relevance gate and before the regex (`:30-37`,
   `walls-lib.sh:786-801` context). Confirmed in
   `project-walls-tests.sh:39-46` — one `allow api\.openai\.com | ...`
   line and the provider domain passes.

3. **A reasonless `allow`/`refuse` line in `project-walls.conf` is skipped
   and named on stderr, not silently active.** Registered: **P-28**,
   closed as **OQ-4** per D-0085 (`RULINGS.md:34-35`, `walls-lib.sh:57-74`).
   Both directions are already fixed in the current tree — confirmed
   reading `walls_field` (`:57-74`) and `project-walls-tests.sh:107-124`.

4. **An uncompilable conf pattern is skipped and named; the rest of the
   file still applies.** Registered: **P-28**. Per-pattern compile check
   against empty input (`walls_field:75-81`) before merging into one
   alternation — the fix for a single typo silently disabling every rule.

5. **`walls_refuses` fails closed (refuse) on a compile error; `walls_allows`
   fails closed (deny the exemption) on anything but a match.** Registered:
   **P-28**'s companion note. Two different codes, same direction — "when
   in doubt, refuse" — confirmed at `walls-lib.sh:88-92` (`return 1` on
   no-match) vs `:102-112` (`return 0` — refuse — on `grep` exit > 1).

6. **`walls_cmd_words` over-reports on purpose in two ways**, both used by
   `block-direct-llm`. Registered: **P-27**. (a) heredoc body lines are
   yielded as command words (`walls-lib.sh:158-161`, `:234-237` mirrored
   in `block-upstream-edit`); (b) exec-wrappers and non-mutating prefixers
   are stepped over, flag-group included (`:127-138`, `:174-179`). Both
   can only make a wall see *more*, never less.

7. **A domain named in prose is not a call.** Registered: NEW — same
   family as I-0132/I-0134/I-0135 (cited in **P-25**/**P-26** for other
   walls) but not itself an existing PHILOSOPHY.md entry for this hook.
   `walls_can_call_out(cmd) || walls_shell_dials(cmd)` must be true before
   the domain regex runs at all (`block-direct-llm.sh:44`), so
   `scrumux decide new --rationale "...api.openai.com..."` passes
   (`block-direct-llm-tests.sh:165-170`). Candidate for the register as
   its own numbered entry, since P-25/P-26 are written against the secret
   and destructive walls specifically.

8. **`walls_can_call_out` is a fixed word list**, structurally identical to
   `walls_can_read_file` which **OQ-11** already names as incomplete
   (missing `dd`, `nl`, `tac`, `bat`, `vim`, `view`, `ex`,
   `busybox`/`toybox`) and scheduled for a Phase-1a bash-first fix. The
   call-out list (`walls-lib.sh:263-264`: curl, wget, http(ie), nc, ncat,
   telnet, openssl, ssh, scp, rsync, and a set of language runtimes and
   package/cloud CLIs) has not been named anywhere as complete or
   audited. Registered: NEW — flagged as an open question below rather
   than asserted as a gap, since OQ-11 explicitly scopes only the
   secret-read list and this module's list was not part of that review.

9. **Command substitution and data-driven paths are an accepted inherent
   limit for both hooks.** Registered: **P-26**. `block-upstream-edit.sh
   :62-74` states its own version of this for arm 2 (cannot see a path
   built in a variable or reached via `cd` + relative name), and the
   general statement in `TS-MIGRATION-HANDOFF.md §5` covers
   `block-direct-llm` identically — a URL assembled via `$(...)` or built
   character-by-character defeats the domain regex. Not chased, by
   design (`DESIGN_SPEC.MD §4b`).

10. **A missing `jq` fails closed (exit 2, refuse) on both hooks**, not
    fail-open. Registered: **P-01/CLI-1** family — the general principle
    is stated once and applied per-wall; both hooks' own headers state it
    (`block-upstream-edit.sh:83-93`, `block-direct-llm.sh:19-25`).
    Confirmed in `walls-jq-absent-tests.sh:65-77` for direct-llm and
    `:102-110` for upstream-edit (whose jq guard fires *before* the
    `.claude/DEPLOYED` marker check is even reached, so a jq-less host
    fails closed regardless of deployment state).

11. **`walls_record`'s failure is fully silent and never changes whether
    the wall blocks.** Registered: **P-08**. Both hooks call it purely
    for its side effect; `block()` in `block-upstream-edit.sh:137-139`
    restates the same reasoning inline: *"a wall that fails because its
    bookkeeping failed would be worse than the write it prevented."*

12. **The refusal-recording ledger is deliberately gone from
    `block-direct-llm`'s own test file's living memory** — the suite
    comment at `block-direct-llm-tests.sh:56-57` and `:144-147` records
    that this wall **used to** write a `governance/gates.json` row per
    denial and no longer does (251 unread rows, T-0184-era contraction).
    Registered: NEW, adjacent to **P-43** (gates.json is unranked) but
    about a different journal (`gates.json` vs `.scrumux/events.jsonl`) —
    worth a register entry so a porter does not "restore" the gate row
    thinking it was dropped by accident.

13. **`block-upstream-edit`'s protected-path match is a substring test,
    not a path-boundary test.** Not registered anywhere as a looseness
    (P-23 covers the *conf* asymmetry, not this). Flagged: NEW. `case "$1"
    in *.claude/scripts/*)` matches `/abs/repo/.claude/scripts/scrumux`,
    `open.claude/scripts/scrumux` (post-strip), and would equally match a
    contrived path like `my-notes/.claude/scripts/appendix.md` if such a
    path existed under an app repo's own tree — the comment at `:112-116`
    treats this as intentional generosity ("a bare 'scripts/scrumux'
    still does not [match], and that is the part that matters"), so this
    is *already* a documented deliberate looseness, just not yet a
    PHILOSOPHY.md entry in its own right. Recommend folding into P-23's
    entry or a new P-number, User's call.

---

## Simplify/perf

- **BEHAVIOR-PRESERVING.** `walls_cmd_words` currently forks `awk` once
  per call and both hooks call functions built on it multiple times per
  invocation (`block-direct-llm.sh:34` inside `walls_reason`, `:44` via
  `walls_can_call_out`/`walls_shell_dials`, `:48` via `walls_record`'s
  subject). A single in-process tokenizer pass, memoized per command
  string for the lifetime of one hook invocation, reproduces the exact
  same token stream with zero subprocess spawns. This is pure
  performance — the awk program's character-by-character quote-state
  machine (`walls-lib.sh:182-231`) is the algorithm to port verbatim
  (P-27 requires the heredoc-yields-body and wrapper-skip behaviour be
  bit-for-bit preserved), just executed in-process.

- **BEHAVIOR-PRESERVING.** `walls_field`/`walls_allows`/`walls_refuses`/
  `walls_reason` each independently re-read and re-`sed` `project-walls.conf`
  from disk and re-run `grep -Eq` against a merged alternation, once per
  wall per hook invocation. Since a hook process is short-lived and the
  file cannot change mid-invocation, compiling the conf once (both
  `refuse` and `allow` pattern lists, plus their per-pattern
  validity/skip decisions per P-28/OQ-4) at the top of the hook and
  reusing the compiled `RegExp` objects for the remainder of the call is
  pure performance — the plan's own `conf compiled once per process`
  item names exactly this.

- **BEHAVIOR-PRESERVING.** No subprocess `jq` for reading `tool_input`:
  the PreToolUse payload is small, and TS reads it with `JSON.parse`
  directly. This does change what a **malformed-JSON stdin** does (jq's
  parse-error path is a shell fail-closed via `command -v jq` succeeding
  but the pipeline failing) — flagged below in Open questions rather than
  silently assumed equivalent.

- **OBSERVABLE — proposal only.** Fold looseness item 8 (`walls_can_call_out`'s
  word-list completeness) into whatever OQ-11's Phase-1a bash-first fix
  does for `walls_can_read_file`, auditing the call-out list the same
  pass. **What an operator would see change:** a command using a tool
  currently absent from the list (e.g. a bare `httpx`, `Invoke-WebRequest`,
  or a to-be-named gap) that reaches a provider domain today passes
  silently; after the audit it might block. This is a bash-first,
  pre-port change exactly like OQ-11's own scope — not something to
  decide inside the TS port itself. User rules whether it's worth
  auditing at all, since (unlike the secret-read list) no incident has
  been recorded against this one.

- **OBSERVABLE — proposal only.** Looseness item 13 (substring vs.
  path-boundary matching in `is_protected`) could be tightened to a
  path-segment-aware test (e.g. requiring the match to be preceded by `/`
  or start-of-string and followed by `/` or end-of-string) without
  losing the documented "bare scripts/scrumux still does not match"
  property. **What an operator would see change:** nothing in the
  documented cases; the only behavior change would be on a currently-
  unexercised contrived path (an app's own tree containing a directory
  literally named `.claude/scripts/` off-target) — vanishingly unlikely
  and not something the register or the tests currently probe. Not
  recommending this change; recording it as a theoretical seam only, in
  case User wants it named rather than silently ported as-is.

---

## Open questions

1. **OQ-11's fixed-word-list concern extends to `walls_can_call_out`
   without a matching decision.** `walls-lib.sh:263-264`. OQ-11 as
   written names only `walls_can_read_file` (the secret wall's reader
   list) as the item scheduled for a Phase-1a bash-first audit. Is
   `walls_can_call_out` — which gates `block-direct-llm`'s entire
   relevance check — in scope for the same audit, or intentionally
   excluded because no incident has been measured against it? If
   excluded, should this doc's item 8 above become its own PHILOSOPHY.md
   NEW entry so a future porter does not conflate the two lists' review
   status.

2. **POSIX ERE vs JS RegExp, for exactly the patterns these two hooks
   compile.** `block-direct-llm.sh:47` is a fixed, hardcoded
   alternation (not a `project-walls.conf`-sourced pattern), so **OQ-8**'s
   general question is *resolved* for this literal by D-0085/D-0086: it
   ships as written, translated once, and the property-test corpus
   (`ere.ts`, per the plan) needs a case pinned to it. What is **not**
   resolved by OQ-8's ruling and is specific to this module: both hooks
   also call into `walls_field`/`walls_allows`/`walls_refuses` over
   **user-authored** `project-walls.conf` patterns (`block-direct-llm.sh
   :32-37`; `block-upstream-edit.sh` does not, per looseness item 1, so
   this only touches direct-llm). OQ-8's three-way question (skip+name /
   fail-closed / validate at write time) governs those user patterns —
   confirm the D-0085 mirror line ("an untranslatable ERE fails closed
   on refuse lines, is skipped-and-named on allow lines") is the
   binding answer for this hook's own conf consultation, since D-0085's
   summary line does not repeat which walls it covers.

3. **`walls_cmd_words`'s awk-vs-JS quote-state parity is the single
   highest-risk translation surface both hooks share**, and is worth its
   own differential test file rather than being covered incidentally by
   each hook's suite. `walls-lib.sh:182-231` — the character scan handles
   nested single/double quotes, `;`/`&&`/`||`/`|` splitting, a lookahead
   for two-character operators (`&&`, `||`), heredoc detection is
   **not** handled inside this function at all (it is the *caller*'s
   `heredoc` state variable in `block-upstream-edit.sh:197`/`:234-237`
   that does that — `walls_cmd_words` itself has no heredoc awareness,
   worth noting since `block-direct-llm` does *not* have that separate
   heredoc-tracking loop and instead relies on P-27's "heredoc lines look
   like commands" property purely through `walls_cmd_words` seeing the
   heredoc body as ordinary lines it was fed). Confirm: does
   `block-direct-llm`'s heredoc case (`block-direct-llm-tests.sh:108`,
   "heredoc body") actually block *because* the domain string sits inside
   a body line that `walls_cmd_words` never distinguishes from a real
   command word, or because the interpreter that opened the heredoc
   (`curl ... -d @- <<EOF`) is itself the mutator? Reading `:108`'s
   payload (`curl https://api.anthropic.com/v1/messages -d @- <<EOF ...`)
   — the domain appears **before** the heredoc marker, on the curl
   invocation line itself, so this specific test does not actually probe
   heredoc-body scanning for `block-direct-llm` (unlike
   `block-upstream-edit`, which has real heredoc-body cases at
   `hook-upstream-tests.sh:152-155` and `:181-183`). Is a heredoc-body
   probe for `block-direct-llm` (a provider domain appearing only inside
   the `<<EOF ... EOF` body, past a first line that names no domain) an
   intentional gap in that suite, or worth adding before/during the port
   so parity is proven rather than assumed for this hook too?

4. **Locale/collation is not exercised by either suite for these two
   hooks.** `grep -Eqi` (case-insensitive match, `block-direct-llm.sh:47`)
   and every `grep -E`/`sed -E` call in `walls-lib.sh` run under whatever
   `LC_COLLATE`/`LC_CTYPE` the hook's environment carries — untested here
   (no `LC_ALL=C` pinning visible in either hook or in
   `walls-lib.sh`). JS `RegExp`'s `i` flag and its Unicode case-folding
   table do not exactly match POSIX `grep -Eqi`'s locale-dependent
   folding on every host. Practically low-risk for the ASCII-only domain
   list in `block-direct-llm.sh:47`, but the *user-authored*
   `project-walls.conf` patterns direct-llm also evaluates
   (`walls_allows`/`walls_refuses`, both called with `-i` implicitly via
   `walls_field`'s underlying `grep -Eqi` — confirmed at
   `walls-lib.sh:91`, `:105`) could contain non-ASCII text with
   locale-sensitive case folding. Not measured; flagged rather than
   assumed benign.

5. **`printf '%s' "$input" | jq -r '.tool_input.command // empty'`
   (`block-direct-llm.sh:27`) vs. a TS `JSON.parse` — behavior on
   malformed stdin.** jq's parse failure here is not caught by either
   hook (`cmd=$(... | jq -r ...)` — no `[ $? -eq 0 ]` check follows,
   unlike the `command -v jq` guard above it), so `cmd` becomes an empty
   string on a jq parse error and the hook exits 0 at `:28` **silently
   allowing the tool call**, indistinguishable from a genuinely-absent
   `command` field. `JSON.parse` throwing in the TS port must be made to
   reach the same outcome (treat as absent, allow) rather than crash the
   hook process — worth stating explicitly as a port requirement rather
   than leaving it to be discovered, since an uncaught throw in a
   PreToolUse hook process is a different failure shape (nonzero exit
   with no message vs. this shell's clean exit 0) and Claude Code's own
   contract for a hook that errors (not exit 2) is "the call proceeds"
   per `hook-upstream-tests.sh:47-48`'s comment — so the *outcome*
   (allow) would coincidentally match, but arriving at it via an uncaught
   exception rather than a deliberate `catch` is not the same
   implementation and should not be left implicit.

6. **`block-upstream-edit`'s `MARKER` read for `source_remote`
   (`:140`) has no fallback tested for a `.claude/DEPLOYED` that exists
   but is not valid JSON.** `jq -r '.source_remote // "the upstream
   harness repository"' "$MARKER" 2>/dev/null` — a jq parse failure on a
   corrupt marker file produces empty stdout from jq (redirected to
   /dev/null on stderr), and `_remote` becomes an empty string, not the
   `"the upstream harness repository"` fallback the `//` operator would
   otherwise supply (that fallback only fires on a `null`/missing key
   inside otherwise-valid JSON, not on a parse error, which produces no
   output at all). The refusal message then reads "...and redeploy in
   ." with a blank destination — no test in `hook-upstream-tests.sh`
   covers a corrupt `.claude/DEPLOYED`. Not asserted as a bug: absence of
   a test is not evidence the case was overlooked as deliberate or
   accidental, so recorded here for a ruling rather than silently
   "fixed" with a fallback the bash does not have.
