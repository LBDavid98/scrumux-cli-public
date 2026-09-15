#!/usr/bin/env node
/**
 * Wall 4 of 4 — direct LLM provider calls.
 *
 * Model traffic goes through whatever gateway this repo has declared, so
 * keys, model policy and spend have one home. THE PRINCIPLE IS GENERIC AND
 * THE DESTINATION IS THE REPO'S TO DECLARE (D-0086): the shipped text names
 * `.claude/rules/project-standards.md`, never one installation's gateway.
 *
 * A DOMAIN IN A COMMAND IS ONLY EVIDENCE OF A CALL IF THE COMMAND CAN MAKE
 * ONE. `scrumux decide new --rationale "...api.openai.com..."` — recording WHY
 * an exemption was declared — was refused by this wall for naming the provider
 * in prose. It reaches nothing. Same family as I-0132 / I-0134 / I-0135: match
 * the act, not the string.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readHookInput, allow, refuse, refuseOldNode,
  processWallIo, runAsEntry, type WallIo,
} from './lib/hook.js';
import { loadConf, emitWarnings, allows, refuses, reasonFor } from './lib/conf.js';
import { cmdWords } from './lib/cmd-words.js';
import { canCallOut, shellDials } from './lib/predicates.js';
import { wallsRecord } from './lib/record.js';
import { matchesAnyLine } from './lib/ere.js';
import { psExpand } from './lib/ps.js';
import { psCanCallOut } from './lib/ps-reads.js';

const PROVIDERS = new RegExp(
  'api\\.anthropic\\.com|api\\.openai\\.com|generativelanguage\\.googleapis\\.com'
  + '|aiplatform\\.googleapis\\.com|api\\.mistral\\.ai|api\\.cohere\\.(ai|com)'
  + '|api\\.groq\\.com|openrouter\\.ai|api\\.together\\.(xyz|ai)'
  + '|bedrock(-runtime)?\\.[a-z0-9-]+\\.amazonaws\\.com|api\\.x\\.ai'
  + '|api\\.deepseek\\.com|api\\.perplexity\\.ai',
  'i',
);

const REMEDY =
  'BLOCKED by no-direct-llm-calls: this command targets an LLM provider API directly. '
  + 'Model traffic goes through whatever gateway this repo has declared, so keys, model policy and spend have one home. '
  + 'Read .claude/rules/no-direct-llm-calls.md, and this repo\'s own gateway details in .claude/rules/project-standards.md. '
  + 'Never paste or print a token — reference a secret by path (.claude/scripts/scrumux secret set NAME). '
  + 'If this repo genuinely must call a provider directly — a course assignment, a vendor SDK under test, or a repo whose gateway IS the provider — '
  + 'declare it once in .claude/project-walls.conf with an allow line and a reason. That is the sanctioned path; going around the wall is not.';

export function main(io: WallIo = processWallIo()): never {
  refuseOldNode('block-direct-llm', io);
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const input = readHookInput(hookDir, io);
  if (input.command === '') allow(io);

  const conf = loadConf(input.root);
  // Through the SEAM, not process.stderr. One output path per wall, so a
  // named skip is visible to a test the same way it is visible to the agent
  // -- and Article 5 makes that line product surface like any other.
  emitWarnings(conf, io.err);

  // This repo's own say, FIRST. A wall that argues with its owner is the wall
  // people route around (P-29).
  if (allows(conf, input.command)) allow(io);
  const r = refuses(conf, input.command);
  if (r.refused) {
    const why = r.failedClosed
      ? 'a refuse pattern this build cannot evaluate — refusing rather than waving it through (OQ-8, D-0085)'
      : reasonFor(conf, 'refuse', input.command);
    wallsRecord({
      root: input.root, wall: 'project-walls.conf',
      subject: cmdWords(input.command)[0] ?? '', reason: why, payload: input.payload,
    });
    refuse(io, `BLOCKED by project-walls.conf: ${why}`);
  }

  // THE POWERSHELL DIALECT JOINS THE POSIX ONE. `Invoke-RestMethod
  // https://api.openai.com/...` carries no POSIX program word, and `iwr` and
  // `irm` carry nothing a word list built for sh would recognise. Note what
  // does NOT change: `curl` and `wget` were already on the POSIX call-out
  // list, and on Windows they are ALIASES for Invoke-WebRequest — the same
  // verdict for a different reason, which is worth knowing before someone
  // concludes the cover is there when `curl` has been aliased away.
  //
  // `psExpand` first, so an `iex`, a `-Command` payload or a base64
  // `-EncodedCommand` blob is scanned as the command it is rather than as the
  // opaque string it looks like.
  const psCmd = psExpand(input.command);
  if (!canCallOut(input.command) && !shellDials(input.command) && !psCanCallOut(psCmd)) allow(io);

  // grep -Eqi, so line-oriented. See block-destructive.ts for the
  // shell-payload case that made this not a detail.
  if (matchesAnyLine(PROVIDERS, psCmd)) {
    wallsRecord({
      root: input.root, wall: 'block-direct-llm',
      subject: cmdWords(input.command)[0] ?? '',
      reason: 'targets an LLM provider API directly instead of the gateway',
      payload: input.payload,
    });
    refuse(io, REMEDY);
  }
  allow(io);
}

// RUN ONLY WHEN THIS IS THE PROCESS ENTRY, and turn the WallExit every path
// throws into a real exit code. Written once in lib/hook.ts: importing this
// module to unit-test a predicate must not execute the wall.
runAsEntry('block-direct-llm', import.meta.url, main);
