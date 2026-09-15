#!/usr/bin/env node
/**
 * Wall 1 of 4 — destructive filesystem commands and database purges.
 *
 * THE SCOPE IS NARROWER THAN "DESTRUCTIVE", by User's explicit v1 selection
 * (P-32). Three classes only: recursive-force delete, database purge, git
 * history destruction. Deploy, production, TestFlight and tunnel actions are
 * documented policy in CLAUDE.MD and are NOT hook-enforced.
 *
 * A TRAILING COMMENT IS NOT PART OF THE ACT (CLI-3). It must not DISARM an
 * exemption (a temp keyword or `--force-with-lease` in a comment) nor ARM a
 * match. Every detection and every exemption judges the comment-stripped
 * string; the raw text is still what stderr shows and what the attestation
 * records.
 *
 * `HARNESS_BACKUP_DONE=1` IS AN ATTESTATION, NOT A VERIFICATION (P-30). The
 * wall does not check that a backup exists — it computes what it can (the
 * syntactic position, the comment strip) and RECORDS the rest. Adding a check
 * that a backup really exists would be a check the harness cannot compute,
 * which is Article 4 exactly.
 *
 * EXACTLY ONE ATTESTED CLASS PER INVOCATION. Every branch sets a variable and
 * nothing writes; the single write happens at the end. Writing per branch
 * would put two rows on the log for one command (an attested `rm -rf` that
 * also drops a table), which is what "exactly one" rules out.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import {
  readHookInput, allow, refuse, refuseOldNode,
  processWallIo, runAsEntry, type WallIo,
} from './lib/hook.js';
import { loadConf, emitWarnings, allows, refuses, reasonFor } from './lib/conf.js';
import { cmdWords } from './lib/cmd-words.js';
import { wallsRecord } from './lib/record.js';
import { jqCompact } from './lib/jsonl.js';
import { matchesAnyLine, ereOrThrow } from './lib/ere.js';
import { psExpand } from './lib/ps.js';
import { inScratch, resolveOperand, cdTarget, SCRATCH_DIR } from './lib/scratch.js';
import {
  psDestructive, psRemoveTargetsTemp, psHasRemoveAct, psHasAttestationPrefix, psWords,
} from './lib/ps-destructive.js';

/**
 * EVERY REGEX BELOW MUST BE ASKED grep -Eq's QUESTION: does ANY LINE match.
 *
 * This is not a detail. `sh -c "rm -rf /x"` folds its payload into SCAN as a
 * SECOND LINE, and a line-start alternative written as `(^|[;&| ])rm` only
 * matches at that line's start. A bare JavaScript `.test()` over the joined
 * string does not: the character before `rm` is a newline, which is in
 * neither alternative, so a shell-payload case can walk straight through at
 * exit 0.
 *
 * `matchesAnyLine` asks grep's question — does ANY line match — so `^`, `$`
 * and "no line contains a newline" all come out right at once. Every pattern
 * below MUST go through it, never a bare `.test()`.
 */

const DB_CLIENTS = new Set([
  'psql', 'mysql', 'mysqldump', 'mariadb', 'mariadb-dump', 'sqlite3',
  'redis-cli', 'valkey-cli', 'mongo', 'mongosh', 'mongod', 'cqlsh',
  'clickhouse-client', 'clickhouse', 'cockroach', 'influx',
  'pg_dump', 'pg_dumpall', 'dropdb',
]);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/**
 * Collapse `.` and `..` components TEXTUALLY.
 *
 * All of this is string work on purpose. The paths a PreToolUse hook judges
 * must not be touched and mostly do not exist yet, so `realpath` and `cd --`
 * are unavailable; `..` is resolved lexically instead, and an unexpanded
 * `$SANDBOX` survives as itself while `/tmp/../Users/foo` becomes the
 * `/Users/foo` it actually deletes.
 */
export function lexResolve(path: string): string {
  const lead = path.startsWith('/') ? '/' : '';
  const acc: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { acc.pop(); continue; }
    acc.push(seg);
  }
  return lead + acc.join('/');
}

/**
 * True only for a path under a temp root AT A COMPONENT BOUNDARY, so `/tmpfoo`
 * and `/private/tmpfoo` do not match, or for one of the named unexpanded forms
 * the shell would have expanded into temp space. A scratchpad directory is
 * temp because it LIVES under one of these roots, never because something in
 * the string is spelled "scratchpad" (I-0103).
 */
export function isTemp(p: string): boolean {
  if (/^\/tmp\/.+/.test(p) || /^\/private\/tmp\/.+/.test(p) || /^\/var\/folders\/.+/.test(p)) return true;
  if (p === '$TMPDIR' || p.startsWith('$TMPDIR/')) return true;
  if (p.startsWith('${TMPDIR')) return true;
  if (p === '$SANDBOX' || p.startsWith('$SANDBOX/')) return true;
  if (p.startsWith('$(mktemp')) return true;
  return false;
}

/** Where the session's scratch directory is, for `rmTargetsTemp` (D-S040). */
export interface ScratchContext { workRoot: string; cwd: string }

/**
 * True only when EVERY operand of EVERY `rm` invocation is a temp target:
 * under an OS temp root (`isTemp`) or, given a `ScratchContext`, inside
 * `<WORK_ROOT>/.scratch` (D-S040, `lib/scratch.ts`).
 * A trailing comment is cut first, the command is split at its shell
 * separators so a second `rm` cannot hide behind a temp-looking first one, and
 * each segment's operands are the words after the flag group.
 *
 * NO OPERAND AT ALL FAILS CLOSED: an odd command shape is not an exemption.
 */
export function rmTargetsTemp(cmd: string, scratch?: ScratchContext): { allTemp: boolean; first: string } {
  const body = cmd.split('#')[0]!;
  let seen = false;
  let first = '';
  let allTemp = true;
  // Where a relative operand points (D-S040): the shell's cwd, moved by `cd`.
  let cwd: string | null = scratch === undefined ? null : (scratch.cwd !== '' ? scratch.cwd : scratch.workRoot);
  for (const seg of body.split(/[;&|]/)) {
    const moved = cdTarget(seg, cwd);
    if (moved !== undefined) { cwd = moved; continue; }
    // One dash, optional second, so the flag group is stripped for `-rf` and
    // for `--recursive --force` alike. Without this the long spellings lose
    // their temp exemption and `rm --recursive --force /tmp/x` starts blocking.
    const m = /.*\brm((?:\s+--?[a-zA-Z][a-zA-Z-]*)+)\s+/.exec(seg);
    if (m === null) continue;
    const rest = seg.slice(m[0].length);
    for (const rawWord of rest.split(/\s+/)) {
      if (rawWord === '') continue;
      const word = rawWord.replace(/["']/g, '');       // "$TMPDIR"/x -> $TMPDIR/x
      if (word === '') continue;
      if (word.startsWith('-')) continue;              // still in the flag group
      const resolved = lexResolve(word);
      if (!seen) first = resolved;
      seen = true;
      const scratchOk = scratch !== undefined && inScratch(resolveOperand(word, cwd) ?? '', scratch.workRoot);
      if (!isTemp(resolved) && !scratchOk) allTemp = false;
    }
  }
  return { allTemp: seen && allTemp, first };
}

const ATT_PREFIX = ereOrThrow('^[[:space:]]*HARNESS_BACKUP_DONE=1[[:space:]]');
const ATT_ANYWHERE = ereOrThrow('(^|[;&|][[:space:]]*)HARNESS_BACKUP_DONE=1[[:space:]]');

/** The per-class markers the segment walk looks for. */
export const ATT_RM = ereOrThrow('(^|[[:space:]])rm([[:space:]]|$)');
export const ATT_GIT = ereOrThrow('(^|[[:space:]])git[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-[a-zA-Z]*f)');
export const ATT_DB = ereOrThrow(`(^|[[:space:]])(${[...DB_CLIENTS].join('|')})([[:space:]]|$)`);

/**
 * An attestation counts ONLY as an env-assignment prefix in command position
 * (CLI-3) — a trailing comment `# HARNESS_BACKUP_DONE=1` must not be able to
 * disarm the wall AND drive a FALSE backup row into attestations.jsonl — AND
 * IT MUST PRECEDE THE ACT (D-0090).
 *
 * POSITION ALONE IS NOT ENOUGH. `rm -rf X && HARNESS_BACKUP_DONE=1 echo
 * done` puts the assignment in command position of the SECOND segment, so a
 * whole-string test would accept it — attesting for an rm that had already
 * run, unbacked-up, and writing a row claiming a backup that never happened.
 *
 * So the segments are walked IN ORDER: an attestation in this segment or any
 * earlier one counts; nothing later does.
 */
/**
 * @param psAct the PowerShell spelling of THIS class's act, or null when the
 *              class has no PowerShell arm. It is a parameter rather than a
 *              fixed extra test because the walk stops at the FIRST segment
 *              carrying the act: folding a PowerShell delete into the marker
 *              for every class would make `psql -c "DROP TABLE x"; Remove-Item y`
 *              stop at the `Remove-Item` when asked about the DB class, and
 *              answer about the wrong segment.
 */
export function hasAttestation(
  cmdNc: string,
  actMarker: RegExp,
  psAct: ((seg: string) => boolean) | null = null,
): boolean {
  let seen = false;
  for (const seg of cmdNc.split(/[;&|]/)) {
    // POWERSHELL SPELLS THE PREFIX DIFFERENTLY, and the sanctioned path has to
    // exist on both platforms or it does not exist. `VAR=value cmd` is shell
    // syntax PowerShell does not have; `$env:HARNESS_BACKUP_DONE=1; Remove-Item …`
    // is how the same thing is said there, and it lands in command position of
    // its own segment — which is what this ordered walk already understands.
    if (ATT_PREFIX.test(seg) || psHasAttestationPrefix(seg)) seen = true;
    if (actMarker.test(seg) || (psAct !== null && psAct(seg))) return seen;
  }
  // No segment matched the act at all — only the shell-payload shape, where
  // the class was detected on the extracted payload rather than on a segment
  // of cmdNc. Fall back to the whole-string test, which is where the behaviour
  // was before this ruling.
  return matchesAnyLine(ATT_ANYWHERE, cmdNc);
}

/** Both r and f, bundled or separate; or r and d; or the GNU long spellings. */
export function rmDestructiveFlags(scan: string): boolean {
  if (matchesAnyLine(/(^|[;&| ])rm[ \t]+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|-[rR][ \t]+-f|-f[ \t]+-[rR])/, scan)) return true;
  if (matchesAnyLine(/(^|[;&| ])rm[ \t]+(-[a-zA-Z]*[rR][a-zA-Z]*d[a-zA-Z]*|-[a-zA-Z]*d[a-zA-Z]*[rR][a-zA-Z]*)/, scan)) return true;
  // GNU long flags, either order, other arguments allowed between them.
  // D-0085/OQ-17: macOS `rm` rejects --recursive, so this case cannot be
  // observed by testing on macOS alone -- but this wall also runs on Linux,
  // where GNU coreutils accepts the long flags, so the check has to cover
  // them regardless.
  return matchesAnyLine(/(^|[;&| ])rm[ \t]/, scan)
    && matchesAnyLine(/(^|[ \t])--recursive([ \t]|$)/, scan)
    && matchesAnyLine(/(^|[ \t])--force([ \t]|$)/, scan);
}

export function main(io: WallIo = processWallIo()): never {
  refuseOldNode('block-destructive', io);
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const input = readHookInput(hookDir, io);
  const cmd = input.command;
  if (cmd === '') allow(io);

  const cmdNc = cmd.split('#')[0]!;
  let words = cmdWords(cmd);

  // SHELL-INTERPRETER -c PAYLOADS ARE COMMANDS, NOT DATA (CLI-4 augment).
  // `sh -c "rm -rf /x"` executes its quoted argument, so the payload reaches
  // the same class detection the top-level command gets — the "look at MORE"
  // rule already applied to heredoc bodies. The trigger is STRUCTURE-AWARE and
  // that is the whole safety of it: we act only when a shell interpreter
  // surfaced as a real command WORD, never when "sh" merely sits inside quoted
  // prose.
  let scan = cmdNc;
  if (words.some((w) => INTERPRETERS.has(w)) && matchesAnyLine(/(^|[ \t])-[A-Za-z]*c[A-Za-z]*([ \t]|$)/, cmdNc)) {
    // `[^"]*` not `.*`: stop stripping at the payload's opening quote so an
    // inner client flag (`bash -lc "psql -c \"DROP…\""`) is not mistaken for
    // the interpreter's own -c and over-stripped past the real program word.
    const payload = cmdNc.replace(/^[^"]*[ \t]-[A-Za-z]*c[A-Za-z]*[ \t]+/, '').replace(/["']/g, '');
    if (payload !== '' && payload !== cmdNc.replace(/["']/g, '')) {
      words = [...words, ...cmdWords(payload)];
      scan = `${cmdNc}\n${payload}`;
    }
  }

  // THE POWERSHELL PAYLOAD ANALOGUE, folded into the same SCAN string.
  // `iex "…"`, `pwsh -Command "…"` and `powershell -EncodedCommand <base64>`
  // all execute their argument, so the argument reaches the same class
  // detections the top-level command does — the `sh -c` rule, in the dialect
  // that has three spellings of it instead of one. Appending rather than
  // replacing keeps every POSIX line intact, so this cannot narrow the
  // POSIX arm's view; it can only widen it.
  scan = psExpand(scan);

  // THE POWERSHELL COMMAND WORDS JOIN THE POSIX ONES, rather than replacing
  // them. `& psql -c "DROP DATABASE x"` and `git reset --hard` typed at a
  // PowerShell prompt run the SAME programs the POSIX arm already knows
  // about; what the POSIX tokenizer cannot do is find the program word past a call
  // operator, a `$x =` assignment or a `Start-Process`. So the DB and git
  // classes below need no new patterns at all — only a wider view of what the
  // command word is. Folded to lower case on the way in, because PowerShell
  // is case-insensitive and `PSQL` is `psql` there.
  const words2 = [...words, ...psWords(scan)];
  const hasWord = (set: Set<string> | string): boolean =>
    typeof set === 'string' ? words2.includes(set) : words2.some((w) => set.has(w));
  const firstWord = (set: Set<string> | string): string =>
    (typeof set === 'string' ? words2.find((w) => w === set) : words2.find((w) => set.has(w))) ?? '';

  const conf = loadConf(input.root);
  // Through the SEAM, not process.stderr. One output path per wall, so a
  // named skip is visible to a test the same way it is visible to the agent
  // -- and Article 5 makes that line product surface like any other.
  emitWarnings(conf, io.err);

  // This repo's own say, first. An `allow` line is how a repo says the archive
  // folder really is meant to be deleted, without anyone forking this hook.
  if (allows(conf, cmd)) allow(io);
  const cr = refuses(conf, cmd);
  if (cr.refused) {
    const why = cr.failedClosed
      ? 'a refuse pattern this build cannot evaluate — refusing rather than waving it through (OQ-8, D-0085)'
      : reasonFor(conf, 'refuse', cmd);
    wallsRecord({ root: input.root, wall: 'project-walls.conf', subject: words[0] ?? '', reason: why, payload: input.payload });
    refuse(io, `BLOCKED by project-walls.conf: ${why}`);
  }

  let attestedClass = '';
  let attestedPath = '';
  const attest = (cls: string, path: string): void => {
    if (attestedClass !== '') return;             // first matching branch wins
    attestedClass = cls;
    attestedPath = path;
  };

  const block = (subject: string, what: string, remedy: string): never => {
    wallsRecord({
      root: input.root, wall: 'block-destructive', subject,
      reason: 'destructive filesystem command or database purge without an attested backup',
      payload: input.payload,
    });
    refuse(io, `BLOCKED by block-destructive: ${what} CLAUDE.MD hard limit: never run destructive filesystem commands or purge a database without backing it up first. ${remedy}`);
  };

  // ---- recursive force delete, POWERSHELL DIALECT ----------------------
  // Runs BEFORE the POSIX arm and returns through the same `block()` site, so
  // there is one refusal sentence for one act however it was spelled. It is
  // reached on every command, not only on Windows: the payload does not have
  // to say which tool it came from for the wall to be right, and looking at
  // MORE is this repo's standing invariant (P-27).
  {
    const ps = psDestructive(scan);
    if (ps.kind !== '') {
      const t = psRemoveTargetsTemp(scan);
      if (!t.allTemp) {
        if (hasAttestation(cmdNc, ATT_RM, psHasRemoveAct)) {
          attest('rm-rf', t.first !== '' ? t.first : ps.subject);
        } else {
          block(t.first !== '' ? t.first : ps.subject,
            `recursive force delete outside temp space ('${cmd}').`,
            'Back up or git-stash the target first; the one sanctioned path is to re-run prefixed with HARNESS_BACKUP_DONE=1, which this hook records in governance/attestations.jsonl.');
        }
      }
    }
  }

  // ---- recursive force delete -----------------------------------------
  if (hasWord('rm') && rmDestructiveFlags(scan)) {
    // --no-preserve-root is blocked UNCONDITIONALLY and BEFORE any exemption:
    // no attestation and no temp target opens it, because there is no
    // sanctioned use of the flag here. Preserve this ordering.
    if (scan.includes('--no-preserve-root')) {
      block(firstWord('rm'), 'recursive force delete with --no-preserve-root.',
        'There is no sanctioned use of this flag here — no backup attestation opens it.');
    }
    const t = rmTargetsTemp(cmd, { workRoot: input.workRoot, cwd: input.cwd });
    if (!t.allTemp) {
      if (hasAttestation(cmdNc, ATT_RM)) {
        attest('rm-rf', t.first);
      } else {
        block(t.first !== '' ? t.first : firstWord('rm'),
          `recursive force delete outside temp space ('${cmd}').`,
          `Throwaway files you made belong in ${SCRATCH_DIR}/ at the repo (or worktree) root — gitignored, and removable with rm -rf ${SCRATCH_DIR}/<name> without refusal (D-S040). `
          + 'Anything else is real work: back up or git-stash the target first; the one sanctioned path is to re-run prefixed with HARNESS_BACKUP_DONE=1, which this hook records in governance/attestations.jsonl.');
      }
    }
  }

  // ---- database purge classes -----------------------------------------
  // `truncate table` REQUIRES the `table` word: coreutils `truncate -s 0 file`
  // and the prose word "truncate" no longer match.
  if (hasWord(DB_CLIENTS)
    && matchesAnyLine(/drop[ \t]+(database|table|schema|collection)|truncate[ \t]+table|flushall|flushdb|db\.dropDatabase/i, scan)) {
    if (hasAttestation(cmdNc, ATT_DB)) attest('db-purge', '');
    else {
      block(firstWord(DB_CLIENTS), `database purge class command ('${cmd}').`,
        'Back up first, then re-run prefixed with HARNESS_BACKUP_DONE=1 (and record the backup location in the scrumux log).');
    }
  }

  // ---- git history destruction ----------------------------------------
  // `--force-with-lease` exempts, AS A STANDALONE WORD, so a trailing comment
  // can neither fake the lease exemption nor smuggle a --force in (CLI-3).
  if (hasWord('git')
    && matchesAnyLine(/git[ \t]+push[ \t]+.*(--force([ \t]|$)|-f([ \t]|$))/, scan)
    && !matchesAnyLine(/(^|[ \t])--force-with-lease([ \t]|$)/, scan)) {
    block(firstWord('git'), `bare force-push ('${cmd}').`,
      "Use --force-with-lease on a branch you own; force-pushing shared history needs User's explicit word.");
  }
  if (hasWord('git') && matchesAnyLine(/git[ \t]+(reset[ \t]+--hard|clean[ \t]+-[a-zA-Z]*f)/, scan)) {
    if (hasAttestation(cmdNc, ATT_GIT)) attest('git-history', '');
    else {
      block(firstWord('git'), `working-tree destruction ('${cmd}').`,
        'git stash -u (or commit) first — then re-run prefixed with HARNESS_BACKUP_DONE=1.');
    }
  }

  // ---- the ONE attestation write ---------------------------------------
  // Reached only when nothing blocked. A plain append: no scrumux, no
  // write_json — this is a PreToolUse hot path and write_json is a
  // read-modify-write over a whole journal. LOGGING NEVER BLOCKS THE COMMAND
  // AND NEVER PRINTS: a failed write leaves the hook silent at exit 0, because
  // a broken record must not become a broken tool call.
  if (attestedClass !== '') {
    try {
      const dir = `${input.root}/governance`;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const row = jqCompact({
        date: new Date().toISOString().slice(0, 10),
        class: attestedClass,
        command: cmd,
        attested_path: attestedPath,
      });
      appendFileSync(`${dir}/attestations.jsonl`, row + '\n');
    } catch {
      // Silent by contract. See the comment above.
    }
  }
  allow(io);
}

// RUN ONLY WHEN THIS IS THE PROCESS ENTRY, and turn the WallExit every path
// throws into a real exit code. Written once in lib/hook.ts: importing this
// module to unit-test a predicate must not execute the wall.
runAsEntry('block-destructive', import.meta.url, main);
