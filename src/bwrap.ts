/**
 * Build bwrap command-line arguments for filesystem-only sandbox.
 *
 * Strategy:
 *   1. `--ro-bind / /` — full rootfs, read-only.
 *   2. `--bind <path> <path>` — override each allowWrite path as writable.
 *   3. `--tmpfs <path>` — hide each denyRead path (empty tmpfs).
 *   4. `--dev /dev --proc /proc` — pseudo-fs for tooling.
 *   5. `--unshare-ipc --unshare-pid --unshare-uts` — basic isolation.
 *
 * Crucially, NO `--unshare-net` → network is fully accessible.
 *
 * NOTE: --tmpfs targets MUST exist on disk before bwrap runs (bwrap
 * cannot mkdir inside a --ro-bind rootfs). Call ensureBwrapDirs()
 * before spawning the bwrap process.
 */

import { existsSync } from "node:fs";
import { resolveHome } from "./config.ts";

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
  home: string,
): BwrapArgs {
  const resolvedWrite = allowWrite.map((p) => resolveHome(p, home));
  const resolvedDeny = denyRead.map((p) => resolveHome(p, home));

  const args: string[] = [];

  // 1. Full rootfs read-only
  args.push("--ro-bind", "/", "/");

  // 2. Writable paths
  // bwrap needs the source to exist on the host for --bind.
  for (const p of resolvedWrite) {
    if (existsSync(p)) {
      args.push("--bind", p, p);
    }
  }

  // 3. Hidden paths (tmpfs — empty, no-op inside the sandbox)
  //
  // IMPORTANT: bwrap's --tmpfs requires the target directory to already
  // exist — it cannot mkdir inside a --ro-bind rootfs. We ensure this
  // by creating the dir on the host first. For denyRead paths that
  // don't exist on the host, there's nothing to hide, so we skip them.
  for (const p of resolvedDeny) {
    // Ensure the mount point exists so bwrap can mount tmpfs over it.
    // If the path doesn't exist on host, skip it (nothing to hide).
    if (existsSync(p)) {
      args.push("--tmpfs", p);
    }
  }

  // 4. Fix known problematic files inside the sandbox.
  // /etc/ssh/ssh_config.d/ files owned by nobody break SSH's strict
  // ownership check. Override them with /dev/null.
  const sshConfigDir = "/etc/ssh/ssh_config.d";
  args.push("--tmpfs", sshConfigDir);

  // 5. SSH: ensure host key check works without known_hosts
  // (the user's ~/.ssh/ may be hidden by denyRead)
  args.push("--setenv", "GIT_SSH_COMMAND", "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null");

  // 6. Pseudo-filesystems
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // 5. Basic isolation (not network!)
  args.push("--unshare-ipc");
  args.push("--unshare-pid");
  args.push("--unshare-uts");

  return { args, writablePaths: resolvedWrite, hiddenPaths: resolvedDeny };
}

/**
 * Build the full bwrap command that wraps a shell command string.
 * Returns ["bwrap", ...args, "--", "bash", "-c", command].
 */
export function buildBwrapCommand(
  command: string,
  allowWrite: string[],
  denyRead: string[],
  home: string,
): string[] {
  const { args } = buildBwrapArgs(allowWrite, denyRead, home);
  return ["bwrap", ...args, "--", "bash", "-c", command];
}
