#!/usr/bin/env node
/**
 * The one executable. It does three things and delegates everything else:
 * the version banner, the call into dispatch, and the error boundary.
 *
 * ORDER MATTERS HERE. The exit rule is installed BEFORE anything that can
 * fail. In bash the jq guard fires while `die` is still lib.sh's -- which
 * exits 1 -- so a missing jq made `status session` return 1, "the assertion
 * did not hold", for a command that never ran (docs/port/PHILOSOPHY.md
 * P-02). The shape of that bug is a bootstrap failure inheriting the wrong
 * code, and the fix is to have no code path that can fail before the rule
 * exists. That is why the version check is a static import of a file written
 * in ES5-parseable syntax and everything else is imported after it.
 *
 * The body lives in src/cli/dispatch.ts so it is reachable from a unit test:
 * every refusal message in this CLI is product surface (Article 5), and a
 * message only a subprocess can reach is a message v8 coverage cannot see.
 */
import { nodeVersionProblem } from '../util/node-version.js';

const vp = nodeVersionProblem(process.version);
if (vp !== null) {
  process.stderr.write(vp + '\n');
  process.exit(2);
}

import { dispatch } from '../cli/dispatch.js';
import { ExitSignal } from '../cli/exit.js';

// `process.exitCode`, NEVER `process.exit`, and this was measured.
//
// When stdout is a PIPE -- which is every interesting caller: the SessionStart
// hook, `jq`, the differential harness, `$( )` -- Node's writes to it are
// ASYNCHRONOUS, and `process.exit` tears the process down with the queued
// bytes still queued. A report that fits in the pipe buffer survives and a
// large one is silently truncated: `backlog tasks` over the 5,000-entry tier-2
// fixture came back cut at ~1,300 of 8,575 lines, exit 0, with nothing to say
// anything was missing. A truncated report that reports success is the worst
// failure shape this CLI has.
//
// Setting the code and RETURNING lets Node drain stdout and then exit with it.
// Nothing here leaves a handle open -- every child process this CLI runs is
// spawned synchronously -- so "drain and exit" is immediate, not a wait.
try {
  dispatch(process.argv.slice(2));
} catch (e) {
  if (e instanceof ExitSignal) {
    process.exitCode = e.code;
  } else {
    // The error boundary. Anything unhandled is "could not run" -> exit 2,
    // never a silent 0 and never a 1 that reads as a real verdict.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`scrumux: error: ${msg}\n`);
    process.exitCode = 2;
  }
}
