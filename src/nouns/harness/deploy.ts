/**
 * `harness deploy`.
 *
 * Install the governance machinery into a target repo. Every item is decided
 * by BYTE comparison, never timestamp: a timestamp comparison would call an
 * untouched file changed on every fresh clone and a rewritten-identical file
 * unchanged. What deploy does NOT do is as deliberate as what it does:
 *
 *   - it never merges a target's existing `.claude/settings.json`, with ONE
 *     narrow exception (I-0155): `permissions.allow` is UNIONED,
 *     append-if-absent, existing rules first, never removed;
 *   - it seeds ZERO repo-health checks and no roster documents (I-0029);
 *   - it prunes only what a PREVIOUS manifest claims and the payload no
 *     longer ships (I-0143), and NEVER a path the seeding lane owns — the
 *     seeded list is written by the lane that seeds, not restated at the
 *     prune, which is exactly how the two lanes once came to contradict each
 *     other with the repo's own standards deleted;
 *   - it is not transactional: a FAIL on the terminal checks rolls nothing
 *     back, and the summary says so (module brief, looseness 6).
 *
 * The terminal `records check` runs from THIS repo's scripts with GOV_ROOT at
 * the target: code location comes from where the CLI lives, data location
 * from GOV_ROOT, so the known-good validator asserts the install from
 * OUTSIDE rather than the copy whose correctness is in question.
 */
import {
  chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync,
  utimesSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { JsonValue } from '../../journal/jqformat.js';
import { refusing } from '../../journal/refusal.js';
import { ensureFile } from '../../journal/write.js';
import {
  HOOK_CHAIN_COUNT, JOURNALS, PAYLOAD_CLAUDE_MD, allPayloadFiles, srcPathOf,
} from './payload.js';
import { missingChains, hookTargets, expandProjectDir, settingsFixText } from './settings.js';
import { writeManifest } from './manifest.js';
import { constitutionAct, desiredConstitution } from './constitution.js';
import { committedText, indexNeedsCommit, reusableIndex } from './index-commit.js';
import { allowOf, detectedToolSeeds, unionAllow } from './permissions.js';
import { reportSessionPermissions } from './session-permissions.js';
import {
  grepHead3Semis, selfBundle, shHead, spawnCombinedWith,
  stripTrailingNewlines, trNewlines, type SpawnOut,
} from './util.js';
import { isDir, isFile } from '../../util/fs-predicates.js';
import { check, commitPaths, harnessEmit, item, type HarnessRun } from './state.js';

/** `cp -p src dst` — bytes, mode and timestamps. */
function cpP(src: string, dst: string): void {
  copyFileSync(src, dst);
  const st = statSync(src);
  chmodSync(dst, st.mode & 0o7777);
  utimesSync(dst, st.atime, st.mtime);
}

function bytesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function parseJson(path: string): JsonValue | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
}

/** The exact template the walls lane seeds. */
const PWALL_TEMPLATE = `# This repo's wall rules. The one place to extend the refusal layer.
#
#   refuse <extended-regex> | why this repo refuses it
#   allow  <extended-regex> | why this repo permits it
#
# \`refuse\` adds a pattern to every wall — what only this repo knows is
# dangerous here. \`allow\` exempts a command the built-in walls would stop,
# for work that legitimately needs it.
#
# Both need a reason after the pipe. A rule with no reason is ignored:
# an exemption nobody can read is an exemption nobody can audit.
# \`allow\` wins over \`refuse\`. Lines starting with # are comments.
#
# Examples:
#   refuse  flyctl deploy      | production is released by CI, never from a session
#   allow   api\\.openai\\.com   | this coursework calls the provider directly on purpose
`;

/** The exact template the standards lane seeds. */
const PSTD_TEMPLATE = `---
name: project-standards
paths: ["**"]
skills: []
scripts: []
---
# Rule: this repo's own standards

Yours to write. Nothing here is enforced by the harness: no gate reads
this file, no check fails on it, and no exit code depends on its
contents. It is context an agent is given, not a wall it hits.

Note on \`paths\`: the CLI loads ALL rules every session regardless of
what \`paths\` declares (D-0008; path-scoping is tracked as I-0001), so
write these as standards that are always in context.

To give a standard teeth of your own, name a skill in \`skills:\` and the
scripts it calls in \`scripts:\` — the harness checks those pointers
resolve to real files, and nothing more.

An example, commented out so a fresh repo validates with no dangling
pointers:

    # ---
    # name: project-standards
    # paths: ["**"]
    # skills: ["notebook-deps"]
    # scripts: [".claude/scripts/check-deps"]
    # ---
    # ## Pinned dependencies
    # The graded notebook runs against the versions in requirements.txt.
    # Do not change them, and do not add imports the file does not pin.
    # Before touching any cell that imports, run .claude/scripts/check-deps.
`;


/** What `postInstall` gives its two callers back. */
interface PostInstallRun extends SpawnOut {
  /**
   * Appended to the check detail. Empty when the check ran normally; carries
   * an explanation only when it could not run at all (see `postInstall`).
   */
  note: string;
  /** The command to name when telling an operator to re-run the check. */
  rerun: string;
}

/**
 * DEPLOY'S TWO POST-INSTALL CHECKS, RUN BY THIS BUNDLE.
 *
 * `code-graph-built` and `records-check` are the only two things `harness
 * deploy` learns from a child process rather than from the filesystem --
 * both verbs answer natively in TypeScript (R-004 for the schema sweep,
 * wave 5J for the code index), so this is a straight self-invocation, not a
 * shell handoff.
 *
 * `process.execPath` on `process.argv[1]`, the shape `graph/code-build-arm.ts`
 * already uses to reach its own parser. If there is no bundle path to
 * re-invoke (a SEA, per the caveat in `code-build-arm.ts`), the check
 * reports that it did not run rather than leaving an operator to infer it
 * from an exit code.
 */
function postInstall(
  ctx: HarnessRun['ctx'],
  argv: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): PostInstallRun {
  const self = selfBundle(ctx.env);
  if (self === null) {
    return {
      rc: 127,
      combined: '',
      note: ' — and this process has no bundle path to re-run the check on, so the check did not run at all',
      rerun: 'scrumux',
    };
  }
  const r = spawnCombinedWith(process.execPath, [self, ...argv], {
    cwd: ctx.cwd,
    env: { ...ctx.env, ...extraEnv },
    // 64 MiB. `graph code build` reports a line per skipped language and can
    // print a long parse-error list over a big tree, and Node's 1 MiB default
    // truncates a child's stream while leaving its exit code intact -- a cut
    // report that still reads as a verdict.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ...r, note: '', rerun: `${process.execPath} ${self}` };
}

export function harnessDeploy(h: HarnessRun): never {
  const { cli, ctx, target } = h;
  cli.say(`=== HARNESS DEPLOY -> ${target} (${ctx.today}) ===`);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  // 1. the payload directories, byte-compared. Only the bytes decide.
  //
  // EVERY ENTRY IS A STRAIGHT COPY. One in four used to be GENERATED: the four
  // `.claude/hooks/block-*.sh` walls installed as shims onto the bundles
  // beside them, because a deployed settings.json named the `.sh` path. It
  // names `.claude/dist/*.mjs` in exec form now — the only hook shape a stock
  // Windows box can run — so the shim was a file nothing called, and it went
  // with the bash walls it used to stand in for.
  const payloadList = allPayloadFiles(h.srcClaude, h.srcRoot);
  for (const rel of payloadList) {
    if (rel === '') continue;
    const src = srcPathOf(rel, h.srcClaude, h.srcRoot);
    const dst = join(target, rel);
    if (!isFile(dst)) {
      try {
        mkdirSync(dirname(dst), { recursive: true });
      } catch {
        cli.die(`cannot create ${dirname(dst)} — check the target's permissions`);
      }
      try {
        cpP(src, dst);
      } catch {
        cli.die(`cannot install ${rel} into ${target} — check the target's permissions`);
      }
      item(h, rel, 'CREATED');
      created += 1;
    } else if (bytesEqual(src, dst)) {
      item(h, rel, 'UNCHANGED');
      unchanged += 1;
    } else {
      try {
        cpP(src, dst);
      } catch {
        cli.die(`cannot update ${rel} in ${target} — check the target's permissions`);
      }
      item(h, rel, 'UPDATED');
      updated += 1;
    }
  }

  // 1b. CLAUDE.md at the repo ROOT. The constitution has to be in front of
  // every session or the rules below it are a directory nobody opens. Source
  // is the payload's own constitution, deliberately not the harness's
  // /CLAUDE.source.md, which is about BUILDING the harness. An existing one
  // is PRESERVED, never discarded.
  //
  // THE SOURCE FILE IS NOT NAMED `CLAUDE.md`, AND THAT IS THE WHOLE POINT.
  //
  // The payload directory is named `.deploy-claude/` so Claude Code stops
  // auto-loading the deployment cargo as live session config. It only partly
  // works: directory discovery injects a `CLAUDE.md` from the ANCESTORS of
  // any file a session reads, and it matches on the FILE's name, not the
  // directory's. So the moment a supervising session grepped anything under
  // `.deploy-claude/`, the DEPLOYED-repo constitution — "This repo is governed
  // by the harness… ratify is User's alone" — landed in its
  // context as though it were instruction. Observed in sessions
  // building this repo.
  //
  // A file named `CLAUDE.md.payload` is not a name discovery recognises, so
  // the cargo stops being injected. NOTHING CHANGES FOR A DEPLOYED REPO: this
  // is a SOURCE-side name only, the target still receives `CLAUDE.md` at its
  // root with byte-identical content, and the suffix is stripped here — the
  // one seam — exactly as `srcPathOf` is the one seam for the roster.
  const tClaude = join(target, 'CLAUDE.md');
  const srcClaudeMd = join(h.srcClaude, PAYLOAD_CLAUDE_MD);
  if (isFile(srcClaudeMd)) {
    // R-021 (D-S030): a DESIRED STATE — the payload, plus the pointer exactly
    // once while CLAUDE.pre-harness.md exists — so no redeploy can drop or
    // repeat the pointer (constitution.ts).
    const payloadMd = readFileSync(srcClaudeMd);
    const preserved = join(target, 'CLAUDE.pre-harness.md');
    const current = isFile(tClaude) ? readFileSync(tClaude) : null;
    const act = constitutionAct(current, payloadMd, isFile(preserved));
    const install = (failure: string): void => {
      try {
        writeFileSync(tClaude, desiredConstitution(payloadMd, isFile(preserved)));
        const st = statSync(srcClaudeMd);
        chmodSync(tClaude, st.mode & 0o7777);
      } catch {
        cli.die(failure);
      }
    };
    if (act === 'install') {
      install(`cannot install CLAUDE.md into ${target}`);
      item(h, 'CLAUDE.md', 'CREATED', isFile(preserved)
        ? 'the constitution, at the repo root, pointing at the preserved CLAUDE.pre-harness.md'
        : 'the constitution, at the repo root where every session reads it');
      created += 1;
    } else if (act === 'unchanged') {
      item(h, 'CLAUDE.md', 'UNCHANGED');
      unchanged += 1;
    } else if (act === 'update') {
      // Ours, from an earlier deploy: update in place, pointer restored if due.
      install(`cannot update CLAUDE.md in ${target}`);
      item(h, 'CLAUDE.md', 'UPDATED');
      updated += 1;
    } else {
      // Theirs. Preserve it and point at it.
      if (!isFile(preserved)) {
        try {
          cpP(tClaude, preserved);
        } catch {
          cli.die('cannot preserve the existing CLAUDE.md');
        }
        (h.wrote ??= []).push('CLAUDE.pre-harness.md');
      }
      install(`cannot install CLAUDE.md into ${target}`);
      item(h, 'CLAUDE.md', 'CREATED', 'existing one preserved at CLAUDE.pre-harness.md and pointed at from the new one');
      created += 1;
    }
  }

  // 2. settings.json. Written verbatim where there is none; NEVER merged
  // where there is one — except the ONE narrow union (I-0155).
  const tset = join(target, '.claude/settings.json');
  let settingsTouched = false;
  if (!isFile(tset)) {
    try {
      mkdirSync(join(target, '.claude'), { recursive: true });
    } catch {
      cli.die(`cannot create ${target}/.claude — check the target's permissions`);
    }
    try {
      cpP(join(h.srcClaude, 'settings.json'), tset);
    } catch {
      cli.die(`cannot install .claude/settings.json into ${target} — check the target's permissions`);
    }
    item(h, '.claude/settings.json', 'CREATED', 'written verbatim at the repo ROOT, which is the only place Claude Code will resolve it');
    created += 1;
    settingsTouched = true;
  } else {
    // `permissions.allow` is UNIONED, append-if-absent, existing rules first
    // and never removed (`permissions.ts unionAllow`). Hooks, env and
    // everything else stay byte-for-byte alone. An unparseable target
    // settings.json collapses the count to 0 and still reports "kept — all
    // chains present" -- a recorded looseness, reproduced on purpose rather
    // than tightened (see settings.ts header).
    let srcAllow: JsonValue[] = [];
    try {
      srcAllow = allowOf(JSON.parse(readFileSync(join(h.srcClaude, 'settings.json'), 'utf8')) as JsonValue);
    } catch {
      srcAllow = [];
    }
    const newRules = unionAllow(cli, tset, srcAllow);
    if (newRules > 0) {
      item(h, '.claude/settings.json', 'UPDATED', `permissions.allow unioned: ${newRules} canon rule(s) appended; hooks and env untouched`);
      updated += 1;
      settingsTouched = true;
    } else {
      const mc = missingChains(parseJson(tset));
      if (mc !== '') {
        item(h, '.claude/settings.json', 'UNCHANGED', `kept — deploy does not merge; hook chain(s) absent: ${mc}`);
      } else {
        item(h, '.claude/settings.json', 'UNCHANGED', `kept — deploy does not merge; all ${HOOK_CHAIN_COUNT} hook chains present`);
      }
      unchanged += 1;
    }
  }

  // 2b. BUILD TOOLS FROM THE TARGET'S OWN MANIFESTS (SX-008, D-S019). A
  // dispatched headless session has nobody to approve a tool call, so a repo
  // with package.json needs npm and one with pyproject.toml needs uv in its
  // allow-list. Unioned exactly like the canon rules: project-owned entries
  // first and never removed. Counted as an update only when the settings item
  // above did not already count this file.
  for (const seed of detectedToolSeeds(target)) {
    const n = isFile(tset) ? unionAllow(cli, tset, [...seed.rules]) : 0;
    if (n === 0) continue;
    item(h, '.claude/settings.json', 'SEEDED', `permissions.allow: ${seed.rules.join(' ')} for ${seed.manifest} (${n} appended) — a dispatched session has nobody to approve its build tool`);
    if (!settingsTouched) { updated += 1; settingsTouched = true; }
  }

  // 3. journal skeletons, create-if-absent with the exact templates scrumux
  // uses — an existing journal is never rewritten.
  for (const j of JOURNALS) {
    const jp = join(target, 'governance', j);
    if (isFile(jp)) {
      item(h, `governance/${j}`, 'UNCHANGED');
      unchanged += 1;
      continue;
    }
    refusing(cli, () => { ensureFile(jp, '{"entries": []}'); });
    if (j === 'repo-health.json') {
      // ZERO seeded checks: `records check` is User-inspection surface
      // (boundary 7); a repo registers what it wants with `scrumux health add`.
      item(h, `governance/${j}`, 'CREATED', 'seeded empty — register this repo\'s checks with scrumux health add');
    } else {
      item(h, `governance/${j}`, 'CREATED');
    }
    created += 1;
  }

  // 3a. the project-standards lane and the walls lane: create-if-absent, so a
  // repo that has filled these in keeps what it wrote through every redeploy.
  // EVERY PATH THIS LANE OWNS DECLARES ITSELF into the seeded list, and the
  // prune below reads that list and never removes one of them — one home, so
  // the two lanes cannot come to contradict each other again.
  const seededList: string[] = [];
  const seeded = (rel: string): void => { seededList.push(rel); };

  // RETIRED, NOT RECLAIMED — governance/enforcement-posture.md. It shipped as
  // MACHINERY_DOCS until 2026-09-01 and no longer does; declaring it here
  // means the prune LEAVES the copies already installed. A target-editable
  // document that is retired is walked away from, never taken back — every
  // long-lived target had months to write its own gates into its copy.
  // Nothing is created here: a target that never had one does not get one.
  seeded('governance/enforcement-posture.md');

  const pwallRel = '.claude/project-walls.conf';
  seeded(pwallRel);
  const pwall = join(target, pwallRel);
  if (isFile(pwall)) {
    item(h, pwallRel, 'UNCHANGED', 'kept — a repo\'s own wall rules are never overwritten');
    unchanged += 1;
  } else {
    try {
      writeFileSync(pwall, PWALL_TEMPLATE);
    } catch {
      // A write failure here is deliberately unchecked; the item still prints.
    }
    item(h, pwallRel, 'CREATED', 'the one pathway for this repo\'s own wall rules');
    created += 1;
  }

  const pstdRel = '.claude/rules/project-standards.md';
  seeded(pstdRel);
  const pstd = join(target, pstdRel);
  if (isFile(pstd)) {
    item(h, pstdRel, 'UNCHANGED', 'kept — a repo\'s own standards are never overwritten');
    unchanged += 1;
  } else {
    try {
      mkdirSync(join(target, '.claude/rules'), { recursive: true });
    } catch {
      cli.die(`cannot create ${target}/.claude/rules — check the target's permissions`);
    }
    try {
      writeFileSync(pstd, PSTD_TEMPLATE);
    } catch {
      // Deliberately unchecked, as above.
    }
    item(h, pstdRel, 'CREATED', 'empty template for this repo\'s own standards; advisory only, never overwritten');
    created += 1;
  }

  // 3d. the target's .gitignore, for the GENERATED views (SP-0006).
  // APPEND-ONLY, never a rewrite: each line goes in only if the file does not
  // already carry it, so a second deploy adds nothing and a repo that ignored
  // them by its own route is left alone.
  // `.scrumux/events.jsonl` joined this list on 2026-09-02 and is the one
  // entry no `views render` writes: the four WALLS append to it on every tool
  // call (`src/walls/lib/record.ts:84`), so a repo that
  // merely RAN under the harness had an untracked file appear and, on the E2E
  // operator run, committed it into history. Same rationale as the views
  // exactly -- machine-appended, nothing reads it back out of git, and an
  // untracked one reads as an uncommitted change to anything that asks git.
  // `.scratch/` joined on 2026-09-14 (D-S040, SX-026): the one directory a
  // session may fill with throwaway files and remove with `rm -rf` — the
  // destructive wall treats `<WORK_ROOT>/.scratch/` as temp space, so it must
  // never be committed. Append-if-absent like the rest: a redeploy adds it.
  const viewFiles = ['AI_LOG.MD', 'DECISIONS.MD', 'BACKLOG.MD', 'governance/governance-graph.json', '.scrumux/events.jsonl', '.scratch/'];
  const viewFilesStr = viewFiles.join(' ');
  const ign = join(target, '.gitignore');
  const ignLines = isFile(ign) ? readFileSync(ign, 'utf8').split('\n') : null;
  let ignAdd = '';
  const ignAddList: string[] = [];
  for (const vf of viewFiles) {
    // The name goes into an ERE, so its dots must be made literal — AI_LOG.MD
    // must not match AI_LOGxMD, a false negative that looks exactly like the
    // bug it exists to fix.
    const re = new RegExp(`^/?${vf.replace(/\./g, '\\.')}[\\s]*$`);
    if (ignLines !== null && ignLines.some((l) => re.test(l))) continue;
    ignAdd += ` ${vf}`;
    ignAddList.push(vf);
  }
  if (ignAdd === '') {
    item(h, '.gitignore', 'UNCHANGED', `kept — already ignores the generated views and scratch (${viewFilesStr})`);
    unchanged += 1;
  } else {
    const ignExisted = ignLines !== null;
    try {
      // A file whose last byte is not a newline would otherwise get the first
      // appended line welded onto its last one.
      if (ignExisted) {
        const raw = readFileSync(ign);
        if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) appendFileSync(ign, '\n');
      }
      let block = '';
      if (ignExisted) block += '\n';
      block += '# Written by scrumux, not by hand: the rendered views, the walls\' event log and the session scratch directory.\n';
      block += '# The JSON under governance/ is the source of truth; these are projections.\n';
      for (const vf of ignAddList) block += `${vf}\n`;
      appendFileSync(ign, block);
    } catch {
      cli.die(`cannot write ${ign} — check the target's permissions`);
    }
    if (ignExisted) {
      item(h, '.gitignore', 'UPDATED', `appended${ignAdd} — scrumux writes them into the repo root (views render, the walls' event log, session scratch in .scratch/), and an untracked generated file reads as an uncommitted change`);
      updated += 1;
    } else {
      item(h, '.gitignore', 'CREATED', `ignoring${ignAdd} — scrumux writes them into the repo root (views render, the walls' event log, session scratch in .scratch/), and an untracked generated file reads as an uncommitted change`);
      created += 1;
    }
  }

  // 3c. the target's CODE INDEX, built from THIS checkout — the builder
  // travels with the harness source, the only checkout with the grammars.
  // NOT a payload item and NOT in the manifest: the index is DERIVED.
  // Built by this bundle, from web-tree-sitter and the grammars vendored under
  // tools/grammars/ — see `postInstall`.
  const cgPath = join(target, 'governance/code-graph.json');
  // D-S034: a committed index that is not stale is REUSED — no rebuild, no
  // write, nothing listed. A rebuild would only move its build stamp and
  // leave a modified file that `deliver` refuses a checkout over.
  const reuse = reusableIndex(target);
  const cg = reuse.reuse
    ? null
    : postInstall(ctx, ['graph', 'code', 'build', '--repo', target]);
  const cgout = cg === null ? '' : stripTrailingNewlines(cg.combined);
  if (cg === null) {
    cli.say(`  REUSED    governance/code-graph.json — committed and fresh (${reuse.reason})`);
    check(h, 'code-graph-built', true, `the committed code index in ${target} is fresh (${reuse.reason}), so it was reused rather than rebuilt; every scrumux graph code query there answers from it`);
  } else if (cg.rc === 0) {
    // DERIVED, AND STILL A RECORD TO COMMIT (R-020). A dispatched session runs
    // in a worktree cut from HEAD, with this repo's deployed CLI and no
    // grammars, so the index it queries is the one git carries. Listed only
    // when it differs from the committed index apart from the build stamp
    // (R-022, D-S031) — the stamp alone is not a change worth a commit.
    let cgNow: string | null = null;
    try { cgNow = readFileSync(cgPath, 'utf8'); } catch { cgNow = null; }
    if (indexNeedsCommit(committedText(target, 'governance/code-graph.json'), cgNow)) {
      (h.wrote ??= []).push('governance/code-graph.json');
    }
    const first = (cgout.split('\n', 1)[0] ?? '').replace(/^graph code: /, '');
    cli.say(`  BUILT     governance/code-graph.json — ${first}`);
    check(h, 'code-graph-built', true, `the code index was built into ${target} from this checkout, so every scrumux graph code query there answers with no parser of its own${cg.note}`);
  } else {
    cli.say('  SKIPPED   governance/code-graph.json — not built');
    check(h, 'code-graph-built', false, `the code index was NOT built into ${target}: ${trNewlines(shHead(cgout, 2), ' ')} — every scrumux graph code query there will say it has no index. Build it from any harness checkout that has the tree-sitter grammars: scrumux graph code build --repo ${target}${cg.note}`);
  }

  // 3b. PRUNE what we installed and no longer ship (I-0143), then write the
  // manifest last of the writes so it hashes what actually landed. The prune
  // only ever removes paths the PREVIOUS manifest claims this installer put
  // there — and NEVER a seeded path, however loudly the old manifest claims
  // it; a kept path is SAID, and dropped from the new manifest so no later
  // deploy reconsiders it.
  let pruned = 0;
  const prevManifest = join(target, '.claude/DEPLOYED');
  if (isFile(prevManifest)) {
    let was: string[] = [];
    try {
      const doc = JSON.parse(readFileSync(prevManifest, 'utf8')) as { files?: { [k: string]: JsonValue } };
      const files = doc.files;
      if (files === null || files === undefined || typeof files !== 'object' || Array.isArray(files)) {
        throw new Error('no files map');
      }
      was = Object.keys(files).sort();
    } catch {
      was = [];
    }
    for (const old of was) {
      if (old === '') continue;
      if (payloadList.includes(old)) continue; // still shipped
      if (seededList.includes(old)) {
        item(h, old, 'KEPT', 'repo-owned, not pruned — an older harness shipped it as payload and this manifest still claims it; dropped from the new manifest so no later deploy reconsiders it');
        continue;
      }
      if (!isFile(join(target, old))) continue; // already gone
      try {
        unlinkSync(join(target, old));
      } catch {
        continue; // `rm -f … && { … }` — a failed removal reports nothing
      }
      item(h, old, 'REMOVED', 'no longer part of the payload');
      pruned += 1;
    }
  }

  const man = writeManifest(h, payloadList);
  item(h, '.claude/DEPLOYED', man.status, `manifest of ${man.filesCount} payload file(s) from ${[...man.sourceCommit].slice(0, 8).join('')}`);

  const total = created + updated + unchanged;
  cli.say('');
  cli.say('--- checks ---');

  // 4. the settings check, reported as a check and not just an item, so the
  // Control app sees the same verdict a human reads.
  if (isFile(tset)) {
    const mc = missingChains(parseJson(tset));
    if (mc !== '') {
      check(h, 'settings-hook-chains', false, `${target}/.claude/settings.json is missing hook chain(s): ${mc} — ${settingsFixText(h.srcClaude, target)}`);
    } else {
      check(h, 'settings-hook-chains', true, `all ${HOOK_CHAIN_COUNT} hook chains declared at the repo root`);
    }
  } else {
    check(h, 'settings-hook-chains', false, `${target}/.claude/settings.json does not exist — install it: cp ${h.srcClaude}/settings.json ${target}/.claude/settings.json`);
  }

  // 4b. EVERY HOOK COMMAND MUST STILL NAME A FILE THAT EXISTS. Deploy prunes
  // payload files it no longer ships, and a target's own settings.json can
  // name one of them — deploy is the thing that caused it, and the operator
  // is standing right there. Reported, never rewritten.
  if (isFile(tset)) {
    let deadhook = '';
    for (const t of hookTargets(parseJson(tset))) {
      // EXEC FORM'S FILE IS args[0], NOT `command`. Deploy asks only about the
      // FILE it might have pruned; whether `node` itself is on PATH is a
      // property of the machine rather than of the install, and verify's
      // hooks-executable is where that belongs.
      if (t.file === '') continue;
      const dhp = expandProjectDir(t.file, target);
      if (!isFile(dhp)) {
        const shown = dhp.startsWith(`${target}/`) ? dhp.slice(target.length + 1) : dhp;
        deadhook += ` ${shown}`;
      }
    }
    if (deadhook !== '') {
      check(h, 'settings-hook-commands', false, `${target}/.claude/settings.json declares hook command(s) naming a file that is not there:${deadhook} — every event on those chains fails silently, and the repo looks entirely normal from the inside. This repo kept its own settings.json (deploy never merges one), so a payload file renamed or dropped upstream leaves the pointer behind. Take the current settings verbatim: rm ${target}/.claude/settings.json && <this command> again — or edit those command(s) by hand if this repo's settings.json carries hooks of its own worth keeping.`);
    } else {
      check(h, 'settings-hook-commands', true, 'every hook command in the target\'s settings.json names a file that exists');
    }
  } else {
    check(h, 'settings-hook-commands', false, 'not checked — no settings.json at the repo root');
  }

  // 4c. WILL A SESSION HONOUR THIS ALLOW-LIST? (SX-008, D-S019). Passive:
  // advisory rows that never count as checks and never change the exit code.
  reportSessionPermissions(h, tset);

  // 5. the install is not an install until the target validates. The SOURCE
  // checkout's validator runs with GOV_ROOT at the target: code location from
  // where the CLI lives, data location from GOV_ROOT, so the known-good
  // validator asserts the install from OUTSIDE. Native, like the graph child
  // above: R-004 made the schema sweep answer with no interpreter at all.
  const gv = postInstall(ctx, ['records', 'check'], { GOV_ROOT: target });
  const gvout = stripTrailingNewlines(gv.combined);
  if (gv.rc === 0) {
    check(h, 'records-check', true, `clean against ${target}${gv.note}`);
  } else {
    check(h, 'records-check', false, `exited ${gv.rc} against ${target} — the install is NOT good; run GOV_ROOT=${target} ${gv.rerun} records check and fix each named finding. First lines: ${grepHead3Semis(gvout, /^ *(FAIL|WARN) /)}${gv.note}`);
  }

  let changed: boolean;
  let summary: string;
  if (created === 0 && updated === 0) {
    changed = false;
    summary = `harness deploy: nothing changed — all ${total} payload item(s) in ${target} already match this harness byte for byte, and .claude/DEPLOYED already describes them.`;
  } else {
    changed = true;
    // `${PRUNED:+, $PRUNED removed}` — PRUNED is assigned `0` before the
    // prune loop, and `:+` tests set-and-non-null, which "0" is. So the
    // clause appears on EVERY changed summary, ", 0 removed" included.
    // Reproduced, not repaired (looseness — see the module notes).
    summary = `harness deploy: ${created} created, ${updated} updated, ${unchanged} unchanged, ${pruned} removed (${total} payload item(s)) in ${target}, plus .claude/DEPLOYED.`;
  }
  if (cli.fails() !== 0) {
    summary += ' The install FAILED its checks — see the check lines above; nothing was rolled back, fix and re-run.';
  }

  // A DEPLOY DIRTIES THE TARGET, AND A DIRTY TARGET REFUSES A MERGE.
  // `deliver` will not merge into a checkout with uncommitted changes, so a
  // deploy run mid-sprint silently blocks the next acceptance there. This
  // does NOT commit on the operator's behalf — it only says what just
  // happened and what it will cost.
  if (changed && isDir(join(target, '.git'))) {
    let dirty = 0;
    try {
      const r = spawnSync('git', ['-C', target, 'status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '';
      dirty = (out.match(/\n/g) ?? []).length;
    } catch {
      dirty = 0;
    }
    if (dirty > 0) {
      summary += ` ${target} now has ${dirty} uncommitted file(s). \`deliver\` refuses a dirty checkout, so commit them before accepting or dispatching work there.`;
    }
  }

  return harnessEmit(h, summary, {
    changed,
    created,
    updated,
    unchanged,
    // Additive (R-020): what a caller committing this deploy should stage.
    commit_paths: commitPaths(h),
  });
}
