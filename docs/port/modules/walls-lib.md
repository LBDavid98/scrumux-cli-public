# Module inspection — `walls-lib.sh`

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**File:** `.claude/hooks/walls-lib.sh` (342 lines, read in full).
**Callers:** `block-direct-llm.sh`, `block-secret-reads.sh`, `block-destructive.sh`
(all three source it and consult `project-walls.conf` before their own
built-in patterns — P-29), and `block-upstream-edit.sh` (sources it for
`walls_record` only, and *deliberately* never calls `walls_allows` /
`walls_refuses` — P-23; that asymmetry belongs to the caller, not this file,
and is not re-litigated here).
**Tests:** `tests/project-walls-tests.sh` (143 lines, entirely about this
module — the one pathway a repo extends the wall layer through),
`tests/hook-secret-tests.sh` (I-0142 shell-level reads, the busybox/toybox
step-over, the `.example` per-operand split), `tests/hook-destructive-tests.sh`
(CLI-4 quote-awareness, the wrapper/flag-group step-over, OQ-17 `rm` long
flags — the last of which is `block-destructive.sh`'s own regex, exercised
*through* this module's tokenizer but not implemented in it).

---

## Intent

This file is **sourced, never executed** (line 1's own header). It gives the
four walls three things: (1) the one repo-extensible config pathway
(`project-walls.conf`), (2) a shared, quote-aware command tokenizer so a wall
reasons about what a command *runs* rather than what string it contains, and
(3) a fire-and-forget event recorder. Nothing in this file makes a
block/allow decision on its own — it is decision *material* for its callers.

**`project-walls.conf` pathway (lines 26–130).**
`walls_pattern_of` (33–35) strips the verb and the `| reason` suffix from one
conf line, splitting on the **last** pipe via `sed -E "...; s/[[:space:]]*\|[^|]*$//; ..."`
— deliberately, because splitting on the first pipe truncates a pattern that
legally contains one (comment at 30–32, e.g. `refuse (foo|bar)\.env`).

`walls_field` (49–85) is the validation gate: it reads the conf, comments out
`#...` (51), filters to lines starting with the given verb and containing a
pipe (52–53), then for **each line individually**:
- extracts the pattern (55) and skips a genuinely empty one (56);
- extracts the reason the same way `walls_reason` will (70) and, if it is
  empty or whitespace-only, **names the rule on stderr and skips it** (71–74)
  — `project-walls.conf: ignoring a %s rule with no reason, so the rest still
  apply: %s`;
- compiles the pattern alone against empty input (`printf '' | grep -Eq --
  "$_wf_p"`, 77) and treats **only** exit 2 as "will not compile" (78), naming
  and skipping it the same way (79) — `project-walls.conf: ignoring an
  invalid %s pattern, so the rest still apply: %s`.

Surviving patterns are joined into one alternation with `paste -sd'|' -` (84).
Compiling *per pattern before merging* is the load-bearing mechanism: the
comment at 40–45 states the measured failure it replaced — one uncompilable
pattern used to invalidate the whole merged alternation, so `grep` exited 2
and `walls_refuses` (which at the time returned grep's raw status) read that
as "not refused", silently disabling **every** refuse rule in the repo from
one typo.

`walls_allows` (88–92) and `walls_refuses` (102–112) both call `walls_field`
fresh and test the caller's string against the merged alternation with
`grep -Eqi`. They are **asymmetric on purpose** in their failure direction:
`walls_allows` returns 1 (not exempt) on anything but a real match (90) —
fail closed on the exemption side. `walls_refuses` inspects grep's exit code
explicitly: `_wr_rc -gt 1` prints a named stderr line and **returns 0** —
refused — rather than trusting grep's status (107–110). The comment (96–101)
states why: every surviving pattern was already compiled individually, so
`>1` here means "the impossible happened," and on a refusal wall the safe
answer to an impossible state is to refuse, not to wave the act through. This
is the fix for the same bug class `walls_field`'s per-pattern check closes,
one layer up.

`walls_reason` (116–130) re-derives which single rule matched (there is no
memoization from `walls_refuses`/`walls_allows` — the string is tested a
second time, pattern by pattern, until one hits) and returns the text after
its last pipe, so a refusal can say *whose* rule fired.

**The tokenizer, `walls_cmd_words` (162–232).** This is the piece the port
plan names as the highest-risk item — reproduce it as a frozen oracle. It is
one `awk` invocation doing a single character scan with explicit quote state
(`sq`, `dq`), because the comment at 163–177 documents a measured false
positive: a shell `for w in $CMD` loop (or any separator split that ignores
quoting) reads `;`, `|`, `&&` **inside a quoted argument** as structure, so a
`--rationale "we refuse rm -rf outside temp"` yielded a bogus `rm` command
word and tripped the destructive wall on prose that ran nothing (I-0001).

Per-character state machine, walking `$1` byte by byte (211–227):
- `'` toggles `sq` unless inside `"` (213); `"` toggles `dq` unless inside `'`
  (214) — so mismatched-quote-type nesting behaves like a real shell.
- Inside either quote state, every character (including separators) is
  appended to the token as data (215).
- Outside quotes: space/tab flushes the current token (216); `;` flushes and
  resets to "expecting a new command" (217); `|` flushes on `|` and also
  swallows a following `|` for `||` (218–221); `&` flushes and swallows a
  following `&` for `&&`, or flushes alone for a bare background `&`
  (222–225); anything else accumulates (226).
- End of string: `flush_tok()` runs once more, and `expect`/`skipargs` reset
  for the next call (228–229) — **a newline ends a command**, so a multi-line
  string is scanned as if each line were reset to a fresh command start; this
  method receives the whole string in one `printf '%s' "$1"` call, so awk's
  own record/line splitting on `\n` inside the main block never actually
  triggers per this invocation's usage (the string arrives as one `$0`
  record only when it contains no embedded newline in the input mechanism —
  see Open Questions for what happens when it does).

`flush_tok()` (184–208) is where "is this a command word, a prefix, or a
wrapper" gets decided, and only when `expect=1` (i.e., this token is in
command position, the first word after a separator):
- A token containing `=` while `expect` is set is a `VAR=value` prefix: it is
  discarded and `expect` **stays** 1, so the scan keeps looking for the real
  command past any number of env-assignment prefixes (188).
- A token matching the wrapper alternation
  `env|sudo|time|nohup|exec|command|nice|ionice|timeout|xargs|stdbuf|setsid|flock|chrt|doas|busybox|toybox`
  is discarded, and `skipargs=1` is set (195) — the real program is still
  ahead, and (for the non-mutating prefixers in that list) its own flags and
  values need to be skipped too.
- While `skipargs` is set, a token starting with `-` (an option) **or**
  matching `^[0-9]+[a-zA-Z]?$` (a bare duration-shaped value like `5`, `10`,
  `30m`) is discarded and treated as belonging to the prefixer, not the
  command (200). Anything else clears `skipargs` and falls through to being
  treated as the real command word.
- The surviving token is basename'd (`sub(/^.*\//, "", tok)`, 202 — so
  `.claude/scripts/scrumux` reports as `scrumux`), stripped of
  `"'`()<>` (203), printed if non-empty, and `expect` clears (204–205) so
  later words in the same segment are not re-classified as command position.

**The two callable readers, `walls_can_call_out` / `walls_can_read_file`
(262–271).** Both pipe `walls_cmd_words` output through
`grep -qxE` (exact whole-line match, so a program named `catfish` does not
match `cat`) against a fixed alternation of program names. `walls_can_read_file`
already carries the D-0085/Phase-1a widening — `dd nl tac bat vim view ex`
and the shell dot-source form `\.` — confirming Phase 1a's bash-first fix
(OQ-11) has already landed in the tree this document was written against.

**Shell-level reads that never spawn a program (`walls_shell_reads`,
`walls_shell_dials`, 245–253).** `walls_cmd_words` answers "which *program*
runs", which is blind to `read K < .env`, `X=$(<.env)`, and
`exec 3<>/dev/tcp/host/443` — the shell itself opens the fd or the socket
and no program word ever appears. These two functions are **raw `grep -qE`
over the whole command string**, not routed through the tokenizer at all —
see Open Questions for what that costs.

**`walls_record` (298–341).** Appends one `wall` event to
`.scrumux/events.jsonl` and is engineered to be unable to fail the caller:
no writable `.scrumux/` → `return 0` (300); no `jq` on `PATH` → `return 0`
(301); the `jq` append itself ends `2>/dev/null || :` (339); the function's
last line is an unconditional `return 0` (340). This is P-08 verbatim, and
this file is P-08's cited origin. Two truncations are load-bearing:
`%.200s` on the refused subject, `%.400s` on the reason (304–305) — the
comment at 290–292 states the reason the *subject* must already be safe
(never a raw command line, which can carry a secret in a flag) before it
reaches this function; the truncation is stated as a **second** line of
defence, not the first. `sessionId`/`subAgent` are `.session_id // null` /
`.agent_id // null` (316, 331) — never a manufactured placeholder, with
inline comments explaining *why not* (a wall fires from bare CLI runs with
no session at all, and "unknown" was previously grouped into a session that
looked permanently open).

---

## Deliberate looseness

| # | What is loose | Philosophy item |
|---|---|---|
| 1 | `walls_record` swallows every failure path (no dir, no `jq`, failed append) and always returns 0; recording never gates whether a wall blocks. | **P-08** — this file is its cited origin (lines 298–341, early returns 300/301, silenced append 339, unconditional return 340). |
| 2 | One bad `project-walls.conf` pattern is skipped and named on stderr; the rest of that repo's rules still apply. | **P-28** (lines 49–85). |
| 3 | `walls_allows` fails closed by returning "not exempt" on anything but a real match; `walls_refuses` fails closed by returning "refused" on a grep error >1 — two different codes, same direction, stated as deliberately asymmetric. | **P-28** (lines 88–112). |
| 4 | `allow` is checked before every built-in pattern in three of the four walls, so a repo can exempt itself from a built-in wall with one written-down line — this file supplies the primitive; the ordering itself is enforced by the callers. | **P-29** (this file: 88–92; ordering lives in `block-*.sh` call sites). |
| 5 | A conf rule whose reason (text after the last pipe) is empty or whitespace-only is silently **skipped and named** on both the refuse and allow sides — the fail-open direction. | **P-28 / OQ-4**, and the fix is already present in the tree at lines 56–74 (matches D-0085; `tests/project-walls-tests.sh:105-139` exercises it directly). |
| 6 | Heredoc body lines are yielded by `walls_cmd_words` as if they were commands — over-reporting, stated explicitly as the safe direction. | **P-27** item 1 (comment at lines 158–161). |
| 7 | Non-mutating wrapper prefixes (`env sudo time nohup exec command nice ionice timeout xargs stdbuf setsid flock chrt doas busybox toybox`) are stepped over, including their own flag/value group, so the real program underneath always surfaces to the walls that source this file. | **P-27** item 2 (lines 145–232, wrapper regex at 195, flag-group skip at 200). |
| 8 | `walls_shell_reads` / `walls_shell_dials` match against the **raw, unstructured command string** rather than through the quote-aware tokenizer — the opposite discipline from `walls_cmd_words`. | **NEW** — no PHILOSOPHY.md entry covers this. See Open Questions OQ-W1; not clearly a looseness or a tightening, which is why it is raised there instead of asserted here. |
| 9 | `walls_allows` / `walls_refuses` / `walls_reason` all match case-**insensitively** (`grep -Eqi`) against conf patterns; nothing in the file, its comments, or PHILOSOPHY.md states this as a choice. | **NEW** — candidate for the register. Lines 91, 105, 125. Consistent with the "look at MORE, never less" instinct stated for P-27 (a case-insensitive refuse pattern can only catch more, never fewer, commands), but it is undocumented as a decision and the compile-check at line 77 does **not** use `-i`, so a pattern's *validity* is never tested under the mode it is actually matched with. |
| 10 | `walls_field`'s per-pattern compile probe (`printf '' | grep -Eq -- "$_wf_p"`, line 77) runs against **empty input**, so it proves the pattern is syntactically valid ERE, never that it is *useful* — a pattern that can never match anything (compiles, matches nothing, ever) passes silently. | Not previously registered; low-stakes (a no-op rule is inert, not unsafe) but worth naming since a port with a real regex engine could trivially detect an unsatisfiable pattern and would be tempted to warn on it. **NEW**, flagged only for completeness — not proposed. |

---

## Simplify/perf

**BEHAVIOR-PRESERVING**

- **Compile `project-walls.conf` once per process, not once per call.**
  Today, a single hook invocation that calls `walls_allows`, then
  `walls_refuses`, then `walls_reason` (the exact sequence in
  `block-destructive.sh:104-106` and siblings) re-reads and re-parses the
  conf file from scratch three separate times, each re-spawning `sed`,
  `grep`, a `while read` subshell, and `paste`. A TS port can parse the conf
  once per process invocation into a structured rule list (verb, compiled
  pattern, reason, valid/skip-reason) and have `allows`/`refuses`/`reason`
  all read the same structure — as long as the skip-and-name stderr lines
  still fire exactly once per invocation (today they also fire three times
  per invocation, once per re-parse; a single-parse port changes this to
  once — see the OBSERVABLE item below for the caveat).
- **No subprocess `jq`/`grep`/`sed`/`awk`/`paste` per call.** The whole
  pathway — pattern extraction, reason extraction, per-pattern compile
  check, matching, and the tokenizer itself — becomes in-process string/
  regex operations. This is exactly the class of change the port plan and
  PHILOSOPHY.md's closing section pre-approve (P-27's "look at MORE never
  less" invariant and the fail-open/fail-closed asymmetries must be
  reproduced in the *outcome*, not in the *mechanism* of shelling out).
- **`walls_cmd_words` as a hand-written character state machine**, not a
  regex-based re-implementation. The awk version is explicitly a character
  scan with quote state because the comment at 179–181 states a regex/
  parameter-expansion approach would be "slower and far harder to read" —
  that reasoning applies unchanged to a TS port; a state machine mirroring
  `sq`/`dq`/`expect`/`skipargs`/`tok` one-for-one is the safest reproduction
  and the plan's own "frozen oracle" strategy (differential-test the TS
  tokenizer against the live awk on a corpus) depends on structural
  fidelity, not just matching output on today's fixtures.
- **`walls_record` without a `jq` subprocess**: build the JSON object
  directly (the shape is fixed and known — `v, id, sessionId, subAgent,
  repoPath, at, kind, wall, refused, reason, sanctionedPath`), applying the
  two truncations as plain string slicing. Preserve the never-throws
  contract with try/catch around the whole function, not with shell's
  `|| :`.

**OBSERVABLE**

- **Re-parsing the conf once per process (above) changes how many times a
  named skip line prints.** Today, an invalid or reasonless conf rule is
  named on stderr once per `walls_field` call — and a single hook run can
  call it three times (`allows` for the allow verb, `refuses` and `reason`
  for the refuse verb, `reason` again if a match is found). An operator
  running that hook manually against a conf with one bad rule sees the
  warning **once** if the port parses once per process, versus **up to
  three times** today. This is a visible reduction in duplicate stderr
  noise, not a change to what is refused or allowed — but it is an
  observable difference and needs a ruling before landing, per the
  anti-strictness register's own rule that even a "clearly better" change
  is User's to accept.
- **Quote-aware `walls_shell_reads`/`walls_shell_dials`** (routing them
  through `walls_cmd_words`-style segment awareness instead of a raw
  whole-string grep) would stop a quoted, non-executing mention of
  `< .env` or `/dev/tcp/...` inside prose (a `--rationale` or `--summary`,
  the same shape of false positive P-27's header names for the tokenizer
  itself) from tripping these two checks. An operator would see fewer
  refusals on governance commands that merely *discuss* a shell-read idiom
  in a string argument. Proposal only — not applied; see Open Questions
  OQ-W1 for why this is not clearly a bug to begin with.
- **Tightening the prefixer numeric-value skip** (`^[0-9]+[a-zA-Z]?$` at
  line 200) to not swallow a real program name shaped like `7z` when it is
  the first word after a wrapper (`nice 7z x archive.7z`). An operator
  would see such a wrapped invocation newly reach the walls that source
  this file, where today it silently does not. This would make a wall
  **strengthen** in one narrow case — the direction P-27 already treats as
  safe in general — but it is still a change in what fires, so it is listed
  here rather than assumed. See Open Questions OQ-W2.

---

## Open questions

### OQ-W1 · `walls_shell_reads` / `walls_shell_dials` are not quote-aware

`walls_cmd_words` exists specifically because a raw substring/separator
match over an unparsed command string produces false positives on quoted
prose (I-0001, the motivating incident documented at lines 163–177). But
`walls_shell_reads` (245–247) and `walls_shell_dials` (251–253) are
themselves raw `grep -qE` over the **entire, unstructured** command string —
no quote state, no segment boundary. A command like
`scrumux issue new --summary "never leave a socket open on /dev/tcp/host/1"`
would be matched by `walls_shell_dials`'s `/dev\/(tcp|udp)\// ` pattern
exactly the same way a real `exec 3<>/dev/tcp/host/1` would, because both are
just substrings of the same raw string. Likewise a `--check` string
containing literal ` < .env` text (a numeric-comparison-shaped fragment, or a
literal instruction) would trip `walls_shell_reads`'s redirection heuristic.

I could not find a comment, a ruling, or a test asserting either the "this is
fine, false positives here are rare/acceptable" reading or the "this is a
known gap, chase it in Phase 1a" reading — nothing addresses it at all.
`tests/hook-secret-tests.sh:109-119` tests real evasions (`read K < .env`,
`X=$(<.env)`) but no test in the suite asserts that a *quoted, non-executing*
mention of the same substring is left alone the way the tokenizer-based
checks are proven to leave quoted prose alone. **Question for User:** is
this an accepted, un-chased inherent limit in the same family as P-26
(command substitution, data-driven paths), a candidate for the same
bash-first Phase-1a treatment as OQ-11, or simply unnoticed? Not fixed here;
the port reproduces the raw-string match exactly as written.

### OQ-W2 · The numeric-value skip in the wrapper flag-group step-over can swallow a real program name

`flush_tok()`'s comment at line 199 states as fact: *"No real program word is
a bare number, so this only ever skips a prefixer flag or value, never a
command."* The regex it relies on, `^[0-9]+[a-zA-Z]?$` (line 200), matches
not just bare numbers and duration-shaped values (`5`, `10`, `30m`) but also
any real program name shaped like digits-plus-one-letter — `7z` being the
concrete, shipping example (the archiver). `nice 7z x archive.7z` would have
its `7z` token discarded as if it were a prefixer's numeric argument, so the
real program is never yielded to the wall's word list in that position —
the opposite of the "can only strengthen, never weaken" property claimed for
every other part of the wrapper/flag-group mechanism (P-27 item 2). I found
no comment or ruling addressing this specific shape.

Not verified as a live problem in this repo (no wall pattern currently
depends on catching `7z`), and it is narrow — it only fires when the
swallowed token is both digit-prefixed-single-letter-suffixed **and** is the
first token immediately after a wrapper/prefixer word. **Question:** is this
worth a bash-first fix under the same Phase-1a umbrella as OQ-11 (tighten
the regex to require ≥2 digits, or exclude it via a short denylist of
known program names shaped this way), or left as a documented residual
limit? Not fixed here; the port reproduces the regex exactly, including this
gap.

### OQ-W3 · Case-insensitive conf matching is undocumented, and the compile check does not exercise it

`walls_allows`, `walls_refuses`, and `walls_reason` all match with
`grep -Eqi` (case-insensitive) — lines 91, 105, 125 — while `walls_field`'s
own per-pattern compile probe (line 77) uses plain `grep -Eq`, no `-i`. For
POSIX ERE this distinction essentially never affects whether a pattern
*compiles* (case-folding is a matching-time flag, not a syntax concern), so
I do not believe this is a live risk — but it is worth naming for the TS
port for two reasons: (1) whatever case-insensitivity is reproduced (a JS
`RegExp` with the `i` flag) should be applied consistently to the actual
matching in `walls_allows`/`walls_refuses`/`walls_reason` and *not* silently
extended to or dropped from the compile-validity check, since a divergence
there would be a silent behavior change either way; (2) nothing in the file
or PHILOSOPHY.md documents *why* case-insensitivity was chosen at all — it
reads as a reasonable default (a repo's `refuse DROP TABLE` rule should
presumably also catch `drop table`) but no comment says so. **Question:**
should this be added to PHILOSOPHY.md as a named, confirmed-deliberate
looseness (my read: yes, on the "look at more never less" logic already
applied elsewhere in this file), or is it worth asking whether case
sensitivity was ever actually considered? Not changed here either way.

### OQ-W4 · POSIX ERE vs JS RegExp for arbitrary repo-authored patterns

This is OQ-8 in PHILOSOPHY.md, restated here because it is entirely this
module's surface: every pattern this file evaluates — the four built-in
word lists are fixed alternations, but every `project-walls.conf` line is
**caller-authored** POSIX ERE, evaluated today by `grep -E`/`grep -Eqi`.
Backreferences, `\d`/`\w`/`\b` (not ERE; `grep -E` treats them as literals on
some platforms), POSIX bracket classes (`[[:alpha:]]`), leftmost-longest
alternation semantics, and unescaped `{` all have the potential to compile
and match differently under JS `RegExp`. `walls_field`'s per-pattern compile
check (line 77) means a pattern JS's engine rejects would be silently
skipped-and-named exactly like an invalid pattern is today — which, on a
`refuse` line, is the fail-**open** direction for that one rule. Per
PHILOSOPHY.md OQ-8, resolution (skip vs. fail-closed vs. reject at write
time) is User's call and is not decided here; flagged again because this
file is where the translation layer's residual risk actually lives, not
where it is theoretical.

### OQ-W5 · Does `walls_cmd_words` ever receive a string containing an actual embedded newline, and if so, how does awk's own record splitting interact with `expect`/`skipargs` reset?

The function is invoked as `printf '%s' "$1" | awk '...'` (182) — a single
`printf` with no trailing newline appended by the format string itself, but
`$1` (the raw hook-provided command string) can itself contain literal `\n`
characters (a multi-line Bash tool command, or a heredoc body — which is
explicitly meant to be scanned per P-27 item 1). awk treats each `\n`
inside its input as ending one record and starting the next, and the main
block's last two lines (`flush_tok(); expect=1; skipargs=0`) already handle
"newline ends a command" *within* a single execution of the block — but
that block runs once per **record**, i.e., once per line, via awk's normal
record loop, not once for the whole string. I read this as correct (each
line is scanned independently, quote state variables `sq`/`dq` are declared
in `BEGIN` so they persist *across* records/lines — which is exactly what
heredoc-body-as-commands and multi-line quoted strings need) but I want to
name explicitly that quote state **carrying across a newline** is what makes
a multi-line quoted argument continue to be treated as data rather than
re-entering command position mid-string, and this is worth an explicit test
case (a Bash tool command whose `--rationale` value itself spans multiple
lines with an embedded `;`) before the TS state machine is considered
verified against the awk oracle — I did not find such a test in the three
suites read. Not a claimed defect; a coverage gap in the parity spec to
close before porting, not after.
