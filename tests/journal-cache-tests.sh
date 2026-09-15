#!/bin/sh
# journal-cache-tests.sh — T-0139: the derived-value cache is a DERIVED file,
# and everything that walks the governance tree has to keep treating it as one.
#
# WHAT THIS SUITE USED TO DO, AND WHY IT NO LONGER DOES. It drove
# `cache_key` / `cache_put` / `cache_get` through a probe that sourced
# `lib.sh`, because T-0186 had already deleted findings-triage — the cache's
# only consumer — and the primitives were all that was left to exercise. The
# shell primitives are gone with the bash CLI; their port is
# `src/journal/cache.ts` and its behaviour (live hashing, absent-vs-empty
# keys, a corrupt entry falling through, `cachePut` never failing anything)
# is asserted directly against the module in the unit tier, which is where a
# primitive with no CLI surface belongs.
#
# THE MODULE STILL HAS NO CALLER, and that is stated rather than hidden: no
# reader in `src/` imports it. What survives here is the pair of claims that
# are about the REPO rather than about the mechanism — a derived file must
# never be sealed and must never be committed — because those two are what
# silently break the moment a reader does adopt it, and they are checkable
# without one.
# Run: sh tests/journal-cache-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- 1. the cache directory is named in exactly one place -------------
CACHESRC="$ROOT/src/journal/cache.ts"
[ -f "$CACHESRC" ] && ok || bad "src/journal/cache.ts is missing — the cache has no single home"
grep -q "^export const CACHE_DIR_NAME = '.cache';" "$CACHESRC" \
  && ok || bad "the cache directory name must be a constant, not a literal at each use site (D-0010)"

# --- 2. it is NOT sealed -----------------------------------------------
# Sealing a derived file breaks on every legitimate rebuild — the same
# reason the two graph indexes are excluded. The seal map's own glob is
# what has to keep it out, so the assertion is on the glob.
SEALSRC="$ROOT/src/journal/seals.ts"
grep -q "governance/.cache" "$SEALSRC" \
  && ok || bad "src/journal/seals.ts no longer explains why governance/.cache is outside the seal glob — a derived file cannot be sealed"

# --- 3. it is NOT committed --------------------------------------------
grep -q 'governance/.cache' "$ROOT/.gitignore" && ok \
  || bad "governance/.cache is not gitignored — a derived cache would land in commits and in the stray scan"

# --- 4. a dot directory is invisible to every governance sweep ---------
# `governance/*.json` does not match a leading dot, so nothing that walks
# the journals can see the cache. Proved against the real walker rather
# than argued: a planted cache entry must not become a records-check
# finding.
SANDBOX=$(mktemp -d) || { echo "journal-cache-tests: error: cannot create sandbox dir" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/governance/.cache"
for _j in log decisions issues exceptions tasks design sprints repo-health; do
  printf '{"entries": []}\n' > "$SANDBOX/governance/$_j.json"
done
printf 'not a real cached value\n' > "$SANDBOX/governance/.cache/deadbeef"
RC_OUT=$(GOV_ROOT="$SANDBOX" "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1); RC_RC=$?
printf '%s' "$RC_OUT" | grep -q '\.cache' \
  && bad "records check reported the derived cache as a governance record; got: $RC_OUT" || ok
[ "$RC_RC" -eq 0 ] \
  && ok || bad "a planted cache entry must not turn records check red — it is not a record; got rc=$RC_RC: $RC_OUT"

printf 'journal-cache-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "journal-cache-tests: error: $FAIL case(s) wrong — a derived file is being treated as a record (T-0139)" >&2; exit 1; }
