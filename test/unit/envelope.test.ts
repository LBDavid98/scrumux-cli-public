import { describe, it, expect } from 'vitest';
import { Cli } from '../../src/cli/envelope.js';

function cli(json = true): Cli {
  return new Cli('probe verb', ['x'], json);
}

describe('the exit rule lives in one place', () => {
  it('only a fail row moves the verdict', () => {
    const c = cli();
    c.pass('a', 'held');
    c.warn('b', 'advisory');
    c.tell('c', 'advisory naming a fix');
    c.note('d', 'informational');
    const e = c.build('s');
    // PHILOSOPHY P-01: advisories never move the exit code. This is the
    // single most likely place for a port to silently tighten.
    expect(e.ok).toBe(true);
    expect(e.exit).toBe(0);
    expect(e.checks).toHaveLength(4);
  });

  it('a fail row makes the run fail', () => {
    const c = cli();
    c.pass('a');
    c.fail('b', 'did not hold');
    const e = c.build('s');
    expect(e.ok).toBe(false);
    expect(e.exit).toBe(1);
  });

  it('row.ok is (tier !== fail), so the old shape still reads', () => {
    const c = cli();
    c.warn('w');
    c.fail('f');
    const e = c.build('s');
    expect(e.checks[0]!.ok).toBe(true);
    expect(e.checks[1]!.ok).toBe(false);
  });

  it('ok always equals "no fail rows"', () => {
    const c = cli();
    c.tell('t');
    c.note('n');
    const e = c.build('s');
    expect(e.ok).toBe(e.checks.filter((r) => r.tier === 'fail').length === 0);
  });

  it('carries the envelope invariants', () => {
    const c = cli();
    const e = c.build('summary here');
    expect(e.schema).toBe('scrumux.cli/1');
    expect(e.command).toBe('probe verb');
    expect(e.argv).toEqual(['x']);
    expect(e.summary).toBe('summary here');
    expect(e.data).toEqual({});
  });

  it('every tier is in the published vocabulary', () => {
    const c = cli();
    c.pass('a'); c.fail('b'); c.warn('c'); c.tell('d'); c.note('e');
    for (const r of c.build('s').checks) {
      expect(['pass', 'fail', 'warn', 'tell', 'note']).toContain(r.tier);
    }
  });
});
