/**
 * Wave 5I — the schema reader's semantics, in the language it now lives in.
 *
 * test/fixtures/tier2-wave5i.mjs holds the reader to `agents/lib/schema_check.py`
 * byte-for-byte through the two verbs that call it. What belongs HERE is
 * everything a byte comparison can only show as a mystery diff, plus the two
 * things the differential deliberately cannot carry:
 *
 *   - the SUBSET, keyword by keyword. Nine keywords are supported and every
 *     other one is REPORTED rather than ignored; that is the module's stated
 *     reason for existing and it is asserted directly rather than through a
 *     report that happens to mention it.
 *   - Python's VALUE MODEL and Python's FORMATTER — int vs float, bool as a
 *     subclass of int, `==` across the numeric tower, `repr()`'s quote choice,
 *     `str()` of a list — each of which is a rule a JavaScript port gets
 *     wrong silently while every schema still "passes".
 *   - CPython's `json` DIAGNOSTICS, recorded from a real interpreter (the
 *     strings below were captured from `python3 -c 'import json; json.loads(…)'`
 *     and each one names the case that produced it).
 *   - THE RULED DIVERGENCE, asserted PER SIDE. bash fails the schema sweep
 *     closed when there is no `python3` (T-0129); this side has no interpreter
 *     to lose, and the test that says so is the one below that empties PATH.
 *     The bash half of that pair lives in tests/fail-closed-tests.sh. Two
 *     assertions, one per implementation — never one case pinning both, which
 *     is what pinning them together would have cost: the migration exists
 *     because a Windows box has no python3.
 */
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  KNOWN, PAIRS, checkJournal, loadSchema, schemaDir, sweep, unsupportedKeywords,
  unsupportedReport, validate,
} from '../../src/schema/check.js';
import {
  PyFloat, PyInt, PyJsonDecodeError, pyEq, pyLoads, pyRepr, pyStr, pyTypeName,
  type PyDict, type PyValue,
} from '../../src/schema/pyjson.js';

const CHECKOUT = resolve(__dirname, '../..');
const SCHEMAS = join(CHECKOUT, '.deploy-claude/schemas');

/** A schema, written the way a schema file is: parsed by the same reader. */
const S = (text: string): PyDict => pyLoads(text) as PyDict;

/** A record, likewise — never a JS literal, because the value MODEL is under
 *  test and a JS object would smuggle in JavaScript's. */
const R = (text: string): PyValue => pyLoads(text);

/** A scratch repo with `.claude/schemas` and `governance/`. */
function repo(journals: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'w5i-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  cpSync(SCHEMAS, join(root, '.claude/schemas'), { recursive: true });
  mkdirSync(join(root, 'governance'), { recursive: true });
  for (const [name, text] of Object.entries(journals)) {
    writeFileSync(join(root, 'governance', name), text);
  }
  return root;
}

describe('the supported subset, keyword by keyword', () => {
  it('type: a single name, checked against Python\'s types', () => {
    expect(validate(R('"x"'), S('{"type": "string"}'))).toEqual([]);
    expect(validate(R('5'), S('{"type": "string"}')))
      .toEqual(['<root>: expected string, got int']);
    expect(validate(R('{}'), S('{"type": "object"}'))).toEqual([]);
    expect(validate(R('[]'), S('{"type": "array"}'))).toEqual([]);
    expect(validate(R('null'), S('{"type": "null"}'))).toEqual([]);
    expect(validate(R('true'), S('{"type": "boolean"}'))).toEqual([]);
  });

  it('type: a UNION, joined with a pipe in the finding', () => {
    const s = S('{"type": ["string", "null"]}');
    expect(validate(R('"x"'), s)).toEqual([]);
    expect(validate(R('null'), s)).toEqual([]);
    expect(validate(R('5'), s)).toEqual(['<root>: expected string|null, got int']);
  });

  it('type integer vs number: `2.0` is a FLOAT in Python and JSON says so', () => {
    expect(validate(R('2'), S('{"type": "integer"}'))).toEqual([]);
    expect(validate(R('2.0'), S('{"type": "integer"}')))
      .toEqual(['<root>: expected integer, got float']);
    expect(validate(R('2e3'), S('{"type": "integer"}')))
      .toEqual(['<root>: expected integer, got float']);
    expect(validate(R('2.0'), S('{"type": "number"}'))).toEqual([]);
  });

  it('type: a bool passes isinstance(int) and is caught by the second test', () => {
    expect(validate(R('true'), S('{"type": "integer"}')))
      .toEqual(['<root>: expected integer, got bool']);
    expect(validate(R('true'), S('{"type": "number"}')))
      .toEqual(['<root>: expected number, got bool']);
    // ...unless boolean is one of the wanted types, when it is simply right
    expect(validate(R('true'), S('{"type": ["boolean", "integer"]}'))).toEqual([]);
  });

  it('type: a mismatch RETURNS, so no child finding cascades behind it', () => {
    const s = S('{"type": "object", "required": ["a", "b"], "additionalProperties": false}');
    expect(validate(R('"not an object"'), s))
      .toEqual(['<root>: expected object, got str']);
  });

  it('required: one row per absent name, in the SCHEMA\'s order', () => {
    const s = S('{"type": "object", "required": ["c", "a", "b"]}');
    expect(validate(R('{"a": 1}'), s)).toEqual([
      '<root>: missing required \'c\'',
      '<root>: missing required \'b\'',
    ]);
    // present-and-null still counts as present: the test is `not in record`
    expect(validate(R('{"a": null, "b": 1, "c": 2}'), s)).toEqual([]);
  });

  it('additionalProperties: only `false` closes the object, and the order is the RECORD\'s', () => {
    const closed = S('{"type": "object", "additionalProperties": false, "properties": {"a": {}}}');
    expect(validate(R('{"zz": 1, "10": 2, "a": 3, "2": 4}'), closed)).toEqual([
      '<root>: unexpected property \'zz\'',
      '<root>: unexpected property \'10\'',
      '<root>: unexpected property \'2\'',
    ]);
    const open = S('{"type": "object", "properties": {"a": {}}}');
    expect(validate(R('{"zz": 1}'), open)).toEqual([]);
    // `true` is not `false`, and the Python tests identity against False
    const openish = S('{"type": "object", "additionalProperties": true, "properties": {}}');
    expect(validate(R('{"zz": 1}'), openish)).toEqual([]);
  });

  it('properties: the path is dotted, and only at depth zero is it <root>', () => {
    const s = S(`{"type": "object", "properties": {
      "outer": {"type": "object", "properties": {"inner": {"type": "string"}}}
    }}`);
    expect(validate(R('{"outer": {"inner": 5}}'), s))
      .toEqual(['outer.inner: expected string, got int']);
  });

  it('items: the path carries the INDEX, and nesting composes', () => {
    const s = S('{"type": "array", "items": {"type": "string"}}');
    expect(validate(R('["a", 5, null]'), s)).toEqual([
      '[1]: expected string, got int',
      '[2]: expected string, got NoneType',
    ]);
    const nested = S(`{"type": "object", "properties": {
      "rows": {"type": "array", "items": {"type": "object",
        "properties": {"k": {"type": "string"}}}}
    }}`);
    expect(validate(R('{"rows": [{"k": "a"}, {"k": 5}]}'), nested))
      .toEqual(['rows[1].k: expected string, got int']);
  });

  it('enum: checked LAST, unconditionally, and rendered with repr/str', () => {
    const s = S('{"type": "string", "enum": ["a", "b"]}');
    expect(validate(R('"a"'), s)).toEqual([]);
    expect(validate(R('"c"'), s)).toEqual([`<root>: 'c' not one of ['a', 'b']`]);
    // the type arm returns first, so a wrong TYPE never reaches the enum
    expect(validate(R('5'), s)).toEqual(['<root>: expected string, got int']);
    // with no type declared, the enum is still checked
    expect(validate(R('5'), S('{"enum": ["a"]}'))).toEqual([`<root>: 5 not one of ['a']`]);
  });

  it('enum: Python equality, which is wider than JavaScript\'s', () => {
    // True == 1 and 1 == 1.0 in Python, so each of these CONFORMS
    expect(validate(R('true'), S('{"enum": [1]}'))).toEqual([]);
    expect(validate(R('1'), S('{"enum": [1.0]}'))).toEqual([]);
    expect(validate(R('1.0'), S('{"enum": [1]}'))).toEqual([]);
    // and a string never equals a number, however it renders
    expect(validate(R('"1"'), S('{"enum": [1]}'))).toEqual([`<root>: '1' not one of [1]`]);
    // containers compare by value, all the way down
    expect(validate(R('{"a": [1, 2]}'), S('{"enum": [{"a": [1, 2]}]}'))).toEqual([]);
  });

  it('description, $schema and title are known and do nothing', () => {
    const s = S('{"$schema": "x", "title": "T", "description": "d", "type": "string"}');
    expect(validate(R('"ok"'), s)).toEqual([]);
    expect(unsupportedKeywords(s)).toEqual([]);
    for (const k of ['type', 'properties', 'required', 'additionalProperties',
      'enum', 'items', 'description', '$schema', 'title']) {
      expect(KNOWN.has(k)).toBe(true);
    }
    expect(KNOWN.size).toBe(9);
  });
});

describe('the unsupported keywords are REPORTED, not ignored', () => {
  it('names each one with the path it sits at', () => {
    const s = S(`{"type": "object", "pattern": "^x$", "properties": {
      "a": {"type": "string", "minLength": 1},
      "b": {"type": "array", "items": {"type": "string", "format": "date"}}
    }}`);
    expect(unsupportedKeywords(s)).toEqual([
      '<root>: unsupported keyword \'pattern\'',
      'a: unsupported keyword \'minLength\'',
      'b[]: unsupported keyword \'format\'',
    ]);
  });

  it('and the rule it names is genuinely NOT enforced', () => {
    // minLength is reported above and unenforced here: that pair IS the point.
    expect(validate(R('""'), S('{"type": "string", "minLength": 5}'))).toEqual([]);
  });

  it('over the shipped schemas: 124 keywords across 7, six distinct kinds', () => {
    const detail = unsupportedReport(CHECKOUT);
    // 82 -> 87 when F7 added issue.schema.json's validation_history block. It
    // mirrors the `validation` block beside it, minLength/pattern/format and
    // all, so the reader reports five more keywords it declares but does not
    // enforce. That report is the mechanism working, not a defect: the count
    // moves whenever a shipped schema legitimately grows.
    // 87 -> 99 on 2026-09-13 (R-016/R-017): task.schema.json's frozen
    // `acceptance.receipt` and `post_acceptance_checks` mirror the receipt's
    // properties (format/minLength/minimum), and sprint.schema.json's
    // `additions` carries a pattern and a format.
    // 99 -> 101: task.schema.json's `blocked` (SX-006) carries minLength and format.
    // 101 -> 118 on 2026-09-14 (D-S039): decision.schema.json's and
    // exception.schema.json's standing fields (authority, recorded_by, the
    // ratify/reject/acknowledge actor and date fields) carry minLength and format.
    // 118 -> 124 (SX-034, SX-036): task.schema.json's `receipt_history` items
    // mirror the receipt's format/minimum/minLength, and `issue` carries a pattern.
    expect(detail).toHaveLength(124);
    expect(detail[0]).toBe("task.schema.json: id: unsupported keyword 'pattern'");
    const kinds = new Set(detail.map((l) => l.replace(/^.*'([^']*)'$/, '$1')));
    expect([...kinds].sort()).toEqual(
      ['default', 'format', 'minItems', 'minLength', 'minimum', 'pattern'],
    );
  });
});

describe('Python\'s value model and Python\'s formatter', () => {
  it('json.loads types: int, float, str, bool, NoneType, list, dict', () => {
    expect(pyTypeName(pyLoads('1'))).toBe('int');
    expect(pyTypeName(pyLoads('1.0'))).toBe('float');
    expect(pyTypeName(pyLoads('1e2'))).toBe('float');
    expect(pyTypeName(pyLoads('"s"'))).toBe('str');
    expect(pyTypeName(pyLoads('true'))).toBe('bool');
    expect(pyTypeName(pyLoads('null'))).toBe('NoneType');
    expect(pyTypeName(pyLoads('[]'))).toBe('list');
    expect(pyTypeName(pyLoads('{}'))).toBe('dict');
  });

  it('an object keeps its INSERTION order, integer-like keys included', () => {
    const d = pyLoads('{"2": 1, "10": 2, "a": 3, "1": 4}') as PyDict;
    expect([...d.keys()]).toEqual(['2', '10', 'a', '1']);
  });

  it('a duplicate key keeps the LAST value, as CPython does', () => {
    const d = pyLoads('{"a": 1, "a": 2}') as PyDict;
    expect([...d.keys()]).toEqual(['a']);
    expect(pyRepr(d)).toBe("{'a': 2}");
  });

  it('repr() of a string picks its quote the way Python picks it', () => {
    expect(pyRepr('plain')).toBe("'plain'");
    expect(pyRepr("it's")).toBe(`"it's"`);
    expect(pyRepr('he said "no"')).toBe(`'he said "no"'`);
    expect(pyRepr(`both ' and "`)).toBe(`'both \\' and "'`);
    expect(pyRepr('a\nb\tc\\d')).toBe("'a\\nb\\tc\\\\d'");
    expect(pyRepr('')).toBe("'\\x01'");
  });

  it('repr() of the other shapes', () => {
    expect(pyRepr(null)).toBe('None');
    expect(pyRepr(true)).toBe('True');
    expect(pyRepr(false)).toBe('False');
    expect(pyRepr(new PyInt(7n))).toBe('7');
    expect(pyRepr(new PyInt(-0n))).toBe('0');
    expect(pyRepr(new PyFloat(7.5))).toBe('7.5');
    expect(pyRepr(new PyFloat(100))).toBe('100.0');
    expect(pyRepr(new PyFloat(1e-5))).toBe('1e-05');
    expect(pyRepr(new PyFloat(1e17))).toBe('1e+17');
    expect(pyRepr(pyLoads('["a", 1, null]'))).toBe("['a', 1, None]");
    expect(pyRepr(pyLoads('{"a": 1, "b": "x"}'))).toBe("{'a': 1, 'b': 'x'}");
    expect(pyRepr(pyLoads('[]'))).toBe('[]');
  });

  it('str() differs from repr() for exactly one shape', () => {
    expect(pyStr('plain')).toBe('plain');
    expect(pyStr(pyLoads('["a", "b"]'))).toBe("['a', 'b']");
  });

  it('pyEq spans the numeric tower and stops at str', () => {
    expect(pyEq(true, new PyInt(1n))).toBe(true);
    expect(pyEq(new PyInt(1n), new PyFloat(1))).toBe(true);
    expect(pyEq(false, new PyInt(0n))).toBe(true);
    expect(pyEq('1', new PyInt(1n))).toBe(false);
    expect(pyEq(null, false)).toBe(false);
    expect(pyEq(pyLoads('[1, 2]'), pyLoads('[1, 2.0]'))).toBe(true);
    expect(pyEq(pyLoads('{"a": 1}'), pyLoads('{"a": 2}'))).toBe(false);
  });
});

describe('CPython\'s json diagnostics, recorded from a real interpreter', () => {
  const decode = (text: string): string => {
    try {
      pyLoads(text);
    } catch (e) {
      if (e instanceof PyJsonDecodeError) return e.message;
      throw e;
    }
    throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  };

  it('the value, delimiter and extra-data families', () => {
    expect(decode('')).toBe('Expecting value: line 1 column 1 (char 0)');
    expect(decode('   ')).toBe('Expecting value: line 1 column 4 (char 3)');
    expect(decode('nul')).toBe('Expecting value: line 1 column 1 (char 0)');
    expect(decode('[')).toBe('Expecting value: line 1 column 2 (char 1)');
    expect(decode('[,]')).toBe('Expecting value: line 1 column 2 (char 1)');
    expect(decode('[1,]')).toBe('Expecting value: line 1 column 4 (char 3)');
    expect(decode('{"a": }')).toBe('Expecting value: line 1 column 7 (char 6)');
    expect(decode('{"a":tru}')).toBe('Expecting value: line 1 column 6 (char 5)');
    expect(decode('{')).toBe('Expecting property name enclosed in double quotes: line 1 column 2 (char 1)');
    expect(decode('{"a": 1,}')).toBe('Expecting property name enclosed in double quotes: line 1 column 9 (char 8)');
    expect(decode('{"a":1,,}')).toBe('Expecting property name enclosed in double quotes: line 1 column 8 (char 7)');
    expect(decode('{"a" 1}')).toBe("Expecting ':' delimiter: line 1 column 6 (char 5)");
    expect(decode('[1 2]')).toBe("Expecting ',' delimiter: line 1 column 4 (char 3)");
    expect(decode('[1,2')).toBe("Expecting ',' delimiter: line 1 column 5 (char 4)");
    expect(decode('{"a":"b"')).toBe("Expecting ',' delimiter: line 1 column 9 (char 8)");
    expect(decode('{"a":01}')).toBe("Expecting ',' delimiter: line 1 column 7 (char 6)");
    expect(decode('{} x')).toBe('Extra data: line 1 column 4 (char 3)');
    expect(decode('[1] [2]')).toBe('Extra data: line 1 column 5 (char 4)');
    expect(decode('{"a":1}}')).toBe('Extra data: line 1 column 8 (char 7)');
  });

  it('the LINE and COLUMN, which only a real walk computes', () => {
    expect(decode('\n\n  }')).toBe('Expecting value: line 3 column 3 (char 4)');
    expect(decode('{\n  "entries": [\n    {"id": "E-0001"},\n  ]\n}\n'))
      .toBe('Expecting value: line 4 column 3 (char 41)');
  });

  it('the string families, at the C scanner\'s positions', () => {
    expect(decode('"abc')).toBe('Unterminated string starting at: line 1 column 1 (char 0)');
    expect(decode('["ab')).toBe('Unterminated string starting at: line 1 column 2 (char 1)');
    expect(decode('["abc"]')).toBe('Invalid control character at: line 1 column 5 (char 4)');
    expect(decode('["abc\\qz"]')).toBe('Invalid \\escape: line 1 column 6 (char 5)');
    expect(decode('["abc\\u00zz"]')).toBe('Invalid \\uXXXX escape: line 1 column 7 (char 6)');
    expect(decode('﻿{}')).toBe('Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)');
  });

  it('and what CPython ACCEPTS is accepted too', () => {
    expect(pyRepr(pyLoads('{"a":1} '))).toBe("{'a': 1}");
    expect(pyRepr(pyLoads('[1 ,2]'))).toBe('[1, 2]');
    expect(pyRepr(pyLoads('{ }'))).toBe('{}');
    expect(pyRepr(pyLoads('"\\ud83d\\ude00"'))).toBe("'\u{1f600}'");
    // NaN and Infinity are JSON to CPython. Nothing here writes one; refusing
    // where the reader being replaced accepted would be a divergence.
    expect(pyTypeName(pyLoads('NaN'))).toBe('float');
    expect(pyTypeName(pyLoads('[Infinity, -Infinity]'))).toBe('list');
  });
});

describe('the sweep, end to end', () => {
  it('walks PAIRS in order and that order IS the report', () => {
    const root = repo({
      'tasks.json': '{"entries": [{"id": "T-0001", "status": "nope"}]}',
      'issues.json': '{"entries": [{"id": "I-0001"}]}',
      'log.json': '{"entries": [{"id": "L-0001"}]}',
    });
    try {
      const r = sweep(join(root, 'governance'), root);
      const journals = r.lines
        .filter((l) => !l.startsWith('UNSUPPORTED '))
        .map((l) => l.split(' ')[0]);
      expect([...new Set(journals)]).toEqual(['tasks.json', 'issues.json', 'log.json']);
      expect(r.rc).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an ABSENT journal is not a violation (P-16/P-35, the tri-state)', () => {
    const root = repo({});
    try {
      const r = sweep(join(root, 'governance'), root);
      expect(r.rc).toBe(0);
      expect(r.lines.filter((l) => !l.startsWith('UNSUPPORTED '))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a journal with no entries array is ONE row about the journal', () => {
    const root = repo({ 'repo-health.json': '{"checks": []}' });
    try {
      const r = sweep(join(root, 'governance'), root);
      expect(r.lines[0]).toBe('repo-health.json: no entries array');
      expect(r.rc).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a broken journal is LOUD, with CPython\'s own diagnostic in the row', () => {
    const root = repo({ 'sprints.json': 'NOT JSON AT ALL\n' });
    try {
      const r = sweep(join(root, 'governance'), root);
      expect(r.lines[0]).toBe(
        'sprints.json: schema check failed (JSONDecodeError: Expecting value: line 1 column 1 (char 0))',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a document that is valid JSON but not an object is an AttributeError', () => {
    const root = repo({ 'tasks.json': '[]' });
    try {
      const r = sweep(join(root, 'governance'), root);
      expect(r.lines[0]).toBe(
        "tasks.json: schema check failed (AttributeError: 'list' object has no attribute 'get')",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing schema file names the path Python\'s open() would have named', () => {
    const root = mkdtempSync(join(tmpdir(), 'w5i-noschema-'));
    try {
      mkdirSync(join(root, 'governance'), { recursive: true });
      writeFileSync(join(root, 'governance/tasks.json'), '{"entries": [{"id": "T-1"}]}');
      const r = sweep(join(root, 'governance'), root);
      expect(r.lines[0]).toBe(
        'tasks.json: schema check failed (FileNotFoundError: [Errno 2] No such file or directory: '
        + `'${join(root, '.claude/schemas/task.schema.json')}')`,
      );
      // `.claude` is the DEFAULT when neither harness dir exists, so the error
      // names the path a governed repo was expected to have.
      expect(schemaDir(root)).toBe(join(root, '.claude/schemas'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the coverage aggregate is ONE line and does not move the exit code', () => {
    const root = repo({ 'tasks.json': '{"entries": []}' });
    try {
      const r = sweep(join(root, 'governance'), root);
      expect(r.rc).toBe(0);
      expect(r.lines).toEqual([
        'UNSUPPORTED 124 keyword(s) across 7 schema(s) declared but NOT enforced by this reader: '
        + 'default, format, minItems, minLength, minimum, pattern',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the harness SOURCE layout is read too — .deploy-claude, never both', () => {
    expect(schemaDir(CHECKOUT)).toBe(join(CHECKOUT, '.deploy-claude/schemas'));
    expect(loadSchema('task.schema.json', CHECKOUT)).toBeInstanceOf(Map);
    expect(PAIRS.map(([j]) => j)).toEqual([
      'tasks.json', 'issues.json', 'exceptions.json', 'decisions.json',
      'log.json', 'sprints.json', 'repo-health.json',
    ]);
  });

  it('checkJournal prefixes every row with the journal name and the record id', () => {
    const root = repo({ 'tasks.json': '{"entries": [{"id": "T-0009", "status": "nope"}, 5]}' });
    try {
      const rows = checkJournal(join(root, 'governance/tasks.json'), 'task.schema.json', root);
      expect(rows[0]).toContain('tasks.json T-0009 ');
      // a non-dict entry has no id to name, so the Python prints "?"
      expect(rows[rows.length - 1]).toBe('tasks.json ? <root>: expected object, got int');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * THE RULED DIVERGENCE, this side of it. See the file header: bash cannot run
 * its sweep without an interpreter and fails closed; this one has none to
 * fail. tests/fail-closed-tests.sh still asserts bash's half against the bash
 * CLI by literal path, so the pair is covered without either assertion
 * claiming to speak for the other.
 */
describe('the native sweep needs no interpreter', () => {
  it('runs with PATH emptied and agents/ absent, and still reports the violation', () => {
    const root = repo({ 'tasks.json': '{"entries": [{"id": "T-0001", "status": "nope"}]}' });
    const savedPath = process.env['PATH'];
    try {
      process.env['PATH'] = '';
      const r = sweep(join(root, 'governance'), root);
      expect(r.rc).toBe(1);
      expect(r.lines).toContain(
        "tasks.json T-0001 status: 'nope' not one of ['proposed', 'ready', 'in_progress',"
        + " 'in_review', 'blocked', 'accepted', 'superseded']",
      );
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
