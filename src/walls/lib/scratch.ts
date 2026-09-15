/**
 * The session scratch directory, `<WORK_ROOT>/.scratch/` (D-S040, SX-026).
 *
 * Sessions made scratch files in their worktree root because nothing named a
 * place for them, and `block-destructive` then refused `rm -rf` on them as
 * "outside temp space" — OS temp roots were its only temp space. D-S040 names
 * ONE directory: deploy gitignores `.scratch/`, the brief tells a session to
 * put throwaway files there, and this wall treats it as temp space.
 *
 * NARROW AND FIXED, ON PURPOSE. Only `<WORK_ROOT>/.scratch` and paths under
 * it qualify — not any untracked or gitignored path (gitignored paths hold
 * `.env`, local databases), and not `.scratch_foo` beside it. No git call and
 * no filesystem call: the answer is string work over the command, like every
 * other temp judgement here (`lexResolve`).
 *
 * WHERE A RELATIVE OPERAND POINTS is tracked the way a shell would: it starts
 * at the hook payload's `cwd` (the WORK_ROOT when absent), and a `cd DIR`
 * segment before the `rm` moves it. A `cd` this cannot follow (`cd`, `cd -`,
 * `cd ~`, a `$VAR`) makes every later relative operand "not scratch" — the
 * refusal stands, which is the safe direction.
 *
 * Dependencies: none (pure string functions).
 */

/** The directory name, relative to WORK_ROOT. Deploy's .gitignore lane carries `.scratch/`. */
export const SCRATCH_DIR = '.scratch';

/**
 * Collapse `.` and `..` components textually (a copy of block-destructive's
 * `lexResolve`, kept here so this module has no dependency on a wall).
 */
function lex(path: string): string {
  const lead = path.startsWith('/') ? '/' : '';
  const acc: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { acc.pop(); continue; }
    acc.push(seg);
  }
  return lead + acc.join('/');
}

/**
 * True when `abs` (an absolute, lexically resolved path) is `<workRoot>/.scratch`
 * or lies under it, at a component boundary (`.scratchpad` does not count).
 *
 * Dependencies: none.
 */
export function inScratch(abs: string, workRoot: string): boolean {
  if (workRoot === '' || !abs.startsWith('/')) return false;
  const base = lex(`${lex(workRoot)}/${SCRATCH_DIR}`);
  const p = lex(abs);
  return p === base || p.startsWith(`${base}/`);
}

/**
 * Resolve an operand against a working directory: absolute stays, relative
 * joins; null when the directory is unknown or the operand is not plain text
 * (`~`, `$VAR`, a command substitution).
 *
 * Dependencies: none.
 */
export function resolveOperand(word: string, cwd: string | null): string | null {
  if (/^[~$`]/.test(word) || word.includes('$(')) return null;
  if (word.startsWith('/')) return lex(word);
  if (cwd === null) return null;
  return lex(`${cwd}/${word}`);
}

/**
 * The working directory after a segment, when the segment is a `cd`/`pushd`:
 * the new directory, null when it cannot be followed, or `undefined` when the
 * segment is not a directory change at all.
 *
 * Dependencies: resolveOperand.
 */
export function cdTarget(segment: string, cwd: string | null): string | null | undefined {
  const m = /^\s*(?:cd|pushd)(?:\s+(\S+))?\s*$/.exec(segment);
  if (m === null) return undefined;
  const arg = (m[1] ?? '').replace(/["']/g, '');
  if (arg === '' || arg === '-') return null;
  return resolveOperand(arg, cwd);
}
