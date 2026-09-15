#!/usr/bin/env node
/**
 * Wall 2 of 4 — reads of credential and secret files.
 *
 * TWO ARMS, BECAUSE THEY CARRY DIFFERENT KINDS OF STRING (I-0135). A
 * `file_path` IS a path: the tool already resolved it, so a bare word is a
 * filename and matching it is correct. A Bash command is NOT a path — it is a
 * sentence that may quote prose, and treating the two identically is what made
 * `scrumux task new --check "no credentials appear anywhere"` refuse.
 * "credentials" is an ordinary English word; so is a task order telling an
 * agent not to read authorized_keys. So the command arm requires PATH CONTEXT
 * for the words that are also English.
 *
 * THE `.example`/`.template`/`.sample` EXEMPTION IS READ DIFFERENTLY BY EACH
 * ARM, and that is CLI-2 rather than an oversight. In the Read arm the target
 * is ONE resolved path, so a whole-target exemption is correct. In the Bash arm
 * the target is a whole command line, so a whole-target exemption is a hole:
 * `cp .env.example .env && cat .env` matched `.example` once and was waved
 * through wholesale while it read a real secret. The Bash arm therefore judges
 * each read OPERAND on its own.
 *
 * KNOWN LIMIT, DELIBERATE (P-25): `cat credentials` on a file named exactly
 * that — no directory, no extension — passes the command arm. Reading it
 * through the Read tool still blocks. A wall that refuses the word
 * "credentials" in prose costs a session every time an order mentions it and
 * prevents nothing, which is the trade this repo declines.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readHookInput, allow, refuse, refuseOldNode,
  processWallIo, runAsEntry, type WallIo,
} from './lib/hook.js';
import { loadConf, emitWarnings, allows, refuses, reasonFor } from './lib/conf.js';
import { cmdWords } from './lib/cmd-words.js';
import { canReadFile, shellReads } from './lib/predicates.js';
import { wallsRecord } from './lib/record.js';
import { matchesAnyLine } from './lib/ere.js';
import { psExpand } from './lib/ps.js';
import { psCanReadFile, psReadOperands } from './lib/ps-reads.js';

/**
 * Distinctive enough to match anywhere, in either arm. D-0085 broadened three
 * things the handoff named as live holes:
 *   `(\.[A-Za-z0-9_-]+)*` rather than `?` — Next.js ships
 *   `.env.production.local`, and one dot-segment let every multi-segment
 *   secret file through; `~` joined the terminator class, so an editor backup
 *   `.env~` is a secret; `[A-Za-z0-9_-]+\.env` matches the prod.env /
 *   staging.env forms.
 */
const STRONG = new RegExp(
  '(^|[/ "\'=<(])\\.env(\\.[A-Za-z0-9_-]+)*($|[ "\'<>)~])'
  + '|(^|[/ "\'=<(])[A-Za-z0-9_-]+\\.env($|[ "\'<>)~])'
  + '|id_rsa|id_ed25519|\\.pem($|[ "\'])|\\.pfx($|[ "\'])'
  + '|(^|[/ "\'])[^ ]*\\.key($|[ "\'])|keys/apps/[^ ]*\\.json|GATEWAY_API_KEYS\\.json'
  + '|secrets?\\.(json|ya?ml|env)($|[ "\'])|\\.netrc|\\.npmrc|\\.pypirc',
  'i',
);

/** Also ordinary English. Bare in a resolved path... */
const AMBIG_PATH = /credentials(\.(json|ya?ml|txt))?($|[ "'])|authorized_keys|known_hosts/i;
/**
 * ...path-anchored in a command. Do NOT merge these two (P-25).
 *
 * BOTH ALTERNATIONS ARE ANCHORED (SX-023). The first — a name with an
 * extension — used to match anywhere in a word, so a test module
 * `agents/tests/test_credentials.py` read as a credential file. It now needs
 * the name to START a word: the start of the operand, or a character that is
 * not a letter, digit or `_` (`/`, `~`, `.`, `-`, a quote). `credentials.json`,
 * `~/.aws/credentials`, `/x/my-credentials.yaml` still match.
 */
const AMBIG_CMD = /(^|[^A-Za-z0-9_])(credentials|authorized_keys|known_hosts)\.[A-Za-z0-9]+|[/~][^ "']*(credentials|authorized_keys|known_hosts)($|[ "'])/i;

const EXEMPT_SUFFIX = /\.(example|template|sample)\b/;

const BLOCK_MSG =
  'BLOCKED by block-secret-reads: this targets a credential/secret file pattern. '
  + 'CLAUDE.MD hard limit: never read credential or secret files. '
  + 'Reference secrets by path, never by value (see .claude/rules/no-direct-llm-calls.md token-handling rules). '
  + "To put a secret where this repo's code can USE it, store it: printf %s '<value>' | .claude/scripts/scrumux secret NAME "
  + '— it lands in .env, gitignored and mode 600, and is never printed back. '
  + 'Never paste a value into a file, a cell, a record or a commit message. '
  + 'To learn which variables exist, run .claude/scripts/scrumux secret list — names and fingerprints, never values; nothing needs the file read for that. '
  + 'If this file is genuinely not a secret, rename it out of the secret pattern or declare it in .claude/project-walls.conf with an allow line and a reason.';

/** Strip shell quoting/parens so a suffix test anchors correctly. */
function unquote(w: string): string {
  return w.replace(/["'`()<>]/g, '');
}

/**
 * Which operands of a command are READS.
 *
 * JUDGED PER SEGMENT, never over the whole line (SX-009, 2026-09-13). A
 * segment contributes operands ONLY when that segment itself can read a file:
 * its own program is a reader (`canReadFile`), the shell opens a file for it
 * (`shellReads` — then only the redirect targets, `shellReadTargets`), or it carries a command/process substitution whose first
 * word is a reader (`$(cat .env)`, `` `cat .env` ``, `<(cat .env)`). The gate
 * used to be asked of the WHOLE line while the operands came from EVERY
 * segment, so one unrelated reader anywhere opened the scan onto prose and
 * existence checks elsewhere: `scrumux issue new --summary "…writes .env…" &&
 * cat README.md` and `git rev-parse HEAD && ls -la /x/.env | sed 's/.*\/h/'`
 * were refused although nothing read a secret (Rover T-0001, T-0003).
 *
 * WRITES ARE NOT READS. Inside a reading segment:
 *   - for `cp` and `mv` the LAST positional operand is the DESTINATION, so
 *     `cp .env.example .env` reads no secret (D-0085);
 *   - every operand of `tee` is a file it WRITES (it reads stdin), so
 *     `tee .env <<< A=1` creates a secret file rather than reading one;
 *   - the target of an output redirect (`>`, `>>`, `2>`, `&>`, `>|`) is
 *     written, so `cat > .env <<< A=1` is a write. `cat .env > out` still
 *     reads `.env`: only the redirect's own target is dropped.
 * An INPUT redirect (`< .env`) stays an operand — that is the shell reading it.
 *
 * FLAGS STAY CANDIDATES. A flag-attached path (`docker run --env-file=.env`)
 * is still a read. Flags are dropped only where they have to be: when locating
 * cp/mv's positional destination.
 *
 * Depends on: `cmdWords`, `canReadFile`, `shellReads`, `readsBySubstitution`,
 * `dropWriteTargets`.
 */
export function readOperands(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/[;|&\n]/)) {
    if (seg === '') continue;
    const byProgram = canReadFile(seg) || readsBySubstitution(seg);
    if (!byProgram) {
      // Only the SHELL opens a file here (`read K < .env`, `$(<.env)`), so
      // only a redirect's own target is read (SX-023). `shellReads` stays
      // quote-blind on purpose; what a hit licenses is narrowed instead.
      if (shellReads(seg)) out.push(...shellReadTargets(seg));
      continue;
    }
    const cw = cmdWords(seg)[0] ?? '';
    let words = dropWriteTargets(seg.split(/\s+/).filter((w) => w !== ''));
    if (cw === 'tee') {
      // tee WRITES every operand it is given; only its flags remain.
      words = words.filter((w, i) => i === 0 || w.startsWith('-'));
    }
    if (cw === 'cp' || cw === 'mv') {
      // The destination is the LAST operand only when it is POSITIONAL. GNU
      // `cp -t DIR SRC...` / `--target-directory=DIR` carries it in a flag,
      // and then every remaining operand is a SOURCE — dropping the last one
      // there would let `cp -t /tmp .env` exfiltrate.
      const inFlag = words.some((w) => /^--target-directory/.test(w) || /^-[A-Za-z]*t/.test(w));
      if (!inFlag) {
        const positional = words.filter((w) => !w.startsWith('-'));
        // program + >=1 source + destination = 3 words. Anything shorter is
        // not a well-formed cp/mv, so judge every operand rather than deleting
        // the only one (`cp .env` must not become a no-op).
        if (positional.length >= 3) words = positional.slice(0, -1);
      }
    }
    out.push(...words);
  }
  return out;
}

/**
 * The word after an input redirect `<`, `<>` or `$(<`, never a heredoc `<<`.
 *
 * THE GAP AND THE TARGET USE ONE WHITESPACE SET, and it is the SPLITTER's
 * (JS `\s`), not the GATE's (POSIX `[[:space:]]`). `[ \t]*` for the gap beside
 * `[^...\s]` for the target's first character was I-0142 committed twice:
 * narrower in one place and WIDER in the other, inside one expression.
 * `shellReads` licensed `read K <NBSP.env` — a NBSP is not POSIX space, so a
 * shell sees a redirect — and this regex then extracted nothing, so the segment
 * contributed no operand and the wall allowed it. The arm was dark for five of
 * seven whitespace forms (NBSP, em space, VT, FF, CR).
 *
 * `\s` is right HERE because this is an operand SPLITTER, not a bash-parity
 * predicate: it is the same word boundary `readOperands` already uses one
 * branch away (`seg.split(/\s+/)`), and for a splitter the WIDE reading is the
 * safe direction — it makes the wall SEE `.env` where a shell sees `<NBSP>.env`.
 *
 * Where `[ \t]*` stopped at a non-`\s` character, greedy `\s*` stops at the
 * same character, so a target extracted before is never shortened or lost. The
 * one shape that does change — `x <NBSPa<b`, a Unicode-space redirect followed
 * by another `<` with no gap — yields a LONGER target containing the old one
 * led by `<`, which `STRONG` already accepts as a lead character, so no refusal
 * is lost.
 */
const INPUT_TARGET = /(?:^|[^<])<>?\s*([^<>&|\s][^\s]*)/g;

/**
 * The words a SHELL-level read opens: the target of each input redirect in
 * the segment, as raw text (a trailing `)` stays; the patterns accept it).
 *
 * WHY NOT EVERY WORD (SX-023). `shellReads` matches the raw segment, so a
 * doc-style placeholder in quoted prose — `--did "… <app-root>/generated/<name> …"`
 * — reads as a redirect. The gate used to license every whitespace-separated
 * word of that segment, so any secret-shaped word ANYWHERE in the prose was
 * refused as a read. A real redirect reads exactly one file: the word after
 * the `<`. `read K < .env`, `done < .env`, `X=$(<.env)`, `exec 3<> .env` still
 * yield `.env`; a placeholder yields `app-root>/generated/`, which is no secret.
 *
 * Depends on: nothing. Pure.
 */
export function shellReadTargets(segment: string): string[] {
  return [...segment.matchAll(INPUT_TARGET)].map((m) => m[1]!);
}

/** A reader opened by `$(`, a backtick or `<(`, e.g. `echo $(cat .env)`. */
const SUBSTITUTION_WORD = /(?:\$\(|`|<\()\s*([^\s`()]+)/g;

/**
 * Does this segment run a file reader inside a command or process
 * substitution? `cmdWords` reports only the segment's outer program, so
 * `echo $(cat .env)` would otherwise read as `echo`.
 *
 * Depends on: `canReadFile`.
 */
export function readsBySubstitution(segment: string): boolean {
  for (const m of segment.matchAll(SUBSTITUTION_WORD)) {
    if (canReadFile(m[1]!)) return true;
  }
  return false;
}

/**
 * Remove output-redirect targets from a segment's words: the word after a
 * bare `>`/`>>`/`2>`/`&>`/`>|`, and the attached target of `>file`/`2>>file`.
 * Input redirects are untouched.
 *
 * Depends on: nothing. Pure.
 */
export function dropWriteTargets(words: readonly string[]): string[] {
  const out: string[] = [];
  const bare = /^(?:[0-9]*|&)>>?\|?$/;
  const attached = /^(?:[0-9]*|&)>>?\|?./;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (bare.test(w)) { i += 1; continue; }
    if (attached.test(w)) continue;
    out.push(w);
  }
  return out;
}

export function main(io: WallIo = processWallIo()): never {
  refuseOldNode('block-secret-reads', io);
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const input = readHookInput(hookDir, io);
  const fp = input.filePath;
  const cmd = input.command;
  if (fp === '' && cmd === '') allow(io);

  const conf = loadConf(input.root);
  // Through the SEAM, not process.stderr. One output path per wall, so a
  // named skip is visible to a test the same way it is visible to the agent
  // -- and Article 5 makes that line product surface like any other.
  emitWarnings(conf, io.err);

  const confRefusal = (subject: string, safe: string): void => {
    const r = refuses(conf, subject);
    if (!r.refused) return;
    const why = r.failedClosed
      ? 'a refuse pattern this build cannot evaluate — refusing rather than waving it through (OQ-8, D-0085)'
      : reasonFor(conf, 'refuse', subject);
    wallsRecord({ root: input.root, wall: 'project-walls.conf', subject: safe, reason: why, payload: input.payload });
    refuse(io, `BLOCKED by project-walls.conf: ${why}`);
  };

  // ---- Read-tool arm: one resolved path -------------------------------
  if (fp !== '') {
    if (matchesAnyLine(EXEMPT_SUFFIX, fp)) allow(io);
    if (allows(conf, fp)) allow(io);
    confRefusal(fp, fp);                    // CLI-5: a resolved path is safe
    if (matchesAnyLine(STRONG, fp) || matchesAnyLine(AMBIG_PATH, fp)) {
      wallsRecord({
        root: input.root, wall: 'block-secret-reads', subject: fp,
        reason: 'targets a credential or secret file pattern', payload: input.payload,
      });
      refuse(io, BLOCK_MSG);
    }
    allow(io);
  }

  // ---- Bash arm: a sentence; judge each read OPERAND on its own -------
  // CLI-5: every event-stream record here carries the READING PROGRAM WORD,
  // never the command — a command line can carry a secret in a flag, and a
  // secret must never reach the event stream. The full command still shows on
  // stderr, which is displayed to the agent and never persisted.
  const safe = cmdWords(cmd)[0] ?? '';
  if (allows(conf, cmd)) allow(io);
  confRefusal(cmd, safe);

  // A secret path in a command is only evidence of a READ if the command can
  // read a file. `git commit -m "wired .env loading"` was refused for the word
  // ".env" in its own message. It opens nothing.
  //
  // TWO DIALECTS, AND THE GATE AND THE OPERANDS MUST COME FROM THE SAME ONE.
  // Asking "can EITHER dialect read?" and then judging the union of both
  // operand lists is the wrong shape: `Copy-Item .env.example .env` is the
  // first-day setup step D-0085 exists to permit -- the PowerShell reader
  // knows `.env` there is the DESTINATION and drops it -- but the POSIX
  // operand splitter has never heard of `Copy-Item`, so it would keep
  // `.env` as a candidate and the command would block on operands the
  // PowerShell gate licensed for a command written in the other language.
  // So each dialect answers about its own commands, and a
  // read blocks when ONE dialect can both read AND name a secret. That is
  // still the P-27 direction — two chances to catch, never one chance to
  // excuse — without letting either dialect's blind spot become the other's
  // false positive.
  const psCmd = psExpand(cmd);
  const arms: { operands: string[] }[] = [];
  // The POSIX gate is asked PER SEGMENT inside `readOperands` (SX-009): an
  // empty list means no segment can read a file, which is the old "cannot
  // read" answer, now without one reader licensing every other segment.
  const posixOperands = readOperands(cmd);
  if (posixOperands.length > 0) arms.push({ operands: posixOperands });
  if (psCanReadFile(psCmd)) arms.push({ operands: psReadOperands(psCmd) });
  if (arms.length === 0) allow(io);

  for (const arm of arms) {
    for (const w of arm.operands) {
      if (!matchesAnyLine(STRONG, w) && !matchesAnyLine(AMBIG_CMD, w)) continue;
      const q = unquote(w);
      if (/\.(example|template|sample)$/.test(q)) continue;
      wallsRecord({
        root: input.root, wall: 'block-secret-reads', subject: safe,
        reason: 'targets a credential or secret file pattern', payload: input.payload,
      });
      refuse(io, BLOCK_MSG);
    }
  }
  allow(io);
}

// RUN ONLY WHEN THIS IS THE PROCESS ENTRY, and turn the WallExit every path
// throws into a real exit code. Written once in lib/hook.ts: importing this
// module to unit-test a predicate must not execute the wall.
runAsEntry('block-secret-reads', import.meta.url, main);
