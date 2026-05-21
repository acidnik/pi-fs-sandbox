/**
 * Path matching utilities for sandbox policy checks.
 *
 * Supports:
 *  - Exact match: `/home/user/file` matches `/home/user/file`
 *  - Directory prefix: `~/.ssh` matches `/home/nik/.ssh/id_rsa`
 *  - Trailing glob: `~/.ssh/*` matches `/home/nik/.ssh/id_rsa` (same as dir prefix)
 *  - Name glob: `~/.ssh/id_rsa*` matches `/home/nik/.ssh/id_rsa` and `/home/nik/.ssh/id_rsa.pub`
 */

import { resolveHome } from "./config.ts";

function normalize(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Check whether `path` matches a single pattern (resolved). */
function matchesSingle(target: string, pattern: string): boolean {
  const normTarget = normalize(target);
  const normPattern = normalize(pattern);

  // Exact match
  if (normTarget === normPattern) return true;

  // Trailing glob `*` — match prefix
  if (normPattern.endsWith("*")) {
    const prefix = normalize(normPattern.slice(0, -1));
    if (normTarget.startsWith(prefix)) return true;
  }

  // Directory prefix: pattern /a/b matches /a/b/c but not /a/bc
  const withSep = normPattern.endsWith("/") ? normPattern : normPattern + "/";
  if (normTarget.startsWith(withSep)) return true;

  return false;
}

/** Check whether `path` matches any pattern in `patterns` (resolved). */
export function matchesAnyPrefix(
  target: string,
  patterns: string[],
  home: string,
): boolean {
  const resolved = patterns.map((p) => resolveHome(p, home));
  for (const rp of resolved) {
    if (matchesSingle(target, rp)) return true;
  }
  return false;
}

/** Check if target is inside denyRead */
export function isDenyRead(
  target: string,
  denyRead: string[],
  home: string,
): boolean {
  return matchesAnyPrefix(target, denyRead, home);
}

/** Check if target is inside allowWrite */
export function isAllowWrite(
  target: string,
  allowWrite: string[],
  home: string,
): boolean {
  return matchesAnyPrefix(target, allowWrite, home);
}
