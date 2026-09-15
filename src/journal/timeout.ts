/**
 * Runs `sh -c <command>` with a timeout, giving it the exit-code contract a
 * POSIX shell gives a killed or failed command.
 *
 * THE OBSERVABLE CONTRACT IS THE EXIT CODE: the command's own, or 142
 * (128 + SIGALRM) when the timer fires, or 127 when the shell itself could
 * not exec the command, or 128 + N when the command died of signal N.
 *
 * `seconds <= 0` MEANS "no timeout" -- the disposition a registered health
 * check declaring `timeout_seconds: 0` expects.
 *
 * THE WHOLE PROCESS GROUP IS STOPPED ON TIMEOUT (SX-029). `spawnSync`'s own
 * `timeout` signals only the pid it started, so a check that forked — a `&`,
 * a subshell, a helper script — left its descendants running after the CLI
 * reported TIMED OUT (Rover T-0016: a killed check's in-flight runs kept
 * writing vault records). The CLI is synchronous, so the command runs under a
 * small supervisor (`SUPERVISOR`, `node -e`), which starts `sh -c` DETACHED —
 * its own process group — and on timeout sends SIGTERM to the group, then
 * SIGKILL after `GRACE_MS`; on Windows it tree-kills with `taskkill /t /f`.
 * The supervisor reports the child's code, signal and whether it timed out
 * as one JSON line on fd 3, and the caller maps it to the same exit-code
 * contract as before.
 *
 * A timeout counts until the command's output streams CLOSE, as before: a
 * descendant still holding them is still part of the check.
 *
 * Dependencies: node:child_process (spawnSync), the running node binary.
 */
import { spawnSync } from 'node:child_process';

/** POSIX signal numbers for the signals a shell can report here. */
const SIGNUM: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 10,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 30,
  SIGSEGV: 11,
  SIGUSR2: 31,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** How long a timed-out group gets between SIGTERM and SIGKILL. */
export const GRACE_MS = 5000;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Collect the child's streams instead of letting them through, so the caller can capture or inspect them. */
  capture?: boolean;
  /** Merge the child's stderr into `stdout`, as `2>&1` does. */
  combine?: boolean;
}

export interface RunResult {
  /** The command's rc, or 142 on timeout, or 127 when it could not start. */
  code: number;
  /** True when the run was cut short by the timer. */
  timedOut: boolean;
  /** The signal the command died of (SIGALRM on a timeout), or null. */
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * The supervisor, run as `node -e SUPERVISOR <ms> <graceMs> <command>`. It
 * writes `{code, signal, timedOut}` to fd 3 and exits 0; `code: 127` when
 * `sh` could not start.
 */
export const SUPERVISOR = `
const { spawn, spawnSync } = require('node:child_process');
const { writeSync } = require('node:fs');
const [ms, grace, command] = [Number(process.argv[1]), Number(process.argv[2]), process.argv[3]];
const win = process.platform === 'win32';
const report = (r) => { try { writeSync(3, JSON.stringify(r)); } catch {} };
let child;
try {
  child = spawn('sh', ['-c', command], { detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
} catch { report({ code: 127, signal: null, timedOut: false }); process.exit(0); }
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let timedOut = false;
let exitCode = null;
let exitSignal = null;
let done = false;
const stopGroup = (sig) => {
  if (win) { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']); return; }
  try { process.kill(-child.pid, sig); } catch {}
};
const finish = () => {
  if (done) return;
  done = true;
  report({ code: exitCode, signal: exitSignal, timedOut });
  process.exitCode = 0;
  if (timedOut) process.exit(0);
};
let hard = null;
const timer = ms > 0 ? setTimeout(() => {
  timedOut = true;
  stopGroup('SIGTERM');
  hard = setTimeout(() => { stopGroup('SIGKILL'); finish(); }, grace);
}, ms) : null;
child.on('error', () => { if (timer) clearTimeout(timer); report({ code: 127, signal: null, timedOut: false }); process.exit(0); });
child.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });
child.on('close', () => {
  if (timer) clearTimeout(timer);
  if (hard) clearTimeout(hard);
  finish();
});
`;

/**
 * Run `sh -c command` under the supervisor, bounded by `seconds`.
 *
 * Dependencies: SUPERVISOR, spawnSync, process.execPath.
 */
export function runWithTimeout(seconds: number, command: string, opts: RunOptions = {}): RunResult {
  const ms = seconds > 0 ? Math.round(seconds * 1000) : 0;
  const res = spawnSync(process.execPath, ['-e', SUPERVISOR, String(ms), String(GRACE_MS), command], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    stdio: opts.capture === true ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });

  const rawOut = typeof res.stdout === 'string' ? res.stdout : '';
  const rawErr = typeof res.stderr === 'string' ? res.stderr : '';
  const combine = opts.combine === true;
  const stdout = combine ? rawOut + rawErr : rawOut;
  const stderr = combine ? '' : rawErr;

  const r = supervisorReport(res.output?.[3]);
  if (r === null) return { code: 127, timedOut: false, signal: null, stdout, stderr };
  if (r.timedOut) return { code: 128 + SIGNUM['SIGALRM']!, timedOut: true, signal: 'SIGALRM', stdout, stderr };
  if (r.signal !== null) return { code: 128 + (SIGNUM[r.signal] ?? 0), timedOut: r.signal === 'SIGALRM', signal: r.signal, stdout, stderr };
  return { code: r.code ?? 127, timedOut: false, signal: null, stdout, stderr };
}

/**
 * The supervisor's one-line JSON report on fd 3, or null when it wrote none
 * (it could not start) — read as "the shell could not be started", 127.
 * A child that died of a signal is REPORTED, never re-raised on the
 * supervisor: node gives SIGUSR1 to its debugger rather than dying of it.
 *
 * Dependencies: none.
 */
function supervisorReport(raw: unknown): { code: number | null; signal: string | null; timedOut: boolean } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const o = JSON.parse(raw) as { code?: unknown; signal?: unknown; timedOut?: unknown };
    return {
      code: typeof o.code === 'number' ? o.code : null,
      signal: typeof o.signal === 'string' ? o.signal : null,
      timedOut: o.timedOut === true,
    };
  } catch {
    return null;
  }
}
