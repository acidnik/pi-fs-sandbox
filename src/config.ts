/**
 * Config for pi-fs-sandbox.
 *
 * Stored at ~/.pi/agent/fs-sandbox.json
 *
 * Fields:
 *   enabled     — whether fs-sandbox is active (default: false)
 *   allowWrite  — paths where write access is granted inside bwrap
 *                 (everything else is read-only via --ro-bind / /)
 *   denyRead    — paths hidden inside bwrap via --tmpfs
 *
 * denyRead takes precedence: paths listed in both are hidden.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface FsSandboxConfig {
  enabled?: boolean;
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
}

const DEFAULT_CONFIG: Required<FsSandboxConfig> = {
  enabled: false,
  allowWrite: [],
  denyRead: [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.config/git",
    "~/.config/gh",
  ],
  denyWrite: [],
};

function getConfigPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "fs-sandbox.json");
}

/**
 * Attempt to parse JSON with trailing commas fixed.
 * JSON5-style trailing commas are a common source of parse failures
 * when users manually edit the config.
 */
function parseJsonRobust(raw: string): any {
  // First try normal parse
  try {
    return JSON.parse(raw);
  } catch {
    // Remove trailing commas before ] and } (in arrays and objects)
    const cleaned = raw.replace(/,\s*(\]|\})/g, "$1");
    return JSON.parse(cleaned);
  }
}

export function loadConfig(home: string = homedir()): Required<FsSandboxConfig> {
  const path = getConfigPath(home);

  if (!existsSync(path)) {
    ensureDefaultConfig(home);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = parseJsonRobust(readFileSync(path, "utf-8")) as FsSandboxConfig;
    return {
      enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
      allowWrite: raw.allowWrite ?? DEFAULT_CONFIG.allowWrite,
      denyRead: raw.denyRead ?? DEFAULT_CONFIG.denyRead,
      denyWrite: raw.denyWrite ?? DEFAULT_CONFIG.denyWrite,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: FsSandboxConfig, home: string = homedir()): void {
  const path = getConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function ensureDefaultConfig(home: string = homedir()): void {
  const path = getConfigPath(home);
  if (!existsSync(path)) {
    saveConfig(DEFAULT_CONFIG, home);
  }
}

/** Resolve ~/ in a path to the user's home dir. */
export function resolveHome(p: string, home: string): string {
  if (p.startsWith("~")) return join(home, p.slice(1));
  return resolve(p);
}
