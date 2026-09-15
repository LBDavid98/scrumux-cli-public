/**
 * `harness verify`.
 *
 * The whole reason this verb exists: Claude Code resolves project settings
 * and `$CLAUDE_PROJECT_DIR` ONCE, at launch, from the directory `claude` was
 * started in; `cd` never re-resolves them. A `.claude/settings.json` anywhere
 * other than the launch root is SILENTLY INERT — every hook chain in it is
 * dead while the repo looks completely normal from the inside. Check 1 is
 * that fact; checks 2-7 are statements about FILES downstream of it; check 8
 * is the only statement about BEHAVIOUR — verify EXECUTES every command
 * surface it ships, because I-0104 is what presence checks cost: 7/7 green on
 * a target where two surfaces exited 1 with an ImportError.
 *
 * SO THE VERDICT IS "INSTALLED", NOT "LIVE". Every one of those checks is
 * about the TARGET. None of them can see the other half of the governing fact
 * above — the root the SESSION reading them was launched with — and the verb
 * claimed "is live" while computing "is installed" until the E2E audit caught
 * an operator taking 10/10 as proof the walls were up during an `rm -rf` that
 * no wall fired on. Check 1b (`session-topology`) is the computable half of
 * that gap, as a WARN: the topology belongs to the operator's terminal, not
 * to the target, so it is reported and never allowed near the exit code.
 *
 * MACHINERY DRIFT is answered from `.claude/DEPLOYED` and NOTHING ELSE — no
 * comparison against a source checkout, because a server clones the harness,
 * deploys, and deletes the clone (T-0201, and `tests/harness-tests.sh` greps
 * this section for any SRC_ROOT reference). Files are hashed with the same
 * sha256 the manifest was written with (`sealOf`), so the comparison cannot
 * drift by idiom.
 */
import { readFileSync, opendirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '../../journal/jqformat.js';
import { runWithTimeout } from '../../journal/timeout.js';
import { ereMatches } from '../../walls/lib/ere.js';
import { sweep } from '../../schema/check.js';
import {
  HOOK_CHAINS, HOOK_CHAIN_COUNT, JOURNALS, PROBE_TIMEOUT, SURFACE_EXEMPT, SURFACE_PROBES,
  allPayloadFiles, walkLikeFind,
} from './payload.js';
import { missingChains, hookTargets, hookStartProblem, settingsFixText } from './settings.js';
import {
  firstLineCut, sealQuiet, shHead, stripTrailingNewlines, trNewlines,
} from './util.js';
import { isDir, isFile } from '../../util/fs-predicates.js';
import { check, warn, harnessEmit, type HarnessRun } from './state.js';
import { reportSessionPermissions } from './session-permissions.js';

/**
 * FROZEN vs TRACKED (D-0072 boundary 7; R-019). `.claude/rules` and
 * `.claude/skills` are prose a repo legitimately localises, and since D-S027
 * `.claude/schemas` joins them: the operator's canon (scrumux-app, D-S024)
 * versions rules, skills and schemas and layers them over a deploy, so a
 * schema that differs from this manifest is a recorded operator act, not
 * evidence of evasion. All three are reported as variance, never fatal.
 * Everything else the manifest claims — the walls and CLI under `dist`, the
 * `scripts` entry — stays frozen: a mismatch means the wall was evaded, the
 * file was replaced out of band, or the repo was deployed from a different
 * source.
 *
 * NOT the upstream-edit wall's split: an AGENT still may not write
 * `.claude/schemas` (block-upstream-edit.ts). Variance there arrives through
 * the operator's publish, which is exactly why verify stops calling it
 * tampering.
 */
export function driftClass(path: string): 'tracked' | 'frozen' {
  return TRACKED_PREFIXES.some((p) => path.startsWith(p)) ? 'tracked' : 'frozen';
}
const TRACKED_PREFIXES = ['.claude/rules/', '.claude/skills/', '.claude/schemas/'] as const;

/**
 * The probe verdict table, pure so the precedence is unit-testable: a
 * Python traceback anywhere in the output fails FIRST,
 * whatever the exit code; rc 126/127/142 fail whatever the declared regex
 * says; only then is a declared refusal consulted. Returns '' on a pass, or
 * the failure detail line.
 */
export function probeVerdict(name: string, argv: string, refusal: string, rc: number, out: string): string {
  let first = firstLineCut(out, 120);
  if (first === '') first = '(no output)';
  let why = '';
  if (out.includes('Traceback (most recent call last)')) {
    why = 'a Python traceback reached the operator';
  }
  if (why === '') {
    switch (rc) {
      case 0: break;
      case 126: why = 'rc 126 — present but not executable (a payload file that lost its mode bit)'; break;
      case 127: why = 'rc 127 — command or interpreter not found'; break;
      case 142: why = `rc 142 — exceeded the ${PROBE_TIMEOUT}s probe budget`; break;
      default: {
        const lines = out.split('\n');
        if (refusal !== '' && lines.some((l) => ereMatches(refusal, l))) {
          // a DECLARED refusal — pass
        } else if (refusal !== '') {
          why = `rc ${rc} and the output does not match its declared refusal /${refusal}/`;
        } else {
          why = `rc ${rc}, and this surface declares no refusal — its no-op must exit 0`;
        }
      }
    }
  }
  if (why === '') return '';
  return `${name} (${argv}): ${why} | first line: ${first}`;
}

/**
 * `probe_surface` — run one probe in the target. Never mutates: stdin is
 * /dev/null so nothing can block on a read, and GOV_ROOT is pinned at the
 * target (a suite may export a sandbox GOV_ROOT for its whole file, and a
 * probe must speak about the TARGET's records, not that one).
 */
function probeSurface(h: HarnessRun, name: string, argv: string, refusal: string): string {
  const r = runWithTimeout(PROBE_TIMEOUT, argv, {
    cwd: h.target,
    env: { ...h.ctx.env, GOV_ROOT: h.target },
    capture: true,
    combine: true,
  });
  return probeVerdict(name, argv, refusal, r.code, stripTrailingNewlines(r.stdout));
}

/**
 * `find <root> -name <name> -path <star>/.claude/<star>` — every entry (file
 * OR directory) whose own name matches, under a `.claude/` segment, in
 * /usr/bin/find's order: raw readdir order, a matching directory printed
 * pre-order at the point of descent.
 */
function findByName(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      const d = opendirSync(dir);
      entries = [];
      try {
        let e: Dirent | null;
        while ((e = d.readSync()) !== null) entries.push(e);
      } finally {
        d.closeSync();
      }
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.name === name && p.includes('/.claude/')) out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Check 7's body — the journal contracts, delegated to the schema reader and
 * never re-implemented here: `.claude/schemas` is the contract and a second jq
 * copy of it is free to drift from the first (D-0010, T-0113/I-0056).
 *
 * THE MODULE PRESENCE TEST IS GONE, with the module it tested for. It used
 * to ask whether `agents/lib/schema_check.py` had landed in the target,
 * because that module is what the sweep once shelled out to. The sweep is
 * NATIVE now (`src/schema/check.ts`): no interpreter is spawned, none can be
 * missing, and a check that fails on an absent file nothing reads would be
 * claiming something it does not compute.
 *
 * Both roots are the TARGET, so the journals AND the schemas come from the
 * repo being verified rather than from the harness doing the verifying.
 */
export function schemaSweepCheck(
  target: string,
  scriptsDir: string,
): { ok: boolean; detail: string } {
  const r = sweep(join(target, 'governance'), target);
  if (r.rc === 0) {
    return { ok: true, detail: `schema sweep clean against ${target}/governance` };
  }
  // Truncated to the sweep's first 3 lines, semicolon-joined for a one-line
  // summary.
  const scout = stripTrailingNewlines(r.lines.join('\n'));
  return {
    ok: false,
    detail: `the schema sweep exited ${r.rc} against ${target}/governance: ${trNewlines(shHead(scout, 3), ';')} — fix the record, or the schema if the contract genuinely changed; run GOV_ROOT=${target} ${scriptsDir}/scrumux records check for the full list`,
  };
}

function parseJson(path: string): JsonValue | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
}

export function harnessVerify(h: HarnessRun): never {
  const { cli, ctx, target } = h;
  cli.say(`=== HARNESS VERIFY -> ${target} (${ctx.today}) ===`);

  const tset = join(target, '.claude/settings.json');

  // 1. ROOT PLACEMENT. The whole reason this subcommand exists.
  if (isFile(tset)) {
    check(h, 'settings-at-root', true, `settings.json is at the repo root (${tset}), which is where Claude Code resolves it at launch`);
  } else {
    const stray = findByName(target, 'settings.json').slice(0, 5).map((p) => `${p} `).join('');
    if (stray !== '') {
      // Each path carries its own trailing space, so the em-dash clause
      // lands two spaces after the last path.
      check(h, 'settings-at-root', false, `no .claude/settings.json at the repo ROOT ${target}, but one exists deeper: ${stray} — a settings.json below the launch root is SILENTLY INERT (Claude Code resolves project settings and $CLAUDE_PROJECT_DIR once, at launch, from the launch directory; cd never re-resolves them), so every hook chain in it is dead. Move it: mv <that file> ${tset}`);
    } else {
      check(h, 'settings-at-root', false, `no .claude/settings.json at the repo ROOT ${target} — every hook chain is absent. Install it: harness deploy ${target}`);
    }
  }

  // 1b. THE SAME FACT, APPLIED TO THE SESSION DOING THE VERIFYING.
  //
  // Check 1 asks where the settings file SITS. It has always been silent
  // about the other half of the same rule: which root the process reading it
  // was LAUNCHED with. `$CLAUDE_PROJECT_DIR` is that root, resolved once at
  // launch, and when it names a different repo than the target the chains in
  // the target are installed and inert for this session — every check below
  // still goes green, because every check below is about files.
  //
  // Observed in the E2E audit: an operator ran `rm -rf` inside a governed
  // repo from a session rooted elsewhere, no wall fired, and verify said
  // 10/10 both before and after. Nothing was wrong with the install. The
  // session was not the one the install governs, and no row said so.
  //
  // WARN, never a fail (P-01): the topology is a property of how the OPERATOR
  // started their terminal, not of the target, and a check that failed on it
  // would make `harness verify <other repo>` red for everyone doing the
  // normal thing. It is also not counted in the "N/N checks" denominator —
  // see `warn` in state.ts.
  //
  // `h.ctx.env`, NOT `process.env`, for the reason check 4 gives.
  //
  // THE COMPARISON IS TEXTUAL, and deliberately: both sides of the port must
  // decide identically, and `cd -- "$X" && pwd` (sh) and `path.resolve`
  // (Node) part company on symlinks. Trailing slashes are trimmed because a
  // hand-exported value may carry one; a relative or dot-dot spelling is not
  // resolved, so the worst case is an advisory nobody needed — never a missed
  // fail and never an exit code.
  {
    let cpd = h.ctx.env['CLAUDE_PROJECT_DIR'] ?? '';
    while (cpd.length > 1 && cpd.endsWith('/')) cpd = cpd.slice(0, -1);
    if (cpd !== '' && cpd !== target) {
      warn(h, 'session-topology', `CLAUDE_PROJECT_DIR is ${cpd}, not ${target} — the session running this check resolved its project root elsewhere at launch, so the hook chains installed under ${target}/.claude/ are INERT FOR THIS SESSION: they are installed, and nothing here is running them. Claude Code resolves the project root ONCE, at launch, and cd never re-resolves it, so no command inside this session can turn them on — to work under them, launch a session with ${target} as the project root. Advisory: it says nothing about the install below, and never moves the exit code.`);
    }
  }

  // 2/3. parse + the chain roster, only meaningful once (1) holds.
  // `jq -e .` treats a file whose whole value is null or false as a failure,
  // so those parse-but-falsy files land in the "not valid JSON" arm too.
  const settingsDoc = isFile(tset) ? parseJson(tset) : undefined;
  const settingsParse = settingsDoc !== undefined && settingsDoc !== null && settingsDoc !== false;
  if (isFile(tset)) {
    if (settingsParse) {
      check(h, 'settings-parses', true, 'valid JSON');
      const mc = missingChains(settingsDoc);
      if (mc !== '') {
        check(h, 'hook-chains', false, `hook chain(s) absent: ${mc} — ${settingsFixText(h.srcClaude, target)}`);
      } else {
        check(h, 'hook-chains', true, `all ${HOOK_CHAIN_COUNT} chains declared: ${HOOK_CHAINS.join(' ')}`);
      }
    } else {
      check(h, 'settings-parses', false, `${tset} is not valid JSON — Claude Code loads no hooks at all from an unparseable settings file; fix it (jq . ${tset} names the offending line)`);
      check(h, 'hook-chains', false, 'not checked — settings.json does not parse');
    }
  } else {
    check(h, 'settings-parses', false, 'not checked — no settings.json at the repo root');
    check(h, 'hook-chains', false, 'not checked — no settings.json at the repo root');
  }

  // 4. every declared hook CAN ACTUALLY START ON THIS PLATFORM.
  //
  // This check used to ask whether the file carried the POSIX execute bit,
  // which is the right question on macOS and Linux and an unanswerable one on
  // NTFS — where the bit does not exist, Node synthesises one, and the
  // sentence "carries the execute bit" claims a property the check cannot
  // compute (audit F2). It was also blind to both ways a hook is dead on
  // Windows and healthy here: an exec-form `command` missing from PATH, and a
  // `#!/bin/sh` shim that no Windows shell can execute. `hookStartProblem`
  // asks the question all three platforms share instead, and the execute-bit
  // arm survives inside it where it still means something.
  if (isFile(tset)) {
    let badhook = '';
    for (const t of hookTargets(settingsDoc)) {
      if (t.file === '' && t.program === '') continue;
      // `h.ctx.env`, NOT `process.env` — the same environment the surface
      // probes are given. A check that resolved PATH from the ambient
      // environment while the probes resolved it from the context would be
      // answering about a different machine than the one it reports on.
      const p = hookStartProblem(t, target, h.ctx.env);
      if (p !== null) badhook += ` ${p.path}${p.why}`;
    }
    if (badhook !== '') {
      check(h, 'hooks-executable', false, `declared hook(s) unusable:${badhook} — a hook that cannot start fails on every event it is wired to and is indistinguishable from one that never fired; Claude Code treats it as NON-BLOCKING, so the tool call proceeds and the wall is silently open. Restore the file, chmod +x it, or redeploy so settings.json names a hook this platform can run`);
    } else {
      check(h, 'hooks-executable', true, `every hook declared in settings.json resolves and can start on this platform (${process.platform})`);
    }
  } else {
    check(h, 'hooks-executable', false, 'not checked — no settings.json at the repo root');
  }

  // 5. the scripts roster, derived from the payload so it cannot drift.
  const roster = allPayloadFiles(h.srcClaude, h.srcRoot);
  let missingS = '';
  let nMissing = 0;
  for (const rel of roster) {
    if (rel === '') continue;
    if (!isFile(join(target, rel))) {
      missingS += ` ${rel}`;
      nMissing += 1;
    }
  }
  const rcount = roster.length;
  if (missingS !== '') {
    check(h, 'scripts-roster', false, `${nMissing} of ${rcount} payload file(s) absent from ${target}:${missingS} — re-run harness deploy ${target}`);
  } else {
    check(h, 'scripts-roster', true, `all ${rcount} payload file(s) present`);
  }

  // 6. the journals exist at all.
  let missingJ = '';
  for (const j of JOURNALS) {
    if (!isFile(join(target, 'governance', j))) missingJ += ` ${j}`;
  }
  if (missingJ !== '') {
    check(h, 'journals', false, `journal(s) absent from ${target}/governance:${missingJ} — re-run harness deploy ${target}`);
  } else {
    check(h, 'journals', true, `all ${JOURNALS.length} journal skeleton(s) present`);
  }

  // 7. the journals conform. Delegated to the schema module, never
  // re-implemented here (D-0010, T-0113/I-0056): .claude/schemas is the
  // contract and a second copy of it is free to drift from the first.
  {
    const verdict = schemaSweepCheck(target, ctx.scriptsDir);
    check(h, 'journal-schemas', verdict.ok, verdict.detail);
  }

  // 8. THE SURFACES RUN. The only statement about BEHAVIOUR.
  let probeFails = '';
  let probeN = 0;
  let probeNames = '';
  for (const p of SURFACE_PROBES) {
    probeN += 1;
    probeNames += ` ${p.name}`;
    const pfail = probeSurface(h, p.name, p.argv, p.refusal);
    if (pfail !== '') probeFails += `; ${pfail}`;
  }

  // Coverage, DERIVED from the payload the same way the roster is: a shipped
  // .claude/scripts command named by neither table is a surface nobody
  // decided about, and that is a failure rather than a silence.
  let unprobed = '';
  for (const sp of roster) {
    if (!sp.startsWith('.claude/scripts/')) continue;
    let cov = SURFACE_PROBES.some((p) => `${p.argv} `.startsWith(`${sp} `));
    if (!cov) {
      cov = SURFACE_EXEMPT.some((e) => (e.path.endsWith('/') ? sp.startsWith(e.path) : e.path === sp));
    }
    if (!cov) unprobed += ` ${sp}`;
  }

  // An exemption is a hand-wave, so the list is PRINTED rather than implied —
  // including when it is empty, which is the state worth being able to read at
  // a glance: every shipped command has a probe.
  const exemptText = SURFACE_EXEMPT.length === 0
    ? 'none — every shipped command carries a probe'
    : SURFACE_EXEMPT.map((e) => `EXEMPT ${e.path} — ${e.reason}`).join('; ');

  if (unprobed !== '') {
    check(h, 'surfaces-run', false, `shipped command(s) probed by nothing and declared exempt by nothing:${unprobed} — every payload script must carry a SURFACE_PROBES row (cheapest bounded non-mutating no-op) or a SURFACE_EXEMPT row stating why it has none; add it in the harness source at src/nouns/harness/payload.ts.${probeFails === '' ? '' : ` Also, probe failure(s)${probeFails}`}`);
  } else if (probeFails !== '') {
    check(h, 'surfaces-run', false, `registered surface(s) that do NOT run in ${target}${probeFails} — the machinery is installed but not usable there; run the argv shown from inside ${target} to see it. Declared exemptions: ${exemptText}`);
  } else {
    check(h, 'surfaces-run', true, `all ${probeN} registered surface(s) executed in ${target} and answered:${probeNames}. Declared exemptions: ${exemptText}`);
  }

  // ---------- machinery drift, from the target's own manifest ------------
  const man = join(target, '.claude/DEPLOYED');
  const manDoc = isFile(man) ? parseJson(man) : undefined;
  const filesVal = manDoc !== undefined && manDoc !== null && typeof manDoc === 'object' && !Array.isArray(manDoc)
    ? (manDoc as { [k: string]: JsonValue })['files']
    : undefined;
  if (!isFile(man)) {
    check(h, 'machinery-drift', true, `no .claude/DEPLOYED in ${target} — deployed before the manifest existed, so drift cannot be computed and is not being claimed either way; re-run harness deploy ${target} to start recording it`);
  } else if (manDoc === undefined || filesVal === undefined || filesVal === null || filesVal === false) {
    check(h, 'machinery-drift', false, `${target}/.claude/DEPLOYED does not parse or carries no files map — the one record of what was installed is unreadable; re-run harness deploy ${target}`);
  } else {
    const files = typeof filesVal === 'object' && !Array.isArray(filesVal)
      ? (filesVal as { [k: string]: JsonValue })
      : {};
    let driftFrozen = '';
    let driftTracked = '';
    let driftGone = '';
    let dcount = 0;
    for (const dp of Object.keys(files).sort()) {
      if (dp === '') continue;
      dcount += 1;
      const dh = String(files[dp]);
      if (!isFile(join(target, dp))) {
        driftGone += ` ${dp}`;
        continue;
      }
      if (sealQuiet(join(target, dp)) === dh) continue;
      if (driftClass(dp) === 'tracked') driftTracked += ` ${dp}`;
      else driftFrozen += ` ${dp}`;
    }

    // ORPHANS: executables under the machinery directories that the manifest
    // does not claim (I-0143) — the gap the prune cannot close, because a
    // file orphaned before the prune existed is invisible to a mechanism
    // that only looks at what the previous manifest listed. Reported, never
    // auto-deleted. `find` recurses, so the check keeps its meaning wherever
    // machinery lives (the noun modules under .claude/scripts/lib/).
    // `.claude/dist` is on this list for the reason the other three are: a
    // bundle the manifest does not claim still RUNS. `ts_owns` execs
    // `.claude/dist/scrumux.mjs` by name, so a stale one left by a rename or a
    // hand-copy is a whole CLI one version out of date answering as though it
    // were current — I-0143 with a `.mjs` extension.
    let orphans = '';
    for (const od of ['.claude/scripts', '.claude/schemas', '.claude/dist']) {
      if (!isDir(join(target, od))) continue;
      for (const abs of walkLikeFind(join(target, od))) {
        const name = abs.slice(abs.lastIndexOf('/') + 1);
        if (name.endsWith('.pyc') || name === '.DS_Store') continue;
        if (abs.includes('__pycache__')) continue;
        const rel = abs.startsWith(`${target}/`) ? abs.slice(target.length + 1) : abs;
        if (Object.prototype.hasOwnProperty.call(files, rel)) continue;
        // An unclaimed SCHEMA is variance too (R-019): canon may carry a schema
        // this manifest never shipped. A schema does not run, so the reason
        // orphans fail — a stale command still RUNS — does not apply to it.
        if (driftClass(rel) === 'tracked') { driftTracked += ` ${rel} (not in the manifest)`; continue; }
        orphans += ` ${rel}`;
      }
    }

    if (orphans !== '') {
      check(h, 'machinery-orphans', false, `${target} holds machinery the manifest does not claim:${orphans}. A stale command left by a rename still RUNS — an agent can invoke it and write records with a CLI one version out of date, which is worse than it being absent. Remove them, then re-run harness deploy ${target}. If any of these is genuinely this repo's own, it is in the wrong directory: .claude/scripts and .claude/dist are the harness's.`);
    } else {
      check(h, 'machinery-orphans', true, 'no unclaimed machinery under .claude/scripts or .claude/dist (an unclaimed schema is variance, reported with machinery-drift)');
    }

    const manCommitRaw = (manDoc as { [k: string]: JsonValue })['source_commit'];
    const manCommit8 = [...String(manCommitRaw ?? 'null')].slice(0, 8).join('');
    if (driftFrozen !== '' || driftGone !== '') {
      check(h, 'machinery-drift', false, `the machinery in ${target} no longer matches what was installed.${driftFrozen === '' ? '' : ` CHANGED:${driftFrozen}.`}${driftGone === '' ? '' : ` MISSING:${driftGone}.`} The upstream wall should have made this impossible, so either it was evaded, the files were replaced out of band, or this repo was deployed from a different source (${manCommit8}). Restore them with harness deploy ${target}; a change that is genuinely wanted belongs upstream (see .claude/rules/harness-is-upstream.md).${driftTracked === '' ? '' : ` Rules, skills or schemas also vary:${driftTracked} — reported, not a failure.`}`);
    } else if (driftTracked !== '') {
      check(h, 'machinery-drift', true, `all ${dcount} installed file(s) match the manifest, except variance the target carries in rules, skills or schemas:${driftTracked} — reported, never blocking (D-0072 boundary 7, R-019); these are where a repo or the operator's canon legitimately differs`);
    } else {
      check(h, 'machinery-drift', true, `all ${dcount} installed file(s) match .claude/DEPLOYED byte for byte`);
    }
  }

  // WILL A SESSION HONOUR THIS ALLOW-LIST? (SX-008, D-S019). Advisory rows
  // only: they never count toward N/N and never change the exit code.
  reportSessionPermissions(h, join(target, '.claude/settings.json'));

  // INSTALLED, NOT LIVE, and the word is the whole point of this line. Seven
  // of the eight checks are statements about FILES in the target and the
  // eighth runs the commands they are; not one of them can observe whether a
  // session is being governed by them, because that is decided by the project
  // root the session was LAUNCHED with (see 1b). The verb said "is live" and
  // computed "is installed" — an operator read 10/10 as proof the walls were
  // up while `rm -rf` went straight through.
  //
  // `h.rows` counts checks and nothing else: `warn` deliberately does not
  // touch it.
  const nfail = cli.fails();
  const nall = h.rows;
  const summary = nfail === 0
    ? `harness verify: ${target} is INSTALLED — ${nall}/${nall} checks pass. Installed is not live: whether these hooks fire is decided by the project root a session was LAUNCHED with, which nothing inside it can change.`
    : `harness verify: ${target} is NOT fully installed — ${nfail} of ${nall} checks failed. Each FAIL line above names the fix.`;
  return harnessEmit(h, summary);
}
