/**
 * Reading the issues journal from the CLI (SX-025): `issue list`, `issue
 * find`, and the near-duplicate TELL `issue new` prints.
 *
 * Closing sessions hunted for `governance/issues.json` (`find / -iname
 * "issues*.json"`, `printenv GOV_ROOT`) to check whether the defect they were
 * about to file already existed — it usually did (seven filings of one
 * receipt-fresh defect in Rover). These verbs are read-only and refuse only a
 * malformed flag. The TELL never refuses: filing a second report is allowed,
 * and a validator marks it `duplicate`.
 *
 *   scrumux issue list [--status open|accepted|resolved|rejected|all]
 *                      [--type T] [--task T-XXXX]          (default: open)
 *   scrumux issue find TEXT [--status …] [--type T] [--task T-XXXX]  (default: all)
 *
 * `--json` carries `data.issues: [{id, type, status, severity, summary,
 * resolution_pointer, task, files, created_at}]`, absent fields as null.
 *
 * Dependencies: jqformat (JsonValue), jqlike (entriesOf, field, interp), node:fs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cli } from '../cli/envelope.js';
import { parsePreservingNumbers, type JsonValue } from '../journal/jqformat.js';
import type { NounContext } from './lib/context.js';
import { entriesOf, field, interp } from './lib/jqlike.js';

const STATUSES = ['open', 'accepted', 'resolved', 'rejected', 'all'];

interface Filters { status: string; type: string; task: string; text: string }

/** The issues journal's rows, or [] when it is absent or does not parse. */
export function issueRows(gov: string): JsonValue[] {
  try {
    return entriesOf(parsePreservingNumbers(readFileSync(join(gov, 'issues.json'), 'utf8')));
  } catch {
    return [];
  }
}

const str = (v: JsonValue | null): string | null => (typeof v === 'string' ? v : null);
const filesOf = (e: JsonValue): string[] => {
  const f = field(e, 'refs', 'files');
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : [];
};

/** The one JSON shape each verb reports per issue. */
function view(e: JsonValue): Record<string, JsonValue> {
  return {
    id: str(field(e, 'id')), type: str(field(e, 'type')), status: str(field(e, 'status')),
    severity: str(field(e, 'severity')), summary: str(field(e, 'summary')),
    resolution_pointer: str(field(e, 'resolution_pointer')), task: str(field(e, 'refs', 'task')),
    files: filesOf(e), created_at: str(field(e, 'created_at')),
  };
}

/**
 * Rows matching the filters; `text` is a case-insensitive substring of the
 * id, summary, fix text, task or any file.
 *
 * Dependencies: field, interp, filesOf.
 */
export function matchIssues(rows: readonly JsonValue[], f: Filters): JsonValue[] {
  const needle = f.text.toLowerCase();
  return rows.filter((e) => {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
    if (f.status !== 'all' && interp(field(e, 'status')) !== f.status) return false;
    if (f.type !== '' && interp(field(e, 'type')) !== f.type) return false;
    if (f.task !== '' && interp(field(e, 'refs', 'task')) !== f.task) return false;
    if (needle === '') return true;
    const hay = [field(e, 'id'), field(e, 'summary'), field(e, 'resolution_pointer'), field(e, 'refs', 'task')]
      .map((v) => (typeof v === 'string' ? v : '')).concat(filesOf(e)).join('\n').toLowerCase();
    return hay.includes(needle);
  });
}

/**
 * `issue list` / `issue find`. Refuses only an unknown flag, a missing value,
 * a bad --status, or `find` without text.
 *
 * Dependencies: parse, matchIssues, view.
 */
export function issueRead(cli: Cli, ctx: NounContext, verb: 'list' | 'find', args: readonly string[]): never {
  const f: Filters = { status: verb === 'list' ? 'open' : 'all', type: '', task: '', text: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--status' || a === '--type' || a === '--task') {
      const v = args[i + 1];
      if (v === undefined) return cli.die(`issue ${verb}: ${a} needs a value`);
      f[a.slice(2) as 'status' | 'type' | 'task'] = v;
      i++;
      continue;
    }
    if (a.startsWith('--')) return cli.die(`issue ${verb}: unknown flag ${a} — see: scrumux help issue`);
    if (verb === 'find') { f.text = f.text === '' ? a : `${f.text} ${a}`; continue; }
    return cli.die(`issue list: unexpected argument '${a}' — to search, use: scrumux issue find '${a}'`);
  }
  if (!STATUSES.includes(f.status)) return cli.die('issue: --status must be open|accepted|resolved|rejected|all');
  if (verb === 'find' && f.text === '') return cli.die("issue find: what to look for? scrumux issue find 'receipt fresh' [--status open]");
  const hits = matchIssues(issueRows(ctx.gov), f);
  for (const e of hits) {
    const v = view(e);
    const extra = [v['task'] === null ? '' : ` [task ${String(v['task'])}]`, filesOf(e).length === 0 ? '' : ` [files ${filesOf(e).join(', ')}]`].join('');
    const summary = String(v['summary'] ?? '');
    cli.say(`${String(v['id'])}  ${String(v['status'])}  ${String(v['type'])}${v['severity'] === null ? '' : `/${String(v['severity'])}`}  ${summary.length > 160 ? `${summary.slice(0, 157)}...` : summary}${extra}`);
  }
  cli.data({ issues: hits.map(view) });
  return cli.emit(hits.length === 0 ? `(no ${f.status === 'all' ? '' : `${f.status} `}issues match)` : `${hits.length} issue(s). The journal is governance/issues.json under GOV_ROOT; read it through these verbs.`);
}

/** Lower-cased words of 4+ letters or digits, each once. */
function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []));
}

/**
 * Open (or accepted) issues that look like the one being filed: one names a
 * file it names, or at least 3 of the new summary's words — and at least half
 * of them — appear in its summary. Advisory only.
 *
 * Dependencies: issueRows, words, filesOf.
 */
export function nearDuplicates(gov: string, summary: string, files: readonly string[], exceptId = ''): string[] {
  const mine = words(summary);
  const out: string[] = [];
  for (const e of issueRows(gov)) {
    const id = interp(field(e, 'id'));
    const st = interp(field(e, 'status'));
    if (id === exceptId || (st !== 'open' && st !== 'accepted')) continue;
    const sharedFile = files.some((f) => filesOf(e).includes(f));
    const theirs = words(interp(field(e, 'summary')));
    const common = [...mine].filter((w) => theirs.has(w)).length;
    if (sharedFile || (common >= 3 && common * 2 >= mine.size)) out.push(id);
  }
  return out;
}
