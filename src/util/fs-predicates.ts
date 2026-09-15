/**
 * `[ -f ]`, `[ -d ]` and `[ -x ]` — the shell file tests, once.
 *
 * ONE SHARED HOME, DELIBERATELY, not a convenience: every module that needs
 * one of these predicates imports it from here rather than re-deriving it, so
 * there is exactly one place a subtle divergence (see the `try`/`catch` note
 * below) could creep in.
 *
 * THE `try`/`catch` IS THE WHOLE POINT, and it is not defensive padding.
 * `[ -f "$p" ]` in `sh` is FALSE for a path that does not exist, for a path
 * whose parent is not a directory, for a dangling symlink, and for a path the
 * process may not stat — it never raises. `statSync` throws for every one of
 * those, so the catch is what makes the predicate answer the shell's question
 * rather than Node's.
 *
 * THEY FOLLOW SYMLINKS, because `[ -f ]` does: `statSync`, never `lstatSync`.
 * A symlink to a regular file IS a regular file to the shell, and the payload
 * roster walks trees that contain them.
 *
 * `isExecutableFile` is a genuinely DIFFERENT predicate from `isExecutable`
 * and does not collapse into it — see its own note below.
 */
import { accessSync, constants, statSync } from 'node:fs';

/** `[ -f "$p" ]` — a regular FILE, so a directory in the way is not one. */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `[ -d "$p" ]`. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `[ -x "$p" ]` — the EFFECTIVE permission, which is why this is `accessSync`
 * and not a mode-bit test on `statSync`. A file whose mode says 0755 is still
 * not executable to a process on a `noexec` mount or under a sandbox, and the
 * shell's `-x` reports what the process can actually do.
 */
export function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `[ -f "$p" ] && [ -x "$p" ]` BY MODE BIT — a DIFFERENT question from
 * `isExecutable` above, and the two must not be collapsed.
 *
 * `harness verify`'s `hooks-executable` check asks whether the hook file
 * CARRIES the execute bit, because a hook installed 0644 fails silently on
 * every event and is indistinguishable from one that never fired — that is a
 * property of the INSTALL, and the answer must not change with who is asking.
 * `isExecutable` asks the shell's `-x` question: the EFFECTIVE permission for
 * this process, which is legitimately false for a 0755 file on a `noexec`
 * mount or under a sandbox. Right for `task brief` deciding whether it can run
 * the sibling CLI; wrong for an installer reporting on a file it wrote.
 *
 * `(st.mode & 0o111) !== 0` is ANY of the three bits, not the owner's alone --
 * the same question `[ -x ]` reduces to for root, and the right one for an
 * installer that does not know who will later run the file.
 */
export function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
