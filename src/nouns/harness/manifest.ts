/**
 * The deployment manifest. `.claude/DEPLOYED` is what makes a deployed repo
 * self-describing:
 * the upstream wall refuses harness writes only where it exists, and verify
 * answers the drift question from its per-file sha256 map with no source
 * checkout on hand. It is REWRITTEN on every deploy, never merged — a stale
 * hash map would bless exactly the drift it exists to catch — and its status
 * is decided by BYTES against the previous file, exactly as every payload
 * item's is: reporting it UPDATED on a true no-op would make "nothing
 * changed" false.
 *
 * WHOSE COMMIT IS source_commit? The payload's, not the deploying
 * directory's — and those differ the moment a deploy is RELAYED through a
 * repo that is itself a deployment. If the deploying root carries
 * `.claude/DEPLOYED` (the literal name: a deployment's harness dir is always
 * `.claude/`, and the one repo whose payload dir is named differently is the
 * source repo, which is never a deployment), the payload came from wherever
 * THAT says, and the relay is recorded separately as `deployed_from`.
 *
 * BYTE FORMAT MATTERS: `harness verify` hashes against the values in this
 * file, and every manifest already on disk in a deployed repo was written
 * jq-shaped — so it is serialised with `jqFormat`, never `JSON.stringify`. A
 * formatting change here reads as drift in every repo already deployed.
 *
 * ---------------------------------------------------------------------
 * THIS FILE IS THE ONLY DRIFT AUTHORITY, `.claude/dist/` INCLUDED.
 *
 * The TS bundles are payload, and they arrive carrying a second sha map of
 * their own: `BUILD.json`, written by `tools/build.mjs` with a
 * sha256 per bundle under the same target-relative keys this map uses. Two
 * hash maps over one set of files is a standing invitation to consult the
 * wrong one, so the choice is written down here rather than left to whoever
 * reads verify next.
 *
 *   BUILD.json is PROVENANCE. It says which bundles this repo built and on
 *   what date. `harness verify` does not read it and must not: it describes
 *   the bundle as BUILT IN THE SOURCE, and every question verify asks is
 *   about the bundle as INSTALLED IN THE TARGET.
 *
 *   .claude/DEPLOYED is the ORACLE. Every hash below is computed from the
 *   target's own copy at install time, by the run that installed it.
 *
 * WHY NOT BOTH. A second oracle can disagree with the first, and when it
 * does the disagreement is a SOURCE-side inconsistency — someone rebuilt
 * `.deploy-claude/dist/` without regenerating BUILD.json, or edited a bundle
 * by hand — which verify would then report as tampering INSIDE A TARGET that
 * has only ever received files. That is the "freshly rebuilt bundle read as
 * drift against a stale manifest" failure exactly, and the shape of it is
 * general: a manifest written by the installer can never be stale relative to
 * what that installer just wrote, while any map that travels WITH the payload
 * can be stale relative to the payload the moment a hand touches it.
 *
 * WHY IT IS SAFE. BUILD.json is itself payload, so the bundles and their
 * build record travel together and are hashed together by one manifest write.
 * A rebuild in the source is invisible to a target until the next deploy, and
 * that deploy rewrites the bundles, BUILD.json and this map in the same pass.
 * Nothing in a target ever rebuilds, so between deploys the map cannot go
 * stale. `built_at` is a DATE, so a rebuild on a later day changes BUILD.json
 * even when every bundle is byte-identical and the next deploy reports it
 * UPDATED — cosmetic, truthful (the file did change), and cheaper than
 * excluding it from the roster, which would leave an unclaimed file under
 * `.claude/dist/` for the orphan check to special-case.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jqFormat, type JsonValue } from '../../journal/jqformat.js';
import { cmpString } from '../lib/jqlike.js';
import { gitOut, sealQuiet } from './util.js';
import { isFile } from '../../util/fs-predicates.js';
import type { HarnessRun } from './state.js';

export type ManifestStatus = 'CREATED' | 'UNCHANGED' | 'UPDATED';

export interface ManifestResult {
  status: ManifestStatus;
  /** `jq -r '.files | length'` on the file just written. */
  filesCount: number;
  /** `jq -r .source_commit` on the same. */
  sourceCommit: string;
}

export function writeManifest(h: HarnessRun, payloadList: readonly string[]): ManifestResult {
  const srcManifest = join(h.srcRoot, '.claude/DEPLOYED');
  let remote = '';
  let commit = '';
  let relay: { [k: string]: JsonValue } | null = null;
  interface RelaySource { source_remote?: unknown; source_commit?: unknown }
  let relaySource: RelaySource | null = null;
  if (isFile(srcManifest)) {
    try {
      relaySource = JSON.parse(readFileSync(srcManifest, 'utf8')) as RelaySource;
    } catch {
      relaySource = null;
    }
  }
  const relayCommit = relaySource?.source_commit;
  if (relaySource !== null && relayCommit !== null && relayCommit !== undefined && relayCommit !== false) {
    // `jq -r '.source_remote // ""'` — null/false collapse to the empty string.
    const r = relaySource.source_remote;
    remote = typeof r === 'string' ? r : r === null || r === undefined || (r as unknown) === false ? '' : String(r);
    commit = typeof relayCommit === 'string' ? relayCommit : String(relayCommit);
    relay = {
      path: h.srcRoot,
      head: gitOut(h.srcRoot, ['rev-parse', 'HEAD']) ?? 'unknown',
      note: 'this deploy was relayed through a repo that is itself a deployment; source_commit above names the harness the payload came from, not this path',
    };
  } else {
    remote = gitOut(h.srcRoot, ['config', '--get', 'remote.origin.url']) ?? '';
    commit = gitOut(h.srcRoot, ['rev-parse', 'HEAD']) ?? '';
  }
  if (remote === '') remote = 'unknown — the deploying checkout had no origin remote';
  if (commit === '') commit = 'unknown';

  // THE KEYS ARE SORTED, AND THE ROSTER'S OWN ORDER IS NOT TOUCHED.
  //
  // The roster is enumerated in BSD `find` order — raw readdir, which on APFS
  // is B-tree hash order — and that order is contract for deploy's ITEM LINES
  // (payload.ts's header, and the ordering assertions that rest on it). It is
  // not contract for a MANIFEST. A hash map whose key order depends on
  // filesystem enumeration is not reproducible: two deploys of byte-identical
  // payloads produce byte-different `.claude/DEPLOYED` files, the byte
  // comparison two lines below reports UPDATED on a true no-op, and "nothing
  // changed" — the one sentence a reader trusts most — becomes false. That is
  // the CI red this fixes: three macOS parity assertions (no UPDATED items,
  // .claude/DEPLOYED as UNCHANGED, and the bytes actually unmoved).
  //
  // BYTE-ORDERED, CODEPOINT COMPARISON, NEVER LOCALE COLLATION. `cmpString`
  // compares CODEPOINTS — and UTF-8 was designed so that comparing encoded
  // bytes and comparing codepoints give the same answer, which is why "byte
  // order" and "codepoint order" mean the same ordering here rather than two
  // that happen to agree on ASCII. A locale-aware collation would not agree:
  // this repo has been bitten by locale collation before, and `sort` under a
  // UTF-8 locale ignores punctuation at the first pass, which reorders
  // exactly the `.`-and-`/`-rich strings a payload roster is made of.
  const files: { [k: string]: JsonValue } = {};
  for (const rel of [...payloadList].sort(cmpString)) {
    if (rel === '') continue;
    const p = join(h.target, rel);
    if (!isFile(p)) continue;
    files[rel] = sealQuiet(p);
  }

  const doc: { [k: string]: JsonValue } = {
    source_remote: remote,
    source_commit: commit,
    deployed_at: h.ctx.today,
    ...(relay === null ? {} : { deployed_from: relay }),
    files,
  };
  const bytes = jqFormat(doc);

  const dest = join(h.target, '.claude/DEPLOYED');
  let status: ManifestStatus;
  if (!isFile(dest)) {
    status = 'CREATED';
  } else {
    let prev = '';
    try {
      prev = readFileSync(dest, 'utf8');
    } catch {
      prev = '';
    }
    status = prev === bytes ? 'UNCHANGED' : 'UPDATED';
  }
  try {
    writeFileSync(dest, bytes);
  } catch {
    h.cli.die(`cannot write ${h.target}/.claude/DEPLOYED — check the target's permissions`);
  }
  return { status, filesCount: Object.keys(files).length, sourceCommit: commit };
}
