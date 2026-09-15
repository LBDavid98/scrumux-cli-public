#!/usr/bin/env node
/**
 * Wall 3 of 4 — writes to harness machinery inside a DEPLOYED repo.
 * D-0078 boundary 1.
 *
 * IT DELIBERATELY IGNORES `project-walls.conf`, and that asymmetry IS the
 * design (P-23). Its three siblings check the conf first and honour an
 * `allow` line; this one never does.
 *
 * `project-walls.conf` lives INSIDE the deployed repo, and an agent may
 * write it. Every other wall protects the repo FROM the agent, so the
 * repo's own say is the right override there. This one protects the
 * UPSTREAM from the repo — an allow line here would let any agent exempt
 * itself from D-0078 boundary 1 by writing one file, and the wall would be
 * advisory. The lever for this wall is upstream, on purpose: "there is no
 * repo-level fix available to me" is the correct answer to a genuine block,
 * not a defect.
 *
 * This is the one asymmetry that looks like an oversight next to the other
 * three walls' shared conf helper. It is not one.
 *
 * `isProtected` IS A SUBSTRING TEST, and that generosity is deliberate
 * (I-0133). `/abs/repo/.claude/scripts/scrumux`, `.claude/scripts/scrumux`
 * and even `open.claude/scripts/scrumux` all hit; a bare `scripts/scrumux`
 * does not. The `.claude/` component is what separates the harness from an
 * app's own `scripts/` directory, not the leading slash — a stricter,
 * two-anchor version missed a relative path inside a python heredoc, which
 * is the I-0121 evasion working verbatim.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import {
  readHookInput, allow, refuse, refuseOldNode,
  processWallIo, runAsEntry, type WallIo,
} from './lib/hook.js';
import { wallsRecord } from './lib/record.js';
import { psExpand, psSegments, psTokenize, psCommandOf, psHasParam } from './lib/ps.js';
import { heredocOpens, closesHeredoc, type HeredocOpen } from './lib/heredoc.js';

/** Substring for the four frozen `.claude/` directories, on purpose — see the header. */
export function isProtected(path: string): boolean {
  // WINDOWS WRITES THE SAME PATH WITH THE OTHER SLASH, and this wall is a
  // SUBSTRING test over path text rather than anything resolved, so
  // `.claude\scripts\scrumux` matched none of the four patterns and every
  // machinery write from a PowerShell prompt walked straight past. Normalising
  // the separator here rather than at each call site keeps the one substring
  // rule the header describes: `/` is the canonical form and `\` is a spelling
  // of it.
  const p = path.includes('\\') ? path.split('\\').join('/') : path;

  // THE DIRECTORY ITSELF IS PROTECTED, NOT ONLY FILES UNDER IT (R-013).
  //
  // Every pattern here used to require a trailing `/` with something after it,
  // so a path that NAMED one of the machinery directories and stopped —
  // `Expand-Archive -DestinationPath .claude/scripts`, `mv evil .claude/dist`
  // — wrote into the machinery without ever naming a protected FILE, and both
  // dialects allowed it. The hole was dialect-independent, in both scanners,
  // until R-013.
  //
  // THE BOUNDARY IS A SEGMENT BOUNDARY, NOT A STRING PREFIX, and that is the
  // whole care in this line. `(\/|$)` is what keeps `.claude/scriptsomething`
  // — an ordinary name a repo may legitimately own — out of the wall, while
  // `.claude/scripts` and `.claude/scripts/` are both in it. A `startsWith`
  // test would have refused the first as well.
  //
  // The PREFIX side stays generous on purpose: no anchor before `.claude`, so
  // `/abs/repo/.claude/scripts/x` and even `open.claude/scripts/x` still hit.
  // That generosity is I-0133 and is not what changed here.
  // THE ROSTER IS THE FROZEN HALF OF THE PAYLOAD, and `dist` is the half that
  // matters most: it holds the four wall bundles, the CLI bundle and the
  // session guard. Leaving it off this list let an agent in a deployed repo
  // rewrite the walls that are refusing it.
  //
  // `rules` and `skills` are deliberately absent — a repo localises those, and
  // their drift is reported by `harness verify` rather than blocked (D-0072
  // boundary 7). Everything else the payload installs is frozen machinery:
  // scripts, schemas, agents, dist. `driftClass` in
  // `src/nouns/harness/verify.ts` made the same split until R-019 (D-S027):
  // verify now reports SCHEMA variance instead of failing, because schemas
  // reach a deployed repo through the operator's canon publish. The wall does
  // not follow — an agent writing the schema that judges its own records is
  // exactly what this refuses; the operator's publish never passes through it.
  return /\.claude\/(scripts|schemas|agents|dist)(\/|$)/.test(p);
}

/**
 * The path glued to a redirect operator, or '' when this token is not one.
 *
 * WRITTEN ONCE AND USED BY BOTH SCANNERS, because the two used to disagree
 * about it by accident. A token is a glued redirect when it is an optional fd
 * number or `&`, then `>` or `>>`, then a path with no space in between:
 * `>x`, `>>x`, `2>x`, `2>>x`, `10>x`, `&>x`, `&>>x`.
 *
 * THE fd-PREFIXED AND `&`-PREFIXED FORMS WERE MISSED BY BOTH IMPLEMENTATIONS
 * until R-013. `echo x 2>.claude/schemas/task.schema.json` is one token that
 * is neither a bare operator nor a token beginning with `>`, so it fell
 * through to the ordinary operand test with a benign command word (`echo`) in
 * front of it and was allowed — a write to the machinery, through the wall,
 * in both dialects. `walls-hardenE.test.ts` pinned that as a shared gap
 * REPRODUCED rather than repaired, on the standing rule that widening one
 * side alone is a silent divergence; the ruling closes it on both sides at
 * once, which is the form that rule always pointed at.
 *
 * `2>&1` yields `1` here — a dup, not a file — and `1` is not protected, so
 * the ordinary answer is the right one with no special case.
 */
export function redirGluedTarget(tok: string): string {
  const m = /^(?:[0-9]{1,2}|&)?>>?(.+)$/.exec(tok);
  if (m === null) return '';
  return stripTok(m[1]!);
}

/** Shell punctuation stripped, so `open('.claude/scripts/x',` arrives usable. */
function stripTok(t: string): string {
  return t.replace(/["'`;|&()<>]/g, '');
}

type Class = 'BENIGN' | 'MUTATOR' | 'INTERPRETER' | 'SED' | 'GIT';

const MUTATORS = new Set([
  'cp', 'mv', 'rm', 'ln', 'install', 'tee', 'dd', 'truncate', 'touch', 'chmod',
  'chown', 'patch', 'ed', 'rsync', 'unzip', 'tar', 'shred', 'mkdir', 'rmdir',
]);
const INTERPRETERS = new Set([
  'python', 'python3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'sh', 'bash', 'zsh', 'osascript',
]);
const WRAPPERS = new Set(['env', 'sudo', 'time', 'nohup', 'exec', 'command']);
const GIT_MUTATING = new Set(['apply', 'checkout', 'restore', 'rm', 'mv', 'clean']);

/**
 * The PowerShell cmdlets and aliases that WRITE a file, folded. Deliberately a
 * list rather than a catch-all: a reader may name a protected path freely
 * (I-0134), so `Get-Content`, `Select-String` and `Test-Path` are absent on
 * purpose and their absence is the feature.
 */
const PS_MUTATORS = new Set([
  'set-content', 'sc', 'out-file', 'add-content', 'ac',
  'clear-content', 'clc',
  'new-item', 'ni',
  'remove-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri',
  'copy-item', 'cp', 'copy', 'cpi',
  'move-item', 'mv', 'move', 'mi',
  'rename-item', 'rni', 'ren',
  'set-itemproperty', 'sp',
  'expand-archive', 'compress-archive',
  'start-bitstransfer',
  'tee-object', 'tee',
  'set-acl',
]);

/** Interpreters: the I-0121 route, where the path sits inside program text. */
const PS_INTERPRETERS = new Set([
  'python', 'python.exe', 'python3', 'node', 'node.exe', 'ruby', 'perl', 'php',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe',
  'invoke-expression', 'iex',
]);

export interface ScanHit { path: string }

/**
 * Walk the command and report the first protected path a MUTATING context
 * touches, or null.
 *
 * A SEGMENT BLOCKS WHEN its command word mutates files and a protected path
 * appears in it; or its command word is an INTERPRETER and a protected path
 * appears in it (the I-0121 heredoc route, where the path sits inside quotes
 * in the program text and no position rule can see it); or a redirect operator
 * points at a protected path, whatever runs it.
 *
 * Everything else — `scrumux`, `status`, `cat`, `grep`, `git diff` — may name
 * a protected path freely. That is the I-0134 fix: an order that says "graph
 * is unavailable in this deployment" is prose ABOUT the machinery, not an edit
 * of it, and session-open explicitly asks for such sentences.
 *
 * A NEWLINE ENDS A COMMAND TOO (I-0136), with two carve-outs without which
 * that would be a downgrade: a line ending in a backslash CONTINUES the one
 * before it, and the lines after a `<<` are heredoc BODY, where there are no
 * command words at all and every token is scanned.
 *
 * A BODY ENDS AT ITS TERMINATOR (SX-021). The body mode used to be a latch
 * that never reset, so any harness path named anywhere after a closed
 * heredoc — a `--verified` argument of a `scrumux log new` — was refused as a
 * write. `lib/heredoc.ts` reads each `<<`/`<<-` word (quoted or bare) and
 * closes the body on the line a shell closes it on; bodies opened together
 * (`cat <<A <<B`) are read in order. An unreadable word keeps the old latch.
 *
 * NO GLOB EXPANSION, DELIBERATELY. An unquoted `*` in the command text is
 * matched literally here, never expanded against a directory. Expanding it
 * would make this wall see tokens that are not actually in the command text
 * -- and make its answer depend on the CALLER's cwd, so the same command
 * string could be allowed in one terminal and blocked in another. That is
 * the one place this wall sees FEWER tokens than the shell that will
 * actually run the command, which the "look at more, never less" invariant
 * (P-27) elsewhere in this codebase does not otherwise permit.
 */
export function scanCommand(cmd: string): ScanHit | null {
  let expectCmd = true;
  let cls: Class = 'BENIGN';
  let redir = false;
  // Heredocs whose bodies are still to be read, oldest first (SX-021).
  const pending: HeredocOpen[] = [];
  let cont = false;

  for (const line of cmd.split('\n')) {
    if (pending.length > 0) {
      // Inside a heredoc body there are no command words, only program text.
      // Everything is scanned. This is what keeps I-0121 caught.
      if (closesHeredoc(line, pending[0]!)) {
        pending.shift();
        cont = false;
        continue;
      }
      const bodyHit = scanBodyLine(line);
      if (bodyHit !== null) return bodyHit;
      continue;
    }
    if (!cont) { expectCmd = true; cls = 'BENIGN'; redir = false; }
    const opens = heredocOpens(line);
    cont = line.endsWith('\\');

    for (const tok of line.split(/[ \t]+/)) {
      if (tok === '') continue;
      if (tok === ';' || tok === '&&' || tok === '||' || tok === '|') {
        expectCmd = true; cls = 'BENIGN'; redir = false; continue;
      }
      const trailing = /[;|]$|&&$|\|\|$/.test(tok);

      if (['>', '>>', '1>', '1>>', '2>', '2>>', '&>', '&>>'].includes(tok)) { redir = true; continue; }
      {
        // The SPACED forms are the case above (the operator is its own token
        // and the target is the next one). This is the GLUED form, including
        // the fd-prefixed and `&`-prefixed spellings R-013 closed.
        const rt = redirGluedTarget(tok);
        if (rt !== '') {
          if (isProtected(rt)) return { path: rt };
          redir = false;
          if (trailing) { expectCmd = true; cls = 'BENIGN'; }
          continue;
        }
      }

      const t = stripTok(tok);
      if (t === '') {
        if (trailing) { expectCmd = true; cls = 'BENIGN'; }
        continue;
      }

      if (redir) {
        redir = false;
        if (isProtected(t)) return { path: t };
        if (trailing) { expectCmd = true; cls = 'BENIGN'; }
        continue;
      }

      if (expectCmd) {
        if (t.includes('=') || WRAPPERS.has(t)) {
          // A VAR=value prefix or an exec-wrapper: the real command word is
          // still ahead, so stay in command position.
        } else if (MUTATORS.has(t)) { cls = 'MUTATOR'; expectCmd = false; }
        else if (INTERPRETERS.has(t)) { cls = 'INTERPRETER'; expectCmd = false; }
        else if (t === 'sed' || t === 'awk') { cls = 'SED'; expectCmd = false; }
        else if (t === 'git') { cls = 'GIT'; expectCmd = false; }
        else { cls = 'BENIGN'; expectCmd = false; }
      } else {
        // sed and awk only write with -i. Without it they are READERS, and
        // `sed -n 1,5p .claude/scripts/scrumux` is how an agent reads a script.
        if (cls === 'SED' && t.startsWith('-i')) cls = 'MUTATOR';
        // git is mostly a reader. These six subcommands overwrite a path.
        else if (cls === 'GIT') cls = GIT_MUTATING.has(t) ? 'MUTATOR' : 'BENIGN';
        if ((cls === 'MUTATOR' || cls === 'INTERPRETER') && isProtected(t)) return { path: t };
      }

      if (trailing) { expectCmd = true; cls = 'BENIGN'; }
    }
    pending.push(...opens);
  }
  return null;
}

/**
 * One heredoc BODY line: every token is program text, so any protected path
 * in it — glued to a redirect or not — is a hit (I-0121).
 *
 * Dependencies: redirGluedTarget, stripTok, isProtected.
 */
function scanBodyLine(line: string): ScanHit | null {
  for (const tok of line.split(/[ \t]+/)) {
    if (tok === '') continue;
    const rt = redirGluedTarget(tok);
    if (rt !== '' && isProtected(rt)) return { path: rt };
    const t = stripTok(tok);
    if (t !== '' && isProtected(t)) return { path: t };
  }
  return null;
}

/**
 * THE POWERSHELL SCANNER — the same question, the other grammar.
 *
 * `scanCommand` above is a token walk with command-position state, and every
 * bit of that state is POSIX: `VAR=value` prefixes, heredocs, `sed -i`, the
 * six mutating git subcommands. None of it transfers. What DOES transfer is
 * the shape of the judgement, which is why this is a sibling rather than a
 * rewrite: A SEGMENT BLOCKS WHEN its command word writes files and a protected
 * path appears in it, or when a redirect points at one, whatever runs it.
 *
 * READERS ARE STILL FREE TO NAME THE MACHINERY. `Get-Content
 * .claude/scripts/scrumux` is how an agent reads a script, and I-0134 is the
 * ruling that an order SAYING "graph is unavailable in this deployment" is
 * prose about the machinery rather than an edit of it. So the mutator list is
 * a list, not a catch-all: `Get-Content`, `Select-String` and `Test-Path` name
 * a protected path as freely here as `cat` and `grep` do there.
 *
 * `-WhatIf` IS DELIBERATELY NOT HONOURED HERE, and that is the one place this
 * wall parts company with `block-destructive`. That wall protects the repo
 * from the agent and a dry run harms nothing. This one protects the UPSTREAM
 * from the repo (P-23), it takes no `project-walls.conf` override for the same
 * reason, and "I was only going to look at what it would do" is not a
 * distinction worth carving an exemption for in a wall with no repo-level
 * escape hatch.
 */
export function psScanCommand(cmd: string): ScanHit | null {
  // A REDIRECT BLOCKS WHATEVER RUNS IT, and the walk for it is SEPARATE from
  // the command walk below because it needs a different segmentation.
  //
  // `splitAmp: false` KEEPS `&>path` ONE TOKEN, which is what lets the shared
  // `redirGluedTarget` judge it the same way the POSIX scanner does. Splitting
  // at `&` would hand this loop a token that is already `>path`, so the two
  // implementations would reach the same verdict by two different routes and
  // the `&`-prefixed case would stop being tested at all. PowerShell's own
  // stream redirects (`*>`, `2>`) are the same shape.
  for (const seg of psSegments(cmd, false)) {
    const rtokens = psTokenize(seg);
    for (let i = 0; i < rtokens.length; i += 1) {
      const t = rtokens[i]!;
      if (t.quoted) continue;
      if (['>', '>>', '1>', '1>>', '2>', '2>>', '*>', '*>>'].includes(t.text)) {
        const target = rtokens[i + 1]?.text ?? '';
        if (target !== '' && isProtected(target)) return { path: target };
        continue;
      }
      // `*>` is PowerShell's all-streams redirect and has no POSIX spelling,
      // so it is normalised to the fd form the shared helper understands.
      const rt = redirGluedTarget(t.text.replace(/^\*(?=>)/, '2'));
      if (rt !== '' && isProtected(rt)) return { path: rt };
    }
  }

  for (const seg of psSegments(cmd)) {
    const tokens = psTokenize(seg);
    if (tokens.length === 0) continue;
    const name = psCommandOf(tokens);
    if (!PS_MUTATORS.has(name) && !PS_INTERPRETERS.has(name)) continue;
    // `New-Item` only overwrites with -Force; without it, it refuses to
    // clobber an existing file and is not a write to the machinery at all.
    if (name === 'new-item' || name === 'ni') {
      if (!psHasParam(tokens, 'Force')) continue;
    }
    for (const t of tokens) {
      if (t.text === '') continue;
      if (isProtected(t.text)) return { path: t.text };
    }
  }
  // `[IO.File]::WriteAllText('.claude/scripts/x', $s)` and its family: a .NET
  // write with no cmdlet for the walk above to classify.
  for (const m of cmd.matchAll(/::\s*(Write\w*|Append\w*|Delete|Move|Copy|Create\w*)\s*\(\s*(["'])([^"']+)\2/gi)) {
    if (isProtected(m[3]!)) return { path: m[3]! };
  }
  return null;
}

export function main(io: WallIo = processWallIo()): never {
  refuseOldNode('block-upstream-edit', io);
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const input = readHookInput(hookDir, io);
  const marker = `${input.root}/.claude/DEPLOYED`;

  // Not a deployment: this is the harness's own repo, or one that predates the
  // manifest. Nothing to protect from its own author.
  if (!existsSync(marker)) allow(io);

  const block = (path: string): never => {
    let remote = 'the upstream harness repository';
    try {
      const m: unknown = JSON.parse(readFileSync(marker, 'utf8'));
      if (m !== null && typeof m === 'object') {
        const sr = (m as Record<string, unknown>)['source_remote'];
        if (typeof sr === 'string' && sr !== '') remote = sr;
      }
    } catch {
      // Best-effort: the remote is a detail of the message, not the verdict.
    }
    wallsRecord({
      root: input.root, wall: 'block-upstream-edit', subject: path,
      reason: 'harness machinery in a deployed repo is a dependency, not the work',
      payload: input.payload,
    });
    refuse(io, `BLOCKED by block-upstream-edit: ${path} is harness machinery, and this repo is a DEPLOYMENT of the harness (.claude/DEPLOYED). D-0078 boundary 1: no writes to harness machinery in a deployed repo. Capture the problem where it will be seen — .claude/scripts/scrumux issue new --type harness --source <you> --summary '<what the harness does wrong>' --fix '<what it should do>' — then fix it upstream in ${remote} and redeploy. A denied call is a stop, not an obstacle: do not re-route this change through another tool (I-0121).`);
  };

  // ---- arm 1: the edit tools -------------------------------------------
  // Edit and Write carry the target as file_path. NOTEBOOKEDIT DOES NOT — it
  // sends notebook_path, and the comment here once asserted otherwise, so
  // every notebook write walked past this wall untouched. The wall was not
  // weak; it was looking at a field that is never set.
  const fp = input.filePath !== '' ? input.filePath : input.notebookPath;
  if (fp !== '') {
    if (isProtected(fp)) block(fp);
    allow(io);
  }

  // ---- arm 2: the shell, in EITHER dialect -------------------------------
  // Two scanners, both consulted, because they answer about different
  // grammars and neither can be made to answer about the other. The POSIX
  // scanner tracks command position across `;`/`&&`/`|`, heredocs and
  // redirects; the PowerShell one knows cmdlet names, the call operator and
  // `[IO.File]::WriteAllText`. Whichever finds machinery being written first
  // blocks, through the same `block()` site, so one act gets one sentence.
  if (input.command === '') allow(io);
  const hit = scanCommand(input.command);
  if (hit !== null) block(hit.path);
  const psHit = psScanCommand(psExpand(input.command));
  if (psHit !== null) block(psHit.path);
  allow(io);
}

// RUN ONLY WHEN THIS IS THE PROCESS ENTRY, and turn the WallExit every path
// throws into a real exit code. Written once in lib/hook.ts: importing this
// module to unit-test a predicate must not execute the wall.
runAsEntry('block-upstream-edit', import.meta.url, main);
