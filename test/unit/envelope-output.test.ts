import { describe, it, expect } from 'vitest';
import { Cli } from '../../src/cli/envelope.js';
import { captureIo, ExitSignal, type CapturedIo } from '../../src/cli/exit.js';

/**
 * The output half of the envelope: what actually reaches stdout and stderr,
 * and with which exit code. `envelope.test.ts` proves the SHAPE; this proves
 * the BYTES — and under Article 5 those bytes are the instruction set, held
 * to the same review standard as code.
 */
const DEL = '';

function ran(
  fn: (c: Cli) => void,
  json: boolean,
  command = 'probe verb',
  argv: string[] = ['x'],
): { code: number; io: CapturedIo } {
  const io = captureIo();
  const c = new Cli(command, argv, json, io);
  try {
    fn(c);
  } catch (e) {
    if (e instanceof ExitSignal) return { code: e.code, io };
    throw e;
  }
  throw new Error('the call returned without exiting');
}

describe('emitting the one object', () => {
  it('under --json, stdout carries exactly one object and nothing else', () => {
    const { code, io } = ran((c) => { c.say('prose'); c.pass('a', 'held'); c.emit('summary'); }, true);
    expect(code).toBe(0);
    expect(io.stderr).toBe('');
    const env = JSON.parse(io.stdout);
    expect(env.summary).toBe('summary');
    expect(env.checks).toHaveLength(1);
    // say() is suppressed entirely under --json: stdout is the object.
    expect(io.stdout).not.toContain('prose');
  });

  it('renders through jqFormat — 2-space indent, one trailing newline', () => {
    const { io } = ran((c) => { c.emit('s'); }, true);
    expect(io.stdout.endsWith('}\n')).toBe(true);
    expect(io.stdout.split('\n')[1]!.startsWith('  "schema"')).toBe(true);
  });

  it('escapes DEL, which jq does and JSON.stringify does not', () => {
    // Spike A: the ONE string-escaping difference between the two. A summary
    // quoting a filename with a control character in it would otherwise
    // diverge byte-for-byte with no behavioural cause.
    const { io } = ran((c) => { c.emit(`has ${DEL} in it`); }, true);
    expect(io.stdout).toContain('\\u007f');
    expect(io.stdout).not.toContain(DEL);
    expect(JSON.stringify(`has ${DEL} in it`)).toContain(DEL); // the contrast, stated
  });

  it('in human mode the rows print and the summary is last', () => {
    const { code, io } = ran((c) => { c.say('a line'); c.fail('gate', 'did not hold'); c.emit('2 failed'); }, false);
    expect(code).toBe(1);
    expect(io.stdout).toContain('a line');
    expect(io.stdout).toContain('  FAIL gate');
    expect(io.stdout.trimEnd().endsWith('2 failed')).toBe(true);
  });

  it('an empty summary prints nothing extra in human mode', () => {
    const { io } = ran((c) => { c.pass('a'); c.emit(); }, false);
    expect(io.stdout.trimEnd()).toBe('  ok   a');
  });

  it('prints every advisory tier with its own label', () => {
    const { code, io } = ran((c) => {
      c.pass('p'); c.warn('w'); c.tell('t'); c.note('n'); c.emit('');
    }, false);
    // P-01: all four print, and none of them moves the verdict.
    expect(code).toBe(0);
    expect(io.stdout).toContain('  ok  ');
    expect(io.stdout).toContain('  WARN');
    expect(io.stdout).toContain('  TELL');
    expect(io.stdout).toContain('  ..  ');
  });

  it('data() and extra() land in different places in the object', () => {
    const { io } = ran((c) => { c.data({ k: 1 }); c.extra({ top: 'level' }); c.emit('s'); }, true);
    const env = JSON.parse(io.stdout);
    expect(env.data).toEqual({ k: 1 });
    expect(env.top).toBe('level');
  });

  it('sayAlways goes to STDERR even under --json', () => {
    const { io } = ran((c) => { c.sayAlways('a human must see this'); c.emit('s'); }, true);
    expect(io.stderr).toBe('a human must see this\n');
    expect(io.stdout).not.toContain('a human must see this');
  });
});

describe('finish — the dispatcher safety net (P-03)', () => {
  it('a module that never emitted still produces the object', () => {
    // Keep the net. Making "every path must emit" a type-level requirement is
    // STRICTER than bash and turns a missed branch into a crash where bash
    // produced a valid object.
    const { code, io } = ran((c) => { c.pass('a'); c.finish(); }, true);
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout).summary).toBe('scrumux probe verb: ok.');
  });

  it('derives the summary from the rows when they failed', () => {
    const { code, io } = ran((c) => { c.fail('a'); c.fail('b'); c.finish(); }, true);
    expect(code).toBe(1);
    expect(JSON.parse(io.stdout).summary).toBe('scrumux probe verb: 2 check(s) failed.');
  });

  it('is a no-op when the module already emitted — one object, not two', () => {
    const io = captureIo();
    const c = new Cli('probe verb', [], true, io);
    try { c.emit('mine'); } catch { /* the first exit */ }
    let second = -1;
    try { c.finish(); } catch (e) { second = (e as ExitSignal).code; }
    expect(second).toBe(0);
    expect(io.stdout.split('\n').filter((l) => l === '{').length).toBe(1);
  });
});

describe('refusals', () => {
  function refuseOf(json: boolean, kind: 'usage' | 'refused', command = 'probe verb') {
    return ran((c) => { if (kind === 'usage') c.dieUsage('the message'); else c.die('the message'); },
      json, command, ['a']);
  }

  it('is still an object under --json, at exit 2 and ok false', () => {
    const { code, io } = refuseOf(true, 'usage');
    expect(code).toBe(2);
    const env = JSON.parse(io.stdout);
    expect(env.ok).toBe(false);
    expect(env.exit).toBe(2);
    expect(env.error).toEqual({ kind: 'usage', message: 'the message' });
    expect(env.summary).toBe('scrumux probe verb: error: the message');
    expect(env.data).toEqual({});
  });

  it('distinguishes usage from refused, because the two mean different things', () => {
    expect(JSON.parse(refuseOf(true, 'refused').io.stdout).error.kind).toBe('refused');
  });

  it('stderr carries it in BOTH modes — no consumer ever had to parse English', () => {
    for (const json of [true, false]) {
      expect(refuseOf(json, 'usage').io.stderr).toBe('scrumux probe verb: error: the message\n');
    }
  });

  it('human mode writes nothing to stdout', () => {
    expect(refuseOf(false, 'usage').io.stdout).toBe('');
  });

  it('drops the space when there is no command yet', () => {
    expect(refuseOf(false, 'usage', '').io.stderr).toBe('scrumux: error: the message\n');
  });

  it('carries the rows it had collected before the refusal', () => {
    const { io } = ran((c) => { c.warn('w', 'noticed'); c.die('and then this'); }, true);
    expect(JSON.parse(io.stdout).checks).toHaveLength(1);
  });
});
