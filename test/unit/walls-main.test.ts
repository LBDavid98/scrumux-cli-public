import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWallIo, wallExitCode, type CapturedWallIo } from '../../src/walls/lib/hook.js';
import { main as destructive } from '../../src/walls/block-destructive.js';
import { main as secret } from '../../src/walls/block-secret-reads.js';
import { main as upstream } from '../../src/walls/block-upstream-edit.js';
import { main as directLlm } from '../../src/walls/block-direct-llm.js';

/**
 * The four walls END TO END, in-process.
 *
 * `tools/walls-parity.mjs` proves the bundles agree with bash over 684 real
 * payloads, and that is the parity spec. What a subprocess comparison cannot
 * do is assert the SENTENCE — and under Article 5 the refusal text is the
 * instruction set, held to the same review standard as code. So every refusal
 * below is checked for the thing that makes it useful: the next action.
 *
 * "A refusal that states a fact without naming the next action is a defect."
 */
const scratch: string[] = [];
function root(opts: { deployed?: boolean; conf?: string } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'wallmain-'));
  scratch.push(d);
  mkdirSync(join(d, 'governance'), { recursive: true });
  mkdirSync(join(d, '.claude'), { recursive: true });
  if (opts.deployed === true) writeFileSync(join(d, '.claude/DEPLOYED'), '{"source_remote":"git@example:harness.git"}\n');
  if (opts.conf !== undefined) writeFileSync(join(d, '.claude/project-walls.conf'), opts.conf);
  return d;
}
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

type Wall = (io: ReturnType<typeof captureWallIo>) => never;
function run(wall: Wall, payload: unknown, gov: string): { code: number; io: CapturedWallIo } {
  const io = captureWallIo(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const prev = process.env['GOV_ROOT'];
  process.env['GOV_ROOT'] = gov;
  try {
    return { code: wallExitCode(() => wall(io)), io };
  } finally {
    if (prev === undefined) delete process.env['GOV_ROOT']; else process.env['GOV_ROOT'] = prev;
  }
}
const cmd = (c: string): object => ({ tool_input: { command: c } });

// ------------------------------------------------------------ shared -----
describe('every wall, on input it cannot judge', () => {
  const cases: Array<[string, Wall]> = [
    ['block-destructive', destructive as Wall],
    ['block-secret-reads', secret as Wall],
    ['block-upstream-edit', upstream as Wall],
    ['block-direct-llm', directLlm as Wall],
  ];
  for (const [name, wall] of cases) {
    it(`${name}: an UNPARSEABLE payload allows, exactly as bash does`, () => {
      // bash does `jq -r '.tool_input.command // empty'`, which yields empty on
      // anything it cannot read, and every wall then exits 0. Inventing a
      // refusal here would block tool calls this harness has never blocked.
      const g = root();
      expect(run(wall, 'not json at all', g).code).toBe(0);
      expect(run(wall, '', g).code).toBe(0);
      expect(run(wall, '{"tool_input":{}}', g).code).toBe(0);
    });
  }
});

// -------------------------------------------------------- destructive ----
describe('block-destructive', () => {
  it('refuses an rm -rf outside temp AND names the sanctioned path', () => {
    const g = root();
    const { code, io } = run(destructive as Wall, cmd('rm -rf /Users/x/data'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('BLOCKED by block-destructive');
    expect(io.stderr).toContain('CLAUDE.MD hard limit');
    expect(io.stderr).toContain('HARNESS_BACKUP_DONE=1');       // the next action
  });

  it('allows a delete whose every target is temp', () => {
    expect(run(destructive as Wall, cmd('rm -rf /tmp/build-cache'), root()).code).toBe(0);
  });

  it('records exactly ONE attestation row for a command in two classes', () => {
    // An attested `rm -rf` that also drops a table produces ONE row, not two.
    const g = root();
    const c = 'HARNESS_BACKUP_DONE=1 rm -rf /Users/x/d && psql -c "DROP DATABASE p"';
    expect(run(destructive as Wall, cmd(c), g).code).toBe(0);
    const rows = readFileSync(join(g, 'governance/attestations.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)).toMatchObject({ class: 'rm-rf', attested_path: '/Users/x/d' });
  });

  it('the attestation row carries the FULL command, unlike the event stream (P-31)', () => {
    // Two sinks, two policies. attestations.jsonl is a deliberate audit sink
    // for an act a person attested to; .scrumux/events.jsonl gets a safe
    // subject only, because a command line can carry a secret in a flag.
    const g = root();
    const c = 'HARNESS_BACKUP_DONE=1 rm -rf /Users/x/d --token=sk-live-xyz';
    run(destructive as Wall, cmd(c), g);
    expect(readFileSync(join(g, 'governance/attestations.jsonl'), 'utf8')).toContain('sk-live-xyz');
  });

  it('the EVENT row carries a program word, never the command (CLI-5)', () => {
    const g = root();
    run(destructive as Wall, cmd('rm -rf /Users/x/d --token=sk-live-xyz'), g);
    const ev = readFileSync(join(g, '.scrumux/events.jsonl'), 'utf8');
    expect(ev).not.toContain('sk-live-xyz');
    expect(JSON.parse(ev.trim()).refused).toBe('/Users/x/d');
  });

  it('writes NO attestation row when nothing was attested', () => {
    const g = root();
    run(destructive as Wall, cmd('rm -rf /tmp/x'), g);
    expect(existsSync(join(g, 'governance/attestations.jsonl'))).toBe(false);
  });

  it('honours a conf allow line before its own patterns (P-29)', () => {
    const g = root({ conf: 'allow rm -rf /Users/x/archive | the archive really is meant to go\n' });
    expect(run(destructive as Wall, cmd('rm -rf /Users/x/archive'), g).code).toBe(0);
  });

  it('a conf refuse line fires, and the message says WHOSE rule it was', () => {
    const g = root({ conf: 'refuse terraform destroy | this repo owns production\n' });
    const { code, io } = run(destructive as Wall, cmd('terraform destroy'), g);
    expect(code).toBe(2);
    expect(io.stderr).toBe('BLOCKED by project-walls.conf: this repo owns production\n');
  });
});

// ------------------------------------------------------------- secret ----
describe('block-secret-reads', () => {
  it('refuses a read and names where a secret is SUPPOSED to go', () => {
    const g = root();
    const { code, io } = run(secret as Wall, cmd('cat /app/.env'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('scrumux secret NAME');            // the next action
    expect(io.stderr).toContain('project-walls.conf');             // and the escape
  });

  it('allows a commit message that merely names one', () => {
    expect(run(secret as Wall, cmd('git commit -m "wired .env loading"'), root()).code).toBe(0);
  });

  it('the Read arm exempts a whole-target .example; the Bash arm does not (CLI-2)', () => {
    const g = root();
    expect(run(secret as Wall, { tool_input: { file_path: '/app/.env.example' } }, g).code).toBe(0);
    expect(run(secret as Wall, cmd('cp .env.example .env && cat .env'), g).code).toBe(2);
  });

  it('the Read arm matches an ambiguous word bare; the Bash arm needs path context (P-25)', () => {
    const g = root();
    expect(run(secret as Wall, { tool_input: { file_path: '/home/x/credentials' } }, g).code).toBe(2);
    expect(run(secret as Wall, cmd('scrumux task new --check "no credentials anywhere"'), g).code).toBe(0);
  });
});

// ----------------------------------------------------------- upstream ----
describe('block-upstream-edit', () => {
  it('does nothing in a repo that is not a deployment', () => {
    expect(run(upstream as Wall, cmd('cp /tmp/x .claude/scripts/scrumux'), root()).code).toBe(0);
  });

  it('refuses in a deployment, and names the upstream from the manifest', () => {
    const g = root({ deployed: true });
    const { code, io } = run(upstream as Wall, cmd('cp /tmp/x .claude/scripts/scrumux'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('D-0078 boundary 1');
    expect(io.stderr).toContain('git@example:harness.git');        // read from DEPLOYED
    expect(io.stderr).toContain('scrumux issue new --type harness'); // the next action
    expect(io.stderr).toContain('A denied call is a stop, not an obstacle');
  });

  it('falls back to a generic upstream when the manifest will not parse', () => {
    const g = root({ deployed: true });
    writeFileSync(join(g, '.claude/DEPLOYED'), 'not json\n');
    const { io } = run(upstream as Wall, cmd('cp /tmp/x .claude/dist/x.mjs'), g);
    expect(io.stderr).toContain('the upstream harness repository');
  });

  it('IGNORES a conf allow line — the one wall that does (P-23)', () => {
    // An allow line here would let any agent exempt itself from D-0078
    // boundary 1 by writing one file, and the wall would be advisory.
    const g = root({ deployed: true, conf: 'allow .* | this repo permits everything\n' });
    expect(run(upstream as Wall, cmd('cp /tmp/x .claude/scripts/scrumux'), g).code).toBe(2);
  });

  it('catches NotebookEdit, which sends notebook_path and not file_path', () => {
    const g = root({ deployed: true });
    expect(run(upstream as Wall, { tool_input: { notebook_path: '/r/.claude/scripts/n.ipynb' } }, g).code).toBe(2);
  });
});

// ---------------------------------------------------------- direct LLM ---
describe('block-direct-llm', () => {
  it('refuses a provider call and points at THIS repo\'s declared gateway (D-0086)', () => {
    const g = root();
    const { code, io } = run(directLlm as Wall, cmd('curl https://api.openai.com/v1/chat'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('project-standards.md');       // generic destination
    expect(io.stderr).toContain('project-walls.conf');         // the sanctioned escape
    // D-0086: the refusal names no installation's OWN gateway — not its host,
    // not its vendor, not its brand. It points at where this repo declares one.
    // A message that named a particular gateway would be wrong in every repo
    // but the one it was written in.
    expect(io.stderr).not.toMatch(/https?:\/\//);
    expect(io.stderr).not.toMatch(/\b[a-z0-9-]+\.(com|net|io|dev|azurewebsites\.net)\b/i);
    expect(io.stderr).not.toContain('User');
  });

  it('allows a rationale that names a provider — it reaches nothing', () => {
    const g = root();
    const c = 'scrumux decide new --title t --decision d --rationale "we do not call api.openai.com" --by x';
    expect(run(directLlm as Wall, cmd(c), g).code).toBe(0);
  });

  it('catches the shell dialling a provider with no client word', () => {
    expect(run(directLlm as Wall, cmd('exec 3<>/dev/tcp/api.openai.com/443'), root()).code).toBe(2);
  });
});
