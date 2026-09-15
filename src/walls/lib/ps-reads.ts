/**
 * THE POWERSHELL ARMS OF WALLS 2 AND 4 — reads, and calls to a provider.
 *
 * Both walls ask the same shape of question the POSIX side does, and both
 * answers turn on the same doctrine: A STRING IN A COMMAND IS ONLY EVIDENCE OF
 * AN ACT IF THE COMMAND CAN PERFORM IT (I-0132/I-0134/I-0135). `scrumux decide
 * new --rationale "…api.openai.com…"` makes no request in PowerShell either,
 * so the provider list is consulted only where something can dial, and the
 * secret patterns only where something can read.
 *
 * ONE ALIAS CHANGES MEANING ACROSS THE TWO DIALECTS AND IT MATTERS HERE:
 * `curl` and `wget` on Windows PowerShell are ALIASES FOR
 * `Invoke-WebRequest`, not the programs. Both walls already treat the POSIX
 * `curl` as able to call out, so the verdict is unchanged — but the reason is
 * different, and a reader who assumed `curl` meant curl would conclude the
 * cover was there when the alias had been removed (`Remove-Item alias:curl` is
 * a thing people do). `cat` is the same story for reads: on Windows it is
 * `Get-Content`.
 */
import { psSegments, psTokenize, psCommandOf, psOperands, psNetCall, psFold, type PsToken } from './ps.js';

/**
 * Cmdlets and aliases that read a file's CONTENTS. The POSIX `READ_FILE` list
 * is unchanged and still consulted; this is the set that has no POSIX
 * spelling, plus the aliases that mean something different here.
 */
const PS_READERS = new Set([
  'get-content', 'gc', 'cat', 'type',
  'select-string', 'sls',
  'import-csv', 'import-clixml', 'convertfrom-json',
  'get-filehash',
  'copy-item', 'cp', 'copy', 'cpi',
  'move-item', 'mv', 'move', 'mi',
  'out-string',
  'get-item', 'gi',
  'send-mailmessage',
  // Piped destinations that a `Get-ChildItem | …` lands in.
  'foreach-object', 'foreach', '%', 'where-object', 'where', '?',
]);

/** Cmdlets and aliases that can reach the network. */
const PS_DIALERS = new Set([
  'invoke-webrequest', 'iwr', 'curl', 'wget',
  'invoke-restmethod', 'irm',
  'start-bitstransfer',
  'new-object',
  'invoke-expression', 'iex',
]);

/** `cp`/`mv`'s PowerShell spellings — their destination is written, not read. */
const PS_COPIERS = new Set(['copy-item', 'cp', 'copy', 'cpi', 'move-item', 'mv', 'move', 'mi']);

/** Can anything in this command read a file's contents? */
export function psCanReadFile(cmd: string): boolean {
  for (const seg of psSegments(cmd)) {
    if (PS_READERS.has(psCommandOf(psTokenize(seg)))) return true;
  }
  return psNetCall(cmd, ['IO\\.File', 'IO\\.StreamReader', 'Text\\.Encoding']);
}

/** Can anything in this command reach the network? */
export function psCanCallOut(cmd: string): boolean {
  for (const seg of psSegments(cmd)) {
    if (PS_DIALERS.has(psCommandOf(psTokenize(seg)))) return true;
  }
  // `New-Object Net.WebClient` and `[Net.Http.HttpClient]::new()` both dial
  // with no cmdlet name that says so.
  return psNetCall(cmd, ['Net\\.WebClient', 'Net\\.Http\\.HttpClient', 'Net\\.HttpWebRequest'])
    || /\bNew-Object\s+[\w.]*Net\.WebClient/i.test(cmd);
}

/**
 * Which operands of a PowerShell command are READS.
 *
 * THE cp/mv CARVE-OUT IS THE SAME ONE, IN THE OTHER DIALECT AND WITH ONE MORE
 * SPELLING TO HONOUR. `Copy-Item .env.example .env` reads no secret, so the
 * destination is dropped — but PowerShell can also name it as a PARAMETER
 * (`-Destination`), and when it does, EVERY positional operand is a source and
 * dropping the last one would let `Copy-Item -Destination C:\out .env`
 * exfiltrate. That is the exact shape GNU `cp -t DIR SRC…` has on the POSIX
 * side, and it is handled the same way and for the same reason.
 *
 * JUDGED PER SEGMENT, so a copy cannot launder a later reader:
 * `Copy-Item .env.example .env; Get-Content .env` still blocks on the read.
 *
 * A `[IO.File]::ReadAllText("…")` argument is not a token in the cmdlet sense
 * at all, so the literal inside its parentheses is harvested separately.
 */
export function psReadOperands(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of psSegments(cmd)) {
    const tokens = psTokenize(seg);
    const name = psCommandOf(tokens);
    // PER SEGMENT (SX-009): only a segment whose own cmdlet reads contributes
    // operands, so one reader elsewhere on the line cannot open the scan onto
    // prose or an existence check in another segment.
    if (name === '' || !PS_READERS.has(name)) continue;
    let ops: PsToken[] = psOperands(dropPsWriteTargets(tokens));
    if (PS_COPIERS.has(name)) {
      const inParam = tokens.some((t) => !t.quoted && /^-d(e(s(t(i(n(a(t(i(o(n)?)?)?)?)?)?)?)?)?)?$/i.test(t.text.split(':')[0] ?? ''));
      if (!inParam && ops.length >= 2) ops = ops.slice(0, -1);
    }
    // BOTH SEPARATORS, because the secret patterns are anchored on `/`, a
    // quote or a space and Windows writes `.\.env`. In `Get-Content
    // ".\.env"` the character before `.env` is a backslash, which is in
    // none of the anchor classes, so pushing a normalised COPY only adds
    // candidates and cannot narrow the answer.
    for (const o of ops) {
      if (o.text === '') continue;
      out.push(o.text);
      if (o.text.includes('\\')) out.push(o.text.split('\\').join('/'));
    }
    // A flag-attached path (`-Path .env`, `-LiteralPath .env`) is already an
    // operand by `psOperands`' rule that a parameter's VALUE stays a
    // candidate. What is not is a `-Path:.env` colon form, so it is split out.
    for (const t of tokens) {
      const i = t.text.indexOf(':');
      if (t.text.startsWith('-') && i > 0) {
        const v = t.text.slice(i + 1);
        if (v !== '' && !v.startsWith('$')) out.push(v);
      }
    }
  }
  // `[IO.File]::ReadAllText('.env')` — the .NET spelling, whose argument no
  // tokenizer sees as an operand.
  for (const m of cmd.matchAll(/::\s*\w+\s*\(\s*(["'])([^"']+)\1/g)) {
    out.push(m[2]!);
  }
  return out;
}

/**
 * Drop output-redirect targets (`> f`, `>> f`, `2> f`, `>f`) from a segment's
 * tokens: a redirect target is WRITTEN, so `cat > .env` creates a file rather
 * than reading one (SX-009). Input is untouched.
 *
 * Depends on: nothing. Pure.
 */
export function dropPsWriteTargets(tokens: readonly PsToken[]): PsToken[] {
  const out: PsToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!t.quoted && /^(?:[0-9*]*)>>?$/.test(t.text)) { i += 1; continue; }
    if (!t.quoted && /^(?:[0-9*]*)>>?./.test(t.text)) continue;
    out.push(t);
  }
  return out;
}

/** Every command word in the command, folded — for the record's subject. */
export function psFirstWord(cmd: string): string {
  for (const seg of psSegments(cmd)) {
    const n = psCommandOf(psTokenize(seg));
    if (n !== '') return psFold(n);
  }
  return '';
}
