import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWallIo, wallExitCode, type CapturedWallIo } from '../../src/walls/lib/hook.js';
import { main as destructive } from '../../src/walls/block-destructive.js';
import { main as secret } from '../../src/walls/block-secret-reads.js';
import { main as upstream } from '../../src/walls/block-upstream-edit.js';
import { main as directLlm } from '../../src/walls/block-direct-llm.js';

/**
 * The branches `walls-main.test.ts` leaves for the differential to reach.
 *
 * The differential DOES reach them — 684 payloads through both
 * implementations — but a subprocess comparison proves the two AGREE and
 * cannot prove what either one SAID. Under Article 5 the sentence is the
 * product, so each branch below is entered here and its message asserted.
 *
 * Every case names the class it is covering rather than the line number,
 * because a line number is stale the moment anything above it moves.
 */
const scratch: string[] = [];
function root(opts: { deployed?: boolean; conf?: string } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'wallbranch-'));
  scratch.push(d);
  mkdirSync(join(d, 'governance'), { recursive: true });
  mkdirSync(join(d, '.claude'), { recursive: true });
  if (opts.deployed === true) writeFileSync(join(d, '.claude/DEPLOYED'), '{}\n');
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

const FAILED_CLOSED = 'a refuse pattern this build cannot evaluate';
const UNEVALUABLE_CONF = 'refuse a{2,1} | an interval JavaScript will not compile\n';

describe('the conf paths in every wall that consults it (P-29)', () => {
  const walls: Array<[string, Wall, object]> = [
    ['block-destructive', destructive as Wall, cmd('echo hello')],
    ['block-secret-reads', secret as Wall, cmd('cat notes.txt')],
    ['block-direct-llm', directLlm as Wall, cmd('curl https://example.com')],
  ];

  for (const [name, wall, payload] of walls) {
    it(`${name}: an unevaluable REFUSE pattern fails CLOSED (OQ-8, D-0085)`, () => {
      // No bash counterpart: grep compiled this and this build cannot. The
      // asymmetry is walls_allows/walls_refuses's asymmetry one layer down —
      // when in doubt, refuse.
      const g = root({ conf: UNEVALUABLE_CONF });
      const { code, io } = run(wall, payload, g);
      expect(code).toBe(2);
      expect(io.stderr).toContain('BLOCKED by project-walls.conf');
      expect(io.stderr).toContain(FAILED_CLOSED);
    });

    it(`${name}: the skip lines reach stderr before any verdict`, () => {
      const g = root({ conf: 'refuse ( | a pattern that cannot compile\n' });
      const { io } = run(wall, payload, g);
      expect(io.stderr).toContain('ignoring an invalid refuse pattern');
      expect(io.stderr).toContain('so the rest still apply');
    });

    it(`${name}: an allow line short-circuits before the built-ins`, () => {
      const g = root({ conf: 'allow .* | this repo permits everything\n' });
      expect(run(wall, payload, g).code).toBe(0);
    });
  }

  it('the secret wall applies the conf on the READ arm too', () => {
    const g = root({ conf: 'refuse notes\\.txt | this repo keeps notes out of agent hands\n' });
    const { code, io } = run(secret as Wall, { tool_input: { file_path: '/app/notes.txt' } }, g);
    expect(code).toBe(2);
    expect(io.stderr).toBe('BLOCKED by project-walls.conf: this repo keeps notes out of agent hands\n');
  });

  it('...and an allow line on the READ arm exempts a real secret', () => {
    const g = root({ conf: 'allow /app/\\.env | this .env holds only public build flags\n' });
    expect(run(secret as Wall, { tool_input: { file_path: '/app/.env' } }, g).code).toBe(0);
  });

  it('the secret wall records the SAFE program word for a conf refusal, not the command', () => {
    // CLI-5: a command line can carry a secret in a flag, and a secret must
    // never reach the event stream.
    const g = root({ conf: 'refuse zzz | this repo refuses zzz\n' });
    run(secret as Wall, cmd('cat zzz --token=sk-live-xyz'), g);
    const ev = readFileSync(join(g, '.scrumux/events.jsonl'), 'utf8');
    expect(ev).not.toContain('sk-live-xyz');
    expect(JSON.parse(ev.trim()).refused).toBe('cat');
  });
});

describe('block-destructive: the classes walls-main leaves to the differential', () => {
  it('--no-preserve-root refuses even WITH an attestation, and says why', () => {
    const g = root();
    const { code, io } = run(destructive as Wall,
      cmd('HARNESS_BACKUP_DONE=1 rm -rf --no-preserve-root /'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('--no-preserve-root');
    expect(io.stderr).toContain('There is no sanctioned use of this flag here');
  });

  it('a database purge refuses, and names the backup path', () => {
    const g = root();
    const { code, io } = run(destructive as Wall, cmd('psql -c "DROP DATABASE prod"'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('database purge class command');
    expect(io.stderr).toContain('HARNESS_BACKUP_DONE=1');
  });

  it('an attested purge records class db-purge with NO filesystem target', () => {
    const g = root();
    expect(run(destructive as Wall, cmd('HARNESS_BACKUP_DONE=1 psql -c "DROP TABLE t"'), g).code).toBe(0);
    expect(JSON.parse(readFileSync(join(g, 'governance/attestations.jsonl'), 'utf8').trim()))
      .toMatchObject({ class: 'db-purge', attested_path: '' });
  });

  it('a bare force-push refuses and names --force-with-lease', () => {
    const g = root();
    const { code, io } = run(destructive as Wall, cmd('git push origin main --force'), g);
    expect(code).toBe(2);
    expect(io.stderr).toContain('bare force-push');
    expect(io.stderr).toContain('--force-with-lease');
  });

  it('git working-tree destruction refuses, and is attestable', () => {
    const g = root();
    const red = run(destructive as Wall, cmd('git reset --hard HEAD~3'), g);
    expect(red.code).toBe(2);
    expect(red.io.stderr).toContain('working-tree destruction');
    expect(red.io.stderr).toContain('git stash -u');

    const g2 = root();
    expect(run(destructive as Wall, cmd('HARNESS_BACKUP_DONE=1 git clean -fd'), g2).code).toBe(0);
    expect(JSON.parse(readFileSync(join(g2, 'governance/attestations.jsonl'), 'utf8').trim()).class)
      .toBe('git-history');
  });

  it('the interpreter -c payload is folded into the scan (CLI-4 augment)', () => {
    const g = root();
    expect(run(destructive as Wall, cmd('sh -c "rm -rf /Users/x/data"'), g).code).toBe(2);
  });

  it('...but an interpreter word in QUOTED PROSE extracts nothing', () => {
    // The trigger is structure-aware, and that is the whole safety of it: we
    // act only when a shell interpreter surfaced as a real command WORD.
    const g = root();
    const c = 'scrumux decide new --title t --decision d --rationale "never sh -c rm -rf /x" --by y';
    expect(run(destructive as Wall, cmd(c), g).code).toBe(0);
  });

  it('an rm with no operand at all still refuses — no operand is not an exemption', () => {
    expect(run(destructive as Wall, cmd('rm -rf'), root()).code).toBe(2);
  });
});

describe('block-direct-llm: the paths a provider call takes', () => {
  it('allows a command that names a provider but cannot call out', () => {
    expect(run(directLlm as Wall, cmd('echo api.openai.com'), root()).code).toBe(0);
  });

  it('allows a client calling something that is not a provider', () => {
    expect(run(directLlm as Wall, cmd('curl https://example.com/x'), root()).code).toBe(0);
  });

  it('records the program word, never the command, on a provider refusal', () => {
    const g = root();
    run(directLlm as Wall, cmd('curl -H "Authorization: Bearer sk-live-xyz" https://api.openai.com/v1'), g);
    const ev = readFileSync(join(g, '.scrumux/events.jsonl'), 'utf8');
    expect(ev).not.toContain('sk-live-xyz');
    expect(JSON.parse(ev.trim())).toMatchObject({ wall: 'block-direct-llm', refused: 'curl' });
  });
});

describe('block-upstream-edit: the arms and the not-a-deployment exit', () => {
  it('an empty command in a deployment allows', () => {
    expect(run(upstream as Wall, { tool_input: { command: '' } }, root({ deployed: true })).code).toBe(0);
  });

  it('a file_path that is NOT machinery allows', () => {
    const g = root({ deployed: true });
    expect(run(upstream as Wall, { tool_input: { file_path: '/repo/src/app.ts' } }, g).code).toBe(0);
  });

  it('records the PATH as the subject — it is already safe', () => {
    const g = root({ deployed: true });
    run(upstream as Wall, { tool_input: { file_path: '/repo/.claude/dist/block-destructive.mjs' } }, g);
    expect(JSON.parse(readFileSync(join(g, '.scrumux/events.jsonl'), 'utf8').trim()))
      .toMatchObject({ wall: 'block-upstream-edit', refused: '/repo/.claude/dist/block-destructive.mjs' });
  });
});
