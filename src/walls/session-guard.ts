#!/usr/bin/env node
/**
 * THE FAIL-CLOSED GUARANTEE, RELOCATED — the `SessionStart` half of the four
 * walls.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * The four walls used to be reached through `.claude/hooks/block-*.sh`, and
 * the shim in front of each carried the whole fail-closed doctrine in two
 * lines: `command -v node >/dev/null || exit 2`. A missing prerequisite was a
 * REFUSAL, never a pass (CLI-1), because a wall that cannot evaluate a call
 * and waves it through is not a weakened wall, it is an absent one that still
 * looks present.
 *
 * `settings.json` now reaches the walls in EXEC FORM — `node` plus the bundle
 * path — because that is the only shape that runs on a stock Windows box, and
 * exec form cannot carry a guard: there is no shell, so there is nowhere to
 * put `command -v`. Claude Code resolves `command` on PATH itself, and when
 * that resolution fails the hooks documentation is explicit about what
 * happens: "A hook that can't start lands in the same non-blocking bucket …
 * For most hook events, the action proceeds." The tool call goes through. The
 * wall is open, and the only trace is a notice in the transcript.
 *
 * So the guarantee moves to the one event that fires before any tool call can:
 * a session opening in a governed repo asks, ONCE, whether the walls it is
 * about to rely on can actually run here — and says so in a sentence naming
 * the repo, the fault and the fix, rather than letting the session proceed
 * with four dead hooks.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT REFUSES, AND WHY NOT `exit 2`
 *
 * Every other hook in this harness refuses with exit 2. That is WRONG HERE and
 * the docs are unambiguous: in the "Exit code 2 behavior per event" table,
 * `SessionStart` is `Can block? No` — "Shows stderr to user only" — and the
 * paragraph under it spells out the consequence, that Claude Code "renders the
 * exit code 2 stderr in the transcript as a `<hook name> hook error` notice …
 * Claude doesn't see it, and the session … proceeds." An `exit 2` here would
 * be a refusal that refuses nothing, which is the exact failure this file
 * exists to correct, reproduced one layer up.
 *
 * The lever that DOES work at session open is the universal JSON field:
 * `continue: false` — "If `false`, Claude stops processing entirely after the
 * hook runs. Takes precedence over any event-specific decision fields" — with
 * `stopReason` as the message shown to the user. The doc names, event by
 * event, which events discard `continue` (Setup, Notification, ConfigChange,
 * PreCompact, SessionEnd and the rest); SessionStart is not among them, and
 * its own section adds its extra fields "in addition to the JSON output fields
 * available to all hooks". So the refusal is `continue: false` on stdout at
 * exit 0, and the reason is written THREE times on purpose:
 *
 *   stopReason         the user sees it, and it is the one that stops the run
 *   stderr             survives even if the JSON is ignored by an older build
 *   additionalContext  Claude sees it, so if the session runs anyway the agent
 *                      knows its walls are dead rather than assuming cover
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RESIDUAL, STATED RATHER THAN PAPERED OVER
 *
 * This guard is itself an exec-form `node` hook. If node is missing ENTIRELY,
 * it cannot start either, and by the same documented rule the session proceeds
 * — with a `hook error` notice in the transcript, which is visible but not
 * blocking. That case is genuinely unreachable from inside a hook, on ANY
 * platform: closing it would need a hook that runs without the runtime every
 * hook here is written in, and no shell-form spelling is simultaneously valid
 * in `sh`, `cmd.exe` and PowerShell 5.1, so there is nowhere left to put a
 * pre-flight `command -v node` check. `harness verify`'s hooks-executable
 * check is the instrument that answers it out of band.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT REFUSES ONLY WHAT IT CAN PROVE
 *
 * Blast radius: a false positive here halts EVERY session in EVERY governed
 * repo. So each arm below is a condition under which the walls are already
 * dead — never a lint, never a preference — and anything this guard cannot
 * compute it stays silent about.
 */
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readHookInput, processWallIo, runAsEntry, type WallIo } from './lib/hook.js';
import { nodeVersionProblem } from '../util/node-version.js';
import { hookTargets, hookStartProblem, missingChains } from '../nouns/harness/settings.js';
import { findMarker } from '../cli/ungoverned.js';
import { isFile } from '../util/fs-predicates.js';
import { jqCompact } from './lib/jsonl.js';

/** The shell tool this platform actually routes commands through. */
export function shellToolHere(platform: string = process.platform): string {
  // On Windows without Git Bash the Bash tool is not registered at all and
  // everything goes through PowerShell; with Git Bash both exist. Naming
  // PowerShell for win32 unconditionally is the safe direction — it is the
  // tool that MIGHT be the only one there.
  return platform === 'win32' ? 'PowerShell' : 'Bash';
}

/**
 * The one refusal seam. Exit 0 with `continue: false`, because SessionStart
 * cannot block on an exit code — see the header.
 *
 * `jqCompact` rather than `JSON.stringify` for the same reason every other
 * record in this repo uses it: one serialiser, one byte format.
 */
export function refuseSession(io: WallIo, message: string): never {
  io.err(message + '\n');
  io.out(jqCompact({
    continue: false,
    stopReason: message,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: message,
    },
  }) + '\n');
  return io.exit(0);
}

export function main(io: WallIo = processWallIo()): never {
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const input = readHookInput(hookDir, io);
  const root = resolve(input.root);

  // NOT A DEPLOYMENT, NOT THIS GUARD'S BUSINESS. Two independent outs, and
  // both are the same judgement the sibling walls make: `block-upstream-edit`
  // allows outright where `.claude/DEPLOYED` is absent, and the CLI refuses to
  // govern a repo carrying `.scrumux-ungoverned` at all. A guard that halted
  // sessions in the harness's OWN source repo would be the first thing anyone
  // deleted.
  if (findMarker(root) !== null) return io.exit(0);
  const tset = `${root}/.claude/settings.json`;
  if (!isFile(tset)) return io.exit(0);

  // 1. THE RUNTIME. We are running, so this can only be a version fault — the
  // absent-node case is the documented residual in the header.
  const old = nodeVersionProblem(process.version);
  if (old !== null) {
    // This file exists precisely because exec form -- the only hook form
    // that runs on Windows -- cannot carry an inline `command -v node`
    // guard the way a shell-form hook could, so the check has to happen
    // here instead.
    refuseSession(io, `scrumux: this session is REFUSED — the four walls in ${root} cannot run. Node ${process.version} is too old (>=22.11 is required), so every wall bundle would fail to start, and Claude Code treats a hook that cannot start as NON-BLOCKING: the tool call proceeds and the wall is silently open. Install a newer Node and reopen the session. Nothing was read or written.`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(tset, 'utf8'));
  } catch {
    refuseSession(io, `scrumux: this session is REFUSED — ${tset} is not valid JSON, so Claude Code loads NO hooks at all from it and all four walls are absent while the repo looks entirely normal from the inside. Fix the file (jq . ${tset} names the offending line), then reopen the session.`);
  }

  // 2. THE CHAINS COVER THIS PLATFORM'S SHELL TOOL. This is the arm that
  // catches a repo deployed before the migration and opened on Windows: its
  // shell chain is matched `"Bash"`, the Bash tool is not registered there,
  // and all four walls are inert with nothing in the transcript to say so.
  const missing = missingChains(doc);
  if (missing !== '') {
    refuseSession(io, `scrumux: this session is REFUSED — ${tset} is missing hook chain(s): ${missing}. On ${process.platform} Claude Code routes shell commands through the ${shellToolHere()} tool, and a chain that does not match it never fires: the walls are declared and dead. Re-run harness deploy against this repo, or copy the missing chain(s) in by hand, then reopen the session.`);
  }

  // 3. EVERY DECLARED HOOK CAN START HERE. The same computation verify's
  // hooks-executable check runs, asked at the moment it matters.
  let dead = '';
  for (const t of hookTargets(doc)) {
    if (t.file === '' && t.program === '') continue;
    const p = hookStartProblem(t, root);
    if (p !== null) dead += ` ${p.path}${p.why}`;
  }
  if (dead !== '') {
    refuseSession(io, `scrumux: this session is REFUSED — hook(s) declared in ${tset} cannot start on this platform (${process.platform}):${dead}. Claude Code treats a hook that cannot start as NON-BLOCKING, so every tool call would proceed past a wall that never ran. Re-run harness deploy against this repo (harness verify names the same fault), then reopen the session.`);
  }

  return io.exit(0);
}

runAsEntry('session-guard', import.meta.url, main);
