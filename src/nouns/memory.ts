/**
 * The `memory` noun.
 *
 * THE ONE APPEND `scrumux` OWNS BECAUSE THE CALLER CANNOT WRITE IT ITSELF. The
 * issue-validator agent is read-only by design (D-0007), so it cannot keep its
 * own durable memory; it emits `memory-append:` blocks and the orchestrating
 * session lands them here.
 *
 * NOT A JOURNAL, AND THEREFORE NOT A JOURNAL WRITE. `validator-memory.md` is
 * prose -- no ids, no `entries` array, deliberately outside `SEALED_JOURNALS`
 * -- so this cannot go through `write_json` (jq-only) and must NOT reseal.
 * It is a plain append after asserting the target exists and is non-empty, and
 * it is the ONE write verb in the CLI that does not call `seal_bootstrap`,
 * because it writes nothing a seal covers.
 *
 * ABSENT AND EMPTY ARE DIFFERENT FACTS, AND THEY GET DIFFERENT ANSWERS.
 *
 *   ABSENT: create it, with the header, then append normally. D-0089
 *   (2026-08-31) reversed a refusal whose own comment called itself
 *   deliberate; User's ruling is that a comment asserting deliberateness is
 *   not a ruling, and there was none behind this one. `harness deploy` seeds
 *   no validator-memory.md, so the old behaviour made this verb unreachable on
 *   every fresh deploy until a person hand-wrote the file -- a wall in front of
 *   the USER, which is the Prime Article exactly.
 *
 *   EMPTY-BUT-PRESENT: still refuse. A zero-byte file EXISTED and has lost its
 *   header; writing a fresh header over it would silently decide that whatever
 *   was there did not matter. Same tri-state discipline the journal reader is
 *   built on.
 *
 * THE REPORT SAYS WHICH OF THE TWO HAPPENED (Article 5). "appended" over a
 * file this command just made would hide the more consequential half.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFile } from '../util/fs-predicates.js';
import type { Cli } from '../cli/envelope.js';
import { NOUN_USAGE } from '../cli/usage-text.js';
import { JournalRefusal, refusing } from '../journal/refusal.js';
import { nounContext, type NounContext, type NounModule } from './lib/context.js';

export const VERBS = ['add'] as const;

const VERBS_TSV = 'add\tthe only verb\n';
const USAGE = NOUN_USAGE['memory'] ?? '';

/** The heredoc, byte for byte, trailing newline included. */
export const MEMORY_HEADER = `# validator-memory.md — issue-validator's durable memory

Append-only prose. The issue-validator agent reads this before every
run and its \`memory-append:\` blocks land here verbatim (appended by the
orchestrating session — the agent itself is read-only). Not a journal:
no schema, no ids — codebase facts, issue fingerprints, and dead ends
that make the next validation run faster. Memory says where to look;
evidence says what is true.
`;

export interface MemoryFlags {
  file: string;
  by: string;
}

export function parseMemoryFlags(args: readonly string[], die: (m: string) => never): MemoryFlags {
  const f: MemoryFlags = { file: '', by: '' };
  let i = 0;
  const value = (flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) die(`memory: ${flag} needs a value — see: scrumux help memory`);
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case '--file': f.file = value(a); break;
      case '--by': f.by = value(a); break;
      default: die(`memory: unknown flag ${a} — see: scrumux help memory`);
    }
  }
  return f;
}

/**
 * `$(cat …)` -- command substitution strips EVERY trailing newline, not one.
 * A block handed in with three blank lines at the end is stored with none, and
 * the single `printf '%s\n'` below puts exactly one back.
 */
export function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

/**
 * `printf '%s\n' "$BLOCK" | wc -l` -- the NEWLINES in the block plus the one
 * printf adds. With the trailing newlines already stripped that is the line
 * count, and an empty block cannot reach here.
 */
export function blockLineCount(block: string): number {
  let n = 1;
  for (const ch of block) if (ch === '\n') n += 1;
  return n;
}

/** For a test: where the block comes from when `--file` is absent. */
export type StdinReader = () => string;

const readStdin: StdinReader = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    // `cat` with nothing on stdin produces nothing; so does this.
    return '';
  }
};

function memoryAdd(
  cli: Cli,
  ctx: NounContext,
  args: readonly string[],
  stdin: StdinReader,
): never {
  const f = parseMemoryFlags(args, (m) => cli.die(m));

  if (f.by === '') {
    cli.die('memory: --by is required (who produced this block — the agent name, so a reader can tell whose memory this is)');
  }

  let block: string;
  if (f.file !== '') {
    // `[ -f "$MFILE" ]` -- a regular file, symlinks followed.
    if (!isFile(f.file)) cli.die(`memory: --file ${f.file} does not exist`);
    try {
      block = stripTrailingNewlines(readFileSync(f.file, 'utf8'));
    } catch {
      // The file existed but could not be read; falls back to empty and
      // the next guard is the one that speaks.
      block = '';
    }
  } else {
    block = stripTrailingNewlines(stdin());
  }
  if (block === '') {
    cli.die('memory: the block is empty — refusing to append a heading with nothing under it (an empty run is not a run)');
  }

  const mem = join(ctx.gov, 'validator-memory.md');
  let created = false;
  refusing(cli, () => {
    if (!isFile(mem)) {
      try {
        mkdirSync(ctx.gov, { recursive: true });
      } catch {
        throw new JournalRefusal(`memory: cannot create ${ctx.gov}`);
      }
      try {
        writeFileSync(mem, MEMORY_HEADER);
      } catch {
        throw new JournalRefusal(`memory: cannot create ${mem}`);
      }
      created = true;
    }
  });

  // `[ -s "$MEM" ]` -- exists AND is non-empty. A file this command just
  // created always passes; one that was already there and is zero bytes has
  // lost its header and is refused rather than overwritten.
  if (!isNonEmptyFile(mem)) {
    cli.die(`memory: ${mem} is empty — it exists and has lost its header, so this refuses rather than writing a new one over whatever was there. Restore it from git, or delete it and re-run: scrumux memory add creates a fresh one when the file is ABSENT`);
  }

  const heading = `## Run ${ctx.today} — ${f.by}`;
  refusing(cli, () => {
    try {
      // `{ printf '\n## Run %s — %s\n\n' …; printf '%s\n' "$BLOCK"; } >> "$MEM"`
      // -- ONE append, never a rewrite: the append-only contract means no byte
      // already in the file is touched.
      writeFileSync(mem, `\n${heading}\n\n${block}\n`, { flag: 'a' });
    } catch {
      throw new JournalRefusal(`memory: cannot append to ${mem}`);
    }
  });

  const n = blockLineCount(block);
  return cli.emit(created
    ? `created validator-memory.md and appended ${n} line(s) under '${heading}'`
    : `appended ${n} line(s) to validator-memory.md under '${heading}'`);
}

function isNonEmptyFile(p: string): boolean {
  // `-s` is "exists and has a size greater than zero"; it does not require a
  // regular file, and it follows symlinks.
  if (!existsSync(p)) return false;
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

export const MODULE: NounModule = {
  verbs: () => VERBS_TSV,
  usage: () => USAGE,
  run(cli, ctx, verb, args): never {
    switch (verb) {
      case 'add':
        return memoryAdd(cli, nounContext(ctx), args, readStdin);
      default:
        return cli.dieUsage(
          `unknown verb '${verb}' for noun memory — the only verb is 'add'. See: scrumux help memory`,
        );
    }
  },
};

/** The verb with its stdin seam exposed, for a test that has no process. */
export function runMemoryAdd(cli: Cli, ctx: NounContext, args: readonly string[], stdin: StdinReader): never {
  return memoryAdd(cli, ctx, args, stdin);
}
