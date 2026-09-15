import { defineConfig } from 'vitest/config';

// Coverage gates are CI-FATAL and per-directory (the plan's spine section).
// They start ENFORCED rather than aspirational: a threshold added later is a
// threshold nobody ever raises.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The write path is synchronous by ruling (no await between lock acquire
    // and release), so tests must not silently pass on a floating promise.
    dangerouslyIgnoreUnhandledErrors: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // ONE exclusion, and it is a measurement limit rather than a gap.
      // src/bin/scrumux.ts is the shebang, the ES5 version banner and the
      // try/catch that turns an ExitSignal into a real exit code; it cannot
      // be imported without running, and v8 cannot attribute a subprocess.
      // Every one of its properties is asserted in test/unit/bin.test.ts as
      // a real process, and everything it delegates to is at 100% in
      // dispatch.test.ts. Adding a second entry here needs the same pair of
      // sentences -- an exclusion nobody has to justify is a gap.
      exclude: ['src/bin/**'],
      //
      // THE RATCHET ARRIVED (Harden E, 2026-09-01). This block was headed
      // TEMPORARY and said: "These are a RATCHET, not the destination: each
      // number sits just under the measured actual, so coverage can only be
      // lost deliberately, and each hardened module raises it again. END
      // STATE: lines 90, branches 85, functions 90, statements 90 -- the
      // numbers the pre-port harness held -- reached per-module rather than
      // in one jump, because a floor set above the actual is a floor that
      // gets commented out on the first red CI run."
      //
      // It was reached in one wave, per-module, and passed. The end-state
      // numbers are now the PER-DIRECTORY floors below rather than the
      // global ones, because they turned out to be the weaker claim: every
      // directory clears them with room, and a single global number can be
      // held up by src/walls at 100% while src/nouns quietly rots. The
      // global floors keep the original discipline -- each sits about three
      // points under the measured actual -- so coverage can still only be
      // lost deliberately.
      //
      // Measured at the commit that set them, over 1821 tests:
      //   98.14 lines/statements, 93.79 branches, 99.19 functions.
      // Per directory, aggregated:
      //   src/journal  99.12 / 96.18 / 100      src/walls   100 / 99.42 / 100
      //   src/nouns    97.96 / 92.84 /  99.23   src/cli   97.66 / 95.27 / 100
      //   src/schema   95.96 / 92.47 /  94.29   src/util   100 / 100 / 100
      //
      // WHAT IS NOT AT 100, and why raising these floors further would be
      // pinning unreachable code rather than testing it. Four sites are
      // named as unreachable by the wave that covered around them, each with
      // the reasoning at the code: src/journal/read.ts's two `String(e)`
      // fallbacks (readFileSync and the parser only ever throw Error
      // subclasses); src/nouns/graph/code-build-arm.ts's missing
      // SCRUMUX_CODE_GRAPH_DATA_ROOT arm, deliberately untested because
      // `indexPath('')` is RELATIVE and the test would clobber this
      // checkout's own governance/code-graph.json; src/nouns/task/verify.ts's
      // 600s TIMEOUT arm, which no record can configure; and
      // src/nouns/sprint.ts:111 `rowById`'s null return, guarded at every
      // call site by a refExists over the same predicate. Reaching them
      // means contriving an export or mocking node:fs, which is the coverage
      // theater this ratchet exists to avoid.
      thresholds: {
        lines: 95,
        branches: 91,
        functions: 96,
        statements: 95,
        // The END-STATE numbers, held per directory so no one area can be
        // carried by another. Aggregated over each directory's files, which
        // is what lets the four unreachable sites above sit inside a floor
        // instead of forcing a per-file exemption list.
        'src/journal/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/walls/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/nouns/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/cli/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/schema/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/util/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  },
});
