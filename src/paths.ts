/**
 * Path matching utilities for sandbox policy checks.
 *
 * We support exact prefix matching: a path is "covered" by a config entry
 * if the path starts with the resolved config path (as a directory prefix).
 */

import { resolveHome } from "./config.ts";

/** Check whether `path` starts with any prefix in `patterns` (resolved). */
export function matchesAnyPrefix(
  target: string,
  patterns: string[],
  home: string,
): boolean {
  const resolved = patterns.map((p) => resolveHome(p, home));

  // Normalise: strip trailing slash so `/home/user` matches `/home/user/foo`
  const normTarget = target.replace(/\/+$/, "");

  for (const rp of resolved) {
    const normPattern = rp.replace(/\/+$/, "");
    if (normTarget === normPattern) return true;
    // Check directory prefix: pattern /a/b matches /a/b/c but not /a/bc
    const withSep = normPattern.endsWith("/") ? normPattern : normPattern + "/";
    if (normTarget.startsWith(withSep)) return true;
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
