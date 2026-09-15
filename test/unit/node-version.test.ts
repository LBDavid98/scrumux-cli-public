import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nodeVersionProblem, MIN_NODE_MAJOR, MIN_NODE_MINOR } from '../../src/util/node-version.js';

/**
 * A version guard that is itself a syntax error on the version it guards
 * against prints a parser stack trace instead of the one sentence the
 * operator needs. So the guard is written in the most conservative syntax
 * available, and this file asserts both halves: the decisions it makes, and
 * that the source stays parseable by an old runtime.
 */
describe('the Node version guard', () => {
  it('passes a supported runtime', () => {
    for (const v of ['v22.11.0', 'v22.12.3', 'v24.4.1', 'v99.0.0']) {
      expect(nodeVersionProblem(v), v).toBeNull();
    }
  });

  it('refuses one below the floor, naming the fix and what was NOT done', () => {
    const msg = nodeVersionProblem('v22.10.0');
    expect(msg).not.toBeNull();
    // Article 5: a refusal that states a fact without naming the next action
    // is a defect.
    expect(msg).toContain(`Node >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`);
    expect(msg).toContain('Install a newer Node and retry');
    expect(msg).toContain('nothing was read or written');
  });

  it('refuses an older major', () => {
    expect(nodeVersionProblem('v20.19.0')).not.toBeNull();
    expect(nodeVersionProblem('v18.0.0')).not.toBeNull();
  });

  it('sits exactly on the floor', () => {
    expect(nodeVersionProblem(`v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`)).toBeNull();
    expect(nodeVersionProblem(`v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR - 1}.99`)).not.toBeNull();
  });

  it('does NOT refuse on a guess when the version is unreadable', () => {
    // Refusing something it could not parse would turn an unknown runtime
    // into a hard failure, which is the opposite of what the guard is for.
    for (const v of ['', 'nonsense', 'v22']) expect(nodeVersionProblem(v)).toBeNull();
  });

  it('accepts the version with or without the leading v', () => {
    expect(nodeVersionProblem('22.10.0')).not.toBeNull();
    expect(nodeVersionProblem('24.0.0')).toBeNull();
  });

  it('is written in syntax an ES5 parser accepts', () => {
    // The point of the guard is to RUN on the runtime it rejects. Optional
    // chaining, ??, or a template literal in this file would make it a
    // SyntaxError there, and the operator would get a stack trace instead of
    // the sentence.
    const src = readFileSync(resolve(import.meta.dirname, '../../src/util/node-version.ts'), 'utf8');
    const body = src.split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*')).join('\n');
    expect(body).not.toContain('?.');
    expect(body).not.toContain('??');
    expect(body).not.toContain('`');
  });
});
