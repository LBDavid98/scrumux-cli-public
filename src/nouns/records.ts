/**
 * The `records` noun.
 *
 * THE repo validator (T-0140, D-0002/D-0003/D-0012). It collapses three
 * checkers that had grown apart: journal structure, cross-journal refs, the
 * rules chain, doc rosters and seals ("governance-validate"); the
 * `.claude/schemas` contracts ("schema-check", native and never re-
 * implemented as a second jq-shaped copy -- a second copy of a contract is
 * free to drift from the first, D-0010); and a mechanical code-standards
 * sweep, now deliberately empty.
 *
 * THE ROW NAME IS THE PROBLEM AND THE DETAIL IS THE FIX, split on the FIRST
 * " — " exactly once, applied for every consumer. A fail-tier row's NAME
 * must never itself contain " — ": `tests/records-check-tests.sh:144-145`
 * encodes that as contract, because a machine consumer dedupes on name.
 *
 * THE SCHEMA SWEEP RUNS IN-PROCESS, NOT AS A SUBPROCESS (R-004). What that
 * changes and what it does not is set out at `schemaSweep` below -- the
 * finding TEXT is unchanged in every arm that can still fire, and the one
 * arm that can no longer fire is the one where there is no python3 to find.
 *
 * NO `ARG_MAX` TO OVERFLOW. A subprocess jq invocation is bounded by argv
 * size; at HEAD five journal bodies once summed to 1,062,958 bytes against a
 * 1,048,576-byte ceiling, which would fail every `task verify` reading them
 * all at once. In-process there is no argv to overflow, so an absent
 * journal reads as `{entries:[]}` rather than erroring.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDir, isFile } from '../util/fs-predicates.js';
import type { Cli } from '../cli/envelope.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { sweep, unsupportedReport } from '../schema/check.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { alt, asArray, asObject, cmp, cmpString, entriesOf, field, interp, strOr, truthy } from './lib/jqlike.js';
import { SEALED_JOURNALS, SEAL_FILE_NAME, brokenSeals, govJsonFiles, sealsShapeProblem } from '../journal/seals.js';
import { standingOf } from '../journal/standing.js';

export const VERBS = ['check'] as const;

const VERBS_TSV = 'check\tvalidate the journals, refs, rule chains, rosters and seals\n';

const USAGE = `scrumux records — the repo validator.

  scrumux records check                    the governance sweep (default)
  scrumux records check --structure        the same, named explicitly
  scrumux records check --standards [dir]  the mechanical D-0012 corpus rules
  scrumux records check --all              both, structure first
  scrumux records check --unsupported      the JSON Schema keywords the
                                           schemas declare and this reader
                                           does not enforce

Exit 0 clean, 1 with one instructive line per finding, 2 if it could not
run. WARNings never affect the exit code.

--standards is silent where no matching code exists, so language-agnostic
and non-code trees stay clean. A repo's own standards live in
.claude/rules/project-standards.md, and anything mechanical about them is
registered with \`scrumux health add\`. That is the one extension pathway
for this layer.

There is no --porcelain. --json carries every finding as a row with its
own tier, name and fix; a second machine format for one finding set is
the drift this validator exists to catch.
`;

const USAGE_LINE =
  'usage: scrumux records check [--structure|--standards|--all|--unsupported] [dir]'
  + ' — no mode flag means --structure; dir applies to --standards only';

const EM = ' — ';

/** `_split_name`: everything before the FIRST em-dash clause. */
export function splitName(msg: string): string {
  const i = msg.indexOf(EM);
  return i < 0 ? msg : msg.slice(0, i);
}

/** `_split_fix`: everything after it, or the generic pointer. */
export function splitFix(msg: string): string {
  const i = msg.indexOf(EM);
  return i < 0 ? 'run scrumux records check for the full finding and follow its line' : msg.slice(i + EM.length);
}

// --- the roster matchers (T-0080, I-0029) -------------------------------

/**
 * The markdown section under a `## ` heading STARTING WITH `want`,
 * case-insensitively. Returns null when no such heading exists, which is a
 * loud finding rather than a silent pass -- a roster that has been renamed
 * away is exactly the drift this section exists to catch.
 *
 * Reproduces the awk exactly, including that scanning stops at the NEXT
 * `## ` heading whether or not it matches, and that a section that exists but
 * is empty is a present section (empty output, rc 0), not a missing one.
 */
export function rosterSection(text: string, want: string): string[] | null {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let inside = false;
  let found = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inside) break;
      const head = line.slice(3);
      if (head.toLowerCase().startsWith(want.toLowerCase())) {
        inside = true;
        found = true;
      }
      continue;
    }
    if (inside) out.push(line);
  }
  return found ? out : null;
}

/**
 * Is `name` present in these lines as a WHOLE NAME?
 *
 * THIS USED TO BE A WHOLE-FILE SUBSTRING GREP and it passed for two wrong
 * reasons: a name mentioned anywhere in forty pages of prose counted, and
 * with no word boundary a name that is a SUBSTRING of an existing entry
 * passed on the other entry's mention -- an agent named `review` was covered
 * for ever by the line naming `session-review`. Both directions of that
 * failure are silent, which is the worst property a drift detector can have.
 * `-` and `.` count as part of a name, so `review` does NOT match inside
 * `session-review` and `lib.sh` does not match inside `mylib.sh`.
 */
export function rosterNames(lines: readonly string[], name: string): boolean {
  const esc = name.replace(/[.[\\*^$()+?{}|\]]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_.-])${esc}([^A-Za-z0-9_.-]|$)`);
  return lines.some((l) => re.test(l));
}

// --- rule frontmatter ---------------------------------------------------

/**
 * `sed -n '/^---$/,/^---$/p' | sed '1d;$d'` -- every `---`-delimited RANGE in
 * the file concatenated, then the first and last lines of THAT concatenation
 * removed. Not simplified to "the first block": a file with four `---`
 * lines contributes two ranges, and the trimming is of the whole output,
 * not per range.
 */
export function ruleFrontmatter(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const picked: string[] = [];
  let inRange = false;
  for (const l of lines) {
    if (l === '---') {
      picked.push(l);
      inRange = !inRange;
      continue;
    }
    if (inRange) picked.push(l);
  }
  if (picked.length <= 2) return [];
  return picked.slice(1, picked.length - 1);
}

/** `sed -n 's/^KEY: *\[\(.*\)\]/\1/p' | tr ',' '\n' | tr -d ' "'` then word-split. */
export function frontmatterList(fm: readonly string[], key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^${key}: *\\[(.*)\\]`);
  for (const l of fm) {
    const m = re.exec(l);
    if (m === null) continue;
    for (const part of m[1]!.split(',')) {
      const cleaned = part.replace(/[ "]/g, '');
      if (cleaned !== '') out.push(cleaned);
    }
  }
  return out;
}

// --- the sweep ----------------------------------------------------------

interface Journal {
  path: string;
  /** null when the file is absent; the parsed value otherwise. */
  doc: JsonValue | null;
  /** true when the file EXISTS and does not parse -- a different state. */
  broken: boolean;
}

function loadJournal(path: string): Journal {
  if (!existsSync(path) || !isFile(path)) return { path, doc: null, broken: false };
  try {
    return { path, doc: parsePreservingNumbers(readFileSync(path, 'utf8')), broken: false };
  } catch {
    return { path, doc: null, broken: true };
  }
}

/** `.entries` of a journal, with an absent or unparseable file reading empty. */
function ents(j: Journal): JsonValue[] {
  return j.doc === null ? [] : entriesOf(j.doc);
}

function idsOf(entries: readonly JsonValue[]): Set<string> {
  const s = new Set<string>();
  for (const e of entries) {
    const id = field(e, 'id');
    if (typeof id === 'string') s.add(id);
  }
  return s;
}

/** `design_view` -- the per-kind projection of the entries-shaped journal. */
function designView(doc: JsonValue | null): Record<string, JsonValue[]> {
  const entries = doc === null ? [] : entriesOf(doc);
  const of = (kind: string): JsonValue[] => entries.filter((e) => field(e, 'kind') === kind);
  return {
    epics: of('epic'),
    features: of('feature'),
    stories: of('story'),
    surfaces: of('surface'),
    controls: of('control'),
    wireframe_refs: of('wireframe_ref'),
  };
}

function recordsCheck(cli: Cli, ctx: NounContext, argv: readonly string[]): never {
  let mode: 'structure' | 'standards' | 'all' = 'structure';
  let scan = '';
  let unsupported = false;
  for (const a of argv) {
    if (a === '--structure') mode = 'structure';
    else if (a === '--standards') mode = 'standards';
    else if (a === '--all') mode = 'all';
    else if (a === '--unsupported') unsupported = true;
    else if (a.startsWith('-')) cli.dieUsage(`unknown flag '${a}' — ${USAGE_LINE}`);
    else {
      if (scan !== '') cli.dieUsage(`more than one directory given ('${scan}' and '${a}') — ${USAGE_LINE}`);
      scan = a;
    }
  }
  if (scan === '') scan = ctx.root;
  if (!isDir(scan)) cli.die(`no such directory '${scan}' — ${USAGE_LINE}`);

  // `--unsupported`: the per-keyword detail the coverage WARNING tells an
  // operator how to print. The warning named
  // `python3 -m agents.lib.schema_check --unsupported` for as long as that
  // module shipped; the module is gone and `unsupportedReport` is the ported
  // behaviour, so the instruction now names a command that exists. A REPORT,
  // not an assertion: it lists what the reader does not enforce, which is a
  // fact about the reader rather than a defect in the repo, so it exits 0.
  if (unsupported) {
    // `unsupportedReport` takes the CODE ROOT and resolves `<harness>/schemas`
    // itself, the same root the sweep is given.
    const rows = unsupportedReport(ctx.codeRoot);
    for (const line of rows) cli.say(line);
    cli.data({ unsupported: rows as unknown as JsonValue });
    return cli.emit(
      rows.length === 0
        ? 'records check --unsupported: every keyword the schemas declare is enforced by this reader.'
        : `records check --unsupported: ${rows.length} declared keyword(s) this reader does not enforce.`,
    );
  }

  // f() is a FINDING (fails the run); w() is a WARNING (never does).
  const f = (msg: string): void => { cli.fail(splitName(msg), splitFix(msg)); };
  const w = (msg: string): void => { cli.warn(splitName(msg), splitFix(msg)); };
  const human = (s: string): void => { cli.say(s); };

  const gov = ctx.gov;
  const root = ctx.root;
  const hd = ctx.harnessDir;

  const sweepStructure = (): void => {
    human(`=== VALIDATE — structure (${ctx.today}) ===`);

    // --- 0. parse + duplicate ids ---------------------------------------
    for (const name of govJsonFiles(gov)) {
      const p = join(gov, name);
      const j = loadJournal(p);
      if (j.broken) {
        f(`${p} is not valid JSON — restore from git (git checkout -- ${p}) or repair by hand, then re-run`);
        continue;
      }
      const o = asObject(j.doc);
      const raw = o !== null && Object.prototype.hasOwnProperty.call(o, 'entries')
        ? (asArray(o['entries']) ?? []).map((e) => field(e, 'id'))
        : [];
      // `group_by(.)` sorts first, so duplicates come out in jq's order.
      const sorted = [...raw].sort(cmp);
      const dups: string[] = [];
      for (let i = 0; i < sorted.length;) {
        let k = i + 1;
        while (k < sorted.length && cmp(sorted[i]!, sorted[k]!) === 0) k += 1;
        // `join` renders a null element as the EMPTY STRING, not "null".
        if (k - i > 1) dups.push(sorted[i] === null ? '' : interp(sorted[i]!));
        i = k;
      }
      // THE TEST IS ON THE JOINED STRING, NOT ON THE COUNT, and the
      // difference matters: `repo-health.json` holds entries with no `id`
      // at all, so `[.entries[].id]` is a run of nulls, they group as one
      // duplicate class, and joining that class renders as "" -- which the
      // empty-string check below rejects. Testing group COUNT instead would
      // report every id-less journal as having duplicate ids, naming none
      // of them.
      const dupText = dups.join(', ');
      if (dupText !== '') {
        f(`${p} has duplicate ids: ${dupText} — ids are allocated by scrumux; hand-edits must not reuse them`);
      }
    }

    const tasksJ = loadJournal(join(gov, 'tasks.json'));
    const designJ = loadJournal(join(gov, 'design.json'));
    const decJ = loadJournal(join(gov, 'decisions.json'));
    const issJ = loadJournal(join(gov, 'issues.json'));
    const logJ = loadJournal(join(gov, 'log.json'));
    const sprJ = loadJournal(join(gov, 'sprints.json'));
    const healthJ = loadJournal(join(gov, 'repo-health.json'));

    const des = designView(designJ.doc);
    const featureIds = idsOf(des['features']!);
    const storyIds = idsOf(des['stories']!);
    const surfaceIds = idsOf(des['surfaces']!);
    const epicIds = idsOf(des['epics']!);
    const decIds = idsOf(ents(decJ));
    const issIds = idsOf(ents(issJ));
    const logIds = idsOf(ents(logJ));
    const taskIds = idsOf(ents(tasksJ));

    /**
     * count_sweep: a journal that is absent contributes nothing at all, and a
     * parse failure is ITSELF a finding -- never a silently clean run.
     *
     * ONE FINDING PER UNPARSEABLE JOURNAL, never one per reader of it. A
     * design that slurped every cross-referenced journal into each section's
     * own check would produce a finding for the broken file AND a second
     * finding in every OTHER section that reads it -- e.g. an unreadable
     * issues.json would make the tasks section fail too, reporting the same
     * root cause twice under two different names, with two different
     * wordings, for one defect. This design reads each journal once and
     * reports its own brokenness once, so a corrupt file cannot mint a
     * finding per reader.
     *
     * THE COUNT IS NOT COSMETIC. `records check --porcelain` feeds
     * `scrumux issue`, so a shape that reports N findings for one broken
     * byte would mint N issues in the operator's backlog, all describing
     * the same defect and asking for the same fix. The number of times a
     * file happens to be read by other sections is a fact about this
     * implementation, not about the repo, and a validator may only claim
     * what it actually computed: there is one defect here, so the record
     * says one.
     *
     * The VERDICT is what actually matters (exit 1, never clean) and the
     * restore command is named identically by section 0; the finding COUNT
     * is asserted rather than left as an implementation detail -- pinned by
     * test/unit/records-unparseable.test.ts, one finding per file, per the
     * exact numbers a corrupt tasks.json, issues.json, decisions.json and
     * sprints.json each produce.
     */
    const sweep = (j: Journal, produce: () => string[]): void => {
      if (j.doc === null && !j.broken) return;
      if (j.broken) {
        f(`validator internal: jq failed on ${j.path}: could not parse — records-check itself needs fixing; do not trust this run`);
        return;
      }
      for (const line of produce()) if (line !== '') f(line);
    };

    // --- 1. tasks -------------------------------------------------------
    sweep(tasksJ, () => {
      const out: string[] = [];
      for (const e of ents(tasksJ)) {
        const id = strOr(field(e, 'id'));
        const idShown = field(e, 'id') === null ? '<no id>' : interp(field(e, 'id'));
        if (!/^T-[0-9]{4}$/.test(id)) out.push(`tasks: ${idShown} bad id pattern (want T-NNNN)`);
        if (strOr(field(e, 'title')) === '') out.push(`tasks: ${interp(field(e, 'id'))} missing title`);
        if (strOr(field(e, 'acceptance_check')) === '') {
          out.push(`tasks: ${interp(field(e, 'id'))} missing acceptance_check — stated before work starts (CLAUDE.MD)`);
        }
        // I-0147: a record asserting both at once, with nothing downstream
        // reading the pair -- accepted to anything looking at the acceptance
        // object, unfinished to anything looking at the status.
        const accepted = alt(field(e, 'acceptance', 'accepted'), false) === true;
        const status = strOr(field(e, 'status'));
        if (accepted && status !== 'accepted' && status !== 'superseded') {
          out.push(
            `tasks: ${interp(field(e, 'id'))} carries acceptance.accepted=true but status is ${interp(field(e, 'status'))}`
            + ' — a task cannot be both accepted and not; reverse an acceptance with scrumux reject, which records who and why',
          );
        }
        const feature = field(e, 'feature');
        if (feature !== null && !featureIds.has(interp(feature))) {
          out.push(`tasks: ${interp(field(e, 'id'))} feature ${interp(feature)} unresolved in design.json`);
        }
        const story = field(e, 'story');
        if (story !== null && !storyIds.has(interp(story))) {
          out.push(`tasks: ${interp(field(e, 'id'))} story ${interp(story)} unresolved in design.json`);
        }
        for (const d of asArray(alt(field(e, 'decisions'), [])) ?? []) {
          if (!decIds.has(interp(d))) out.push(`tasks: ${interp(field(e, 'id'))} decision ref ${interp(d)} unresolved`);
        }
        for (const i of asArray(alt(field(e, 'issues'), [])) ?? []) {
          if (!issIds.has(interp(i))) out.push(`tasks: ${interp(field(e, 'id'))} issue ref ${interp(i)} unresolved`);
        }
        for (const l of asArray(alt(field(e, 'log_entries'), [])) ?? []) {
          if (!logIds.has(interp(l))) out.push(`tasks: ${interp(field(e, 'id'))} log ref ${interp(l)} unresolved`);
        }
        const order = field(e, 'task_order');
        if (order !== null) {
          if (strOr(field(order, 'scope')) === '' || strOr(field(order, 'verification_command')) === '') {
            out.push(
              `tasks: ${interp(field(e, 'id'))} task_order missing scope or verification_command (D-0005)`
              + ` — scrumux task order ${interp(field(e, 'id'))} ...`,
            );
          }
          for (const tf of asArray(field(order, 'context', 'files')) ?? []) {
            if (strOr(field(tf, 'path')) === '' || strOr(field(tf, 'why')) === '') {
              out.push(`tasks: ${interp(field(e, 'id'))} task_order context file missing path or why (D-0005)`);
            }
          }
        }
        // D-0076/T-0187: acceptance lives on the task. The R- records that
        // once carried it were migrated onto their tasks.
        const acc = field(e, 'acceptance');
        if (status === 'accepted' && (acc === null || field(acc, 'accepted') !== true)) {
          out.push(
            `tasks: ${interp(field(e, 'id'))} accepted with no recorded acceptance — acceptance lives on the task (D-0076);`
            + ` scrumux task accept ${interp(field(e, 'id'))} --by WHO --authority direct|app:<session>|standing:D-XXXX`,
          );
        }
        // WHO TOOK IT. Never checked before, and the CLI defaulted --by to
        // the literal User -- so an acceptance taken by an agent recorded
        // that name, at exit 0, with nothing here to notice.
        if (acc !== null && field(acc, 'accepted') === true && strOr(field(acc, 'by')).length === 0) {
          out.push(
            `tasks: ${interp(field(e, 'id'))} is accepted but names nobody — an acceptance with no actor cannot be audited;`
            + ' repair it with the real actor (scrumux repair journal tasks.json --apply ... --why ... --by WHO)',
          );
        }
      }
      return out;
    });

    // D-0084 admission: nothing may span two sprints, and nothing may exceed
    // the cap the sprint declares. A SECOND PROGRAM, deliberately, and the one
    // place `admission_state` cannot serve -- that function answers "may THIS
    // task be admitted" over one candidate; the validator asks "is what is
    // ALREADY in flight legal" over the whole journal with no candidate.
    // The definition of a task's HOME and the reading that an absent
    // `parallel` is 1 are restated here; if either moves, it moves in both.
    {
      const sps = ents(sprJ);
      const home = (id: string): string => {
        for (const s of sps) {
          if (field(s, 'status') !== 'ratified') continue;
          const list = asArray(alt(field(s, 'tasks'), [])) ?? [];
          if (list.some((t) => interp(t) === id)) return interp(field(s, 'id'));
        }
        return '';
      };
      const ip = ents(tasksJ)
        .filter((e) => field(e, 'status') === 'in_progress')
        .map((e) => ({ id: interp(field(e, 'id')), home: home(interp(field(e, 'id'))) }));
      const homes = [...new Set(ip.map((x) => x.home))].sort(cmpString);
      const adm: string[] = [];
      if (homes.length > 1) {
        adm.push(
          'tasks: work is in_progress across more than one sprint ('
          + ip.map((x) => `${x.id} in ${x.home === '' ? 'no ratified sprint' : x.home}`).join(', ')
          + ') — one sprint at a time (D-0084); scrumux task status <id> in_review|blocked',
        );
      }
      for (const h of homes) {
        const g = ip.filter((x) => x.home === h);
        let cap = 1;
        if (h !== '') {
          const s = sps.find((x) => interp(field(x, 'id')) === h);
          const p = s === undefined ? null : alt(field(s, 'parallel'), 1);
          cap = p === null ? 1 : Number(interp(p));
        }
        if (!(g.length > cap)) continue;
        if (h === '') {
          adm.push(
            `tasks: ${g.length} tasks in_progress outside any ratified sprint (${g.map((x) => x.id).join(', ')})`
            + ' — one at a time there (D-0084); scrumux task status <id> in_review|blocked',
          );
        } else {
          adm.push(
            `tasks: ${g.length} tasks in_progress in ${h}, which declared ${cap} (${g.map((x) => x.id).join(', ')})`
            + ' — over the cap its plan was ratified with (D-0084); scrumux task status <id> in_review|blocked',
          );
        }
      }
      for (const line of adm) if (line !== '') f(line);
    }

    // --- 2. issues ------------------------------------------------------
    sweep(issJ, () => {
      const out: string[] = [];
      const TYPES = ['drift', 'defect', 'idea', 'governance', 'harness'];
      for (const e of ents(issJ)) {
        const id = strOr(field(e, 'id'));
        const idShown = field(e, 'id') === null ? '<no id>' : interp(field(e, 'id'));
        if (!/^I-[0-9]{4}$/.test(id)) out.push(`issues: ${idShown} bad id pattern`);
        if (!TYPES.includes(interp(field(e, 'type')))) {
          out.push(`issues: ${interp(field(e, 'id'))} invalid type ${interp(field(e, 'type'))}`);
        }
        if (strOr(field(e, 'summary')) === '') out.push(`issues: ${interp(field(e, 'id'))} missing summary`);
        if (strOr(field(e, 'resolution_pointer')) === '') {
          out.push(
            `issues: ${interp(field(e, 'id'))} missing resolution_pointer`
            + ' — issues must point to the fix (CLAUDE.MD architecture)',
          );
        }
        const ref = field(e, 'refs', 'task');
        if (ref !== null && !taskIds.has(interp(ref))) {
          out.push(`issues: ${interp(field(e, 'id'))} task ref ${interp(ref)} unresolved`);
        }
      }
      return out;
    });

    // --- 3. decisions ---------------------------------------------------
    sweep(decJ, () => {
      const out: string[] = [];
      for (const e of ents(decJ)) {
        const id = strOr(field(e, 'id'));
        const idShown = field(e, 'id') === null ? '<no id>' : interp(field(e, 'id'));
        if (!/^D-[0-9]{4}$/.test(id)) out.push(`decisions: ${idShown} bad id pattern`);
        // Who stands behind it depends on its standing (D-S039): a legacy or
        // ratified decision names `ratified_by`; a proposed one `recorded_by`;
        // a rejected one `rejected_by`.
        const st = standingOf(e);
        const whoKey = st.status === 'ratified' ? 'ratified_by' : st.status === 'proposed' ? 'recorded_by' : 'rejected_by';
        if (strOr(field(e, 'decision')) === '' || strOr(field(e, 'rationale')) === '' || strOr(field(e, whoKey)) === '') {
          out.push(
            `decisions: ${interp(field(e, 'id'))} missing decision, rationale, or ${whoKey}`
            + ' — precedent needs all three',
          );
        }
        const sup = field(e, 'supersedes');
        if (sup !== null && !decIds.has(interp(sup))) {
          out.push(`decisions: ${interp(field(e, 'id'))} supersedes ${interp(sup)} which does not exist`);
        }
      }
      return out;
    });

    // --- 4. log ---------------------------------------------------------
    // Section 5 swept reviews.json. `gov review` wrote it, that command is
    // gone with the panel D-0076 deleted, and documented approval IS the
    // review. Its 145 acceptances were migrated onto their tasks.
    sweep(logJ, () => {
      const out: string[] = [];
      for (const e of ents(logJ)) {
        const id = strOr(field(e, 'id'));
        const idShown = field(e, 'id') === null ? '<no id>' : interp(field(e, 'id'));
        if (!/^L-[0-9]{4}$/.test(id)) out.push(`log: ${idShown} bad id pattern`);
        if (strOr(field(e, 'what_was_done')) === '' || strOr(field(e, 'actor')) === '') {
          out.push(`log: ${interp(field(e, 'id'))} missing what_was_done or actor`);
        }
        const t = field(e, 'task');
        if (t !== null && !taskIds.has(interp(t))) {
          out.push(`log: ${interp(field(e, 'id'))} task ref ${interp(t)} unresolved`);
        }
      }
      return out;
    });

    // --- 6. sprints -----------------------------------------------------
    sweep(sprJ, () => {
      const out: string[] = [];
      const STATUSES = ['proposed', 'ratified', 'complete', 'abandoned'];
      const orderedTasks = ents(tasksJ);
      for (const e of ents(sprJ)) {
        const id = strOr(field(e, 'id'));
        const idShown = field(e, 'id') === null ? '<no id>' : interp(field(e, 'id'));
        if (!/^SP-[0-9]{4}$/.test(id)) out.push(`sprints: ${idShown} bad id pattern`);
        if (!STATUSES.includes(interp(field(e, 'status')))) {
          out.push(`sprints: ${interp(field(e, 'id'))} invalid status ${interp(field(e, 'status'))}`);
        }
        const hotfix = field(e, 'hotfix');
        const epic = field(e, 'epic');
        if (hotfix !== true && epic === null) {
          out.push(`sprints: ${interp(field(e, 'id'))} non-hotfix sprint without epic (D-0004)`);
        }
        if (hotfix === true && field(e, 'source_issue') === null) {
          out.push(`sprints: ${interp(field(e, 'id'))} hotfix sprint without source_issue (D-0004)`);
        }
        if (epic !== null && !epicIds.has(interp(epic))) {
          out.push(`sprints: ${interp(field(e, 'id'))} epic ${interp(epic)} unresolved`);
        }
        const ratified = field(e, 'ratified');
        if (field(e, 'status') === 'ratified' && ratified === null) {
          out.push(
            `sprints: ${interp(field(e, 'id'))} ratified without ratification record (D-0004);`
            + ' restore .ratified or set status back',
          );
        }
        if (field(e, 'status') === 'ratified' && ratified !== null && strOr(field(ratified, 'by')).length === 0) {
          out.push(
            `sprints: ${interp(field(e, 'id'))} is ratified but names nobody`
            + ' — a ratification with no actor cannot be audited',
          );
        }
        const list = asArray(field(e, 'tasks')) ?? [];
        for (const t of list) {
          if (!taskIds.has(interp(t))) out.push(`sprints: ${interp(field(e, 'id'))} task ${interp(t)} unresolved`);
        }
        // A write-time gate mirrored as a read-time check: orders are the
        // sprint entry gate (D-0005).
        for (const t of list) {
          const hit = orderedTasks.some((x) => interp(field(x, 'id')) === interp(t) && field(x, 'task_order') === null);
          if (hit) out.push(`sprints: ${interp(field(e, 'id'))} task ${interp(t)} has no task_order — orders are the sprint entry gate (D-0005)`);
        }
      }
      return out;
    });

    // --- 7. design ------------------------------------------------------
    // Reference integrity, which is a different and narrower thing than the
    // schema contract check in section 11 (OQ-3: design.json is absent from
    // schema_check.PAIRS, and that is not established as intentional).
    sweep(designJ, () => {
      const out: string[] = [];
      const entries = ents(designJ);
      for (const e of entries) {
        if (field(e, 'kind') !== 'epic') continue;
        for (const fid of asArray(alt(field(e, 'features'), [])) ?? []) {
          if (!featureIds.has(interp(fid))) out.push(`design: epic ${interp(field(e, 'id'))} feature ref ${interp(fid)} unresolved`);
        }
      }
      for (const e of entries) {
        if (field(e, 'kind') !== 'feature') continue;
        for (const sid of asArray(alt(field(e, 'stories'), [])) ?? []) {
          if (!storyIds.has(interp(sid))) out.push(`design: feature ${interp(field(e, 'id'))} story ref ${interp(sid)} unresolved`);
        }
      }
      for (const e of entries) {
        if (field(e, 'kind') !== 'feature') continue;
        for (const d of asArray(alt(field(e, 'dependencies'), [])) ?? []) {
          if (!featureIds.has(interp(d))) out.push(`design: feature ${interp(field(e, 'id'))} dependency ${interp(d)} unresolved`);
        }
      }
      for (const e of entries) {
        if (field(e, 'kind') !== 'story') continue;
        if (!featureIds.has(interp(field(e, 'feature')))) {
          out.push(`design: story ${interp(field(e, 'id'))} feature ${interp(field(e, 'feature'))} unresolved`);
        }
      }
      for (const e of entries) {
        if (field(e, 'kind') !== 'story') continue;
        if ((asArray(alt(field(e, 'acceptance_criteria'), [])) ?? []).length === 0) {
          out.push(`design: story ${interp(field(e, 'id'))} has no acceptance criteria`);
        }
      }
      for (const e of entries) {
        if (field(e, 'kind') !== 'control') continue;
        if (!surfaceIds.has(interp(field(e, 'surface')))) {
          out.push(`design: control ${interp(field(e, 'id'))} surface ${interp(field(e, 'surface'))} unresolved`);
        }
      }
      return out;
    });

    // --- 8. rules chain (CLAUDE.MD -> rules -> skills -> scripts) -------
    for (const r of globFiles(join(root, hd, 'rules'), (n) => n.endsWith('.md'))) {
      const rb = r.split('/').pop()!;
      let text: string;
      try {
        text = readFileSync(r, 'utf8');
      } catch {
        continue;
      }
      const fm = ruleFrontmatter(text);
      if (fm.length === 0) {
        f(`rules: ${rb} has no frontmatter — required per rule-frontmatter.schema.json (name, paths at minimum)`);
        continue;
      }
      if (!fm.some((l) => l.startsWith('name:'))) f(`rules: ${rb} frontmatter missing name`);
      if (!fm.some((l) => l.startsWith('paths:'))) f(`rules: ${rb} frontmatter missing paths`);
      // A missing SKILL is a warning ("fine if user-level"); a missing script
      // or hook is a hard failure. The asymmetry is deliberate.
      for (const s of frontmatterList(fm, 'skills')) {
        if (!isFile(join(root, hd, 'skills', s, 'SKILL.md'))) {
          w(`rules: ${rb} points to skill '${s}' not in this repo's ${hd}/skills — fine if user-level; if not, it is drift`);
        }
      }
      for (const s of frontmatterList(fm, 'scripts')) {
        if (!isFile(join(root, s))) {
          f(`rules: ${rb} points to script ${s} which does not exist — fix the pointer or restore the script`);
        }
      }
      for (const s of frontmatterList(fm, 'hooks')) {
        if (!isFile(join(root, s))) {
          f(`rules: ${rb} points to hook ${s} which does not exist — fix the pointer or restore the hook`);
        }
      }
    }

    // --- 9. repo-health -------------------------------------------------
    sweep(healthJ, () => {
      const out: string[] = [];
      for (const c of ents(healthJ)) {
        if (strOr(field(c, 'name')) === '' || strOr(field(c, 'command')) === '') {
          out.push('repo-health: check missing name or command — scrumux health writes both; fix the entry');
        }
      }
      return out;
    });

    // --- 9a. a registered check's command file exists (T-0185) ----------
    // A check whose command points at a file that is gone is a gate that
    // cannot run. `-e`, existence only, NOT `-f`: matching anything stricter
    // would be a tightening nobody ruled on.
    if (healthJ.doc !== null) {
      for (const c of ents(healthJ)) {
        const name = strOr(field(c, 'name'));
        const cmd = strOr(field(c, 'command'));
        if (name === '' || cmd === '') continue;
        let tok = cmd.split(' ')[0] ?? '';
        if (tok === 'sh' || tok === 'bash') {
          const rest = cmd.slice(cmd.indexOf(' ') + 1);
          tok = rest.split(' ')[0] ?? '';
        }
        if (!tok.includes('/')) continue;
        const p = tok.startsWith('/') ? tok : join(root, tok);
        if (!existsSync(p)) {
          f(
            `repo-health: check '${name}' runs '${cmd}' but ${tok} is not on disk`
            + ' — de-register the check (scrumux repair journal repo-health.json) or restore the file',
          );
        }
      }
    }

    // --- 10. doc rosters vs directories (T-0080, I-0029) ----------------
    // ONE DIRECTION ONLY: everything on disk must be named in the doc that
    // claims to list it. Prose parsing for the reverse is not worth the false
    // positives.
    const spec = join(root, 'PROJECT_SPEC.MD');
    const skidx = join(root, 'SKILLS_INDEX.MD');
    if (isFile(spec)) {
      const specText = readFileSync(spec, 'utf8');
      const rosters: Record<string, string[]> = {};
      for (const sec of ['Agents', 'Skills', 'Rules']) {
        const got = rosterSection(specText, sec);
        if (got === null) {
          f(
            `roster section missing: PROJECT_SPEC.MD has no '## ${sec}' section, so the ${sec} roster cannot be`
            + ' checked against disk — nothing below is known to be documented',
          );
          rosters[sec] = [];
        } else {
          rosters[sec] = got;
        }
      }
      const scripts = rosterSection(specText, 'Deterministic scripts');
      if (scripts === null) {
        f(
          "roster section missing: PROJECT_SPEC.MD has no '## Deterministic scripts' section, so the script"
          + ' roster cannot be checked against disk',
        );
        rosters['Scripts'] = [];
      } else {
        rosters['Scripts'] = scripts;
      }

      const idxLines = isFile(skidx) ? readFileSync(skidx, 'utf8').split('\n') : null;

      for (const a of globFiles(join(root, hd, 'agents'), (n) => n.endsWith('.md'))) {
        const ab = basenameNoExt(a, '.md');
        if (!rosterNames(rosters['Agents']!, ab)) {
          f(
            `agents roster drift: ${ab} exists in ${hd}/agents/ but PROJECT_SPEC.MD's roster does not name it`
            + ' — add it to the Agents roster',
          );
        }
      }
      for (const s of globDirs(join(root, hd, 'skills'))) {
        const sb = s.split('/').pop()!;
        if (!rosterNames(rosters['Skills']!, sb)) {
          f(
            `skills roster drift: ${sb} exists in ${hd}/skills/ but PROJECT_SPEC.MD does not name it`
            + ' — add it to the Skills roster',
          );
        }
        // SKILLS_INDEX.MD is nothing but the index, so its whole body is the
        // roster and there is no section to scope to.
        if (idxLines !== null && !rosterNames(idxLines, sb)) {
          f(`skills index drift: ${sb} exists in ${hd}/skills/ but SKILLS_INDEX.MD does not list it — add its row`);
        }
      }
      for (const r of globFiles(join(root, hd, 'rules'), (n) => n.endsWith('.md'))) {
        const rb = basenameNoExt(r, '.md');
        if (!rosterNames(rosters['Rules']!, rb)) {
          f(
            `rules roster drift: ${rb} exists in ${hd}/rules/ but PROJECT_SPEC.MD's roster does not name it`
            + ' — add it to the Rules roster',
          );
        }
      }
      // T-0142: scripts were exempt from this sweep, and the exemption is
      // exactly why 13 of 22 scripts were missing from SKILLS_INDEX.MD and 19
      // of 22 from PROJECT_SPEC.MD. Directories are skipped as well as
      // dot-prefixed entries: a stray __pycache__ is not a script (I-0094).
      for (const sc of globFiles(join(root, hd, 'scripts'), () => true)) {
        const scb = sc.split('/').pop()!;
        if (scb.startsWith('.')) continue;
        if (!rosterNames(rosters['Scripts']!, scb)) {
          f(
            `scripts roster drift: ${scb} exists in ${hd}/scripts/ but PROJECT_SPEC.MD's Deterministic scripts`
            + ' section does not name it — add it there',
          );
        }
        if (idxLines !== null && !rosterNames(idxLines, scb)) {
          f(`scripts index drift: ${scb} exists in ${hd}/scripts/ but SKILLS_INDEX.MD does not list it — add its row`);
        }
      }
    }

    // --- schema contracts (T-0113/I-0056) -------------------------------
    schemaSweep(ctx, f, w);

    // --- T-0100/I-0047: a journal edited outside scrumux ----------------
    // THE SEAL FILE ITSELF, BEFORE WHAT IT SAYS. A seals.json that is valid
    // JSON but the wrong shape yields no rows, so every journal compares
    // clean and tamper detection is off with nothing saying so.
    const shape = sealsShapeProblem(gov);
    if (shape !== '') {
      f(
        `${shape} — restore it from git, or rebuild it with a gov write after checking the journals by hand.`
        + ' Until then this check is not speaking for any journal (T-0100/I-0047)',
      );
    }
    const sealsPath = join(gov, SEAL_FILE_NAME);
    const sealsDoc = loadJournal(sealsPath);
    const over = sealsDoc.doc === null ? null : field(sealsDoc.doc, 'bootstrapped_over_existing_content');
    if (over !== null && truthy(over) && interp(over) !== '') {
      w(
        `seals were created on ${interp(over)} over journals that ALREADY had entries — anything changed before`
        + ' that date was made the trusted baseline and cannot be detected now. Expected in a repo that predates'
        + ' sealing; if seals.json was deleted and rebuilt, that is the hole this records (T-0100/I-0047)',
      );
    }
    // A SEALED-LISTED JOURNAL WITH NO RECORDED HASH IS INVISIBLE, not clean
    // (D-0085/OQ-19). brokenSeals drives off the seal MAP, and incomplete is
    // the case that arises naturally, because the bootstrap skips a journal
    // that did not exist yet and nothing adds it until its first gov write.
    if (isFile(sealsPath)) {
      let unsealed = '';
      const map = sealsDoc.doc === null ? null : asObject(field(sealsDoc.doc, 'journals'));
      for (const sj of SEALED_JOURNALS) {
        if (!isFile(join(gov, sj))) continue;
        if (map === null || !Object.prototype.hasOwnProperty.call(map, sj)) unsealed += ` ${sj}`;
      }
      if (unsealed !== '') {
        w(
          `sealed-listed journal(s) carrying no recorded hash:${unsealed} — each is on disk and named in`
          + ` SEALED_JOURNALS but absent from governance/${SEAL_FILE_NAME}, so nothing is comparing it and a change`
          + ' to it would not be detected. Any scrumux write to that journal seals it (T-0100/I-0047)',
        );
      }
    }
    for (const b of brokenSeals(gov)) {
      f(
        `governance/${b} was changed outside scrumux — its content does not match the seal recorded by the last`
        + ` gov write. If the change was intentional, make it with scrumux repair journal ${b} --apply '<jq>'`
        + " --why '...' so the correction carries its own record; if not, restore it from git (T-0100/I-0047)",
      );
    }

    // --- historical gaps, surfaced not failed ---------------------------
    // A WARNING, deliberately. Failing a clean repo 145 times every run is how
    // a detector teaches the operator to ignore it. Going forward the CLI
    // refuses the write, so these counts can only shrink.
    if (isFile(join(gov, 'tasks.json'))) {
      const noAuth = ents(tasksJ).filter((e) => {
        const acc = field(e, 'acceptance');
        return acc !== null && field(acc, 'accepted') === true && strOr(field(acc, 'authority')).length === 0;
      }).length;
      if (noAuth > 0) {
        w(
          `${noAuth} accepted task(s) carry no recorded authority — they predate --authority becoming required`
          + ' (2026-08-28). Historical, and the CLI now refuses to write another. Not repaired in bulk: inventing'
          + ' an authority for an act nobody can now attest to would be worse than the gap.',
        );
      }
    }
    if (isFile(join(gov, 'sprints.json'))) {
      const noRAuth = ents(sprJ).filter((e) => {
        const r = field(e, 'ratified');
        return r !== null && strOr(field(r, 'authority')).length === 0;
      }).length;
      if (noRAuth > 0) {
        w(
          `${noRAuth} ratified sprint(s) carry no recorded authority — they predate --authority becoming required`
          + ' on sprint ratify (2026-08-28). Historical, and the CLI now refuses to write another. Not repaired in'
          + ' bulk: inventing an authority for an act nobody can now attest to would be worse than the gap.',
        );
      }
    }
    if (isFile(join(gov, 'issues.json'))) {
      const selfv = ents(issJ)
        .filter((e) => {
          const v = field(e, 'validation');
          const src = field(e, 'source');
          return v !== null && src !== null && cmp(src, field(v, 'by')) === 0 && src !== 'User';
        })
        .map((e) => interp(field(e, 'id')));
      if (selfv.length > 0) {
        w(
          `self-validated issues (raised and certified by the same agent, before scrumux refused it): ${selfv.join(' ')}`
          + ' — re-validate each by dispatching a read-only agent whose identity is NOT that row\'s own source (any'
          + ' read-only definition in .claude/agents — issue-validator, debugger, context-gatherer — minus that'
          + ' source) and recording it with --by <that agent>, when the row is next touched (I-0054/T-0111)',
        );
      }
    }
  };

  // --- standards ---------------------------------------------------------
  // Deliberately empty of built-in rules. The three mechanical stack rules
  // that lived here -- Python/TypeScript only, LangGraph for agents, no mock
  // LLM calls -- were one person's stack hardcoded into a harness whose stated
  // contract is that it "governs any repo, in any language". A Go repo failed
  // standard-1 on principle. They are a REPO's standards, and a repo now
  // states them in .claude/rules/project-standards.md with checks of its own
  // registered through `scrumux health`. That is the one extension pathway.
  const sweepStandards = (): void => {
    human(`=== RECORDS CHECK — standards (${ctx.today}) ===`);
    cli.say('records check --standards: this mode no longer carries built-in stack rules.');
    cli.say("  A repo's own standards live in .claude/rules/project-standards.md,");
    cli.say('  and anything mechanical about them is registered with scrumux health add.');
  };

  if (mode === 'structure') sweepStructure();
  else if (mode === 'standards') sweepStandards();
  else {
    sweepStructure();
    human('');
    sweepStandards();
  }

  human('');
  const n = cli.fails();
  if (n > 0) {
    // `scrumux issue new --source` is a closed vocabulary that still spells
    // this validator governance-validate; the suggestion stays runnable.
    cli.emit(
      `records check --${mode}: ${n} finding(s). Each line names the fix; unresolved drift becomes a scrumux`
      + ' issue (scrumux issue new --type drift --source governance-validate ...).',
    );
  }
  switch (mode) {
    case 'structure':
      cli.emit('records check --structure: clean — journals conform, refs resolve, rules chain intact.');
      break;
    case 'standards':
      cli.emit("records check --standards: no built-in stack rules; a repo states its own.");
      break;
    default:
      cli.emit(
        'records check --all: clean — journals conform, refs resolve, rules chain intact, no mechanical standard'
        + ' violations.',
      );
  }
}

/**
 * The schema sweep -- NATIVE, and no longer a subprocess.
 *
 * `.claude/schemas` declares `additionalProperties:false`, full enums and
 * required sets across nine files, and for a long time was read by NOTHING
 * while this validator re-implemented every contract as hardcoded jq. The
 * task status enum lived in four places. The reader is `src/schema/check.ts`;
 * its violation lines render to the byte-exact format
 * `src/schema/pyjson.ts`'s renderer produces (see both files).
 *
 * WHAT THE FINDING SHAPES ARE. The `schema: …` FAIL per violation, the
 * `schema coverage: …` WARN for the UNSUPPORTED aggregate (D-0085/OQ-2 --
 * coverage, not a record defect, so it never moves the exit code of a repo
 * whose records conform), and the fail-closed `the schema sweep exited …`
 * FAIL for a sweep that produced a non-zero code and no findings.
 *
 * THE COVERAGE WARNING NAMES A COMMAND THAT EXISTS: `records check
 * --unsupported`, which is `unsupportedReport`'s CLI surface. Article 5
 * makes the message the instruction set, and an instruction naming a
 * deleted command is worse than none.
 *
 * THERE IS NO INTERPRETER LEFT TO BE MISSING, which removes a whole class
 * of failure a subprocess-based sweep would have (a machine with no
 * python3 reporting an unchecked-contracts finding, T-0129) -- which was
 * the reason a native reader was worth building: it runs on a Windows box
 * with no python3 at all. The fail-closed arm below still exists because
 * `sweep()` itself can still fail for other reasons, and that is the one
 * state that reaches it now.
 */
function schemaSweep(ctx: NounContext, f: (m: string) => void, w: (m: string) => void): void {
  const r = sweep(ctx.gov, ctx.codeRoot);
  for (const line of r.lines) {
    if (line === '') continue;
    if (line.startsWith('UNSUPPORTED ')) {
      w(
        `schema coverage: ${line.slice('UNSUPPORTED '.length)} — the reader is a deliberate SUBSET of JSON Schema`
        + ' and adds no dependency, but a schema author must not believe an unenforced keyword is enforced.'
        + ' List them: scrumux records check --unsupported',
      );
    } else {
      f(
        `schema: ${line} — the record does not match .claude/schemas; fix the record, or update the schema if the`
        + ' contract genuinely changed (T-0113)',
      );
    }
  }
  // rc 1 WITH output is findings and is handled above; anything else non-zero
  // is the sweep itself failing, and must never read as clean. Kept rather
  // than deleted as unreachable: `sweep()` reproduces the ONE state in which
  // the Python exits non-zero having printed nothing an operator can act on
  // (a schema file that is valid JSON but not an object), and the fail-closed
  // wording is what an operator has always seen for it.
  if (r.rc > 1 || (r.rc !== 0 && r.lines.length === 0)) {
    f(
      `the schema sweep exited ${r.rc} with no findings to report (${r.failure ?? ''}) — the journal schema contracts were`
      + ' NOT checked this run and this sweep cannot speak for them; the failure is in a schema file rather than in a'
      + ' record, so read .claude/schemas and fix the one this names (T-0129: a dependency that fails must'
      + ' fail closed, not pass quietly)',
    );
  }
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'check':
        return recordsCheck(cli, nounContext(ctx), args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun records — the only verb is 'check'. See: scrumux help records`,
        );
    }
  },
};

/**
 * A shell glob's file matches, sorted the way the shell sorts them.
 * A LEADING DOT IS NOT MATCHED BY `*` -- `rules/*.md` never sees a
 * `.DS_Store`-shaped name, and a port that used a bare readdir would mint
 * findings for files the shell never handed the loop.
 */
function globFiles(dir: string, keep: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .filter(keep)
    .sort(cmpString)
    .map((n) => join(dir, n))
    .filter(isFile);
}

function globDirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .sort(cmpString)
    .map((n) => join(dir, n))
    .filter(isDir);
}

function basenameNoExt(p: string, ext: string): string {
  const b = p.split('/').pop()!;
  return b.endsWith(ext) ? b.slice(0, b.length - ext.length) : b;
}


