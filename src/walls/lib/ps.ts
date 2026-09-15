/**
 * THE POWERSHELL DIALECT — the lexer the four walls' second arm is built on.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND DIALECT AT ALL
 *
 * On Windows without Git Bash, Claude Code does not register the Bash tool and
 * routes every shell command through the PowerShell tool. The wall bodies
 * parse bash-shaped commands, so on that machine they would read `Remove-Item
 * -Recurse -Force C:\repo` as a command with no `rm` in it and allow it. The
 * matcher fix makes the walls FIRE there; this file is what makes them SEE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT IS ADDITIVE, ON ITS OWN MERITS, WITH NOTHING ELSE CHECKING IT
 *
 * This dialect must never fire on POSIX-shaped input -- a PowerShell class
 * lighting up on an ordinary shell command line would double-report or
 * diverge from the POSIX wall's verdict. Nothing outside this file enforces
 * that (a parity oracle once checked it against bash's own walls; that
 * comparison retired with bash on 2026-09-03), so it has to hold by
 * construction. That is why nothing here triggers on a bare word: every
 * entry point demands PowerShell-SPECIFIC syntax — a cmdlet name with its
 * `Verb-Noun` hyphen, a `-Parameter` spelling, a `[Type]::` accessor,
 * `$env:`. The one deliberate overlap is the alias set (`rm`, `del`, `cat`,
 * `curl`), and each of those is only consulted alongside a PowerShell
 * parameter, so `rm -rf /x` stays the POSIX wall's business and reaches the
 * same verdict it always did.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR WAYS POWERSHELL DIFFERS FROM sh THAT A WALL HAS TO KNOW
 *
 *  1. IT IS CASE-INSENSITIVE. `REMOVE-ITEM`, `remove-item` and `Remove-Item`
 *     are one command. Every comparison here folds case; the POSIX sets stay
 *     case-SENSITIVE, because `RM` really is not `rm` to a shell.
 *  2. PARAMETERS MAY BE ABBREVIATED to any unambiguous prefix, so `-Recurse`
 *     is also `-Recurs`, `-Rec` and `-R`. Matching is therefore by PREFIX, and
 *     ambiguity is resolved in the STRICT direction: `-F` is read as `-Force`
 *     even though `-Filter` also starts with F. Over-reporting is the
 *     invariant this repo already holds its bash tokenizer to (P-27), and the
 *     cost of the strict reading is a block an operator can attest past, while
 *     the cost of the loose one is a silent delete.
 *  3. THE BACKTICK IS THE ESCAPE CHARACTER, not the backslash — and the
 *     backslash is an ordinary path character, which is why none of this can
 *     be borrowed from the POSIX tokenizer.
 *  4. A QUOTED PARAMETER IS NOT A PARAMETER. `Remove-Item "-WhatIf" x` passes
 *     the string `-WhatIf` as an ARGUMENT; only the bare token is the switch.
 *     Tokens therefore carry whether they were quoted, and the two exemptions
 *     that could disarm a wall — `-WhatIf` and the temp-path test — consult
 *     it. Without that, quoting `-WhatIf` would turn every delete into a
 *     no-op in the wall's eyes while PowerShell went ahead and deleted.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE INHERENT LIMIT, NAMED
 *
 * The POSIX side's is command substitution: `rm -rf $(cat target.txt)` names
 * its target in data the wall cannot read, and this repo declined to chase
 * it. The PowerShell equivalent is `Invoke-Expression` over a COMPUTED
 * string — `iex ("Remove-Item -Rec -For " + $p)` — and it is the same limit
 * for the same reason. What IS handled is the literal case: an `iex`, a
 * `-Command` payload or a `-EncodedCommand` blob whose text is right there
 * in the command line gets expanded and scanned, exactly as `sh -c "…"`
 * does on the POSIX side. A base64 payload is decoded because it is a
 * literal, not a computation; a concatenation is not.
 */

/** A lexed token, and whether any of it came from inside quotes. */
export interface PsToken {
  /** Quotes and escapes resolved. */
  text: string;
  /** True if any character came from inside a quoted run. */
  quoted: boolean;
}

/**
 * PowerShell's statement and pipeline separators, at the top level only:
 * `;`, `|`, `&&`, `||`, and a newline. `&&`/`||` are PowerShell 7 syntax and
 * a parse error in 5.1; splitting on them regardless is the safe direction,
 * because more segments means more command words seen, never fewer.
 *
 * `splitAmp` EXISTS FOR ONE CALLER. Splitting at `&` turns `echo x &>y.sh`
 * into a second segment whose first token is `>y.sh` — a glued redirect the
 * PowerShell scanner then blocked, while the POSIX scanner beside it sees
 * one token starting with `&` and misses it. That miss is a SHARED GAP this
 * repo reproduces rather than repairs (`walls-hardenE` pins it), so
 * repairing it here alone would be a divergence dressed as an improvement.
 * The redirect walk therefore asks for segments with `&` left intact; every
 * other caller wants it split.
 */
export function psSegments(cmd: string, splitAmp = true): string[] {
  const out: string[] = [];
  let cur = '';
  let sq = false;
  let dq = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i]!;
    if (c === '`' && !sq) { cur += c + (cmd[i + 1] ?? ''); i += 1; continue; }
    if (c === "'" && !dq) { sq = !sq; cur += c; continue; }
    if (c === '"' && !sq) { dq = !dq; cur += c; continue; }
    if (!sq && !dq) {
      if (c === ';' || c === '|' || c === '\n' || (c === '&' && splitAmp)) {
        // `||`, `&&` and `|` all end the segment; a single `&` at the START of
        // a token is the CALL OPERATOR and not a separator, but treating it as
        // one only splits more finely, and `psCommandOf` steps over a leading
        // `&` anyway.
        if ((c === '|' && cmd[i + 1] === '|') || (c === '&' && cmd[i + 1] === '&')) i += 1;
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Split one segment into tokens, resolving quotes and backtick escapes.
 *
 * Inside `'...'` PowerShell expands nothing and `''` is a literal quote;
 * inside `"..."` the backtick escapes and `""` is a literal quote. Reproduced
 * because the difference decides whether `"-WhatIf"` is a switch.
 */
export function psTokenize(seg: string): PsToken[] {
  const out: PsToken[] = [];
  let text = '';
  let quoted = false;
  let started = false;
  let sq = false;
  let dq = false;
  const flush = (): void => {
    if (started) out.push({ text, quoted });
    text = '';
    quoted = false;
    started = false;
  };
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i]!;
    if (sq) {
      if (c === "'") {
        if (seg[i + 1] === "'") { text += "'"; i += 1; continue; }
        sq = false;
        continue;
      }
      text += c;
      continue;
    }
    if (dq) {
      if (c === '`') { text += seg[i + 1] ?? ''; i += 1; continue; }
      if (c === '"') {
        if (seg[i + 1] === '"') { text += '"'; i += 1; continue; }
        dq = false;
        continue;
      }
      text += c;
      continue;
    }
    if (c === '`') { text += seg[i + 1] ?? ''; i += 1; started = true; continue; }
    if (c === "'") { sq = true; quoted = true; started = true; continue; }
    if (c === '"') { dq = true; quoted = true; started = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); continue; }
    // Grouping and redirection punctuation ends a token but is itself a token,
    // so `(Get-ChildItem x)` yields the cmdlet and `>file` yields the target.
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === ',') { flush(); continue; }
    text += c;
    started = true;
  }
  flush();
  return out;
}

/** Case-folded, for every comparison in this dialect. */
export function psFold(s: string): string {
  return s.toLowerCase();
}

/**
 * Wrappers whose real command is still ahead — the analogue of the POSIX
 * tokenizer's `env sudo time nohup` list, and stepped over for the same
 * reason: the program that matters is the one after them.
 */
const PS_WRAPPERS = new Set([
  'start-process', 'start', 'saps',
  'invoke-command', 'icm',
  'measure-command',
  'sudo', 'doas',
]);

/**
 * The command word of a segment, with the call operator, assignment prefixes
 * and wrappers stepped over. Returns '' when the segment names no command.
 *
 * `& 'C:\tools\rm.exe'` and `$out = Remove-Item x` both surface their real
 * command word here — the first because `&` is skipped, the second because a
 * token containing `=` in command position is an assignment prefix, exactly as
 * `VAR=value` is on the POSIX side.
 */
export function psCommandOf(tokens: readonly PsToken[]): string {
  for (const t of tokens) {
    const raw = t.text;
    if (raw === '') continue;
    if (raw === '&' || raw === '.') continue;                 // call / dot-source
    if (raw === '=') continue;
    if (/^\$[^=]*=?$/.test(raw)) continue;                    // $x   /  $x=
    if (/^\$[A-Za-z_:][\w:]*=/.test(raw)) continue;           // $env:FOO=1
    // A BARE PATH IS STILL A COMMAND WORD, and the basename is what names it:
    // `C:\Windows\System32\cmd.exe` and `./tool.exe` both report their leaf,
    // as the POSIX tokenizer's `sub(/^.*\//, "")` does.
    const leaf = raw.split(/[\\/]/).pop() ?? raw;
    const name = psFold(leaf);
    if (PS_WRAPPERS.has(name)) continue;
    return name;
  }
  return '';
}

/**
 * Does this token spell `-<name>`, allowing PowerShell's abbreviation?
 *
 * UNQUOTED ONLY. `"-Force"` is an argument to PowerShell, not a switch, so
 * honouring a quoted one would let a wall be disarmed by adding quotes — and
 * would equally let one be tripped by a filename that happens to look like a
 * switch. A parameter may also carry its value with a colon (`-Force:$true`),
 * which is why the name is cut there first.
 */
export function psHasParam(tokens: readonly PsToken[], name: string): boolean {
  const want = psFold(name);
  return tokens.some((t) => {
    if (t.quoted) return false;
    if (!t.text.startsWith('-') || t.text.startsWith('--')) return false;
    const body = psFold(t.text.slice(1).split(':')[0] ?? '');
    return body !== '' && want.startsWith(body);
  });
}

/**
 * `-WhatIf` — the one exemption in this dialect, and the reason it is safe.
 *
 * A cmdlet supporting ShouldProcess does NOTHING under `-WhatIf`; it prints
 * what it would have done. So a `-WhatIf` delete is not a delete, and blocking
 * it would be a wall refusing a dry run — which is how operators learn to
 * route around walls. `-Confirm` is deliberately NOT here: it prompts, and a
 * prompt can be answered yes, so a `-Confirm` delete is still a delete.
 */
export function psIsWhatIf(tokens: readonly PsToken[]): boolean {
  return psHasParam(tokens, 'WhatIf');
}

/** Positional (non-parameter, non-value) operands of a segment, after the command. */
export function psOperands(tokens: readonly PsToken[]): PsToken[] {
  const out: PsToken[] = [];
  let seenCmd = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.text === '' || t.text === '&' || t.text === '.') continue;
    if (!seenCmd) {
      if (/^\$/.test(t.text) || t.text === '=') continue;
      seenCmd = true;
      continue;
    }
    if (!t.quoted && t.text.startsWith('-')) {
      // A SWITCH TAKES NO VALUE AND A PARAMETER DOES, and this dialect cannot
      // tell them apart without a cmdlet's parameter table. The next token is
      // therefore kept as a candidate rather than skipped: a wall that looked
      // at fewer operands than the command has is a wall with a gap, and the
      // flag-attached path (`-Path .env`) is exactly the shape that matters.
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Cmdlets and aliases that RUN A STRING AS A COMMAND, plus the flags on
 * `powershell.exe`/`pwsh.exe` that do the same. This is the `sh -c` analogue,
 * and it is the reason `psExpand` exists.
 */
const IEX = new Set(['invoke-expression', 'iex']);
const PS_HOSTS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe']);

/**
 * Fold every literal command PAYLOAD in `cmd` into extra lines, so the class
 * detections see them as commands rather than as data.
 *
 * THE SAME DOCTRINE AS THE POSIX SIDE'S `sh -c` HANDLING, and structure-aware
 * for the same reason: a payload is expanded only when an `iex`, a PowerShell
 * host or a `-Command`/`-EncodedCommand` parameter surfaced as a real command
 * word, never when the word merely sits inside quoted prose.
 *
 * `-EncodedCommand` IS DECODED. It is base64 of UTF-16LE — a LITERAL, however
 * unreadable, and the single most common way a destructive PowerShell command
 * is written when somebody does not want it read. Decoding it is not chasing
 * the inherent limit; the limit is a string the wall would have to EXECUTE
 * something to learn, and this one is right there.
 */
function psExpandOnce(cmd: string): string[] {
  const extra: string[] = [];
  for (const seg of psSegments(cmd)) {
    const tokens = psTokenize(seg);
    if (tokens.length === 0) continue;
    // A HOST ANYWHERE IN THE SEGMENT, not only in command position.
    // `Start-Process cmd -ArgumentList "/c rd /s /q X"` walks straight
    // through a test anchored on the command word: that word is
    // `Start-Process`, which `psCommandOf` steps over to reach `cmd` -- but
    // `-ArgumentList` belongs to Start-Process, not to cmd, so such a test
    // sees a host with no payload parameter and a payload parameter with no
    // host. Asking whether the SEGMENT names a host answers both.
    const isHost = tokens.some((t) => PS_HOSTS.has(psFold(t.text.split(/[\\/]/).pop() ?? '')));
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      const lead = psFold(t.text.split(/[\\/]/).pop() ?? '');
      // `iex <string>` / `iex (…)` — every following token is program text.
      if (!t.quoted && IEX.has(lead)) {
        for (const rest of tokens.slice(i + 1)) if (rest.text !== '') extra.push(rest.text);
        continue;
      }
      if (!isHost || t.quoted) continue;
      const next = tokens[i + 1]?.text ?? '';
      if (next === '') continue;
      // cmd.exe TAKES ITS PAYLOAD AFTER `/c` OR `/k`, not after a `-` switch,
      // and `cmd /c "rd /s /q C:\repo"` is one keystroke away from any
      // PowerShell prompt. A dialect that only understood PowerShell's own
      // `-Command` was blind to the whole cmd.exe surface behind it.
      const slash = psFold(t.text);
      if (slash === '/c' || slash === '/k') { extra.push(next); continue; }
      if (!t.text.startsWith('-')) continue;
      const pname = psFold(t.text.slice(1).split(':')[0] ?? '');
      if (pname === '') continue;
      // `-e`, `-ec`, `-enc`, `-encodedcommand` all mean EncodedCommand to
      // powershell.exe — including the SINGLE letter. `-ex` is
      // ExecutionPolicy and is not a prefix of `encodedcommand`, so the two
      // do not collide.
      if ('encodedcommand'.startsWith(pname)) {
        // Only attempt a decode on something base64-SHAPED. Feeding an
        // ordinary word to the decoder yields mojibake that widens the scan
        // with noise, and noise in a wall's input is how false positives get
        // in.
        if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(next)) {
          const dec = Buffer.from(next, 'base64').toString('utf16le');
          if (dec !== '') extra.push(dec);
        }
        continue;
      }
      // `-Command` / `-c`, and `-ArgumentList` / `-Args` for Start-Process.
      if ('command'.startsWith(pname)) extra.push(next);
      else if ('argumentlist'.startsWith(pname) || 'args'.startsWith(pname)) extra.push(next);
    }
  }
  return extra;
}

export function psExpand(cmd: string): string {
  // TO A FIXED POINT, up to a small bound. `pwsh -c "iex 'Remove-Item …'"` is
  // TWO layers — the host's `-Command` payload, and then the `iex` inside it —
  // and a single pass yielded the `iex …` line without ever looking at what
  // `iex` was given. The bound is what keeps a self-referential command from
  // expanding forever; three rounds covers every nesting anyone has a reason
  // to write, and the limit is the same one the header names: a payload that
  // must be COMPUTED to exist is not reachable by any number of rounds.
  let out = cmd;
  for (let round = 0; round < 3; round += 1) {
    const extra = psExpandOnce(out);
    if (extra.length === 0) break;
    // A cmd.exe ARGV STILL CARRIES ITS `/c`, and the command starts after it.
    // `Start-Process cmd -ArgumentList "/c rd /s /q C:\repo"` yields the whole
    // argument list as one payload line, whose first token is `/c` — so every
    // command-word test read `c` as the program and found no remover. Cutting
    // the switch here rather than in each caller keeps the payload lines a
    // uniform shape: whatever produced them, a line is a command.
    const cleaned = extra.map((e) => e.replace(/^\s*\/[cCkK]\s+/, ''));
    const next = `${out}\n${cleaned.join('\n')}`;
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Does `cmd` contain a `[Type]::Method(` accessor naming one of `names`?
 * `[IO.File]::ReadAllText(...)` and `[System.IO.File]::WriteAllText(...)` are
 * ordinary .NET calls that read and write files with no cmdlet in sight, so a
 * dialect that only knew cmdlet names would be blind to them.
 */
export function psNetCall(cmd: string, names: readonly string[]): boolean {
  for (const n of names) {
    const re = new RegExp(`\\[[\\w.]*\\b${n}\\s*\\]\\s*::`, 'i');
    if (re.test(cmd)) return true;
  }
  return false;
}
