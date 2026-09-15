import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readJournal, journalUnreadable } from '../../src/journal/read.js';

function sandbox(): string {
  return mkdtempSync(resolve(tmpdir(), 'scrumux-read-'));
}

describe('readJournal is TRI-state, and collapsing two of them is the bug', () => {
  it('ABSENT yields the default and is NOT an error', () => {
    const d = sandbox();
    try {
      const r = readJournal(resolve(d, 'nope.json'));
      expect(r.kind).toBe('absent');
      // A fresh repo is in this state. Making it an error is the two-state
      // collapse PHILOSOPHY P-16 forbids.
      if (r.kind === 'absent') expect(r.value).toEqual({ entries: [] });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('PRESENT and parseable yields the value', () => {
    const d = sandbox();
    try {
      const p = resolve(d, 'j.json');
      writeFileSync(p, '{"entries":[{"id":"T-0001"}]}');
      const r = readJournal(p);
      expect(r.kind).toBe('ok');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('PRESENT and unparseable is UNREADABLE, distinct from absent', () => {
    const d = sandbox();
    try {
      const p = resolve(d, 'j.json');
      writeFileSync(p, 'NOT JSON AT ALL');
      const r = readJournal(p);
      expect(r.kind).toBe('unreadable');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('never throws — each caller disposes of the fact differently', () => {
    const d = sandbox();
    try {
      const p = resolve(d, 'j.json');
      writeFileSync(p, '{oops');
      expect(() => readJournal(p)).not.toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('has ONE wording for the refusal, naming the file and the repair', () => {
    const m = journalUnreadable('/x/governance/tasks.json');
    expect(m).toContain('tasks.json is not valid JSON');
    expect(m).toContain('—');
    expect(m).toContain('scrumux repair journal tasks.json');
  });
});
