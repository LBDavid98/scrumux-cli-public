/**
 * D-S020 — an already-instrumented repo is upgraded IN PLACE by `harness
 * deploy` over its existing deployment: project-owned settings, walls and
 * journals survive byte for byte, and the new seeds are added.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, harness, tempRepo } from './harness-real-deploy.helper.js';

const NO_CFG = { SCRUMUX_CLAUDE_CONFIG: '/nonexistent/claude.json' };

describe('D-S020: harness deploy over an existing deployment', () => {
  it('keeps project-owned allow entries, project-walls.conf and journals, and adds the seeds', () => {
    const t = tempRepo('redeploy');
    writeFileSync(join(t, 'package.json'), '{"name":"x"}\n');
    expect(harness('deploy', t, NO_CFG).rc).toBe(0);

    // The shape of an older deployment carrying the project's own additions:
    // an allow-list without the seeds, its own entries, its own wall rule,
    // and real journal records.
    const sp = join(t, '.claude/settings.json');
    const doc = JSON.parse(readFileSync(sp, 'utf8')) as { permissions: { allow: string[] } };
    const seeds = ['Edit', 'Write', 'Bash(mkdir *)', 'Bash(rm *)', 'Bash(npm *)', 'Bash(npx *)'];
    doc.permissions.allow = [
      ...doc.permissions.allow.filter((a) => !seeds.includes(a)),
      'Bash(curl *)', 'Read(//srv/x/**)',
    ];
    writeFileSync(sp, `${JSON.stringify(doc, null, 2)}\n`);
    const walls = join(t, '.claude/project-walls.conf');
    writeFileSync(walls, `${readFileSync(walls, 'utf8')}refuse flyctl deploy | production is released by CI\n`);
    const decisions = join(t, 'governance/decisions.json');
    writeFileSync(decisions, `${JSON.stringify({ entries: [{
      id: 'D-0001', date: '2026-09-13', title: 'kept', decision: 'keep it', rationale: 'a real record', ratified_by: 'User',
    }] }, null, 2)}\n`);
    commitAll(t, 'project-owned state');
    const wallsBefore = readFileSync(walls);
    const decisionsBefore = readFileSync(decisions);
    const before = doc.permissions.allow;

    const { rc, env } = harness('deploy', t, NO_CFG);
    expect(rc, JSON.stringify(env.checks.filter((c) => !c.ok))).toBe(0);
    const after = (JSON.parse(readFileSync(sp, 'utf8')) as { permissions: { allow: string[] } }).permissions.allow;
    // Project-owned entries first, in their order, untouched.
    expect(after.slice(0, before.length)).toEqual(before);
    for (const s of seeds) expect(after).toContain(s);
    expect(readFileSync(walls).equals(wallsBefore)).toBe(true);
    expect(readFileSync(decisions).equals(decisionsBefore)).toBe(true);
    expect(env.items.find((i) => i.path === '.claude/settings.json')?.status).toBe('UPDATED');

    // And the upgraded install verifies.
    commitAll(t, 'redeploy');
    const v = harness('verify', t, NO_CFG);
    expect(v.rc).toBe(0);
    expect(v.env.summary).toContain('is INSTALLED');
  }, 90_000);
});
