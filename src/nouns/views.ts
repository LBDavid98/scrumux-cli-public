/**
 * The `views` noun.
 *
 * One verb, and one small hazard: `cli.emit()` EXITS. So the
 * `if (r.graphBuildFailed) { ...; cli.emit(...); }` block below never falls
 * through to the `cli.pass`/`cli.emit` pair after it. Read as ordinary
 * control flow it looks like "record a failure, then also record a pass";
 * it is not. Whoever touches this function must keep that early exit --
 * turning it into "run checks, then always report" double-reports
 * (read-verbs-small.md, open question 7).
 */
import type { Cli } from '../cli/envelope.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';
import { renderViews } from './views-render.js';

export const VERBS = ['render'] as const;

const VERBS_TSV = 'render\tregenerate AI_LOG.MD, DECISIONS.MD, BACKLOG.MD and the governance graph\n';

const USAGE = `scrumux views — the generated MD views of the journals.

  scrumux views render

AI_LOG.MD, DECISIONS.MD and BACKLOG.MD are GENERATED. The sources of
truth are the JSON journals under governance/ (D-0002); the MD files are
projections and are never hand-edited.

Rendering also rebuilds governance/governance-graph.json, which is a
generated view of the same journals (I-0063). T-0187 took this OFF the
write path — every gov write was re-rendering three files and rebuilding
the whole graph, ~0.15s of a ~0.19s write, for views nobody reads
mid-session — so it happens on demand and at the session close.
`;

function viewsRender(cli: Cli, ctx: NounContext): never {
  const r = renderViews(ctx);
  // Warnings are already newline-terminated and go to stderr in BOTH modes
  // -- stdout under --json carries one object and nothing else.
  for (const w of r.warnings) cli.sayAlways(w.replace(/\n$/, ''));

  // T-0129: renderViews keeps a graph-build failure non-fatal on the WRITE
  // path, but this is an explicit request to regenerate, so it must not
  // report success when the graph did not rebuild.
  if (r.graphBuildFailed) {
    cli.fail(
      'governance-graph',
      'views regenerated, but the governance graph did NOT rebuild — governance/governance-graph.json'
      + ' is stale and every query over it is answering from old data. See the warning on stderr; run'
      + ' .claude/scripts/scrumux graph gov build to see why.',
    );
    cli.emit('views regenerated, but the governance graph is STALE.');
  }
  cli.pass('views', 'AI_LOG.MD, DECISIONS.MD, BACKLOG.MD and governance-graph.json regenerated');
  cli.emit('views regenerated');
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'render':
        if (args.length !== 0) cli.dieUsage('views render takes no arguments');
        return viewsRender(cli, nounContext(ctx));
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun views — the only verb is 'render'. See: scrumux help views`,
        );
    }
  },
};
