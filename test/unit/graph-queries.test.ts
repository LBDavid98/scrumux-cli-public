/**
 * The graph queries, unit-tested where the differential cannot aim.
 *
 * PARITY IS THE GATE, NOT THIS FILE. `npm run diff` runs both implementations
 * over the same tree and compares stdout, stderr, the exit code and the whole
 * post-state, which is a stronger statement than any assertion here. These
 * tests exist for the two places that statement is weak:
 *
 *   - `bearing`'s TRAVERSAL, which is the hairiest query in the noun. Its
 *     answer is a set reached through two hops with a precedence rule on top,
 *     and a differential case proves only that both sides produced the same
 *     set — including if both produced the wrong one, which is exactly the
 *     failure mode a port shares with its original when the port was written
 *     by reading it. So the shapes it must and must not reach are asserted
 *     against the RULING, not against bash.
 *
 *   - the pure helpers underneath, where the input that would exercise them
 *     is awkward to build as a repo: Python's `PurePath.suffix`, the shebang
 *     probe, and the first-word `expected_diff` match.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bearing, build, diffIsChange, impact, orderPaths, orphans, provenance,
} from '../../src/nouns/graph/gov-graph.js';
import {
  languageOf, neighbourhood, pySuffix, symbolsIn, findSymbol, callersOf, calleesOf,
} from '../../src/nouns/graph/code-index.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'scrumux-graph-test-'));
}

/** One tree: the shapes the traversal branches on, and nothing else. */
function fixture(): string {
  const root = scratch();
  mkdirSync(join(root, 'governance'), { recursive: true });
  const w = (name: string, doc: unknown): void =>
    writeFileSync(join(root, 'governance', name), JSON.stringify(doc, null, 2) + '\n');
  w('tasks.json', {
    entries: [
      {
        id: 'T-0001', title: 'the edit', refs: { issue: 'I-0001' },
        task_order: {
          context: {
            files: [
              { path: 'src/alpha.sh', expected_diff: 'two lines added, the guard branch untouched' },
              { path: 'src/beta.sh', expected_diff: 'none — pattern reference only' },
              { path: 'T-0009' },
            ],
            expected_artifacts: ['src/gamma.sh'],
          },
        },
      },
      {
        id: 'T-0002', title: 'the read', refs: { task: 'T-0001' },
        task_order: { context: { files: [{ path: 'src/alpha.sh', expected_diff: 'unchanged' }] } },
      },
      { id: 'T-0003', title: 'a dangling ref', refs: { issue: 'I-9999' } },
    ],
  });
  w('decisions.json', {
    entries: [
      { id: 'D-0001', title: 'binds alpha', refs: { task: 'T-0001' } },
      { id: 'D-0002', title: 'reached through the read', refs: { task: 'T-0002' } },
    ],
  });
  w('issues.json', {
    entries: [
      { id: 'I-0001', status: 'open', summary: 'produced T-0001' },
      { id: 'I-0002', status: 'resolved', summary: 'reached only through the relay hop' },
      { id: 'I-0003', status: 'open', summary: 'homed outward', refs: { task: 'T-0003' } },
      { id: 'I-0004', status: 'open', summary: 'nobody owns this one' },
    ],
  });
  w('reviews.json', { entries: [{ id: 'R-0001', task: 'T-0001', refs: { issue: 'I-0002' } }] });
  w('log.json', { entries: [{ id: 'L-0001', title: 'a log entry' }] });
  w('sprints.json', { entries: [{ id: 'SP-0001', tasks: ['T-0001'] }] });
  w('design.json', { entries: [{ kind: 'story', id: 'S-0001', narrative: 'a story' }] });
  return root;
}

describe('the governance builder', () => {
  it('makes a NODE of every order path and types the edge from the field it came from', () => {
    const root = fixture();
    const g = build(root);
    const nodes = g['nodes'] as Record<string, { kind: string }>;
    expect(nodes['src/alpha.sh']!.kind).toBe('file');
    const edges = g['edges'] as Array<{ from: string; to: string; kind: string }>;
    const alpha = edges.filter((e) => e.to === 'src/alpha.sh');
    // T-0001 EDITS it, T-0002 only reads it. The distinction is DERIVED from
    // expected_diff, never declared -- task.schema.json sets
    // additionalProperties:false on the order's context, so no flag could be
    // added without invalidating every order already written (I-0064).
    expect(alpha).toEqual([
      { from: 'T-0001', to: 'src/alpha.sh', kind: 'changes' },
      { from: 'T-0002', to: 'src/alpha.sh', kind: 'reads' },
    ]);
    // expected_artifacts is a file the task will CREATE, so it is changed by
    // definition and appears in no reading list.
    expect(edges).toContainEqual({ from: 'T-0001', to: 'src/gamma.sh', kind: 'changes' });
    rmSync(root, { recursive: true });
  });

  it('SKIPS a context path that looks like a record id rather than colliding it', () => {
    const root = fixture();
    const g = build(root);
    const nodes = g['nodes'] as Record<string, unknown>;
    // T-0009 is not a record here, and it must not become a FILE node either:
    // loosening the id guard to let paths through would let typos through too.
    expect(Object.prototype.hasOwnProperty.call(nodes, 'T-0009')).toBe(false);
    rmSync(root, { recursive: true });
  });

  it('records a ref to a record that is gone as DANGLING rather than dropping it', () => {
    const root = fixture();
    const g = build(root);
    expect(g['dangling']).toEqual([{ from: 'T-0003', to: 'I-9999', kind: 'refs_issue' }]);
    rmSync(root, { recursive: true });
  });
});

describe('expected_diff, matched on the FIRST WORD only', () => {
  it('reads the "not editing this" phrasings, gloss and all', () => {
    for (const s of ['none', 'none — pattern reference only', 'unchanged',
      'unchanged, assert its exit code in the suite', 'read-only reference',
      'No change.', 'n/a', 'nil', 'expected none', '', '   ', '—']) {
      expect(diffIsChange(s), s).toBe(false);
    }
  });

  it('does NOT scan the whole string for a negation', () => {
    // "two lines removed, the guard branch untouched" and "verify_pack
    // untouched" are real EDITS. A whole-string scan trades two quiet false
    // positives for a class of false NEGATIVES, and a missed change is the
    // failure this exists to close.
    for (const s of ['two lines removed, the guard branch untouched',
      'verify_pack untouched', 'a rewrite', 'source of a rule name; not edited']) {
      expect(diffIsChange(s), s).toBe(true);
    }
  });

  it('treats an ABSENT expected_diff as a read', () => {
    // `task order --file "path | why"` makes the third pipe field optional,
    // so most reading-list entries carry none at all.
    expect(diffIsChange(undefined)).toBe(false);
    expect(diffIsChange(null)).toBe(false);
    expect(orderPaths({ task_order: { context: { files: [{ path: 'x' }] } } }).get('x')).toBe('reads');
  });
});

describe('bearing — the traversal', () => {
  it('walks one hop further through a REVIEW, which is where most rulings sit', () => {
    const root = fixture();
    const g = build(root);
    const b = bearing(g, ['src/alpha.sh'], null);
    const ids = b.records.map((r) => r.id).sort();
    // D-0001 points AT T-0001 (one hop). I-0001 is pointed at BY it (one hop,
    // the other direction). I-0002 is reached only through R-0001, which is
    // the relay: the ruling that binds a file is usually recorded on the
    // review of the task that last touched it, not on the task row.
    expect(ids).toEqual(['D-0001', 'D-0002', 'I-0001', 'I-0002']);
    rmSync(root, { recursive: true });
  });

  it('returns DECISIONS and ISSUES only — stories and sprints are not law', () => {
    const root = fixture();
    const g = build(root);
    const kinds = new Set(bearing(g, ['src/alpha.sh'], null).records.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['decision', 'issue']);
    rmSync(root, { recursive: true });
  });

  it('lets a record reached through a CHANGE outrank the same record reached through a read', () => {
    const root = fixture();
    const g = build(root);
    const b = bearing(g, ['src/alpha.sh'], null);
    // Unscoped, each record's relation is the edge kind it was reached
    // through. D-0001 hangs off T-0001, which CHANGES alpha; D-0002 hangs off
    // T-0002, which only reads it.
    expect(b.records.find((r) => r.id === 'D-0001')!.relation).toBe('changes');
    expect(b.records.find((r) => r.id === 'D-0002')!.relation).toBe('reads');
    rmSync(root, { recursive: true });
  });

  it('scoped to a task, drops that task as a SOURCE and reads the relation from ITS order', () => {
    const root = fixture();
    const g = build(root);
    // I-0070, reintroduced, is what this prevents: T-0001 edits alpha, so
    // without the scoping rule the path would read as `changes` for T-0002's
    // order, which lists it read-only.
    const b = bearing(g, ['src/alpha.sh'], 'T-0002');
    expect(b.paths[0]!.relation).toBe('reads');
    // T-0002's own refs are what a caller is checking, so returning them
    // would make the check vacuous: D-0002 hangs off T-0002 and is absent.
    expect(b.records.map((r) => r.id)).not.toContain('D-0002');
    expect(b.records.map((r) => r.id)).toContain('D-0001');
    rmSync(root, { recursive: true });
  });

  it('says ABSENT for a path no order has ever named', () => {
    const root = fixture();
    const g = build(root);
    const b = bearing(g, ['src/nowhere.sh'], null);
    // Not "no decisions bear on this file", which is a different and false
    // claim: nothing is KNOWN about it.
    expect(b.paths[0]).toEqual({ path: 'src/nowhere.sh', relation: 'absent', tasks: [] });
    expect(b.total).toBe(0);
    rmSync(root, { recursive: true });
  });

  it('reports a read-only path as `reads`', () => {
    const root = fixture();
    const g = build(root);
    expect(bearing(g, ['src/beta.sh'], null).paths[0]!.relation).toBe('reads');
    rmSync(root, { recursive: true });
  });
});

describe('the other gov queries', () => {
  it('impact does not walk THROUGH a file node', () => {
    const root = fixture();
    const g = build(root);
    // Every task touches some shared path; one hop out to a file and one back
    // in would reach nearly the whole backlog, which is the
    // technically-complete-and-useless answer this was cut back from.
    const r = impact(g, 'T-0001', 2);
    expect(Object.keys(r.reached)).not.toContain('file');
    rmSync(root, { recursive: true });
  });

  it('impact names an unknown id as an error inside the result, not an exception', () => {
    const root = fixture();
    expect(impact(build(root), 'T-9999', 2).error).toBe('unknown record id');
    rmSync(root, { recursive: true });
  });

  it('orphans excludes authored roots and keeps an issue that is owned OUTWARD', () => {
    const root = fixture();
    const o = orphans(build(root), null);
    const byKind = Object.fromEntries(o.orphans);
    // Reviews, decisions, log entries and sprints are roots: nothing is
    // supposed to point at them, so listing them is noise, not signal.
    expect(Object.keys(byKind).sort()).toEqual(['issue', 'story']);
    // Every task IS pointed at here -- by a sprint, a decision or an issue --
    // which is the state the query exists to distinguish from the one below.
    expect(byKind['story']).toEqual(['S-0001']);
    // I-0003 names a task, so ownership flows outward and it is not an orphan.
    expect(byKind['issue']).toEqual(['I-0004']);
    rmSync(root, { recursive: true });
  });

  it('provenance walks BOTH directions', () => {
    const root = fixture();
    const p = provenance(build(root), 'T-0001');
    // D-0001 points at T-0001 and I-0001 is pointed at by it; the referencing
    // direction carries most of this repo's rulings.
    expect(p['decisions']).toEqual(['D-0001']);
    expect(p['issues']).toEqual(['I-0001']);
    // Files are bucketed but deliberately never PRINTED by the CLI.
    expect(p['files']).toContain('src/alpha.sh');
    rmSync(root, { recursive: true });
  });
});

describe('the code-index helpers', () => {
  it('reproduces PurePath.suffix, which is not "the text after the last dot"', () => {
    expect(pySuffix('code_graph.py')).toBe('.py');
    expect(pySuffix('archive.tar.gz')).toBe('.gz');
    // A leading dot is not a suffix, which is why a dotfile takes the shebang
    // path instead of being called a `gitignore` file.
    expect(pySuffix('.gitignore')).toBe('');
    expect(pySuffix('scrumux')).toBe('');
    expect(pySuffix('trailing.')).toBe('');
  });

  it('names an extensionless file by its shebang, and an unknown one not at all', () => {
    const root = scratch();
    const w = (name: string, body: string): string => {
      const p = join(root, name);
      writeFileSync(p, body);
      return p;
    };
    expect(languageOf(w('scrumux', '#!/bin/sh\ncase x in\n'))).toBe('bash');
    expect(languageOf(w('runner', '#!/usr/bin/env bash\n'))).toBe('bash');
    expect(languageOf(w('tool', '#!/usr/bin/env python3\n'))).toBe('python');
    expect(languageOf(w('cli', '#!/usr/bin/env node\n'))).toBe('javascript');
    expect(languageOf(w('README', 'not a script at all\n'))).toBe(null);
    // Naming is independent of whether a grammar is INSTALLED: that is what
    // lets the index report "2 php files, no grammar loaded" instead of
    // dropping them without trace.
    expect(languageOf(join(root, 'x.php'))).toBe('php');
    expect(languageOf(join(root, 'x.md'))).toBe(null);

    // AN EXTENSIONLESS FILE UNDER A DOTTED ANCESTOR is the shape that broke on
    // win32, and it is the shape the harness installs into every governed repo
    // -- `.claude/scripts/scrumux` and `.claude/scripts/readonly-sh`. The name
    // has to be cut at the last SEPARATOR; cut anywhere else and `pySuffix`
    // reaches the dot in `.claude`, returns a non-empty suffix that is in no
    // registry, and the shebang probe -- the only thing that can classify an
    // extensionless file -- never runs. `walkTree` joins with the HOST
    // separator, so on Windows this was every such file in the tree.
    mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
    writeFileSync(join(root, '.claude/scripts/scrumux'), '#!/bin/sh\nexit 0\n');
    expect(languageOf(join(root, '.claude/scripts/scrumux'))).toBe('bash');
    // …and a POSIX filename that CONTAINS a backslash keeps it: the backslash
    // is part of the name here, not a separator, which is why the cut is
    // `basename` (separator-aware per platform) and not a blanket
    // `replaceAll('\\', '/')`.
    //
    // POSIX-ONLY BY CONSTRUCTION, and not a partition miss. On win32 `\` IS a
    // separator, so there is no such filename to create -- `join()` renders it
    // as a `we` directory that does not exist and the write fails with ENOENT
    // before anything is asserted. The case exists to prove `basename` reads
    // the HOST's separator rather than a hardcoded one, so the platform where
    // the backslash is not a separator is the only one that can state it.
    if (process.platform !== 'win32') {
      writeFileSync(join(root, 'we\\ird'), '#!/usr/bin/env python3\n');
      expect(languageOf(join(root, 'we\\ird'))).toBe('python');
    }
    rmSync(root, { recursive: true });
  });

  it('answers the four symbol queries off a loaded index', () => {
    const g = {
      files: ['a.sh', 'b.sh'],
      symbols: {
        'a.sh::one': { file: 'a.sh', name: 'one', lang: 'bash' },
        'a.sh::two': { file: 'a.sh', name: 'two', lang: 'bash' },
        'b.sh::one': { file: 'b.sh', name: 'one', lang: 'bash' },
      },
      edges: [
        { from: 'b.sh::one', to: 'a.sh::one', kind: 'calls' },
        { from: 'a.sh::two', to: 'a.sh::one', kind: 'calls' },
      ],
    };
    expect(symbolsIn(g, 'a.sh')).toEqual(['a.sh::one', 'a.sh::two']);
    expect(findSymbol(g, 'one')).toEqual(['a.sh::one', 'b.sh::one']);
    expect(callersOf(g, 'a.sh::one')).toEqual(['a.sh::two', 'b.sh::one']);
    expect(calleesOf(g, 'b.sh::one')).toEqual(['a.sh::one']);
    // The neighbourhood's file set is the union of two derivations: the files
    // its symbols are defined in, and any FILE id the walk itself reached.
    expect(neighbourhood(g, 'a.sh::one', 1)).toEqual({
      symbols: ['a.sh::one', 'a.sh::two', 'b.sh::one'],
      files: ['a.sh', 'b.sh'],
    });
    // depth 0 reaches nothing beyond the target
    expect(neighbourhood(g, 'a.sh::one', 0).symbols).toEqual(['a.sh::one']);
  });
});
