/**
 * Settings inspection: `missingChains`, `hookTargets`, `settingsFixText`,
 * plus the `ls -l | cut -c1-10` mode string the hooks-executable check
 * prints.
 *
 * ONE PARSE INSTEAD OF TWO SUBPROCESS jq INVOCATIONS, same predicate — the
 * module brief sanctions exactly this. What is preserved with care is the
 * FAILURE SHAPE: any unparseable shape (an unparseable file, a `.hooks` that
 * is a string, a non-string matcher) yields the EMPTY answer, and the
 * callers read empty as "nothing missing" / "no commands". That is a
 * recorded looseness (module brief, open question 2 — deploy reports "all
 * chains present" over a settings.json it never parsed) and it is
 * deliberate, not a bug: every helper here swallows its own errors into
 * that same empty answer.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isExecutableFile, isFile } from '../../util/fs-predicates.js';

function isObj(v: unknown): v is { [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The space-separated names of the hook chains this file does NOT declare,
 * in the fixed roster order. Empty string = all of them present (or the
 * file could not be interrogated at all).
 *
 * The names here must stay in step with HOOK_CHAINS (payload.ts): this is
 * the only other place the roster is written, because each chain needs its
 * own matcher pattern and the map cannot be derived from a name.
 */
export function missingChains(doc: unknown): string {
  try {
    if (!isObj(doc)) throw new Error('not an object');
    const hooksVal = doc['hooks'];
    const chain = (ev: string, m: string): boolean => {
      // `.hooks[$ev] // []` — a missing .hooks or a missing event key is [];
      // a non-indexable .hooks (string, number) is a jq error, which the
      // enclosing try turns into the empty answer.
      let arr: unknown;
      if (hooksVal === undefined || hooksVal === null) arr = [];
      else if (isObj(hooksVal)) arr = hooksVal[ev] ?? null;
      else throw new Error('hooks is not indexable');
      let items: unknown[];
      if (arr === null || arr === undefined) items = [];
      else if (Array.isArray(arr)) items = arr;
      else if (isObj(arr)) items = Object.values(arr); // `[]` iterates an object's values
      else throw new Error('chain entry is not iterable');
      let n = 0;
      for (const it of items) {
        if (m === '') { n += 1; continue; }
        // `null | .matcher` is null in jq, not an error — a null element
        // simply fails the match. Any other non-object element DOES error
        // ("Cannot index string…"), collapsing the whole answer to ''.
        if (it === null) continue;
        if (!isObj(it)) throw new Error('entry is not an object');
        const matcher = it['matcher'];
        // `.matcher // ""` — jq's `//` treats false like null, so a literal
        // `false` matcher means "no matcher", never a type error.
        const s = matcher === null || matcher === undefined || matcher === false ? '' : matcher;
        if (typeof s !== 'string') throw new Error('matcher is not a string');
        if (new RegExp(m).test(s)) n += 1;
      }
      return n > 0;
    };
    const missing: string[] = [];
    // THE SHELL CHAIN MUST COVER BOTH SHELL TOOLS, and `Bash` alone no longer
    // does. On Windows without Git Bash, Claude Code does not register the
    // Bash tool at ALL and routes every shell command through the PowerShell
    // tool; the hooks doc says it in as many words — "a hook that matches only
    // `Bash` never fires there". A chain declared `"Bash"` is therefore not a
    // chain that is present-but-narrow, it is FOUR WALLS THAT DO NOT RUN on
    // Windows, with nothing in the transcript to say so.
    //
    // So this asks for both tool names rather than testing one pattern, which
    // is the one place the roster's "does the declared matcher match this
    // pattern" shape is not enough. Reporting "all 4 chains declared" over a
    // matcher that cannot fire here would be verify claiming a property it did
    // not compute.
    if (!(chain('PreToolUse', 'Bash') && chain('PreToolUse', 'PowerShell'))) {
      missing.push('PreToolUse:Bash|PowerShell');
    }
    if (!chain('PreToolUse', 'Read')) missing.push('PreToolUse:Read');
    if (!chain('PreToolUse', 'Edit')) missing.push('PreToolUse:Edit|Write|NotebookEdit');
    if (!chain('SessionStart', 'startup|resume')) missing.push('SessionStart');
    return missing.join(' ');
  } catch {
    return '';
  }
}

/**
 * ONE DECLARED HOOK, IN THE TWO FORMS CLAUDE CODE RUNS THEM.
 *
 * A prior shape answered with just the raw `.command` string and left
 * callers to cut it at the first space to get a path. That is right for
 * SHELL FORM and
 * silently wrong for EXEC FORM, where `command` is the EXECUTABLE (`node`) and
 * the script is `args[0]`: the old cut yields the word "node", `[ -f node ]`
 * is false, and deploy would report every wall as a dead hook while verify
 * reported the same four as missing. So the shape of the answer has to carry
 * WHICH FORM the hook is in.
 */
export type HookForm = 'exec' | 'shell';

export interface HookTarget {
  /** exec when `args` is a non-empty array, shell otherwise — the doc's rule. */
  form: HookForm;
  /**
   * exec: the executable Claude Code resolves on PATH and spawns.
   * shell: '' — a shell-form hook has no separate program, the shell is it.
   */
  program: string;
  /**
   * The FILE this hook needs on disk. exec form's `args[0]`, or the shell
   * command cut at its first space. Placeholders are NOT expanded here; the
   * caller knows which target root to expand against.
   */
  file: string;
  /** The declared `command`, verbatim, for messages. */
  raw: string;
}

/**
 * Every hook a chain declares, in form.
 * `.hooks // {} | to_entries[] | .value[]? | .hooks[]? |
 *  select((.type // "command") == "command")` and then the form split.
 *
 * The error-to-empty discipline of the rest of this module is preserved
 * exactly: any shape that would make that jq filter raise collapses the
 * whole answer to the empty list, matching `missingChains`' failure shape.
 */
export function hookTargets(doc: unknown): HookTarget[] {
  const out: HookTarget[] = [];
  try {
    if (!isObj(doc)) throw new Error('not an object');
    const hooksVal = doc['hooks'];
    const hooks = hooksVal === null || hooksVal === undefined ? {} : hooksVal;
    if (!isObj(hooks)) throw new Error('hooks is not an object');
    for (const value of Object.values(hooks)) {
      // `.value[]?` — iterate arrays (and objects' values); anything else is
      // silently skipped by the `?`.
      let items: unknown[];
      if (Array.isArray(value)) items = value;
      else if (isObj(value)) items = Object.values(value);
      else continue;
      for (const item of items) {
        // `.hooks[]?` — same shape, errors suppressed per element.
        if (!isObj(item)) continue;
        const inner = item['hooks'];
        let hs: unknown[];
        if (Array.isArray(inner)) hs = inner;
        else if (isObj(inner)) hs = Object.values(inner);
        else continue;
        for (const h of hs) {
          if (!isObj(h)) continue;
          const type = h['type'] === null || h['type'] === undefined || h['type'] === false
            ? 'command' : h['type'];
          if (type !== 'command') continue;
          const cmd = h['command'];
          if (cmd === null || cmd === undefined || cmd === false) continue; // `// empty`
          const raw = typeof cmd === 'string' ? cmd : String(cmd);
          const args = h['args'];
          if (Array.isArray(args) && args.length > 0) {
            const a0 = args[0];
            out.push({
              form: 'exec',
              program: raw,
              file: a0 === null || a0 === undefined || a0 === false ? '' : String(a0),
              raw,
            });
          } else {
            // `${hp%% *}` — the shell-form cut, kept HERE rather than in the
            // two callers so exec form cannot accidentally inherit it.
            const sp = raw.indexOf(' ');
            out.push({ form: 'shell', program: '', file: sp === -1 ? raw : raw.slice(0, sp), raw });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `sed -e "s|\${CLAUDE_PROJECT_DIR}|$TARGET|g" -e "s|\$CLAUDE_PROJECT_DIR|$TARGET|g"`.
 *
 * BOTH SPELLINGS ARE EXPANDED HERE AND ONLY ONE IS WRITTEN, and that is not a
 * contradiction. The payload writes the BRACED form exclusively, because that
 * is the only one Claude Code rewrites for a PowerShell hook — the bare
 * `$CLAUDE_PROJECT_DIR` is parsed by PowerShell as an undefined local and
 * resolves to `$null`, which silently strips the project root off the front of
 * the path and leaves the hook pointing at `\.claude\dist\...`. But verify and
 * deploy run against repos deployed YEARS ago, and every one of those carries
 * the bare form. A reader that understood only the new spelling would report
 * every legacy repo's hooks as missing, which is the opposite of the truth.
 *
 * Braced first: expanding the bare form first would eat the `$CLAUDE_PROJECT_DIR`
 * inside `${CLAUDE_PROJECT_DIR}` and leave a stray `{...}` behind.
 */
export function expandProjectDir(s: string, target: string): string {
  return s.split('${CLAUDE_PROJECT_DIR}').join(target).split('$CLAUDE_PROJECT_DIR').join(target);
}

/** The exact remedy line both verbs print. */
export function settingsFixText(srcClaude: string, target: string): string {
  return `copy the missing chain(s) from ${srcClaude}/settings.json into ${target}/.claude/settings.json under .hooks (deploy will not merge for you); if the existing file has nothing worth keeping: cp ${srcClaude}/settings.json ${target}/.claude/settings.json`;
}

/**
 * `ls -l <file> | cut -c1-10` for a regular file: the type dash and the nine
 * permission characters, setuid/setgid/sticky included. Printed by verify's
 * hooks-executable failure.
 */
export function lsMode(mode: number): string {
  const triplet = (shift: number, special: boolean, specialChar: [string, string]): string => {
    const r = (mode >> (shift + 2)) & 1 ? 'r' : '-';
    const w = (mode >> (shift + 1)) & 1 ? 'w' : '-';
    const xBit = (mode >> shift) & 1;
    let x: string;
    if (special) x = xBit ? specialChar[0] : specialChar[1];
    else x = xBit ? 'x' : '-';
    return r + w + x;
  };
  const setuid = (mode & 0o4000) !== 0;
  const setgid = (mode & 0o2000) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  return '-'
    + triplet(6, setuid, ['s', 'S'])
    + triplet(3, setgid, ['s', 'S'])
    + triplet(0, sticky, ['t', 'T']);
}

/**
 * Can this platform find and start `program`? — `command -v`, cross-platform.
 *
 * A bare name is looked up on PATH, with PATHEXT applied on Windows, because
 * exec form's contract is "Claude Code resolves `command` as an executable on
 * PATH". A name carrying a separator is a path and is tested as one. This is
 * the question `[ -x ]` was standing in for and could not ask: whether the
 * thing that has to START can be found.
 */
export function programResolves(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (program === '') return false;
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  if (program.includes('/') || (win && program.includes('\\'))) {
    return win ? isFile(program) : isExecutableFile(program);
  }
  // PATHEXT is what makes `node` find `node.exe`. Its absence is not an error
  // — a Windows box with PATHEXT unset still resolves the documented set — so
  // the default is spelled out rather than left to fail closed on a missing
  // variable, which would refuse every session on a machine that works.
  const exts = win
    ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
    : [''];
  for (const dir of (env['PATH'] ?? '').split(sep)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const p = `${dir}${win ? '\\' : '/'}${program}${ext}`;
      // On Windows the execute BIT does not exist; being a regular file on
      // PATH with an executable extension is the whole of the question there.
      if (win ? isFile(p) : isExecutableFile(p)) return true;
    }
  }
  return false;
}

/**
 * WHY THIS REPLACED A MODE-BIT TEST (audit finding F2's spirit).
 *
 * The old check asked one question — does this file carry `0o111`? — and
 * printed "every hook declared in settings.json exists and carries the execute
 * bit". On NTFS that sentence is not false so much as MEANINGLESS: there is no
 * POSIX mode bit there, Node synthesises one, and a check may only claim what
 * it computes. Worse, it was silent about the two ways a hook is dead on
 * Windows and fine on macOS — an exec-form `command` that is not on PATH, and
 * a `#!/bin/sh` file that no Windows shell can execute.
 *
 * So the question is now the one that matters on both: CAN THIS HOOK START
 * HERE? Returns '' when it can, or the failure clause naming why.
 *
 * @param target the deployed repo, for expanding the placeholder.
 */
export function hookStartProblem(
  t: HookTarget,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): { path: string; why: string } | null {
  const win = platform === 'win32';
  const file = expandProjectDir(t.file, target);

  if (t.form === 'exec') {
    const program = expandProjectDir(t.program, target);
    if (!programResolves(program, env, platform)) {
      return { path: program, why: `(exec form: '${program}' does not resolve to an executable on PATH here)` };
    }
    if (file !== '' && !isFile(file)) return { path: file, why: '(missing)' };
    return null;
  }

  // ---- shell form -------------------------------------------------------
  if (!isFile(file)) return { path: file, why: '(missing)' };
  if (win) {
    // A shell-form hook on Windows runs under PowerShell when Git Bash is
    // absent, and PowerShell cannot execute a `#!/bin/sh` file: there is no
    // shebang honouring on Windows, so the four wall SHIMS are inert there.
    // That is the third of the three ways the walls failed open on a stock
    // Windows box, and it is reported rather than assumed away.
    if (shebangOf(file) !== '') {
      return {
        path: file,
        why: `(shell form: '${shebangOf(file)}' — Windows has no shebang handling and PowerShell cannot execute this file; redeploy so settings.json names the exec-form hook)`,
      };
    }
    return null;
  }
  if (!isExecutableFile(file)) {
    return { path: file, why: `(mode ${lsMode(statSync(file).mode)}, not executable)` };
  }
  return null;
}

/** The `#!...` line of a file, or '' — read as bytes, never decoded whole. */
function shebangOf(p: string): string {
  try {
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = readSync(fd, buf, 0, 128, 0);
      const head = buf.subarray(0, n).toString('utf8');
      if (!head.startsWith('#!')) return '';
      const nl = head.indexOf('\n');
      return (nl === -1 ? head : head.slice(0, nl)).trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}
