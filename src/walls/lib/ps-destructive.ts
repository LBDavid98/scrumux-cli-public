/**
 * THE POWERSHELL ARM OF WALL 1 — the same three classes, in the other dialect.
 *
 * THE SCOPE STAYS NARROWER THAN "DESTRUCTIVE" (P-32). The POSIX wall blocks
 * three classes and nothing else — recursive-force delete, database purge, git
 * history destruction — by User's explicit v1 selection, and this arm maps
 * onto THOSE THREE rather than taking the opportunity to grow. Two members
 * join the delete class because they are the same act with no POSIX spelling
 * (`Clear-Content`, which destroys a file's contents in place, and
 * `Format-Volume`, which is the act at the scale of a disk); nothing else is
 * added. In particular `Set-Content` and `Out-File` are NOT here, though they
 * overwrite: POSIX `>` overwrites too and this wall allows it, and the case
 * that matters — overwriting the machinery — belongs to `block-upstream-edit`,
 * which owns the notion of a protected path and gained exactly those cmdlets.
 *
 * THE ATTESTATION HAD TO GAIN A POWERSHELL SPELLING, or the sanctioned path
 * would not exist on Windows. POSIX shells attest with an env-assignment
 * PREFIX in command position (`HARNESS_BACKUP_DONE=1 rm -rf x`), which is
 * shell syntax PowerShell does not have; the PowerShell way to say the same
 * thing is `$env:HARNESS_BACKUP_DONE=1; Remove-Item …`. A wall that blocked
 * the act and offered a remedy nobody on that platform could type would be a
 * wall people route around, which is the failure P-29 names.
 */
import { psSegments, psTokenize, psCommandOf, psFold, psHasParam, psIsWhatIf, psOperands, psNetCall, type PsToken } from './ps.js';

/**
 * Remove-Item and every alias PowerShell ships for it. `rm`, `del`, `erase`,
 * `rd`, `rmdir` and `ri` all resolve to the same cmdlet — which is why `rm` is
 * in this list even though it is also the POSIX program: on Windows the word
 * means Remove-Item, and the two arms reach the same verdict about it anyway.
 */
const REMOVERS = new Set([
  'remove-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri',
  'remove-itemproperty', 'rp',
]);


/**
 * cmd.exe's OWN removers, which take `/s /q` rather than `-Recurse -Force`.
 *
 * `cmd /c "rd /s /q C:\repo"` is one keystroke from any PowerShell prompt,
 * and without these four cmd.exe removers that whole surface goes unguarded.
 * These four are kept SEPARATE from the PowerShell aliases above on purpose:
 * `rd /s /q` and `del /s /q` are unambiguously cmd.exe, while `rm /s /q` is a
 * POSIX `rm` of two files called `/s` and `/q` — which the POSIX wall ALLOWS.
 * Folding the cmd-style switch test into `rm` would make this dialect
 * stricter than the POSIX wall it mirrors, on a shape nothing has tested,
 * which is how a wall acquires strictness nobody ruled on.
 */
const CMD_REMOVERS = new Set(['rd', 'rmdir', 'del', 'erase']);

/** cmd.exe's recurse and force switches, unquoted, case-insensitive. */
function psHasCmdSwitch(tokens: readonly PsToken[], sw: string): boolean {
  return tokens.some((t) => !t.quoted && psFold(t.text) === sw);
}

/** Content destruction in place — no POSIX counterpart in this wall; see header. */
const CLEARERS = new Set(['clear-content', 'clc']);

/** The delete class at the scale of a disk. */
const FORMATTERS = new Set(['format-volume', 'clear-disk', 'initialize-disk']);

/**
 * Temp space, PowerShell-spelled. The POSIX roots stay in the list because
 * PowerShell Core runs on macOS and Linux, where `/tmp` is still `/tmp`.
 */
export function psIsTemp(p: string): boolean {
  const s = p.replace(/^["']|["']$/g, '');
  const f = psFold(s);
  if (/^\/tmp\/.+/.test(s) || /^\/private\/tmp\/.+/.test(s) || /^\/var\/folders\/.+/.test(s)) return true;
  if (f.startsWith('$env:temp') || f.startsWith('$env:tmp')) return true;
  if (f.startsWith('$tmpdir') || f.startsWith('${tmpdir')) return true;
  if (f.startsWith('[io.path]::gettemppath') || f.startsWith('[system.io.path]::gettemppath')) return true;
  // The expanded form, at a component boundary so `…\Tempest` is not temp.
  if (/[\\/]appdata[\\/]local[\\/]temp[\\/].+/.test(f)) return true;
  if (/^[a-z]:[\\/]temp[\\/].+/.test(f)) return true;
  if (/^[a-z]:[\\/]windows[\\/]temp[\\/].+/.test(f)) return true;
  return false;
}

/**
 * Every operand of every delete in `cmd` is temp space.
 *
 * FAILS CLOSED ON NO OPERAND AT ALL, exactly as the POSIX `rmTargetsTemp`
 * does: an odd command shape is not an exemption. A QUOTED operand still
 * counts as a path — unlike a quoted PARAMETER, which is not a parameter —
 * because `Remove-Item "$env:TEMP\x"` is how a path with spaces is written and
 * refusing to see it would delete the exemption rather than the file.
 */
export function psRemoveTargetsTemp(cmd: string): { allTemp: boolean; first: string } {
  let seen = false;
  let first = '';
  let allTemp = true;
  for (const seg of psSegments(cmd)) {
    const tokens = psTokenize(seg);
    const name = psCommandOf(tokens);
    if (!REMOVERS.has(name) && !CLEARERS.has(name)) continue;
    for (const op of psOperands(tokens)) {
      if (op.text === '') continue;
      if (!seen) first = op.text;
      seen = true;
      if (!psIsTemp(op.text)) allTemp = false;
    }
  }
  return { allTemp: seen && allTemp, first };
}

export interface PsDestructive {
  /** '' when nothing in this dialect fired. */
  kind: '' | 'remove' | 'format';
  /** The first operand, for the message and the attestation row. */
  subject: string;
}

/**
 * The delete class. Returns what fired, or kind ''.
 *
 * A DELETE COUNTS ONLY WITH BOTH `-Recurse` AND `-Force`, mirroring the
 * POSIX wall's "r AND f" rule exactly — with two carve-outs that are the same act
 * without the flags. `Clear-Content` needs no flags because it destroys the
 * contents of everything it is given; a volume format needs none for the same
 * reason. `-WhatIf` exempts everywhere, because a cmdlet under `-WhatIf` does
 * nothing at all.
 */
export function psDestructive(cmd: string): PsDestructive {
  for (const seg of psSegments(cmd)) {
    const tokens = psTokenize(seg);
    if (tokens.length === 0) continue;
    const name = psCommandOf(tokens);
    if (psIsWhatIf(tokens)) continue;
    if (FORMATTERS.has(name)) {
      return { kind: 'format', subject: psOperands(tokens)[0]?.text ?? name };
    }
    if (CLEARERS.has(name)) {
      return { kind: 'remove', subject: psOperands(tokens)[0]?.text ?? name };
    }
    if (CMD_REMOVERS.has(name)
      && psHasCmdSwitch(tokens, '/s') && (psHasCmdSwitch(tokens, '/q') || psHasCmdSwitch(tokens, '/f'))) {
      return { kind: 'remove', subject: psOperands(tokens)[0]?.text ?? name };
    }
    if (!REMOVERS.has(name)) continue;
    if (psHasParam(tokens, 'Recurse') && psHasParam(tokens, 'Force')) {
      return { kind: 'remove', subject: psOperands(tokens)[0]?.text ?? name };
    }
  }
  // `[IO.Directory]::Delete(path, $true)` — the .NET spelling of a recursive
  // delete, with no cmdlet and no parameter for the tests above to see.
  if (psNetCall(cmd, ['IO\\.Directory', 'IO\\.File'])
    && /::\s*Delete\s*\(/i.test(cmd)) {
    return { kind: 'remove', subject: '[IO]::Delete' };
  }
  return { kind: '', subject: '' };
}

/**
 * A PowerShell delete anywhere in the command, ignoring flags — the marker the
 * ordered attestation walk looks for, so `$env:HARNESS_BACKUP_DONE=1` must
 * come before the segment that deletes, never after it.
 */
export function psHasRemoveAct(seg: string): boolean {
  const tokens = psTokenize(seg);
  const name = psCommandOf(tokens);
  return REMOVERS.has(name) || CLEARERS.has(name) || FORMATTERS.has(name);
}

/** `$env:HARNESS_BACKUP_DONE=1` in command position of this segment. */
export function psHasAttestationPrefix(seg: string): boolean {
  return /^\s*\$env:HARNESS_BACKUP_DONE\s*=\s*['"]?1['"]?\s*$/i.test(seg)
    || /^\s*\$env:HARNESS_BACKUP_DONE\s*=\s*['"]?1['"]?[\s;]/i.test(seg);
}

/** Is this segment's command word one of `set`, folded? Used by the DB arm. */
export function psSegmentCommand(seg: string): string {
  return psCommandOf(psTokenize(seg));
}

/** Every command word in the command, folded — the PowerShell `cmdWords`. */
export function psWords(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of psSegments(cmd)) {
    const n = psCommandOf(psTokenize(seg));
    if (n !== '') out.push(n);
  }
  return out;
}

/** Every token of every segment, for the operand-level walls. */
export function psAllTokens(cmd: string): PsToken[] {
  const out: PsToken[] = [];
  for (const seg of psSegments(cmd)) out.push(...psTokenize(seg));
  return out;
}
