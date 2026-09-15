/**
 * SX-008 (CLI half), D-S019 — `harness deploy` seeds what a dispatched
 * headless session needs to work, and deploy/verify REPORT (never refuse)
 * whether Claude Code will honour the allow-list at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeConfig, commitAll, harness, rowOf, tempRepo } from './harness-real-deploy.helper.js';
import { detectedToolSeeds, missingWriteTools, unionAllow } from '../../src/nouns/harness/permissions.js';
import { claudeConfigPath, trustOf, trustRoot } from '../../src/nouns/harness/trust.js';
import { Cli } from '../../src/cli/envelope.js';
import { captureIo } from '../../src/cli/exit.js';

const allowIn = (t: string): string[] =>
  (JSON.parse(readFileSync(join(t, '.claude/settings.json'), 'utf8')) as { permissions: { allow: string[] } }).permissions.allow;

describe('SX-008: deploy seeds the allow-list', () => {
  it('a fresh deploy allows Edit, Write, mkdir, rm, and the build tools its manifests name', () => {
    const t = tempRepo('seed');
    writeFileSync(join(t, 'package.json'), '{"name":"x"}\n');
    writeFileSync(join(t, 'pyproject.toml'), '[project]\nname="x"\n');
    const cfg = claudeConfig(mkdtempSync(join(tmpdir(), 'sx008cfg-')), t, true);
    const { env, rc } = harness('deploy', t, { SCRUMUX_CLAUDE_CONFIG: cfg });
    expect(rc).toBe(0);
    const allow = allowIn(t);
    for (const r of ['Edit', 'Write', 'Bash(mkdir *)', 'Bash(rm *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(uv *)']) {
      expect(allow).toContain(r);
    }
    const seeded = env.items.filter((i) => i.status === 'SEEDED').map((i) => i.detail);
    expect(seeded.some((d) => d.includes('Bash(npm *) Bash(npx *) for package.json'))).toBe(true);
    expect(seeded.some((d) => d.includes('Bash(uv *) for pyproject.toml'))).toBe(true);
  }, 60_000);

  it('a repo with no manifests gets no build tools, and the settings stay the canon file byte for byte', () => {
    const t = tempRepo('nomanifest');
    const { rc } = harness('deploy', t, { SCRUMUX_CLAUDE_CONFIG: '/nonexistent/claude.json' });
    expect(rc).toBe(0);
    expect(allowIn(t)).not.toContain('Bash(npm *)');
    expect(readFileSync(join(t, '.claude/settings.json'), 'utf8'))
      .toBe(readFileSync(join(__dirname, '../../.deploy-claude/settings.json'), 'utf8'));
  }, 60_000);

  it('unionAllow keeps project-owned entries first and never duplicates', () => {
    const d = mkdtempSync(join(tmpdir(), 'sx008u-'));
    const p = join(d, 'settings.json');
    writeFileSync(p, JSON.stringify({ permissions: { allow: ['Bash(curl *)', 'Edit'] }, env: { A: 1 } }));
    const cli = new Cli('t', [], false, captureIo());
    expect(unionAllow(cli, p, ['Edit', 'Write', 'Write'])).toBe(1);
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { permissions: { allow: string[] }; env: unknown };
    expect(doc.permissions.allow).toEqual(['Bash(curl *)', 'Edit', 'Write']);
    expect(doc.env).toEqual({ A: 1 });
    expect(unionAllow(cli, p, ['Edit'])).toBe(0);
  });

  it('detectedToolSeeds reads only manifests at the root and names uv once', () => {
    const d = mkdtempSync(join(tmpdir(), 'sx008m-'));
    writeFileSync(join(d, 'pyproject.toml'), '');
    writeFileSync(join(d, 'uv.lock'), '');
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub/package.json'), '{}');
    expect(detectedToolSeeds(d)).toEqual([{ manifest: 'pyproject.toml', rules: ['Bash(uv *)'] }]);
  });
});

describe('SX-008: the trust report is passive, and unknown is not bad', () => {
  it('untrusted is a WARN naming the fix; the exit code and N/N do not move; nothing else from the config is printed', () => {
    const t = tempRepo('untrusted');
    harness('deploy', t, { SCRUMUX_CLAUDE_CONFIG: '/nonexistent/claude.json' });
    commitAll(t, 'deploy');
    const cfg = claudeConfig(mkdtempSync(join(tmpdir(), 'sx008cfg-')), t, false);
    const { env, rc, raw } = harness('verify', t, { SCRUMUX_CLAUDE_CONFIG: cfg });
    expect(rc).toBe(0);
    const r = rowOf(env, 'session-trust');
    expect(r.tier).toBe('warn');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('NOT trusted');
    expect(r.detail).toContain('Trust this repo');
    expect(env.summary).toMatch(/(\d+)\/\1 checks pass/);
    expect(raw).not.toContain('do-not-print');
    expect(raw).not.toContain('never printed');
  }, 60_000);

  it('trusted is a note; a missing config is a note that says unknown', () => {
    const t = tempRepo('trusted');
    const cfg = claudeConfig(mkdtempSync(join(tmpdir(), 'sx008cfg-')), t, true);
    expect(trustOf(t, { SCRUMUX_CLAUDE_CONFIG: cfg }).state).toBe('trusted');
    const unknown = trustOf(t, { SCRUMUX_CLAUDE_CONFIG: '/nonexistent/claude.json' });
    expect(unknown.state).toBe('unknown');
    expect(unknown.detail).toContain('unknown, not a failure');
    expect(trustOf(t, {}).state).toBe('unknown');       // no HOME, no override
    expect(claudeConfigPath({ HOME: '/h' })).toBe('/h/.claude.json');
  });

  it('a worktree resolves trust on the MAIN repo root', () => {
    const t = tempRepo('wt');
    commitAll(t, 'root');
    const wt = `${t}--wt`;
    execFileSync('git', ['-C', t, 'worktree', 'add', '-q', '-b', 'w', wt]);
    expect(trustRoot(wt)).toBe(t);
    const cfg = claudeConfig(mkdtempSync(join(tmpdir(), 'sx008cfg-')), t, true);
    expect(trustOf(wt, { SCRUMUX_CLAUDE_CONFIG: cfg }).state).toBe('trusted');
  });

  it('verify WARNs when the allow-list has no Edit or Write, and still passes', () => {
    const t = tempRepo('nowrite');
    harness('deploy', t, { SCRUMUX_CLAUDE_CONFIG: '/nonexistent/claude.json' });
    const p = join(t, '.claude/settings.json');
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { permissions: { allow: string[] } };
    doc.permissions.allow = doc.permissions.allow.filter((a) => a !== 'Edit' && a !== 'Write');
    writeFileSync(p, JSON.stringify(doc, null, 2));
    expect(missingWriteTools(p)).toEqual(['Edit', 'Write']);
    commitAll(t, 'deploy');
    const { env, rc } = harness('verify', t, { SCRUMUX_CLAUDE_CONFIG: '/nonexistent/claude.json' });
    expect(rc).toBe(0);
    const r = rowOf(env, 'session-write-tools');
    expect(r.tier).toBe('warn');
    expect(r.detail).toContain('"Edit" and "Write"');
  }, 60_000);
});
