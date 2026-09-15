/**
 * THE ROOT CONSTITUTION LANE, decided purely (R-021, D-S030, SX-018).
 *
 * Deploy installs the payload constitution at the target's root. A repo that
 * had its OWN `CLAUDE.md` keeps it verbatim as `CLAUDE.pre-harness.md`, and the
 * installed constitution ends with a pointer to it. That pointer used to be
 * appended once, on the deploy that preserved the file: the next deploy saw a
 * constitution that was "ours" but not byte-equal to the payload, copied the
 * payload over it and dropped the pointer — the repo's own rules stayed on
 * disk with nothing telling a session to read them.
 *
 * So the lane is stated as a DESIRED STATE rather than as edits: the payload
 * constitution, plus the pointer exactly once whenever `CLAUDE.pre-harness.md`
 * exists. Every deploy compares the target to that and writes it whole, so the
 * pointer can neither vanish nor repeat.
 *
 * Depends on: nothing (pure).
 */

/** Appended to the installed constitution while `CLAUDE.pre-harness.md` exists. */
export const CLAUDE_POINTER = '\n## This repo had its own CLAUDE.md\n\nIt is preserved verbatim at `CLAUDE.pre-harness.md` and it still\napplies. Read it. Where it and this file disagree about how THIS repo\nworks, it wins; where they disagree about the governance loop, this file\nwins, and the disagreement is worth reporting.\n';

/** The marker that says a root constitution was written by a deploy, not by the repo. */
export const OURS_MARKER = 'governed by the **harness**';

/** What the root `CLAUDE.md` should be. Depends on: nothing. */
export function desiredConstitution(payload: Buffer, preservedExists: boolean): Buffer {
  return preservedExists ? Buffer.concat([payload, Buffer.from(CLAUDE_POINTER)]) : payload;
}

/**
 * The act for the root `CLAUDE.md`:
 *   install   — none there;
 *   unchanged — already the desired bytes;
 *   update    — a constitution a deploy wrote, now different from desired
 *               (an older payload, or the pointer lost or doubled);
 *   preserve  — the repo's own: keep it aside, then install with the pointer.
 * Depends on: `desiredConstitution`, `OURS_MARKER`.
 */
export function constitutionAct(
  current: Buffer | null, payload: Buffer, preservedExists: boolean,
): 'install' | 'unchanged' | 'update' | 'preserve' {
  if (current === null) return 'install';
  if (current.equals(desiredConstitution(payload, preservedExists))) return 'unchanged';
  if (current.toString('utf8').includes(OURS_MARKER)) return 'update';
  return 'preserve';
}
