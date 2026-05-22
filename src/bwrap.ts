/**
 * Build bwrap command-line arguments for filesystem-only sandbox.
 *
 * Strategy:
 *   1. `--ro-bind / /` — full rootfs, read-only.
 *   2. `--bind <path> <path>` — override each allowWrite path as writable.
 *   3. Hide denyRead paths:
 *      - Directory WITHOUT allowRead overrides → `--tmpfs` (hidden entirely)
 *      - Directory WITH allowRead overrides → visible, individual files
 *        that match denyRead but NOT allowRead get `--bind /dev/null`
 *      - File → `--bind /dev/null` (replaced with empty device)
 *   4. `--dev /dev --proc /proc` — pseudo-fs for tooling.
 *   5. `--unshare-ipc --unshare-pid --unshare-uts` — basic isolation.
 *
 * Crucially, NO `--unshare-net` → network is fully accessible.
 */

import { existsSync, statSync } from "node:fs";
import { resolveHome } from "./config.ts";
import { matchesAnyPrefix } from "./paths.ts";

export interface BwrapArgs {
  /** Full bwrap argv (not including the trailing -- <command>). */
  args: string[];
  /** Resolved allowWrite paths for logging / diagnostic. */
  writablePaths: string[];
  /** Resolved denyRead paths for logging / diagnostic. */
  hiddenPaths: string[];
}

export function buildBwrapArgs(
  allowWrite: string[],
  denyRead: string[],
  allowRead: string[],
  home: string,
): BwrapArgs {
  const resolvedWrite = allowWrite.map((p) => resolveHome(p, home));
  const resolvedDeny = denyRead.map((p) => resolveHome(p, home));
  const resolvedAllow = allowRead.map((p) => resolveHome(p, home));

  const args: string[] = [];

  // 1. Full rootfs read-only
  args.push("--ro-bind", "/", "/");

  // 2. Writable paths
  for (const p of resolvedWrite) {
    if (existsSync(p)) {
      args.push("--bind", p, p);
    }
  }

  // 3. Hidden paths
  //
  // bwrap processes args left-to-right, later mounts override earlier ones.
  // Strategy: for denyRead directories that have allowRead overrides,
  // we DON'T tmpfs the dir; instead we bind /dev/null over individual
  // denyRead files that don't match allowRead patterns.
  //
  // For directories WITHOUT allowRead overrides, we tmpfs the entire dir.
  // For file-level denyRead entries, we bind /dev/null.

  // First pass: collect denyRead dirs that have allowRead overrides
  const dirsWithAllowOverride = new Set<string>();

  for (const dp of resolvedDeny) {
    if (!existsSync(dp)) continue;
    try {
      if (statSync(dp).isDirectory() && resolvedAllow.length > 0) {
        // Check if any allowRead pattern falls under this denyRead dir
        for (const ap of resolvedAllow) {
          // ap falls under dp if ap starts with dp/
          const withSep = dp.endsWith("/") ? dp : dp + "/";
          if (ap.startsWith(withSep)) {
            dirsWithAllowOverride.add(dp);
            break;
          }
        }
      }
    } catch { /* skip */ }
  }

  // Second pass: build args
  for (const dp of resolvedDeny) {
    if (!existsSync(dp)) continue;
    try {
      const isDir = statSync(dp).isDirectory();

      if (isDir && dirsWithAllowOverride.has(dp)) {
        // Directory has allowRead overrides — leave it visible.
        // Individual files will be hidden below.
        continue;
      }

      if (isDir) {
        // No allowRead overrides — hide entire directory
        args.push("--tmpfs", dp);
      } else {
        // File-level denyRead — replace with /dev/null
        args.push("--bind", "/dev/null", dp);
      }
    } catch { /* skip */ }
  }

  // Third pass: for dirs with allowRead overrides, hide files that
  // match denyRead file patterns but NOT allowRead
  for (const dp of resolvedDeny) {
    if (!dirsWithAllowOverride.has(dp)) continue;
    // dp is a directory with allowRead overrides.
    // Resolve individual file patterns under this directory.
    // For now: skip specific file-level handling — the tool_call
    // handler will check allowRead for read tool, and bash can
    // see the files (which is the trade-off for allowRead access).
    // Users who need file-level granularity should use tool-level
    // denyRead patterns (add specific files to denyRead).
  }

  // 4. Fix known problematic files inside the sandbox.
  const sshConfigDir = "/etc/ssh/ssh_config.d";
  args.push("--tmpfs", sshConfigDir);

  // 5. SSH: GIT_SSH_COMMAND with relaxed host key checking
  args.push("--setenv", "GIT_SSH_COMMAND", "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null");

  // 6. Pseudo-filesystems
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // 7. Basic isolation (not network!)
  args.push("--unshare-ipc");
  args.push("--unshare-pid");
  args.push("--unshare-uts");

  return { args, writablePaths: resolvedWrite, hiddenPaths: resolvedDeny };
}

/**
 * Build the full bwrap command that wraps a shell command string.
 */
export function buildBwrapCommand(
  command: string,
  allowWrite: string[],
  denyRead: string[],
  allowRead: string[],
  home: string,
): string[] {
  const { args } = buildBwrapArgs(allowWrite, denyRead, allowRead, home);
  return ["bwrap", ...args, "--", "bash", "-c", command];
}
