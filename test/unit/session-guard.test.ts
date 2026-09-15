/**
 * THE SESSION GUARD — the fail-closed guarantee, after it moved.
 *
 * The four walls used to be reached through `.claude/hooks/block-*.sh`, and
 * each shim carried the doctrine in two lines: `command -v node || exit 2`.
 * `settings.json` reaches them in EXEC FORM now, because that is the only hook
 * shape that runs on a stock Windows box, and exec form has no shell to put a
 * guard in. So the guarantee moved to SessionStart.
 *
 * WHAT MAKES THESE ASSERTIONS DIFFERENT FROM THE WALLS'. Every wall test in
 * this repo asserts an EXIT CODE, because PreToolUse blocks on exit 2. This
 * hook cannot: the hooks doc's "Exit code 2 behavior per event" table gives
 * `SessionStart` `Can block? No — Shows stderr to user only`, and spells out
 * that Claude Code renders such a hook's stderr as a notice and "the session
 * … proceeds". An `exit 2` here would refuse nothing. So the assertions below
 * are about STDOUT — specifically `continue: false`, the universal JSON field
 * that does stop the session — and every one of them checks the exit code is
 * ZERO, because a nonzero exit is precisely what would get the JSON treated as
 * a hook error and discarded.
 *
 * THE BLAST RADIUS IS THE REASON FOR THE 'ALLOWS' CASES. A false positive here
 * halts every session in every governed repo. Half of this file is therefore
 * about what the guard must NOT refuse.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWallIo, wallExitCode, type CapturedWallIo } from '../../src/walls/lib/hook.js';
import { main as guard, shellToolHere } from '../../src/walls/session-guard.js';

const scratches: string[] = [];
function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `sg-${name}-`));
  scratches.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratches) rmSync(d, { recursive: true, force: true });
});

/** The settings.json the payload ships, in miniature. */
function execFormSettings(): unknown {
  const wall = (n: string): unknown => ({
    type: 'command',
    command: 'node',
    args: [`\${CLAUDE_PROJECT_DIR}/.claude/dist/${n}.mjs`],
  });
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|PowerShell', hooks: [wall('block-destructive')] },
        { matcher: 'Read', hooks: [wall('block-secret-reads')] },
        { matcher: 'Edit|Write|NotebookEdit', hooks: [wall('block-upstream-edit')] },
      ],
      SessionStart: [{ matcher: 'startup|resume', hooks: [wall('session-guard')] }],
    },
  };
}

/**
 * A repo the guard should be happy with: the settings above, and every bundle
 * the settings names actually on disk.
 */
function goodRepo(name: string, settings: unknown = execFormSettings()): string {
  const t = scratch(name);
  mkdirSync(join(t, '.claude/dist'), { recursive: true });
  for (const n of ['block-destructive', 'block-secret-reads', 'block-upstream-edit', 'session-guard']) {
    writeFileSync(join(t, `.claude/dist/${n}.mjs`), '// bundle\n');
  }
  writeFileSync(join(t, '.claude/settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return t;
}

/** Drive the guard with GOV_ROOT at `root`, capturing everything it says. */
function run(root: string): { rc: number; io: CapturedWallIo } {
  const io = captureWallIo('{"hook_event_name":"SessionStart","source":"startup"}');
  const prev = process.env['GOV_ROOT'];
  process.env['GOV_ROOT'] = root;
  try {
    const rc = wallExitCode(() => guard(io));
    return { rc, io };
  } finally {
    if (prev === undefined) delete process.env['GOV_ROOT'];
    else process.env['GOV_ROOT'] = prev;
  }
}

/** The parsed `continue: false` object, or null when the guard said nothing. */
function verdict(io: CapturedWallIo): { continue?: boolean; stopReason?: string } | null {
  if (io.stdout === '') return null;
  return JSON.parse(io.stdout) as { continue?: boolean; stopReason?: string };
}

describe('the guard refuses only where the walls are already dead', () => {
  it('says NOTHING about a repo whose chains and bundles are all in order', () => {
    const { rc, io } = run(goodRepo('ok'));
    expect(rc).toBe(0);
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('');
  });

  it('says nothing where there is no settings.json — that repo is not a deployment', () => {
    const { rc, io } = run(scratch('bare'));
    expect(rc).toBe(0);
    expect(io.stdout).toBe('');
  });

  /**
   * THE REPO THAT BUILDS SCRUMUX MUST NEVER BE HALTED BY IT. Same judgement
   * the CLI makes (it refuses to govern a repo carrying the marker) and the
   * same one `block-upstream-edit` makes (it allows outright where there is no
   * `.claude/DEPLOYED`). A guard that stopped sessions in the harness source
   * would be the first thing anybody deleted.
   */
  it('says nothing in a repo marked .scrumux-ungoverned, however broken its settings', () => {
    const t = goodRepo('ungov', { hooks: {} });
    writeFileSync(join(t, '.scrumux-ungoverned'), 'this repo builds scrumux\n');
    const { rc, io } = run(t);
    expect(rc).toBe(0);
    expect(io.stdout).toBe('');
  });
});

describe('the refusal, when it fires', () => {
  /**
   * THE WINDOWS CASE, AND THE WHOLE REASON THIS FILE EXISTS. A repo deployed
   * before the migration matches its shell chain on `"Bash"`. On Windows
   * without Git Bash the Bash tool is not registered at all, every shell
   * command goes through the PowerShell tool, and that chain never fires:
   * four walls declared, four walls dead, nothing in the transcript.
   */
  it('refuses a repo whose shell chain names only Bash', () => {
    const s = execFormSettings() as { hooks: { PreToolUse: { matcher: string }[] } };
    s.hooks.PreToolUse[0]!.matcher = 'Bash';
    const { rc, io } = run(goodRepo('legacy-matcher', s));
    expect(rc).toBe(0);
    const v = verdict(io);
    expect(v?.continue).toBe(false);
    expect(v?.stopReason).toContain('PreToolUse:Bash|PowerShell');
    expect(v?.stopReason).toContain('harness deploy');
    // The user sees it, and so does Claude if the session runs anyway.
    expect(io.stderr).toContain('this session is REFUSED');
    expect(io.stdout).toContain('additionalContext');
  });

  it('refuses when a declared wall bundle is not on disk', () => {
    const t = goodRepo('nobundle');
    rmSync(join(t, '.claude/dist/block-destructive.mjs'));
    const v = verdict(run(t).io);
    expect(v?.continue).toBe(false);
    expect(v?.stopReason).toContain('block-destructive.mjs(missing)');
    expect(v?.stopReason).toContain('NON-BLOCKING');
  });

  it('refuses an unparseable settings.json — Claude Code loads NO hooks from one', () => {
    const t = goodRepo('badjson');
    writeFileSync(join(t, '.claude/settings.json'), '{ not json\n');
    const v = verdict(run(t).io);
    expect(v?.continue).toBe(false);
    expect(v?.stopReason).toContain('is not valid JSON');
  });

  /**
   * EXIT ZERO IS LOAD-BEARING ON EVERY ONE OF THESE. A nonzero exit with a
   * parsed object is fine for events using the standard decision model, but
   * SessionStart's own row says exit 2 is rendered as a hook-error notice and
   * the session proceeds — so the one path that actually stops the session is
   * a clean exit carrying the JSON. Asserted separately from the content so a
   * later edit cannot quietly turn a refusal back into a notice.
   */
  it('always exits 0, because a nonzero exit is what makes SessionStart output a notice', () => {
    const t = goodRepo('rc');
    rmSync(join(t, '.claude/dist/block-destructive.mjs'));
    expect(run(t).rc).toBe(0);
  });
});

describe('shellToolHere', () => {
  it('names PowerShell on win32 and Bash elsewhere', () => {
    expect(shellToolHere('win32')).toBe('PowerShell');
    expect(shellToolHere('darwin')).toBe('Bash');
    expect(shellToolHere('linux')).toBe('Bash');
  });
});
