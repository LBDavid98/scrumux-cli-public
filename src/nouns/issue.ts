/**
 * The `issue` noun. Brief: docs/port/modules/design-nouns.md.
 *
 * FOUR VERBS, AND TWO OF THEM ARE THE PROMOTION GATE. `validate` records what
 * an INDEPENDENT identity found; `authorize` records that User said fix it
 * anyway. They are disjoint facts (I-0010) and neither branch touches the
 * other's field -- `sprint new --hotfix --issue` reads both and refuses on
 * neither being present, so a port that let `authorize` write `.validation`
 * would open the fast lane on an unconfirmed report.
 *
 * THE VERDICT STATE MACHINE has four values and only two of them are gates:
 *
 *   reproduced | evidenced   the claim stands -- promotion may proceed.
 *   invalidated              the disproof is the deliverable (D-0011); the
 *                            issue is closed, not fixed.
 *   duplicate                needs `--duplicate-of`, which must RESOLVE
 *                            (an issue or a backlog task) and must not be
 *                            the issue itself.
 *
 * ...and any OTHER string in `.validation.verdict` -- a hand-written journal,
 * a record from an older vocabulary -- is not this module's to police. This
 * writer accepts whatever verdict string it is given; `sprint new`'s hotfix
 * gate is what refuses an unrecognised one when it matters (see
 * `hotfixGate` in sprint.ts). Validating the vocabulary here too would be a
 * second encoding of a decision that belongs entirely to the gate that
 * consumes it.
 *
 * SELF-VALIDATION IS REFUSED BY DISJOINTNESS ONLY (P-47).
 * Not a roster allowlist -- one was designed and rejected, because of the
 * identities actually in use only `issue-validator` appears in `.claude/agents`,
 * so an allowlist would reject User and every `claude` validation AND make the
 * validator's own reports permanently unvalidatable. User is exempt by literal
 * string comparison: him validating his own report is the authority the gate
 * defers to, not a bypass of it. The refusal deliberately does not prescribe
 * the `--by` value to use instead (I-0099).
 *
 * `--waives` REPLACES rather than appends (OQ-DN2, unruled). An issue created
 * with two waivers and later updated with one ends up carrying one. Left as
 * it stands; the two readings produce materially different data and only
 * User's intent settles which is the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { emitted } from '../journal/beat.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { refExists, requireTaskRef } from '../journal/refs.js';
import { refusing } from '../journal/refusal.js';
import { sealBootstrap } from '../journal/seals.js';
import { ensureFile } from '../journal/write.js';
import { issueRead, nearDuplicates } from './issue-read.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';
import {
  appendEntry,
  flagValue,
  guardedAppend,
  guardedWrite,
  idStream,
  mapEntries,
} from './lib/writers.js';

export const VERBS = ['new', 'update', 'validate', 'authorize', 'list', 'find'] as const;

const VERBS_TSV = `new\traise a defect, drift, harness problem or idea
update\tchange status, severity, fix text or waivers
validate\trecord a read-only agent's verdict on the claim
authorize\trecord that the FIX is authorized (never a validation)
list\tthe open issues (or --status …), read-only
find\tissues whose id, summary, fix, task or files contain TEXT
`;

/** The seed template, byte for byte -- 16 bytes, not jq's 22 (P-49). */
const SEED = '{"entries": []}';

/** `--source` is a closed vocabulary, not prose (T-0130). */
const SOURCES = [
  'User', 'human', 'claude', 'monitor', 'implement-sop', 'session-check',
  'session-review', 'planning-session', 'issue-validator', 'simplicity-engineer',
  'panel-review', 'debugger', 'governance-validate', 'decisions-pending',
  'arbiter-review', 'audit-agent',
] as const;

const TYPES = ['drift', 'defect', 'idea', 'governance', 'harness'] as const;
const VERDICTS = ['reproduced', 'evidenced', 'invalidated', 'duplicate'] as const;
const STATUSES = ['open', 'accepted', 'resolved', 'rejected'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** `$GOV/issues.json`, the one journal this noun writes. */
function issuesPath(ctx: NounContext): string {
  return join(ctx.gov, 'issues.json');
}

/** `ref_exists "$GOV/issues.json" '.entries[].id' "$IID"`, with the refusal. */
function requireIssue(cli: Cli, ctx: NounContext, verb: string, id: string): void {
  if (refExists(issuesPath(ctx), id)) return;
  cli.die(
    `issue ${verb}: ${id} not found in issues.json — list them: scrumux issue list --status all`,
  );
}

// ---------------------------------------------------------------- authorize
function issueAuthorize(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const iid = args[0] ?? '';
  const rest = args.slice(1);
  if (iid === '') {
    cli.die(
      'usage: scrumux issue authorize I-0001 --by WHO [--note TEXT] — records fix authorization; it does NOT validate the claim (I-0010)',
    );
  }
  requireIssue(cli, ctx, 'authorize', iid);

  let by = '';
  let note = '';
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    if (f === '--by') { by = flagValue(cli, rest, i + 1, 'issue authorize'); i += 2; continue; }
    if (f === '--note') { note = flagValue(cli, rest, i + 1, 'issue authorize'); i += 2; continue; }
    cli.die(`issue authorize: unknown flag ${f} — see: scrumux help issue`);
  }
  if (by === '') {
    cli.die('issue authorize: --by is required (whose word authorizes the fix — normally User)');
  }

  // Authorization and validation are disjoint facts (I-0010): this branch
  // must never touch `.validation`.
  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, issuesPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== iid) return row;
      const authorization: { [k: string]: JsonValue } = note === ''
        ? { by, date: d }
        : { by, date: d, note };
      return { ...row, authorization, updated_at: d };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${iid} authorized by ${by}`);
}

// ----------------------------------------------------------------- validate
function issueValidate(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const iid = args[0] ?? '';
  const rest = args.slice(1);
  if (iid === '') {
    cli.die(
      'usage: scrumux issue validate I-0001 --verdict reproduced|evidenced|invalidated|duplicate --evidence TEXT [--repro-cmd CMD] [--duplicate-of I-0001|T-0001] [--by WHO]',
    );
  }
  requireIssue(cli, ctx, 'validate', iid);

  let verdict = '';
  let evidence = '';
  let reproCmd = '';
  let by = 'agent';
  let dupOf = '';
  let revalidate = false;
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    const v = (): string => flagValue(cli, rest, i + 1, 'issue validate');
    if (f === '--verdict') { verdict = v(); i += 2; continue; }
    if (f === '--evidence') { evidence = v(); i += 2; continue; }
    if (f === '--repro-cmd') { reproCmd = v(); i += 2; continue; }
    if (f === '--by') { by = v(); i += 2; continue; }
    if (f === '--duplicate-of') { dupOf = v(); i += 2; continue; }
    if (f === '--revalidate') { revalidate = true; i += 1; continue; }
    cli.die(`issue validate: unknown flag ${f} — see: scrumux help issue`);
  }

  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    cli.die('issue validate: --verdict must be reproduced|evidenced|invalidated|duplicate');
  }
  if (evidence === '') {
    cli.die(
      'issue validate: --evidence is required — what you saw, or the disproof; validation without evidence is noise (D-0011). State how you reproduced it, what the run printed, and the line the mechanism sits on. GOOD (reproduced) "An independent read-only agent reproduced it against 444dfd1 in a detached worktree: deployed into a fresh target, wrote repo-owned content into both seeded files, stamped the previous manifest to claim them, redeployed. One run printed UNCHANGED ... kept for both files, then REMOVED ... no longer part of the payload; both were gone afterwards. Mechanism confirmed at cmd-harness.sh: neither path is in payload.list, so the grep guard never fires and rm -f runs" (I-0152). GOOD (evidenced, no repro needed) "cmd-session.sh:146 tests for a .git DIRECTORY; inside a worktree .git is a file, so the stray scan is silently skipped" (I-0052). GOOD (invalidated) "Ran the named command at HEAD in a sandbox GOV_ROOT: exit 0, no refusal printed. The behaviour described was removed by T-0189 and the report is against a build that no longer exists" — a disproof is a deliverable, not a failure. BAD "confirmed" or "looks right" — a verdict with no evidence is the reporter claim restated by a second name.',
    );
  }

  if (verdict === 'duplicate') {
    if (dupOf === '') {
      cli.die('issue validate: verdict duplicate needs --duplicate-of <I-XXXX|T-XXXX> (the original it duplicates)');
    }
    if (dupOf.startsWith('I-')) {
      if (!refExists(issuesPath(ctx), dupOf)) {
        cli.die(`issue validate: duplicate-of ${dupOf} not found in issues.json`);
      }
    } else if (dupOf.startsWith('T-')) {
      refusing(cli, () => requireTaskRef(ctx.gov, dupOf));
    } else {
      cli.die('issue validate: --duplicate-of must be an issue (I-XXXX) or backlog task (T-XXXX) id');
    }
    if (dupOf === iid) cli.die('issue validate: an issue cannot duplicate itself');
  } else if (dupOf !== '') {
    cli.die('issue validate: --duplicate-of only goes with --verdict duplicate');
  }

  // T-0111/I-0054, and P-47: DISJOINTNESS ONLY. `[.entries[] | select(.id==$id)
  // | .source] | first // ""` -- absent, null and false all become "".
  const src = firstSource(ctx, iid);
  if (src !== '' && src === by && by !== 'User') {
    cli.die(
      `self-validation refused: ${iid} was raised by '${src}' and cannot be validated by '${by}' — the point of the gate is independent confirmation by an agent with its own tools and process. Dispatch a read-only agent whose identity is NOT '${src}' (any read-only definition in .claude/agents — issue-validator, debugger, context-gatherer — except '${src}'), let it reach its own verdict, and record that verdict with --by <that agent> (I-0054)`,
    );
  }

  // A verdict is the artifact BOTH promotion gates read (sprint --hotfix and
  // task --issue), so it is not replaced silently. Overwriting one erased a
  // disjoint validator's 3,886-character evidence block during the first
  // end-to-end operator run, with no warning and nothing retained. Write-once
  // by default, superseded only on purpose, and the prior verdict is KEPT --
  // the same shape as task accept's guard.
  const prior = priorValidation(ctx, iid);
  if (prior !== null && !revalidate) {
    cli.die(
      `issue validate: ${iid} already carries a validation — '${prior.verdict}' recorded by '${prior.by}' on ${prior.date}. A verdict is what both promotion gates read, so it is never replaced silently: the second run would erase the first validator's evidence and nothing would show it had. Read it first: jq '.entries[] | select(.id=="${iid}") | .validation' governance/issues.json — then, if it genuinely must be superseded, re-run with --revalidate, which keeps the prior verdict in .validation_history`,
    );
  }

  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, issuesPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== iid) return row;
      const validation: { [k: string]: JsonValue } = { verdict, evidence, by, date: d };
      if (reproCmd !== '') validation['repro_cmd'] = reproCmd;
      if (dupOf !== '') validation['duplicate_of'] = dupOf;
      // jq sets `.validation_history` BEFORE replacing `.validation`, and a key
      // it does not already carry lands last. The spread reproduces both: an
      // existing key keeps its slot, a new one is appended.
      const kept = row['validation'];
      if (revalidate && kept !== undefined && kept !== null) {
        const hist = row['validation_history'];
        const prev = Array.isArray(hist) ? hist : [];
        return { ...row, validation, updated_at: d, validation_history: [...prev, kept] };
      }
      return { ...row, validation, updated_at: d };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  if (prior !== null) {
    return cli.emit(
      `${iid} re-validated: ${verdict} — the prior verdict '${prior.verdict}' by '${prior.by}' is kept in .validation_history`,
    );
  }
  return cli.emit(`${iid} validated: ${verdict}`);
}

/**
 * `[.entries[] | select(.id==$id) | .source] | first // ""` through `jq -r`.
 *
 * A journal that cannot be read yields the empty string, because that is what
 * `jq -r` on a parse error hands a command substitution -- and an empty source
 * turns the gate OFF rather than into a refusal. Reproduced: this is a read of
 * somebody else's field inside an independence check, not the surface that
 * reports a corrupt journal.
 */
function firstSource(ctx: NounContext, id: string): string {
  const doc = loadIssues(ctx);
  if (doc === null) return '';
  for (const row of doc) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as { [k: string]: JsonValue };
    if (r['id'] !== id) continue;
    const s = r['source'];
    // `first` takes the FIRST match and `// ""` swallows null and false.
    if (s === undefined || s === null || s === false) return '';
    return typeof s === 'string' ? s : String(s);
  }
  return '';
}

/**
 * The prior `.validation`: null yields null, a non-object yields the
 * `(malformed)` triple rather than being mistaken for absence, and each
 * field falls back through a null-and-false-swallowing default. A journal
 * that cannot be read yields null, matching the tolerant read
 * `firstSource` documents: this is a read of an existing field, not the
 * surface that reports a corrupt journal.
 */
function priorValidation(
  ctx: NounContext,
  id: string,
): { verdict: string; by: string; date: string } | null {
  const doc = loadIssues(ctx);
  if (doc === null) return null;
  for (const row of doc) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as { [k: string]: JsonValue };
    if (r['id'] !== id) continue;
    const v = r['validation'];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) {
      return { verdict: '(malformed)', by: '(unknown)', date: '(undated)' };
    }
    const o = v as { [k: string]: JsonValue };
    const or = (x: JsonValue | undefined, dflt: string): string =>
      x === undefined || x === null || x === false ? dflt : typeof x === 'string' ? x : String(x);
    return {
      verdict: or(o['verdict'], '(none)'),
      by: or(o['by'], '(unknown)'),
      date: or(o['date'], '(undated)'),
    };
  }
  return null;
}

function loadIssues(ctx: NounContext): JsonValue[] | null {
  // Deliberately the same tolerant read `refExists` performs: this module has
  // already established the id exists before either caller gets here.
  const doc = readDoc(issuesPath(ctx));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const e = (doc as { [k: string]: JsonValue })['entries'];
  return Array.isArray(e) ? e : null;
}

// ------------------------------------------------------------------- update
function issueUpdate(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  const iid = args[0] ?? '';
  const rest = args.slice(1);
  if (iid === '') {
    cli.die('usage: scrumux issue update I-0001 [--status ...] [--severity ...] [--task T-0001] [--fix TEXT]');
  }
  requireIssue(cli, ctx, 'update', iid);

  let status = '';
  let severity = '';
  let task = '';
  let fix = '';
  const waives: string[] = [];
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    const v = (): string => flagValue(cli, rest, i + 1, 'issue update');
    if (f === '--status') { status = v(); i += 2; continue; }
    if (f === '--severity') { severity = v(); i += 2; continue; }
    if (f === '--task') { task = v(); i += 2; continue; }
    if (f === '--fix') { fix = v(); i += 2; continue; }
    if (f === '--waives') {
      // The ref is checked AS THE FLAG IS READ, before the rest of argv is
      // even parsed -- so a bad waiver refuses ahead of an unknown flag later
      // on the line. Reproduced by keeping the check inside the loop.
      const w = v();
      refusing(cli, () => requireTaskRef(ctx.gov, w));
      waives.push(w);
      i += 2;
      continue;
    }
    cli.die(`issue update: unknown flag ${f} — see: scrumux help issue`);
  }

  if (status + severity + task + fix === '' && waives.length === 0) {
    cli.die('issue update: nothing to update — pass --status, --severity, --task, --fix, and/or --waives');
  }
  if (status !== '' && !(STATUSES as readonly string[]).includes(status)) {
    cli.die('issue update: --status must be open|accepted|resolved|rejected');
  }
  if (severity !== '' && !(SEVERITIES as readonly string[]).includes(severity)) {
    cli.die('issue update: --severity must be low|medium|high|critical');
  }
  if (task !== '') refusing(cli, () => requireTaskRef(ctx.gov, task));

  const d = ctx.today;
  guardedWrite(cli, ctx, ictx.io, issuesPath(ctx), (doc) =>
    mapEntries(doc, (row) => {
      if (row['id'] !== iid) return row;
      let out: { [k: string]: JsonValue } = { ...row };
      if (status !== '') out = { ...out, status };
      if (severity !== '') out = { ...out, severity };
      if (task !== '') {
        // `.refs.task = $tk` -- jq CREATES `.refs` when it is absent, and the
        // new object carries only `task`.
        const refs = out['refs'];
        const base = refs !== null && typeof refs === 'object' && !Array.isArray(refs)
          ? (refs as { [k: string]: JsonValue })
          : {};
        out = { ...out, refs: { ...base, task } };
      }
      if (waives.length !== 0) out = { ...out, waives: [...waives] };
      if (fix !== '') {
        // T-0114/I-0057: the PRIOR text is kept rather than overwritten, so a
        // correction is visible where the wrong pointer used to be. The RHS
        // reads `.resolution_pointer` from the row as it stands, before the
        // reassignment on the next line -- which is jq's evaluation order for
        // `A = f | B = g`, and the reason these are two statements here.
        const prior = out['prior_resolution_pointers'];
        const priorArr = Array.isArray(prior) ? prior : [];
        const before = out['resolution_pointer'];
        out = {
          ...out,
          prior_resolution_pointers: [
            ...priorArr,
            { text: before === undefined ? null : before, replaced_on: d },
          ],
        };
        out = { ...out, resolution_pointer: fix };
      }
      return { ...out, updated_at: d };
    }),
  );
  sealBootstrap(ctx.gov, ctx.today);
  return cli.emit(`${iid} updated`);
}

// ---------------------------------------------------------------------- new
function issueNew(cli: Cli, ctx: NounContext, ictx: DispatchContext, args: readonly string[]): never {
  let type = '';
  let source = '';
  let summary = '';
  let fix = '';
  let severity = '';
  let task = '';
  const files: string[] = [];
  const waives: string[] = [];

  for (let i = 0; i < args.length; ) {
    const f = args[i]!;
    const v = (): string => flagValue(cli, args, i + 1, 'issue');
    if (f === '--type') { type = v(); i += 2; continue; }
    if (f === '--source') { source = v(); i += 2; continue; }
    if (f === '--summary') { summary = v(); i += 2; continue; }
    if (f === '--fix') { fix = v(); i += 2; continue; }
    if (f === '--severity') { severity = v(); i += 2; continue; }
    if (f === '--task') { task = v(); i += 2; continue; }
    // `--file` IS NOT CHECKED AGAINST THE FILESYSTEM (design-nouns.md), and
    // neither `--file` nor `--waives` dedupes. Both reproduced.
    if (f === '--file') { files.push(v()); i += 2; continue; }
    if (f === '--waives') {
      const w = v();
      refusing(cli, () => requireTaskRef(ctx.gov, w));
      waives.push(w);
      i += 2;
      continue;
    }
    cli.die(`issue: unknown flag ${f} — see: scrumux help issue`);
  }

  if (!(TYPES as readonly string[]).includes(type)) {
    cli.die('issue: --type must be drift|defect|idea|governance|harness');
  }
  if (source === '') cli.die('issue: --source is required (hook name, agent name, or "human")');

  // An agent files BUGS. Nothing else (D-0079). Boundary 7 already keeps
  // governance corrections from reaching an agent; this is the same rule
  // pointed outward. Only the SOURCE is gated -- the vocabulary is unchanged
  // and User and the app still file all five types.
  if (type === 'drift' || type === 'idea' || type === 'governance') {
    if (source !== 'User' && source !== 'human') {
      cli.die(
        `issue: --type ${type} is not an agent's to file — an agent files bugs. Use --type defect when you SAW something behave wrong and can name the command that shows it, or --type harness when the harness itself misbehaved. An observation that something is untidy, inconsistent, duplicated or could-be-better is not filed at all (D-0079).`,
      );
    }
  }
  if (!(SOURCES as readonly string[]).includes(source)) {
    cli.die(
      `issue: --source '${source}' is not one of the recorded sources — it is a closed vocabulary, not prose (T-0130). Valid: User human claude monitor implement-sop session-check session-review planning-session issue-validator simplicity-engineer panel-review debugger governance-validate decisions-pending arbiter-review audit-agent`,
    );
  }
  if (summary === '') {
    cli.die(
      'issue: --summary is required — what you SAW, at which site, and the command or observation that shows it. A summary a validator cannot reproduce from is not a report. GOOD (defect) "harness deploy DELETES a repo own project-standards.md and project-walls.conf. The seeding lane creates both create-if-absent; the I-0143 prune then removes any path the PREVIOUS manifest names that payload.list lacks. Observed 2026-08-30 in ~/tools/scrumux-agents: UNCHANGED ... kept, then REMOVED ... no longer part of the payload, in ONE run" (I-0152). GOOD (defect) "harness deploy seeds no .gitignore lines for the views scrumux writes, so running a report dirties a deployed repo tree. Repro: deploy into a git repo, commit, run scrumux views render, git status shows four untracked generated files" (I-0153). GOOD (harness) "Three walls emit wall: project-walls.conf while the four named walls emit their own names; a reader grouping by wall cannot tell which project wall fired" (I-0151). BAD "deploy is broken" — no site, no repro, nothing a validator can confirm or refute.',
    );
  }
  if (fix === '') {
    cli.die(
      'issue: --fix is required (resolution_pointer — the rule/skill/script/step that resolves it, so no scope creep) — name the site and the shape of the repair and stop there; it BOUNDS the work, it is not the work. GOOD "The prune must never remove a path the seeding lane owns, and the exclusion must come from that lane rather than a second literal: the lane writes each path it seeds into TMPD/seeded.list and the prune skips anything on it" (I-0152). GOOD "deploy appends the ignore lines for exactly what views render writes into the target .gitignore, once: append-only and append-if-absent, so a second deploy adds nothing" (I-0153). GOOD "walls_record in .claude/hooks/walls-lib.sh should carry the wall own name rather than the file the rule came from" (I-0151). BAD "fix it" or "investigate" — neither bounds anything, so the next session picks its own scope.',
    );
  }
  if (severity !== '' && !(SEVERITIES as readonly string[]).includes(severity)) {
    cli.die('issue: --severity must be low|medium|high|critical');
  }
  if (task !== '') refusing(cli, () => requireTaskRef(ctx.gov, task));

  const path = issuesPath(ctx);
  refusing(cli, () => ensureFile(path, SEED));
  const d = ctx.today;
  const r = guardedAppend(cli, ctx, ictx.io, path, idStream, 'I', (doc, id) => {
    const rec: { [k: string]: JsonValue } = {
      id,
      type,
      source,
      summary,
      resolution_pointer: fix,
      status: 'open',
      created_at: d,
    };
    if (severity !== '') rec['severity'] = severity;
    if (waives.length !== 0) rec['waives'] = [...waives];
    const refs: { [k: string]: JsonValue } = { files: [...files] };
    if (task !== '') refs['task'] = task;
    rec['refs'] = refs;
    return appendEntry(doc, rec);
  });
  sealBootstrap(ctx.gov, ctx.today);
  // SX-025: a TELL, never a refusal. On stderr so `ID=$(scrumux issue new …)`
  // still captures only the id; a row under --json.
  const similar = nearDuplicates(ctx.gov, summary, files, r.id);
  if (similar.length > 0) {
    const tell = `open issue(s) that look like this one: ${similar.join(', ')} — read them (scrumux issue find ${similar[0]}); if this is the same defect, add what is new to it rather than keeping two`;
    cli.sayAlways(`TELL: ${tell}`);
    if (cli.json) cli.tell('possible duplicate', tell);
  }
  return emitted(cli, r.id);
}

// ------------------------------------------------------------------ the seam
/**
 * The shared impl, called with two different argv shapes by design.
 *
 * The `new` dispatch arm calls this with the verb ALREADY STRIPPED, while
 * the other three arms put it back onto the front of `argv` -- so
 * `scrumux issue new authorize I-0001 --by X` reaches this function as
 * `["authorize", ...]` and takes the authorize branch. Changing either
 * shape here is a silent surface change.
 */
function issueImpl(cli: Cli, ctx: NounContext, ictx: DispatchContext, argv: readonly string[]): never {
  const head = argv[0] ?? '';
  if (head === 'authorize') return issueAuthorize(cli, ctx, ictx, argv.slice(1));
  if (head === 'validate') return issueValidate(cli, ctx, ictx, argv.slice(1));
  if (head === 'update') return issueUpdate(cli, ctx, ictx, argv.slice(1));
  return issueNew(cli, ctx, ictx, argv);
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => NOUN_USAGE['issue'] ?? '',
  run(cli, ictx, verb, args): never {
    const ctx = nounContext(ictx);
    switch (verb) {
      case 'new':
        return issueImpl(cli, ctx, ictx, args);
      case 'update':
      case 'validate':
      case 'authorize':
        return issueImpl(cli, ctx, ictx, [verb, ...args]);
      case 'list':
      case 'find':
        return issueRead(cli, ctx, verb, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun issue — verbs: new, update, validate, authorize, list, find. See: scrumux help issue`,
        );
    }
  },
};

/**
 * A tolerant parse -- the same "unreadable is indistinguishable from absent"
 * disposition every `jq -r` read in this module has, because a read of
 * somebody else's field inside an independence check is not the surface that
 * reports a corrupt journal.
 */
function readDoc(path: string): JsonValue | null {
  try {
    return parsePreservingNumbers(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
