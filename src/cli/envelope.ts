/**
 * The cross-cutting CLI layer.
 *
 * One shape, one renderer, one exit rule, written ONCE. Eleven scripts each
 * invented their own before the consolidation.
 *
 * THE EXIT RULE:
 *   0  the assertion held, or the report was produced
 *   1  the assertion did NOT hold (at least one `fail` row)
 *   2  the command could not run -- nothing was asserted either way
 *
 * ADVISORIES NEVER MOVE IT. `warn`, `tell` and `note` are recorded with
 * ok:true and their tier, they print, and they are invisible to the verdict.
 * That is D-0072 boundary 7 and T-0144 made mechanical: a red linter is a
 * finding, not this command's failure. See docs/port/PHILOSOPHY.md P-01 --
 * porting this stricter is a regression, and the tier->verdict mapping lives
 * in exactly one place so it cannot drift.
 *
 * Exit 2 inside a Claude Code HOOK means "block the tool call". Different
 * namespace: hooks do not route through this dispatcher and no hook reads a
 * subcommand's verdict.
 */
import { jqFormat, type JsonValue } from '../journal/jqformat.js';
import { processIo, type Io } from './exit.js';

export type Tier = 'pass' | 'fail' | 'warn' | 'tell' | 'note';

export interface Row {
  name: string;
  ok: boolean;
  tier: Tier;
  detail: string;
}

export interface Envelope {
  schema: 'scrumux.cli/1';
  command: string;
  argv: string[];
  ok: boolean;
  exit: 0 | 1 | 2;
  summary: string;
  checks: Row[];
  data: Record<string, JsonValue>;
  error?: { kind: 'usage' | 'refused'; message: string };
}

// A second error type for refusals lived here once and is gone:
// `Cli.refuse` writes the envelope and ends the process through the one
// exit seam, so nothing ever constructed it. Two error types for one job is
// the drift this file exists to prevent (D-0010). ExitSignal in
// src/cli/exit.ts is the only control-flow exception the CLI throws.

export class Cli {
  private readonly rows: Row[] = [];
  private readonly dataParts: Record<string, JsonValue> = {};
  private readonly extraParts: Record<string, JsonValue> = {};
  private emitted = false;

  constructor(
    readonly command: string,
    readonly argv: string[],
    readonly json: boolean,
    /**
     * Where output goes and how the process ends. Defaulted, so no call site
     * has to know about it; injectable, so every refusal message in this
     * class is reachable from a unit test rather than only from a subprocess
     * (src/cli/exit.ts explains why that mattered enough to add a seam).
     */
    private readonly io: Io = processIo,
  ) {}

  // --- result rows ----------------------------------------------------
  // `ok` on a row is (tier !== 'fail'), so a consumer written against the
  // old {name, ok, detail} shape still works and simply gains a field.
  //
  // WRITTEN THROUGH, NOT BUFFERED (User's ruling, 2026-09-01). An early cut
  // of this class buffered both `row` and `say` and flushed at `emit`, which
  // produced identical bytes for any verb that reaches `emit` normally --
  // the lines come out in the order they were said, ahead of the summary --
  // and DIFFERENT bytes for a verb that SPEAKS AND THEN REFUSES, because
  // `refuse` exits without flushing. Concretely: `secret set` into a repo
  // whose `.gitignore` lacks `.env` and whose `.env` git already tracks
  // writes "added .env to .gitignore" and then refuses; buffered, only the
  // refusal would print, and the operator would lose the fact that their
  // `.gitignore` was just changed. Two nouns once carried a local `sayNow`
  // workaround for exactly this; the ruling moves the behaviour into this
  // one shared class and retires them.
  private row(tier: Tier, name: string, detail = ''): void {
    this.rows.push({ name, ok: tier !== 'fail', tier, detail });
    if (this.json) return;
    const label =
      tier === 'pass' ? '  ok  ' : tier === 'fail' ? '  FAIL' : tier === 'warn' ? '  WARN' : tier === 'tell' ? '  TELL' : '  ..  ';
    this.io.out(`${label} ${name.padEnd(24)} ${detail}\n`);
  }

  pass(name: string, detail?: string): void { this.row('pass', name, detail); }
  fail(name: string, detail?: string): void { this.row('fail', name, detail); }
  warn(name: string, detail?: string): void { this.row('warn', name, detail); }
  tell(name: string, detail?: string): void { this.row('tell', name, detail); }
  note(name: string, detail?: string): void { this.row('note', name, detail); }

  /** How many rows failed. A module must not consult the verdict directly. */
  fails(): number {
    return this.rows.filter((r) => r.tier === 'fail').length;
  }

  // --- prose ----------------------------------------------------------
  /** Human stdout, written through the moment it exists.
   *  Suppressed entirely under --json. */
  say(line: string): void {
    if (!this.json) this.io.out(line + '\n');
  }

  /**
   * The rare line a human must see even under --json. Goes to STDERR,
   * because stdout under --json carries exactly one object and nothing else.
   */
  sayAlways(line: string): void {
    this.io.err(line + '\n');
  }

  data(obj: Record<string, JsonValue>): void { Object.assign(this.dataParts, obj); }
  extra(obj: Record<string, JsonValue>): void { Object.assign(this.extraParts, obj); }

  // --- the one object, and the exit -----------------------------------
  build(summary: string): Envelope {
    const ok = this.fails() === 0;
    return {
      schema: 'scrumux.cli/1',
      command: this.command,
      argv: this.argv,
      ok,
      exit: ok ? 0 : 1,
      summary,
      checks: this.rows,
      data: this.dataParts,
      ...this.extraParts,
    } as Envelope;
  }

  emit(summary = ''): never {
    this.emitted = true;
    const env = this.build(summary);
    if (this.json) {
      // jqFormat, NEVER JSON.stringify: they differ on DEL (0x7f), which
      // jq's format escapes and JSON.stringify does not. A summary carrying
      // a control character -- a refusal quoting a file that has one in its
      // name -- would then diverge byte-for-byte with no behavioural cause
      // (Spike A).
      this.io.out(jqFormat(env as unknown as JsonValue));
    } else if (summary !== '') {
      // The prose and the rows are already out -- `say` and `row` write
      // through -- so the only byte `emit` owes human mode is the summary.
      this.io.out(summary + '\n');
    }
    this.io.exit(env.exit);
  }

  /**
   * The dispatcher's safety net. A module that returns without emitting
   * still produces the one object, with a summary derived from its rows.
   * Never a licence -- every module emits explicitly -- but a missed
   * branch must not become a crash; it should still produce a valid
   * object (docs/port/PHILOSOPHY.md P-03).
   */
  finish(): never {
    if (this.emitted) this.io.exit(this.fails() === 0 ? 0 : 1);
    const n = this.fails();
    this.emit(n === 0 ? `scrumux ${this.command}: ok.` : `scrumux ${this.command}: ${n} check(s) failed.`);
  }

  /** A refusal is still an object under --json. exit 2, ok false. */
  refuse(kind: 'usage' | 'refused', message: string): never {
    if (this.json) {
      const env: Envelope = {
        schema: 'scrumux.cli/1',
        command: this.command,
        argv: this.argv,
        ok: false,
        exit: 2,
        summary: `scrumux ${this.command}: error: ${message}`,
        checks: this.rows,
        data: {},
        error: { kind, message },
      };
      this.io.out(jqFormat(env as unknown as JsonValue));
    }
    // stderr carries it in BOTH modes.
    const prefix = this.command ? ` ${this.command}` : '';
    this.io.err(`scrumux${prefix}: error: ${message}\n`);
    this.io.exit(2);
  }

  die(message: string): never { return this.refuse('refused', message); }
  dieUsage(message: string): never { return this.refuse('usage', message); }
}
