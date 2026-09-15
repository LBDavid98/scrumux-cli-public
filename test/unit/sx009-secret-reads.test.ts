/**
 * SX-009 — block-secret-reads refuses READING a secret file, not MENTIONING
 * one (super-repo ISSUES.MD, Rover T-0001/T-0003).
 *
 * Driven through the real wall `main`, in-process, the way walls-main.test.ts
 * drives it: a PreToolUse payload in, an exit code and stderr out.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWallIo, wallExitCode } from '../../src/walls/lib/hook.js';
import { main as secret, readOperands, dropWriteTargets, readsBySubstitution } from '../../src/walls/block-secret-reads.js';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'sx009-'));
  scratch.push(d);
  mkdirSync(join(d, 'governance'), { recursive: true });
  mkdirSync(join(d, '.claude'), { recursive: true });
  return d;
}

function run(payload: object): { code: number; stderr: string } {
  const io = captureWallIo(JSON.stringify(payload));
  const prev = process.env['GOV_ROOT'];
  process.env['GOV_ROOT'] = repo();
  try {
    return { code: wallExitCode(() => (secret as (io: unknown) => never)(io)), stderr: io.stderr };
  } finally {
    if (prev === undefined) delete process.env['GOV_ROOT']; else process.env['GOV_ROOT'] = prev;
  }
}
const bash = (command: string) => run({ tool_input: { command } });

describe('SX-009: still refused — a read of a secret file', () => {
  const refused = [
    'cat .env',
    'source .env',
    '. .env',
    'grep KEY .env',
    "sed -n '1p' .env",
    'cat < .env',
    'read K < .env',
    'git rev-parse HEAD && cat /srv/apps/example-app/.env',
    'ls -la && head -3 .env.production.local',
    'cat .env > /tmp/out.txt',
    'echo $(cat .env)',
    'diff <(cat .env) other',
    'cp -t /tmp .env',
    'cp .env.example .env && cat .env',
    'docker run --env-file=.env img',
  ];
  for (const c of refused) {
    it(`refuses: ${c}`, () => {
      const r = bash(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('BLOCKED by block-secret-reads');
      expect(r.stderr).toContain('scrumux secret');       // names the fix
    });
  }

  it('refuses the Read tool on .env, relative and absolute', () => {
    expect(run({ tool_input: { file_path: '.env' } }).code).toBe(2);
    expect(run({ tool_input: { file_path: '/srv/apps/example-app/.env' } }).code).toBe(2);
  });
});

describe('SX-009: allowed — prose, existence checks and writes', () => {
  const allowed = [
    // The observed false positives.
    '.claude/scripts/scrumux issue new --summary "the secret set verb writes .env in the main checkout"',
    '.claude/scripts/scrumux issue new --summary "…writes .env…" && cat README.md',
    "git rev-parse HEAD && ls -la /x/.env | sed 's/.*/h/'",
    "git rev-parse HEAD && ls -la /srv/apps/example-app/.env | sed 's/.*/hidden/' && find . -name MODELS.md",
    // Writing a NEW secret file is not reading one.
    "printf 'A=1' > .env",
    'tee .env <<< "A=1"',
    'cat > .env <<< "A=1"',
    'echo A=1 >> .env && cat README.md',
    'cp .env.example .env',
    'git commit -m "wired .env loading"',
  ];
  for (const c of allowed) {
    it(`allows: ${c}`, () => {
      const r = bash(c);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
    });
  }
});

describe('SX-009: the per-segment helpers', () => {
  it('readOperands takes operands only from segments that can read', () => {
    expect(readOperands('scrumux issue new --summary "x .env" && cat README.md')).not.toContain('.env"');
    expect(readOperands('ls -la /x/.env | sed s/a/b/')).not.toContain('/x/.env');
    expect(readOperands('ls && cat .env')).toContain('.env');
  });

  it('dropWriteTargets drops output-redirect targets, never input ones', () => {
    expect(dropWriteTargets(['cat', '>', '.env'])).toEqual(['cat']);
    expect(dropWriteTargets(['cat', '>>.env'])).toEqual(['cat']);
    expect(dropWriteTargets(['cmd', '2>', 'err.log', '&>', 'all.log'])).toEqual(['cmd']);
    expect(dropWriteTargets(['cat', '<', '.env'])).toEqual(['cat', '<', '.env']);
    expect(dropWriteTargets(['cat', '.env', '>', 'out'])).toEqual(['cat', '.env']);
  });

  it('readsBySubstitution finds a reader inside $( ), backticks and <( )', () => {
    expect(readsBySubstitution('echo $(cat .env)')).toBe(true);
    expect(readsBySubstitution('echo `head .env`')).toBe(true);
    expect(readsBySubstitution('diff <(sort a) b')).toBe(true);
    expect(readsBySubstitution('echo $(date)')).toBe(false);
  });
});
