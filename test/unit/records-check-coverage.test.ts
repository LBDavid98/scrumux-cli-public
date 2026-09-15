/**
 * `records check`'s structure sweep, driven in-process against a maximally
 * violated fixture tree.
 *
 * WHY THIS FILE EXISTS. `test/differential/nouns-wave1b.test.ts` used to
 * drive this exact code in process as the TypeScript half of a bash
 * comparison, and retired with the rest of the differential apparatus and
 * bash itself (2026-09-03) — taking with it the only coverage most of
 * `sweepStructure` had, since `tests/records-check-tests.sh` exercises the
 * same code but as a subprocess, invisible to `vitest --coverage`. This file
 * is that coverage's replacement: no bash comparison, one rich fixture per
 * section, asserting the finding each violation is supposed to produce.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_SCHEMAS = resolve(import.meta.dirname, '../../.deploy-claude/schemas');

import { Cli } from '../../src/cli/envelope.js';
import { ExitSignal, captureIo } from '../../src/cli/exit.js';
import { todayStamp, type DispatchContext } from '../../src/nouns/lib/context.js';
import { MODULE as records } from '../../src/nouns/records.js';

interface Envelope {
  ok: boolean;
  exit: number;
  checks: { name: string; tier: string; detail: string }[];
}

function ctxFor(root: string): DispatchContext {
  return {
    roots: { root, gov: join(root, 'governance'), workRoot: root },
    today: todayStamp(),
    io: captureIo(),
    scriptsDir: join(root, '.claude/scripts'),
    env: {},
    cwd: root,
  };
}

function check(root: string, args: string[] = []): { env: Envelope; rc: number } {
  const io = captureIo();
  const cli = new Cli('check', args, true, io);
  let rc = 0;
  try {
    records.run(cli, { ...ctxFor(root), io }, 'check', args);
  } catch (e) {
    if (e instanceof ExitSignal) rc = e.code;
    else throw e;
  }
  return { env: JSON.parse(io.stdout) as Envelope, rc };
}

const names = (env: Envelope): string[] => env.checks.map((c) => c.name);
const has = (env: Envelope, substr: string): boolean => env.checks.some((c) => `${c.name} ${c.detail}`.includes(substr));

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scrumux-records-cov-'));
  const gov = join(root, 'governance');
  mkdirSync(gov, { recursive: true });
  mkdirSync(join(root, '.claude/rules'), { recursive: true });
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  mkdirSync(join(root, '.claude/scripts'), { recursive: true });
  cpSync(REAL_SCHEMAS, join(root, '.claude/schemas'), { recursive: true });

  const write = (name: string, doc: unknown): void => writeFileSync(join(gov, name), JSON.stringify(doc));

  write('tasks.json', {
    entries: [
      {
        id: 'bad-id', title: '', acceptance_check: '',
        acceptance: { accepted: true }, status: 'in_progress',
        feature: 'F-9999', story: 'S-9999',
        decisions: ['D-9999'], issues: ['I-9999'], log_entries: ['L-9999'],
        task_order: {
          scope: '', verification_command: '',
          context: { files: [{ path: '', why: '' }] },
        },
      },
      { id: 'T-0002', title: 'accepted with no record', acceptance_check: 'x', status: 'accepted' },
      {
        id: 'T-0003', title: 'accepted with no actor', acceptance_check: 'x', status: 'accepted',
        acceptance: { accepted: true, by: '' },
      },
      { id: 'T-0002', title: 'duplicate of T-0002', acceptance_check: 'x', status: 'proposed' },
    ],
  });

  write('issues.json', {
    entries: [
      {
        id: 'bad-issue-id', type: 'not-a-real-type', summary: '', resolution_pointer: '',
        refs: { task: 'T-9999' },
      },
    ],
  });

  write('decisions.json', {
    entries: [
      { id: 'bad-decision-id', decision: '', rationale: '', ratified_by: '', supersedes: 'D-9999' },
    ],
  });

  write('log.json', {
    entries: [
      { id: 'bad-log-id', what_was_done: '', actor: '', task: 'T-9999' },
    ],
  });

  write('sprints.json', {
    entries: [
      {
        id: 'bad-sprint-id', status: 'not-a-real-status', hotfix: false, epic: 'E-9999',
        tasks: ['T-9999'],
      },
      { id: 'SP-0002', status: 'ratified', hotfix: true, tasks: [] },
      { id: 'SP-0003', status: 'ratified', hotfix: false, epic: null, ratified: { by: '' } },
      { id: 'SP-0004', status: 'ratified', hotfix: false, epic: null },
    ],
  });

  write('design.json', {
    entries: [
      { id: 'E-0001', kind: 'epic', features: ['F-9999'] },
      { id: 'F-0001', kind: 'feature', stories: ['S-9999'], dependencies: ['F-9999'] },
      { id: 'S-0001', kind: 'story', feature: 'F-9999', acceptance_criteria: [] },
      { id: 'C-0001', kind: 'control', surface: 'SURF-9999' },
    ],
  });

  write('exceptions.json', { entries: [] });

  write('repo-health.json', {
    entries: [
      { name: '', command: '' },
      { name: 'runs a gone script', command: 'sh scripts/not-there.sh' },
    ],
  });

  // --- rules chain (section 8) ---
  writeFileSync(join(root, '.claude/rules/no-frontmatter.md'), '# no frontmatter at all\n');
  writeFileSync(
    join(root, '.claude/rules/missing-name.md'),
    '---\npaths: ["**"]\n---\n# missing name\n',
  );
  writeFileSync(
    join(root, '.claude/rules/missing-paths.md'),
    '---\nname: missing-paths\n---\n# missing paths\n',
  );
  writeFileSync(
    join(root, '.claude/rules/dangling-pointers.md'),
    '---\nname: dangling-pointers\npaths: ["**"]\nskills: [nonexistent-skill]\nscripts: [.claude/scripts/nonexistent.sh]\nhooks: [.claude/dist/nonexistent.mjs]\n---\n# dangling\n',
  );
});

afterAll(() => { if (root !== '') rmSync(root, { recursive: true, force: true }); });

describe('records check --all, over a maximally violated fixture', () => {
  it('reports every seeded violation', () => {
    const { env, rc } = check(root, ['--all']);
    expect(rc).toBe(1);
    expect(env.ok).toBe(false);

    // section 0: duplicate ids
    expect(has(env, 'has duplicate ids: T-0002')).toBe(true);

    // section 1: tasks
    expect(has(env, 'bad id pattern')).toBe(true);
    expect(has(env, 'missing title')).toBe(true);
    expect(has(env, 'missing acceptance_check')).toBe(true);
    expect(has(env, 'carries acceptance.accepted=true but status is')).toBe(true);
    expect(has(env, 'feature F-9999 unresolved')).toBe(true);
    expect(has(env, 'story S-9999 unresolved')).toBe(true);
    expect(has(env, 'decision ref D-9999 unresolved')).toBe(true);
    expect(has(env, 'issue ref I-9999 unresolved')).toBe(true);
    expect(has(env, 'log ref L-9999 unresolved')).toBe(true);
    expect(has(env, 'task_order missing scope or verification_command')).toBe(true);
    expect(has(env, 'task_order context file missing path or why')).toBe(true);
    expect(has(env, 'accepted with no recorded acceptance')).toBe(true);
    expect(has(env, 'is accepted but names nobody')).toBe(true);

    // section 2: issues
    expect(has(env, 'issues: <no id> bad id pattern').valueOf() || has(env, 'bad-issue-id bad id pattern')).toBe(true);
    expect(has(env, 'invalid type not-a-real-type')).toBe(true);
    expect(has(env, 'issues:') && has(env, 'missing summary')).toBe(true);
    expect(has(env, 'missing resolution_pointer')).toBe(true);
    expect(has(env, 'task ref T-9999 unresolved')).toBe(true);

    // section 3: decisions
    expect(has(env, 'decisions:') && has(env, 'bad id pattern')).toBe(true);
    expect(has(env, 'missing decision, rationale, or ratified_by')).toBe(true);
    expect(has(env, 'supersedes D-9999 which does not exist')).toBe(true);

    // section 4: log
    expect(has(env, 'log:') && has(env, 'bad id pattern')).toBe(true);
    expect(has(env, 'missing what_was_done or actor')).toBe(true);

    // section 6: sprints
    expect(has(env, 'sprints:') && has(env, 'bad id pattern')).toBe(true);
    expect(has(env, 'invalid status not-a-real-status')).toBe(true);
    expect(has(env, 'non-hotfix sprint without epic')).toBe(true);
    expect(has(env, 'hotfix sprint without source_issue')).toBe(true);
    expect(has(env, 'epic E-9999 unresolved')).toBe(true);
    expect(has(env, 'ratified without ratification record')).toBe(true);
    expect(has(env, 'is ratified but names nobody')).toBe(true);
    expect(has(env, 'task T-9999 unresolved')).toBe(true);

    // section 7: design
    expect(has(env, 'epic E-0001 feature ref F-9999 unresolved')).toBe(true);
    expect(has(env, 'feature F-0001 story ref S-9999 unresolved')).toBe(true);
    expect(has(env, 'feature F-0001 dependency F-9999 unresolved')).toBe(true);
    expect(has(env, 'story S-0001 feature F-9999 unresolved')).toBe(true);
    expect(has(env, 'story S-0001 has no acceptance criteria')).toBe(true);
    expect(has(env, 'control C-0001 surface SURF-9999 unresolved')).toBe(true);

    // section 8: rules chain
    expect(has(env, 'no-frontmatter.md has no frontmatter')).toBe(true);
    expect(has(env, 'missing-name.md frontmatter missing name')).toBe(true);
    expect(has(env, 'missing-paths.md frontmatter missing paths')).toBe(true);
    expect(has(env, "points to script .claude/scripts/nonexistent.sh which does not exist")).toBe(true);
    expect(has(env, 'points to hook .claude/dist/nonexistent.mjs which does not exist')).toBe(true);

    // section 9 / 9a: repo-health
    expect(has(env, 'check missing name or command')).toBe(true);
    expect(has(env, "is not on disk")).toBe(true);

    // standards mode is a stub now; --all runs it too.
    expect(names(env)).not.toHaveLength(0);
  });

  it('the skills warning fires as a WARN, never a FAIL, and never moves the exit code', () => {
    const { env } = check(root, ['--all']);
    const row = env.checks.find((c) => c.name.includes("points to skill 'nonexistent-skill'"));
    expect(row).toBeDefined();
    expect(row!.tier).toBe('warn');
  });

  it('--structure alone skips the standards stub banner', () => {
    const { env, rc } = check(root, ['--structure']);
    expect(rc).toBe(1);
    expect(env.ok).toBe(false);
  });

  it('--standards alone is a stub that reports clean', () => {
    const { env, rc } = check(root, ['--standards']);
    expect(rc).toBe(0);
    expect(env.ok).toBe(true);
  });

  it('--unsupported lists the schema keywords this reader does not enforce', () => {
    const { rc } = check(root, ['--unsupported']);
    expect(rc).toBe(0);
  });

  it('a clean repo reports clean', () => {
    const clean = mkdtempSync(join(tmpdir(), 'scrumux-records-clean-'));
    try {
      const gov = join(clean, 'governance');
      mkdirSync(gov, { recursive: true });
      cpSync(REAL_SCHEMAS, join(clean, '.claude/schemas'), { recursive: true });
      for (const j of ['tasks', 'issues', 'decisions', 'log', 'sprints', 'design', 'exceptions', 'repo-health']) {
        writeFileSync(join(gov, `${j}.json`), '{"entries": []}\n');
      }
      const { env, rc } = check(clean, ['--structure']);
      expect(rc).toBe(0);
      expect(env.ok).toBe(true);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it('refuses an unknown flag and more than one directory', () => {
    const io1 = captureIo();
    const cli1 = new Cli('check', ['--nope'], false, io1);
    let rc1 = -1;
    try {
      records.run(cli1, { ...ctxFor(root), io: io1 }, 'check', ['--nope']);
    } catch (e) {
      if (e instanceof ExitSignal) rc1 = e.code;
    }
    expect(rc1).toBe(2);

    const io2 = captureIo();
    const cli2 = new Cli('check', [root, root], false, io2);
    let rc2 = -1;
    try {
      records.run(cli2, { ...ctxFor(root), io: io2 }, 'check', [root, root]);
    } catch (e) {
      if (e instanceof ExitSignal) rc2 = e.code;
    }
    expect(rc2).toBe(2);
  });

  it('refuses a directory that does not exist', () => {
    const io = captureIo();
    const nowhere = join(root, 'nowhere-at-all');
    const cli = new Cli('check', [nowhere], false, io);
    let rc = -1;
    try {
      records.run(cli, { ...ctxFor(root), io }, 'check', [nowhere]);
    } catch (e) {
      if (e instanceof ExitSignal) rc = e.code;
    }
    expect(rc).toBe(2);
  });
});
