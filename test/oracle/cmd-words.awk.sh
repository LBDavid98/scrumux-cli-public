#!/bin/sh
# test/oracle/cmd-words.awk.sh — THE FROZEN AWK ORACLE. Do not "improve" it.
#
# This is `walls_cmd_words`'s awk program, lifted verbatim out of
# .deploy-claude/hooks/walls-lib.sh, wrapped so it can be driven directly:
#
#     printf %s '<command string>' | sh test/oracle/cmd-words.awk.sh
#
# WHY IT IS FROZEN, AND WHY IT OUTLIVES BASH. The tokenizer is the single
# highest-risk item in the whole port: three walls decide what to look at from
# its output, and every wall defect this project has paid for was the same
# shape -- reasoning about a command string without respecting its structure
# (I-0001, I-0132, I-0134, I-0135). A TypeScript state machine that agrees
# with it on today's fixtures has proved nothing; a TypeScript state machine
# that agrees with it on ten thousand generated cases per run has proved
# something, and it can only keep proving it if this file stays exactly as it
# is after .deploy-claude/hooks/ is deleted in Phase 6.
#
# So: this file is a COPY, deliberately. test/oracle/oracle.test.ts asserts it
# is still byte-identical to the awk inside walls-lib.sh for as long as that
# file exists, so the freeze cannot silently drift while bash is still live --
# and after bash retires, the copy is the record of what bash did.
#
# Its own behaviour is not asserted anywhere as "correct". It is the
# definition of correct.
set -u
exec awk '
    BEGIN { sq=0; dq=0; expect=1; tok=""; skipargs=0 }
    function flush_tok() {
      if (tok == "") return
      if (expect) {
        # VAR=value prefix: the real command is still ahead, expect stays set.
        if (tok ~ /=/) { tok=""; return }
        # An exec-wrapper or non-mutating prefixer: step over it, and mark that
        # its OWN flag group (options and their values) should be skipped so
        # the real program surfaces past `nice -n 10`, `timeout 5`, etc.
        # busybox and toybox are MULTIPLEXERS: the real program is their
        # first argument (`busybox cat .env`), so stepping over them is the
        # same "look at MORE" move as the prefixers beside them (D-0085).
        if (tok ~ /^(env|sudo|time|nohup|exec|command|nice|ionice|timeout|xargs|stdbuf|setsid|flock|chrt|doas|busybox|toybox)$/) { tok=""; skipargs=1; return }
        # While in a prefixer flag group, an option (-x, --foo) or a bare
        # numeric value (5, 10, a 5s/30m duration) belongs to the prefixer and
        # not to the command. No real program word is a bare number, so this
        # only ever skips a prefixer flag or value, never a command.
        if (skipargs && (tok ~ /^-/ || tok ~ /^[0-9]+[a-zA-Z]?$/)) { tok=""; return }
        skipargs=0
        sub(/^.*\//, "", tok)          # basename: .claude/scripts/x -> x
        gsub(/["\047`()<>]/, "", tok)
        if (tok != "") print tok
        expect=0
      }
      tok=""
    }
    {
      n=length($0)
      for (i=1; i<=n; i++) {
        c=substr($0,i,1)
        if (c == "\047" && !dq) { sq=!sq; continue }
        if (c == "\"" && !sq)   { dq=!dq; continue }
        if (sq || dq) { tok = tok c; continue }     # inside quotes: data
        if (c == " " || c == "\t") { flush_tok(); continue }
        if (c == ";") { flush_tok(); expect=1; skipargs=0; continue }
        if (c == "|") {
          if (substr($0,i+1,1) == "|") i++
          flush_tok(); expect=1; skipargs=0; continue
        }
        if (c == "&") {
          if (substr($0,i+1,1) == "&") { i++; flush_tok(); expect=1; skipargs=0; continue }
          flush_tok(); expect=1; skipargs=0; continue
        }
        tok = tok c
      }
      flush_tok()
      expect=1; skipargs=0                            # newline ends a command
    }
  '
