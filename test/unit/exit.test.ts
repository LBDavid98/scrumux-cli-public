import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExitSignal, captureIo, processIo, exitCodeOf } from '../../src/cli/exit.js';

/**
 * The exit seam. `exit` THROWS in every configuration — one code path, no
 * branch on "am I under test" — and the entry point turns the throw back into
 * a real exit. These assert that property directly, because a seam that
 * behaved differently under test would make every test below it evidence
 * about a program nobody ships.
 */
describe('the exit seam', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('captureIo collects both streams separately', () => {
    const io = captureIo();
    io.out('to stdout\n');
    io.err('to stderr\n');
    expect(io.stdout).toBe('to stdout\n');
    expect(io.stderr).toBe('to stderr\n');
  });

  it('exit throws an ExitSignal carrying the code', () => {
    const io = captureIo();
    expect(() => io.exit(2)).toThrow(ExitSignal);
    try { io.exit(1); } catch (e) { expect((e as ExitSignal).code).toBe(1); }
  });

  it('nothing after an exit() call runs — the bash semantics exactly', () => {
    const io = captureIo();
    const after = vi.fn();
    try {
      io.exit(0);
      after();
    } catch { /* expected */ }
    expect(after).not.toHaveBeenCalled();
  });

  it('processIo writes to the real streams and throws rather than killing us', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    processIo.out('x');
    processIo.err('y');
    expect(out).toHaveBeenCalledWith('x');
    expect(err).toHaveBeenCalledWith('y');
    expect(() => processIo.exit(2)).toThrow(ExitSignal);
  });

  it('exitCodeOf reports the code the body asked for', () => {
    expect(exitCodeOf(() => { throw new ExitSignal(2); })).toBe(2);
  });

  it('exitCodeOf treats a body that returns as the cli_finish case (0)', () => {
    // In bash that is `cli_finish` -- the dispatcher's safety net. A module
    // that returns without emitting must not become a crash where bash
    // produced a valid object (PHILOSOPHY P-03).
    expect(exitCodeOf(() => { /* falls off the end */ })).toBe(0);
  });

  it('a real error is NOT swallowed as an exit code', () => {
    expect(() => exitCodeOf(() => { throw new TypeError('a genuine bug'); })).toThrow(TypeError);
  });
});
