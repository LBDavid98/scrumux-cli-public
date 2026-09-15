/**
 * The scope-text scan of `task lint` (I-0130): which tokens in an order's
 * scope PROSE name a file the order does not list.
 *
 * RECALL-FIRST, TELL-ONLY, and still so. What changed (SX-011, 2026-09-13):
 * the scan treated ANY token containing `/` as a file, so an API-heavy order
 * drowned its one real finding under `/healthz`, `/api/vault`, `//127.0.0.1`,
 * `GATEWAY_URL/v1/entitlement` and `Sources/_index` (Rover SP-0002).
 * Those shapes are now recognised as NOT files, by their spelling and -- for
 * the one shape spelling cannot settle -- by whether the path exists:
 *
 *   - a URL (`scheme://…`) or a `host:port[/…]` string is removed before
 *     tokenising, so none of its pieces is read as a path;
 *   - a token starting `//` is a protocol-relative or bare host;
 *   - a token whose first segment is an ALL_CAPS name (`GATEWAY_URL/v1/x`) is
 *     an environment variable plus a route;
 *   - a token starting `/` whose last segment has no extension is an HTTP
 *     route (`/healthz`, `/api/vault`) unless it exists on this machine;
 *   - a relative token whose last segment has no extension (`Sources/_index`,
 *     `app/src`) counts only when it exists under the work root -- a directory
 *     the order mentions is still caught, a label in an external system is not.
 *
 * Anything with an extension (`src/new.ts`, `/srv/x/doc.md`, `.env`) is still
 * a path whether or not it exists yet: that is the file a session will create
 * and the close will refuse unless the order lists it.
 *
 * Depends on: node:fs `existsSync`, node:path. Pure apart from the existence probe.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** `scheme://…` and `host:port[/…]` spans, removed before tokenising. */
const URL_SPAN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g;
const HOST_PORT_SPAN = /\b[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{2,5}(?:\/\S*)?/g;
const KNOWN_SUFFIX = /\.(py|sh|json|md|MD)$/;
const HAS_EXTENSION = /(^|\/)[^/]*\.[A-Za-z0-9]{1,10}$/;
const ENV_PREFIX = /^[A-Z][A-Z0-9_]*_[A-Z0-9_]*\//;

/**
 * Is this token a file path worth flagging, rather than a URL, route, host or
 * external label?
 *
 * Depends on: `existsSync` (only for extensionless tokens).
 */
export function isFileShaped(tok: string, workRoot: string): boolean {
  if (!(tok.includes('/') || KNOWN_SUFFIX.test(tok))) return false;
  if (/^[DITSFE]-[0-9]/.test(tok)) return false;
  if (tok.startsWith('//')) return false;
  if (ENV_PREFIX.test(tok)) return false;
  if (HAS_EXTENSION.test(tok)) return true;
  const onDisk = isAbsolute(tok) ? tok : join(workRoot, tok);
  return existsSync(onDisk);
}

/**
 * The file-shaped tokens of `scopeText` that `listed` does not contain, each
 * once, in order of first mention.
 *
 * The tokenisation is the C-locale `tr -c 'A-Za-z0-9_./-'` port the scan always
 * used, applied after URL and host:port spans are removed; a sentence-ending
 * period is not part of a path.
 *
 * Depends on: `isFileShaped`.
 */
export function unlistedScopePaths(
  scopeText: string, listed: readonly string[], workRoot: string, workDirs: readonly string[] = [],
): string[] {
  const have = listed.filter((p) => p !== '');
  const out: string[] = [];
  const text = scopeText.replace(URL_SPAN, ' ').replace(HOST_PORT_SPAN, ' ');
  for (const raw of text.replace(/[^A-Za-z0-9_./-]/g, ' ').split(/\s+/)) {
    const tok = raw.replace(/\.+$/, '').replace(/^\.\//, '');
    if (tok === '' || out.includes(tok) || namesListed(tok, have, workDirs)) continue;
    if (isFileShaped(tok, workRoot)) out.push(tok);
  }
  return out;
}

/**
 * Does a prose token name a path the order already lists (SX-027)?
 *
 *   - exactly;
 *   - under a directory the verification command works in (`cd agents &&`,
 *     `uv run --directory agents`): `tests/test_fast.py` is
 *     `agents/tests/test_fast.py`;
 *   - as a package-relative spelling: a token with a `/` that ends a listed
 *     path at a `/` boundary (`src/runs.ts` for `app/src/runs.ts`), or a bare
 *     file name that ends exactly ONE listed path — `index.ts` with two
 *     listed `…/index.ts` is still flagged, since the scan is recall-first.
 *
 * Depends on: nothing. Pure.
 */
export function namesListed(tok: string, listed: readonly string[], workDirs: readonly string[] = []): boolean {
  if (listed.includes(tok)) return true;
  if (workDirs.some((d) => listed.includes(`${d}/${tok}`))) return true;
  const suffixed = listed.filter((p) => p.endsWith(`/${tok}`)).length;
  return tok.includes('/') ? suffixed >= 1 : suffixed === 1;
}
