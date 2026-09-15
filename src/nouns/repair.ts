/**
 * The `repair` noun. Brief: docs/port/modules/session-sprint-repair.md.
 *
 * THE ONE SANCTIONED CORRECTION WITH NO OTHER SCRUMUX PATH. T-0100/I-0047: a
 * correction that could not be expressed as a scrumux command used to mean a
 * direct write plus a VOLUNTARY log entry, and the voluntary half is exactly
 * what went missing when the R-0063 dates were restored by hand. Here the
 * write and its record are ONE operation, so the record cannot be forgotten.
 *
 * THE SEQUENCE IS LOAD-BEARING AND IS PRESERVED EXACTLY:
 *
 *   1. hash the journal BEFORE anything happens;
 *   2. evaluate the filter and check it (empty output, then no-op);
 *   3. write, through the guarded writer and its five stacked guards;
 *   4. hash again, and append the log entry naming both hashes.
 *
 * BOTH CHECKS DIE BEFORE ANY WRITE, and that ordering is a hole being closed
 * rather than a tidy-up. The no-op check used to run AFTER `write_json`, which
 * was harmless only while sealing was somebody else's job: now that
 * `write_json` reseals the file it wrote, `repair --apply '.'` on a TAMPERED
 * journal would rewrite the same bytes back, reseal them, and erase the
 * mismatch with no record of having done so.
 *
 * jq IS SPAWNED, AND IT HAS TO BE. `--apply` is a jq PROGRAM supplied by the
 * operator; there is no port of that. The subprocess is also what keeps
 * OQ-13's repair intact -- jq's own diagnostic, first line, is relayed inside
 * the refusal, on the one command a person reaches for when a journal is
 * ALREADY damaged (Article 5: the error message is the instruction set).
 *
 * APPROVED-DIVERGENCE: D-0085 (OQ-14). The filter is evaluated ONCE, for the
 * dry-run hash, and the already-checked bytes are written directly rather
 * than re-evaluating the filter inside the writer. The ORDER of the checks
 * is unchanged (empty output, then no-op, then the shape and entry-count
 * guards the writer applies); only a second evaluation is avoided. Note
 * what that also removes: a filter with a side effect, or a journal edited
 * between hash and write, can no longer make the checked bytes and the
 * written bytes differ.
 *
 * A REPAIR THAT WOULD SHRINK A JOURNAL DIES INSIDE THE WRITER, not here, and
 * this verb never sets `ALLOW_ENTRY_REMOVAL` -- so the only way to intentionally
 * drop entries is the operator exporting that variable, which this command's
 * own usage never mentions. Reproduced; flagged in the module brief.
 *
 * THIS COMMAND PRINTS ONE SUMMARY ON SUCCESS, naming the journal, the
 * entry count before and after, and the log id minted. `.data.id` carries
 * that id under `--json`. A mutating governance write that succeeded in
 * total silence -- on the one command reached for when a journal is
 * already damaged -- is exactly the failure this summary line exists to
 * prevent.
 *
 * NO `harness verify` CALL SITS BELOW THE LOG WRITE, deliberately: paying
 * for a `harness verify` on every repair is a decision, not a default a
 * reader should assume is missing by accident.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFile } from '../util/fs-predicates.js';
import type { Cli } from '../cli/envelope.js';
import type { Io } from '../cli/exit.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import { JournalRefusal, refusing } from '../journal/refusal.js';
import { sealBootstrap, sealOf } from '../journal/seals.js';
import { appendWithId, ensureFile, writeJson } from '../journal/write.js';
import { nounContext, type DispatchContext, type NounContext, type NounModule } from './lib/context.js';
import { appendEntry, flagValue, idStream, writeOpts } from './lib/writers.js';

export const VERBS = ['journal'] as const;

const VERBS_TSV = `journal\ta bounded correction to one journal, with its own log entry
`;

const SEED = '{"entries": []}';

function repairImpl(cli: Cli, ctx: NounContext, ictx: DispatchContext, argv: readonly string[]): never {
  // `${1:?"repair journal needs a journal name"}`. Reachable only as
  // `repair journal ""`, since `repair_run` already refuses an empty argv --
  // the same unruled shell-expansion divergence noted in
  // src/nouns/lib/writers.ts, with the message kept verbatim.
  const jf = argv[0] ?? '';
  if (jf === '') cli.die('repair journal needs a journal name');
  const rest = argv.slice(1);

  let expr = '';
  let why = '';
  let by = '';
  for (let i = 0; i < rest.length; ) {
    const f = rest[i]!;
    const v = (): string => flagValue(cli, rest, i + 1, 'repair');
    if (f === '--apply') { expr = v(); i += 2; continue; }
    if (f === '--why') { why = v(); i += 2; continue; }
    if (f === '--by') { by = v(); i += 2; continue; }
    cli.die(
      `repair: unknown flag ${f} — usage: scrumux repair journal <name.json> --apply '<jq>' --why TEXT --by WHO`,
    );
  }
  if (expr === '') cli.die('repair: --apply is required — the jq expression that makes the correction');
  if (why === '') {
    cli.die('repair: --why is required — a repair with no recorded reason is the hand edit this command exists to replace');
  }
  if (by === '') {
    cli.die(
      'repair: --by is required — name who is repairing. It defaulted to User, which is the wrong name to put on the most consequential write in the CLI.',
    );
  }

  const path = join(ctx.gov, jf);
  if (!isFile(path)) cli.die(`repair: no journal at governance/${jf}`);

  const before = sealOf(path);

  // --- the dry run -----------------------------------------------------
  const r = spawnSync('jq', [expr, path], { encoding: 'utf8' });
  if (r.status !== 0) {
    // CARRY JQ'S OWN WORDS (D-0085/OQ-13). `head -1` of the captured stderr,
    // with the trailing newline stripped by the command substitution.
    const said = firstLine(r.stderr ?? '');
    cli.die(
      `repair: the jq expression failed against governance/${jf} — ${said === '' ? 'jq gave no diagnostic' : said}. Check the filter.`,
    );
  }
  const produced = r.stdout ?? '';
  // `[ -s "$_chk" ]` -- a NON-EMPTY file. A filter emitting nothing exits 0
  // and would truncate the journal (I-0058's shape).
  if (produced.length === 0) {
    cli.die(`repair: the jq expression produced NO output, which would truncate governance/${jf} — check the filter`);
  }
  const would = createHash('sha256').update(Buffer.from(produced, 'utf8')).digest('hex');
  if (before === would) {
    cli.die(
      `repair: the expression changed nothing in governance/${jf} — check the filter rather than recording a no-op repair`,
    );
  }

  // --- the write, on the bytes already checked (D-0085/OQ-14) ----------
  let parsed: JsonValue;
  try {
    parsed = parsePreservingNumbers(produced);
  } catch {
    // A KNOWN LIMIT, named rather than guessed at. A filter emitting a
    // STREAM of several documents produces output that is not one JSON
    // value -- a shape nothing has ever exercised and no test pins. This
    // refuses in the writer's own vocabulary rather than inventing a
    // behavior for it.
    cli.die(`jq write failed for ${path}`);
  }
  // `jq '(.entries // []) | length'`, on either side of the write.
  const nBefore = entryCount(path);
  // Not `guardedWrite`: this call site hands the writer the value the dry run
  // already produced, so the transform ignores the document it is given.
  const w = refusing(cli, () => writeJson(path, () => parsed, writeOpts(ctx, ictx.io)));
  if (w.resealWarning !== null && cli.json) cli.warn('reseal', w.resealWarning);

  const after = sealOf(path);
  const nAfter = entryCount(path);

  // --- the log entry, in the SAME operation (T-0100) --------------------
  const lid = logRepair(cli, ctx, ictx.io, {
    jf,
    why,
    expr,
    by,
    before: before.slice(0, 12),
    after: after.slice(0, 12),
  });

  sealBootstrap(ctx.gov, ctx.today);
  // `emitted`'s own `data {id}` shape, carried into this command's envelope.
  if (lid !== '') cli.data({ id: lid });
  return cli.emit(
    `repaired governance/${jf} — entries ${nBefore} -> ${nAfter}, logged as ${lid === '' ? '(no id)' : lid}`,
  );
}

/** `jq '(.entries // []) | length'`, with jq's `|| 0` on any failure. */
function entryCount(path: string): number {
  try {
    const doc = parsePreservingNumbers(readFileSync(path, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 0;
    const e = (doc as { [k: string]: JsonValue })['entries'];
    return Array.isArray(e) ? e.length : 0;
  } catch {
    return 0;
  }
}

interface RepairLog {
  jf: string;
  why: string;
  expr: string;
  by: string;
  before: string;
  after: string;
}

/**
 * `log_new --title ... --did ... --verified ... --actor "$BY"`, with no
 * `--task`, so the task-linking half of `log_new` never fires.
 *
 * WRITTEN HERE RATHER THAN CALLED. `src/nouns/log.ts` exists now, with its
 * own `logEntry`/`logNew`, and this still hand-rolls a parallel append
 * rather than reusing it -- the cross-module import was deferred once and
 * the duplication has not been collapsed since. Anyone changing the log
 * entry shape should check both.
 */
function logRepair(cli: Cli, ctx: NounContext, io: Io, r: RepairLog): string {
  const path = join(ctx.gov, 'log.json');
  const record = {
    date: ctx.today,
    task: null,
    actor: r.by,
    title: `Repair applied to governance/${r.jf}`,
    what_was_done:
      `scrumux repair on governance/${r.jf}. Reason: ${r.why}. Applied: ${r.expr}. ` +
      `Content hash ${r.before} -> ${r.after}.`,
    verification:
      'Journal reseals clean after the write; the correction and this record were made in one operation, ' +
      'so the record cannot be omitted (T-0100).',
  };
  try {
    ensureFile(path, SEED);
    const res = appendWithId(
      path,
      idStream,
      'L',
      (doc, id) =>
        appendEntry(doc, {
          id,
          date: record.date,
          task: record.task,
          actor: record.actor,
          title: record.title,
          what_was_done: record.what_was_done,
          verification: record.verification,
        }),
      writeOpts(ctx, io),
    );
    if (res.resealWarning !== null && cli.json) cli.warn('reseal', res.resealWarning);
    return res.id;
  } catch (e) {
    if (!(e instanceof JournalRefusal)) throw e;
    // UNDER `--json` THIS REFUSAL CARRIES NO ENVELOPE OBJECT, deliberately:
    // the line is written directly to stderr and the process exits, rather
    // than going through `cli.die` (which would emit a JSON envelope).
    io.err(`scrumux ${cli.command}: error: ${e.message}\n`);
    io.exit(2);
  }
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => NOUN_USAGE['repair'] ?? '',
  run(cli, ictx, verb, args): never {
    const ctx = nounContext(ictx);
    switch (verb) {
      case 'journal':
        if (args.length === 0) {
          return cli.dieUsage(
            "repair journal needs a journal name — scrumux repair journal tasks.json --apply '<jq>' --why TEXT",
          );
        }
        return repairImpl(cli, ctx, ictx, args);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun repair — the only verb is 'journal'. See: scrumux help repair`,
        );
    }
  },
};

/** `head -1`, with the trailing newline stripped as `$( )` strips it. */
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}
