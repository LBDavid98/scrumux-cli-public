import { describe, it, expect } from 'vitest';
import { redactArgv, stripGlobalFlags } from '../../src/cli/argv.js';

/**
 * `--json` is a GLOBAL flag and `--` is its escape. Four spellings of the
 * same request must be the same request, because a surface that accepts some
 * of them and not others is a surface people get wrong -- and cli-shape-tests
 * caught exactly that on its first run in bash.
 */
describe('the global-flag stripper', () => {
  it('finds --json anywhere before the noun', () => {
    expect(stripGlobalFlags(['--json', 'task', 'lint', 'T-1'])).toEqual({
      argv: ['task', 'lint', 'T-1'], json: true,
    });
  });

  it('finds it between the noun and the verb', () => {
    expect(stripGlobalFlags(['task', '--json', 'lint', 'T-1'])).toEqual({
      argv: ['task', 'lint', 'T-1'], json: true,
    });
  });

  it('finds it at the end', () => {
    expect(stripGlobalFlags(['task', 'lint', 'T-1', '--json'])).toEqual({
      argv: ['task', 'lint', 'T-1'], json: true,
    });
  });

  it('leaves argv alone when it is absent', () => {
    expect(stripGlobalFlags(['task', 'lint', 'T-1'])).toEqual({
      argv: ['task', 'lint', 'T-1'], json: false,
    });
  });

  it('`--` ends the stripping and is itself removed', () => {
    // The escape for a governance record whose VALUE is literally --json.
    // Absurd and possible, so it gets the standard escape, not a caveat.
    expect(stripGlobalFlags(['log', 'new', '--did', '--', '--json'])).toEqual({
      argv: ['log', 'new', '--did', '--json'], json: false,
    });
  });

  it('only the FIRST `--` is consumed', () => {
    // bash sets _passthru=1 and never clears it, so a second `--` is data.
    expect(stripGlobalFlags(['a', '--', 'b', '--', 'c'])).toEqual({
      argv: ['a', 'b', '--', 'c'], json: false,
    });
  });

  it('a --json BEFORE the -- still sets the mode', () => {
    expect(stripGlobalFlags(['a', '--json', '--', '--json'])).toEqual({
      argv: ['a', '--json'], json: true,
    });
  });

  it('two --json are one --json', () => {
    expect(stripGlobalFlags(['--json', 'a', '--json'])).toEqual({ argv: ['a'], json: true });
  });

  it('an empty argv is an empty argv', () => {
    expect(stripGlobalFlags([])).toEqual({ argv: [], json: false });
  });

  it('does not eat a flag that merely starts with --json', () => {
    expect(stripGlobalFlags(['a', '--jsonl'])).toEqual({ argv: ['a', '--jsonl'], json: false });
  });
});

/**
 * The other half of what the dispatcher does to argv before the envelope sees
 * it (User's ruling, Harden C — landed on both sides at once, so bash's
 * `cli_argv_capture` in `.deploy-claude/scripts/scrumux` is the same rule and
 * `t2-hC-secret-set-argv-redacted*` holds the two to the same bytes).
 *
 * The population is narrow ON PURPOSE. Only `secret set` has a value to hide;
 * `list` takes nothing and `remove` takes a NAME, so a blanket rule over the
 * noun would erase the record of what was removed and buy nothing.
 */
describe('the secret-value redactor', () => {
  it('replaces everything after the NAME', () => {
    expect(redactArgv('secret', 'set', ['TOKEN', 'hunter2'])).toEqual(['TOKEN', '<redacted>']);
  });

  it('preserves the entry COUNT rather than collapsing the list', () => {
    // PK-2 restated: `.argv` is the record of what was run, so a list that
    // dropped an element misstates the act as surely as one that leaks it.
    expect(redactArgv('secret', 'set', ['TOKEN', 'a', 'b'])).toEqual(
      ['TOKEN', '<redacted>', '<redacted>'],
    );
  });

  it('leaves a NAME-only invocation alone — the stdin form has nothing to hide', () => {
    expect(redactArgv('secret', 'set', ['TOKEN'])).toEqual(['TOKEN']);
    expect(redactArgv('secret', 'set', [])).toEqual([]);
  });

  it('is POSITIONAL, not parsed: a flag in the value slot is redacted too', () => {
    // The seam must not have its own opinion about which slot held the secret,
    // or it can disagree with the noun's parse. `secret set N --x` refuses as
    // an unknown flag, and the envelope still says nothing about the value.
    expect(redactArgv('secret', 'set', ['TOKEN', '--x'])).toEqual(['TOKEN', '<redacted>']);
  });

  it('redacts the NAME SLOT when it begins with a dash (R-010)', () => {
    // The value typed one slot early. `args[0]` was kept verbatim on the
    // reasoning that it is the NAME and a NAME is not a secret — true of every
    // argv that HAS a name, and this one does not. A leading dash can never be
    // a usable NAME (`requireUsableName` allows letters, digits and underscore
    // only), so withholding it costs the record nothing.
    expect(redactArgv('secret', 'set', ['-sup3r-s3cret'])).toEqual(['<redacted>']);
    expect(redactArgv('secret', 'set', ['-sup3r-s3cret', 'tail'])).toEqual(
      ['<redacted>', '<redacted>'],
    );
    // …and a NAME that is merely UNUSABLE for another reason still shows,
    // because the refusal names it anyway and the record is worth more than a
    // redaction that hides nothing.
    expect(redactArgv('secret', 'set', ['1BAD', 'hunter2'])).toEqual(['1BAD', '<redacted>']);
  });

  it('touches no other verb and no other noun', () => {
    expect(redactArgv('secret', 'remove', ['TOKEN'])).toEqual(['TOKEN']);
    expect(redactArgv('secret', 'list', [])).toEqual([]);
    expect(redactArgv('log', 'new', ['--title', 'X', '--did', 'Y'])).toEqual(
      ['--title', 'X', '--did', 'Y'],
    );
  });

  it('returns a COPY, so the module and the envelope cannot alias one array', () => {
    const args = ['TOKEN'];
    const out = redactArgv('secret', 'set', args);
    expect(out).not.toBe(args);
    expect(out).toEqual(args);
  });
});
