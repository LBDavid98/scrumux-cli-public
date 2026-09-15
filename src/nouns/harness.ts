/**
 * The `harness` noun.
 *
 * Two verbs that are their own subsystem: `deploy` installs the governance
 * machinery into a target repo, `verify` proves it is actually INSTALLED
 * there — installed, not live: every check verify computes is about files in
 * the target and the commands they are, and whether a session is governed by
 * them is decided by the root that session was launched with.
 * The fact behind the whole command, because nothing inside a session can
 * observe it about itself: Claude Code resolves project settings and
 * `$CLAUDE_PROJECT_DIR` ONCE, at launch, from the directory `claude` was
 * started in — `cd` never re-resolves them — so a `.claude/settings.json`
 * anywhere other than the launch root is SILENTLY INERT.
 *
 * The machinery lives in `src/nouns/harness/`: the derived payload roster and
 * the one source-mapping seam (`payload.ts`), settings inspection
 * (`settings.ts`), the deployment manifest (`manifest.ts`), and the two verbs
 * (`deploy.ts`, `verify.ts`). This file is the seam: `verbs()`, `usage()`,
 * `run()`.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { nounContext, type DispatchContext, type NounModule } from './lib/context.js';
import { harnessDeploy } from './harness/deploy.js';
import { harnessVerify } from './harness/verify.js';
import type { HarnessRun } from './harness/state.js';

export const VERBS = ['deploy', 'verify'] as const;

const VERBS_TSV = 'deploy\tinstall the machinery into a target repo\n'
  + 'verify\tprove the machinery is INSTALLED in a target repo\n';
const USAGE = NOUN_USAGE['harness'] ?? '';

function harnessRun(cli: Cli, ctx: DispatchContext, verb: string, args: readonly string[]): never {
  if (verb !== 'deploy' && verb !== 'verify') {
    cli.dieUsage(`unknown verb '${verb}' for noun harness — verbs: deploy, verify. See: scrumux help harness`);
  }
  let target = '';
  for (const a of args) {
    if (a.startsWith('-')) {
      cli.dieUsage(`unknown flag ${a} — usage: scrumux harness ${verb} <target> [--json]`);
    }
    if (target !== '') {
      cli.dieUsage(`harness takes ONE target, got '${target}' and '${a}' — usage: scrumux harness ${verb} <target> [--json]`);
    }
    target = a;
  }
  if (target === '') {
    cli.dieUsage(`${verb} needs a target repo — usage: scrumux harness ${verb} <target> [--json]`);
  }

  const nctx = nounContext(ctx);
  const abs = resolve(nctx.cwd, target);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    cli.die(`target ${target} is not a directory — create it first (mkdir -p '${target}'), then re-run`);
  }
  // THE DOUBLE SPACE BELOW IS DELIBERATE, not a typo: this message's target
  // name gap is empty, byte for byte, and `test/unit/harness-
  // hardenE.test.ts` pins the literal string. Do not fill it in. The arm is
  // all but unreachable (a directory without search permission).
  try {
    accessSync(abs, constants.X_OK);
  } catch {
    cli.die('cannot resolve  — check the path and its permissions');
  }

  const h: HarnessRun = {
    cli,
    ctx: nctx,
    io: ctx.io,
    target: abs,
    // SRC_CLAUDE is derived from where the CLI lives, so it already carries
    // whichever name the source actually uses (`.deploy-claude/` here,
    // `.claude/` in a deployment) and nothing downstream needs to know which.
    srcClaude: resolve(nctx.scriptsDir, '..'),
    srcRoot: nctx.codeRoot,
    items: [],
    rows: 0,
  };
  if (verb === 'deploy') return harnessDeploy(h);
  return harnessVerify(h);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run: harnessRun,
};
