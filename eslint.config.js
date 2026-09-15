import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint 9 flat config. Three project-specific rules matter more than style:
//
//  1. NO ASYNC UNDER src/journal/ -- the write path is fully synchronous by
//     ruling. An await between lock acquire and release is the CLI-14 bug
//     class with a new face.
//  2. The package NAME appears only in package.json and README.
//  3. Every failure/refusal traces to a bash counterpart or carries an
//     APPROVED-DIVERGENCE marker (the anti-strictness backstop). THAT ONE IS
//     NOT HERE, and its absence is deliberate rather than outstanding: it
//     landed in the hardening wave as `test/unit/refusal-parity.test.ts` over
//     `tools/refusal-corpus.mjs`. The check compares two TREES -- every
//     refusal string in the shell payload against every refusal string
//     `src/` can print -- and ESLint hands a rule one file at a time with no
//     ordering guarantee, so expressing it as a rule means building the bash
//     corpus in module-global state and hoping the run is not sharded. It
//     also reads the TypeScript through the compiler's own parser, which is
//     what a rule has, and the shell payload through a regex, which a rule
//     has no business doing during `eslint .`. The full argument is at the
//     top of `tools/refusal-corpus.mjs`.
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // OFF, and it is a direct consequence of a STRONGER guarantee we keep:
      // tsconfig sets `noUncheckedIndexedAccess`, so `argv[0]` is
      // `string | undefined` and every index read needs either a `!` or a
      // redundant guard on a bound the surrounding code has already checked.
      // Turning this rule on with that compiler option on is a rule that
      // fights the type system: it does not remove the assumption, it moves
      // it into an `if` nobody reads. The option is the load-bearing half.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Allowed WITH a description, which the three sites have: the
      // differential tooling is .mjs and has no declarations, and giving it a
      // tsconfig of its own buys nothing a comment does not.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
    },
  },
  {
    ignores: [
      'dist/**', 'build/**', 'node_modules/**', 'coverage/**',
      // The esbuild output and the Python virtualenv are not source.
      '.deploy-claude/dist/**', '.venv/**',
      // GENERATED, and the generator is what gets reviewed:
      // tools/gen-usage.mjs extracts the 21 usage blocks from bash verbatim.
      // Linting 28KB of transcribed prose reports on the prose.
      'src/cli/usage-text.ts',
      // Regenerable fixture corpora, gitignored (see .gitignore).
      'test/fixtures/sandbox/**', 'test/fixtures/corpus/**',
    ],
  },
  {
    // The build/differential/sandbox tooling runs under node directly rather
    // than through the bundle, so `process` and `console` are ambient there
    // and nowhere else. Declared per-glob rather than globally: a `console`
    // in src/ IS a defect -- the CLI writes through the exit seam so its
    // output is capturable, and a stray console.log would bypass the one
    // place --json output is kept to exactly one object.
    files: ['tools/**/*.mjs', 'test/fixtures/*.mjs', 'test/oracle/*.mjs'],
    languageOptions: {
      // `Buffer` joined the pair when the PowerShell dialect matrix had to
      // build a `-EncodedCommand` blob, which is base64 of UTF-16LE and has no
      // spelling in plain JS. Same reasoning as the other two and the same
      // scope: ambient where node runs the file directly, nowhere else.
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    files: ['src/journal/**/*.ts'],
    rules: {
      // TODO(phase4): replace with a custom rule that also bans `await`.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration[async=true]',
          message:
            'src/journal/ is synchronous by ruling: no await may sit between a lock acquire and its release.',
        },
        {
          selector: 'ArrowFunctionExpression[async=true]',
          message:
            'src/journal/ is synchronous by ruling: no await may sit between a lock acquire and its release.',
        },
      ],
    },
  },
);
