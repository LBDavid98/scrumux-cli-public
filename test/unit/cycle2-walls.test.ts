/**
 * Improvement cycle 2 (D-S038), the three wall corrections:
 *
 *   SX-021  block-upstream-edit's heredoc body ends at its terminator
 *   SX-023  block-secret-reads: a doc placeholder is not a read of every word;
 *           `test_credentials.py` is not a credential file; the refusal names
 *           `scrumux secret list`
 *   SX-026  block-destructive treats `<WORK_ROOT>/.scratch/` as temp (D-S040)
 *
 * Each corrects precision inside an existing hard gate: every true positive
 * the validators named stays refused and is pinned here. The two exact
 * transcript commands are fixtures (test/fixtures/cycle2/).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureWallIo, wallExitCode, type WallIo } from '../../src/walls/lib/hook.js';
import { scanCommand, main as upstream } from '../../src/walls/block-upstream-edit.js';
import { main as secret, readOperands, shellReadTargets } from '../../src/walls/block-secret-reads.js';
import { main as destructive, rmTargetsTemp } from '../../src/walls/block-destructive.js';
import { heredocOpens, closesHeredoc } from '../../src/walls/lib/heredoc.js';
import { inScratch, cdTarget, resolveOperand } from '../../src/walls/lib/scratch.js';

const FIX = resolve(import.meta.dirname, '../fixtures/cycle2');
const T0017 = readFileSync(join(FIX, 'sx021-t0017-log-new.sh.txt'), 'utf8');
const T0016 = readFileSync(join(FIX, 'sx023-t0016-log-new.sh.txt'), 'utf8');

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function repo(deployed: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'cycle2-walls-'));
  scratch.push(d);
  mkdirSync(join(d, 'governance'), { recursive: true });
  mkdirSync(join(d, '.claude'), { recursive: true });
  if (deployed) writeFileSync(join(d, '.claude/DEPLOYED'), '{}\n');
  return d;
}

/** Run a wall in-process with GOV_ROOT (and optionally WORK_ROOT) set. */
function run(wall: (io: WallIo) => never, payload: object, opts: { deployed?: boolean; workRoot?: string } = {}):
  { code: number; stderr: string; root: string } {
  const root = repo(opts.deployed ?? false);
  const io = captureWallIo(JSON.stringify(payload));
  const prev = { gov: process.env['GOV_ROOT'], work: process.env['WORK_ROOT'] };
  process.env['GOV_ROOT'] = root;
  if (opts.workRoot !== undefined) process.env['WORK_ROOT'] = opts.workRoot; else delete process.env['WORK_ROOT'];
  try {
    return { code: wallExitCode(() => wall(io)), stderr: io.stderr, root };
  } finally {
    if (prev.gov === undefined) delete process.env['GOV_ROOT']; else process.env['GOV_ROOT'] = prev.gov;
    if (prev.work === undefined) delete process.env['WORK_ROOT']; else process.env['WORK_ROOT'] = prev.work;
  }
}
const hits = (c: string): string | null => scanCommand(c)?.path ?? null;

// ---------------------------------------------------------------- SX-021
describe('SX-021: a heredoc body ends at its terminator', () => {
  it('allows the exact T-0017 log new call, end to end in a deployment', () => {
    expect(hits(T0017)).toBeNull();
    expect(run(upstream, { tool_input: { command: T0017 } }, { deployed: true }).code).toBe(0);
  });

  it('h1 (heredoc, then a later prose mention) now matches h2 (no heredoc)', () => {
    const h1 = '.claude/scripts/scrumux log new --task T-1 --did "$(cat <<\'EOF\'\nplain prose\nEOF\n)" --verified "(run via .claude/scripts/scrumux task verify T-1)"';
    const h2 = '.claude/scripts/scrumux log new --task T-1 --did "plain prose" --verified "(run via .claude/scripts/scrumux task verify T-1)"';
    expect(hits(h1)).toBeNull();
    expect(hits(h2)).toBeNull();
  });

  it('keeps I-0121: every line of a real body is scanned, wherever the write sits', () => {
    expect(hits("python3 - <<'PY'\nprint('hi')\nx = 1\nopen('.claude/scripts/scrumux','a').write('x')\nPY")).not.toBeNull();
    expect(hits('python3 <<EOF\nopen(".claude/dist/x.mjs","w")\nEOF')).not.toBeNull();
    expect(hits('node <<"JS"\nrequire("fs").writeFileSync(".claude/schemas/t.json","")\nJS')).not.toBeNull();
  });

  it('a real write after the terminator is still judged as a command (f)', () => {
    expect(hits('cat <<EOF\nhello\nEOF\necho hi > .claude/dist/y.mjs')).toBe('.claude/dist/y.mjs');
    expect(hits('echo hi > .claude/scripts/scrumux')).toBe('.claude/scripts/scrumux');
  });

  it('closes only where a shell closes: exact word for <<, leading tabs for <<-', () => {
    // An indented terminator does not end a `<<` body, so the write stays body.
    expect(hits("python3 <<EOF\n  EOF\nopen('.claude/dist/x','w')\nEOF")).not.toBeNull();
    // `<<-` strips TABS, not spaces.
    expect(hits("python3 <<-EOF\n\tEOF\necho ok")).toBeNull();
    expect(hits("python3 <<-EOF\n    EOF\nopen('.claude/dist/x','w')\nEOF")).not.toBeNull();
    // `EOF)` on one line is not a terminator outside a command substitution.
    expect(hits("python3 <<EOF\nEOF)\nopen('.claude/dist/x','w')\nEOF")).not.toBeNull();
  });

  it('reads quoted, double-quoted and escaped words, and two bodies in order', () => {
    const after = '\nscrumux log new --did "see .claude/dist"';
    expect(hits(`cat <<'X'\nbody\nX${after}`)).toBeNull();
    expect(hits(`cat <<"X"\nbody\nX${after}`)).toBeNull();
    expect(hits(`cat <<\\X\nbody\nX${after}`)).toBeNull();
    expect(hits(`cat <<A <<B\na\nA\nopen('.claude/dist/x','w')\nB`)).not.toBeNull();
    expect(hits(`cat <<A <<B\na\nA\nb\nB${after}`)).toBeNull();
  });

  it('an unreadable word keeps the old latch; a here-string opens no body', () => {
    expect(hits('cat <<\nbody\nscrumux log new --did "see .claude/dist"')).toBe('.claude/dist');
    expect(hits('cat <<< "x"\nscrumux log new --did "see .claude/dist"')).toBeNull();
  });

  it('heredocOpens / closesHeredoc', () => {
    expect(heredocOpens("x <<'EOF' <<-B <<<y")).toEqual([{ word: 'EOF', stripTabs: false }, { word: 'B', stripTabs: true }]);
    expect(heredocOpens('cat <<')).toEqual([{ word: null, stripTabs: false }]);
    expect(closesHeredoc('EOF\r', { word: 'EOF', stripTabs: false })).toBe(true);
    expect(closesHeredoc('\t\tEOF', { word: 'EOF', stripTabs: true })).toBe(true);
    expect(closesHeredoc('\tEOF', { word: 'EOF', stripTabs: false })).toBe(false);
    expect(closesHeredoc('EOF', { word: null, stripTabs: false })).toBe(false);
  });
});

// ---------------------------------------------------------------- SX-023
describe('SX-023: block-secret-reads precision, and the refusal names secret list', () => {
  const bash = (command: string): { code: number; stderr: string } => run(secret, { tool_input: { command } });

  it('allows the exact T-0016 log new call and its follow-up prose', () => {
    expect(bash(T0016).code).toBe(0);
    expect(bash('scrumux log new --did "resolves under <app-root>/generated/<name>; added agents/tests/test_credentials.py (8 tests)"').code).toBe(0);
    expect(bash('scrumux issue new --summary "fires on \'no .env/checkout mounted\' in <app-root> prose"').code).toBe(0);
  });

  const refused = [
    "grep -o '^[A-Z_]*=' /srv/apps/example-app/.env",
    "cat ../.env | sed 's/=.*/=.../'",
    'read K < .env',
    'X=$(<.env)',
    'while read l; do echo "$l"; done < .env',
    'exec 3<> .env',
    'cat credentials.json',
    'cat ~/.aws/credentials',
    'head /x/my-credentials.yaml',
    'cat < .env',
  ];
  for (const c of refused) {
    it(`still refuses, naming secret list: ${c}`, () => {
      const r = bash(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('BLOCKED by block-secret-reads');
      expect(r.stderr).toContain('scrumux secret list');
    });
  }

  it('a test module named for credentials is not a credential file', () => {
    expect(bash('cat agents/tests/test_credentials.py').code).toBe(0);
  });

  it('a shell-level read licenses only its redirect targets', () => {
    expect(shellReadTargets('read K < .env')).toEqual(['.env']);
    expect(shellReadTargets('X=$(<.env)')).toEqual(['.env)']);
    expect(shellReadTargets('exec 3<> .env')).toEqual(['.env']);
    expect(shellReadTargets('cat <<EOF')).toEqual([]);
    expect(readOperands('scrumux log new --did "<app-root>/x test_credentials.py .env/checkout"'))
      .toEqual(['app-root>/x']);
  });
});

// ---------------------------------------------------------------- SX-026
describe('SX-026 / D-S040: <WORK_ROOT>/.scratch/ is temp space for block-destructive', () => {
  const work = (): string => { const d = mkdtempSync(join(tmpdir(), 'cycle2-work-')); scratch.push(d); return d; };
  const rm = (command: string, cwd: string | undefined, workRoot: string): { code: number; stderr: string } =>
    run(destructive, { tool_input: { command }, ...(cwd === undefined ? {} : { cwd }) }, { workRoot });

  it('allows removing the scratch directory and anything under it', () => {
    const w = work();
    for (const c of ['rm -rf .scratch', 'rm -rf .scratch/export_dir', 'rm -rf ./.scratch/a .scratch/b/c', `rm -rf ${w}/.scratch/x`, 'rm -rf .scratch/*']) {
      expect(rm(c, w, w).code, c).toBe(0);
    }
    // No payload cwd: relative operands resolve against WORK_ROOT.
    expect(rm('rm -rf .scratch/x', undefined, w).code).toBe(0);
  });

  it('follows a cd before the rm, and refuses when the cd cannot be followed', () => {
    const w = work();
    expect(rm(`cd ${w} && rm -rf .scratch/x`, '/somewhere/else', w).code).toBe(0);
    expect(rm('cd /elsewhere && rm -rf .scratch', w, w).code).toBe(2);
    expect(rm('cd && rm -rf .scratch', w, w).code).toBe(2);
    expect(rm('cd "$HOME" && rm -rf .scratch', w, w).code).toBe(2);
  });

  it('a shell sitting in a subdirectory names the scratch dir by ../', () => {
    const w = work();
    expect(rm('rm -rf .scratch', join(w, 'agents'), w).code).toBe(2);
    expect(rm('rm -rf ../.scratch/x', join(w, 'agents'), w).code).toBe(0);
  });

  it('keeps refusing everything else, and the refusal names .scratch/', () => {
    const w = work();
    const t0010 = 'rm -f .scratch_openapi.json .scratch_export.json && rm -rf .scratch_export_dir && git status --short | head -30';
    const t0017 = 'rm -rf .scratch scratch_fetch_export.py scratch_diff.py && git status --porcelain=v1';
    for (const c of [t0010, t0017, 'rm -rf .scratch/../src', 'rm -rf .scratchpad', 'rm -rf .scratch/x src', 'rm -rf .scratch/x ~/y', 'rm -rf $X/.scratch']) {
      const r = rm(c, w, w);
      expect(r.code, c).toBe(2);
      expect(r.stderr).toContain('.scratch/');
      expect(r.stderr).toContain('HARNESS_BACKUP_DONE=1');
    }
    expect(rm('rm -rf --no-preserve-root .scratch', w, w).code).toBe(2);
  });

  it('the helpers', () => {
    expect(inScratch('/w/.scratch', '/w')).toBe(true);
    expect(inScratch('/w/.scratch/a/b', '/w/')).toBe(true);
    expect(inScratch('/w/.scratchy', '/w')).toBe(false);
    expect(inScratch('.scratch', '/w')).toBe(false);
    expect(inScratch('/w/.scratch', '')).toBe(false);
    expect(resolveOperand('~/x', '/w')).toBeNull();
    expect(resolveOperand('x', null)).toBeNull();
    expect(resolveOperand('a/../b', '/w')).toBe('/w/b');
    expect(cdTarget('echo hi', '/w')).toBeUndefined();
    expect(cdTarget(' cd sub ', '/w')).toBe('/w/sub');
    expect(cdTarget('pushd -', '/w')).toBeNull();
    expect(rmTargetsTemp('rm -rf .scratch/x').allTemp).toBe(false);
    expect(rmTargetsTemp('rm -rf .scratch/x', { workRoot: '/w', cwd: '' }).allTemp).toBe(true);
  });
});
