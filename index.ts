/**
 * pi-fs-sandbox — filesystem-only sandbox for pi via bwrap.
 *
 * Unlike the full pi-sandbox, this extension:
 *  - Only restricts filesystem access (no network isolation)
 *  - Uses raw bwrap directly instead of @anthropic-ai/sandbox-runtime
 *  - Has a minimal config ~/.pi/agent/fs-sandbox.json
 *
 * Commands:
 *  /fs-sandbox         — show current status and effective config
 *  /fs-sandbox-enable  — start sandboxing bash commands
 *  /fs-sandbox-disable — stop sandboxing bash commands
 *
 * When a blocked access is detected, the user is prompted with choices:
 *  - "Allow once" — temporary for this session
 *  - "Allow and save" — persist to config
 *  - "Block" — deny access
 *
 * How it works:
 *  - Overrides the built-in `bash` tool to run inside bwrap
 *    with --ro-bind / / (default read-only), plus --bind for
 *    allowed write paths and --tmpfs for denied read paths.
 *  - Intercepts read/write/edit tool calls to check policy
 *    (since those use Node.js fs, not bash).
 *  - Never passes --unshare-net — full network access.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashToolDefinition,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { buildBwrapArgs, buildBwrapCommand } from "./src/bwrap.ts";
import { loadConfig, saveConfig, ensureDefaultConfig, resolveHome } from "./src/config.ts";
import { isAllowWrite, isDenyRead, matchesAnyPrefix } from "./src/paths.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

type AllowanceKind = "read" | "write";

/**
 * Compute the "effective" allowWrite list: config paths + session additions.
 * denyRead is more nuanced: if a user allowed a path for read, we remove it
 * from denyRead if it was denied by exact/directory match.
 */
function effectiveAllowWrite(configAllowWrite: string[], sessionWrite: string[]): string[] {
  return [...new Set([...configAllowWrite, ...sessionWrite])];
}

function effectiveDenyRead(
  configDenyRead: string[],
  sessionAllowedRead: string[],
  home: string,
): string[] {
  // A denyRead entry is removed from the effective list if the user has
  // allowed a path that falls under it.
  return configDenyRead.filter((d) => {
    const resolved = resolveHome(d, home);
    return !matchesAnyPrefix(resolved, sessionAllowedRead, home);
  });
}

/**
 * Extract a blocked write path from bwrap stderr output.
 * Common patterns:
 *   "touch: cannot touch '/path/file': Read-only file system"
 *   "mkdir: cannot create directory '/path': Read-only file system"
 *   "/path/file: Read-only file system"
 */
function extractBlockedWritePath(stderr: string): string | null {
  const patterns = [
    /cannot touch '([^']+)'/,
    /cannot create directory '([^']+)'/,
    /cannot create regular file '([^']+)'/,
    /cannot open '([^']+)'/,
  ];
  for (const re of patterns) {
    const m = stderr.match(re);
    if (m) return m[1];
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  const home = homedir();
  const localCwd = process.cwd();
  const localBash = createBashToolDefinition(localCwd);

  // ── state ──────────────────────────────────────────────────────────────────

  let sandboxEnabled = false;
  let sandboxInitialized = false;

  // Session-level allowances (paths user allowed via prompt).
  const sessionAllowWrite: string[] = [];
  const sessionAllowRead: string[] = [];

  // ── bwrap availability check ───────────────────────────────────────────────

  function checkBwrap(): boolean {
    try {
      const result = spawnSync("bwrap", ["--version"], {
        stdio: "pipe",
        encoding: "utf-8",
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  // ── permission prompt ─────────────────────────────────────────────────────

  /**
   * Show a select prompt with 3 options:
   *   1. Allow once (add to session allowance)
   *   2. Allow and save (add to config and session)
   *   3. Block
   *
   * Returns true if the user chose to allow.
   */
  async function promptAllow(
    ctx: ExtensionContext,
    kind: AllowanceKind,
    path: string,
  ): Promise<boolean> {
    const config = loadConfig(home);
    const choice = await ctx.ui.select(
      kind === "read"
        ? `📖 Read blocked: "${path}" is hidden (denyRead)`
        : `📝 Write blocked: "${path}" is not in allowWrite`,
      ["🔓 Allow once (session)", "💾 Allow and save to config", "🚫 Block"],
    );

    if (!choice || choice === "🚫 Block") return false;

    if (kind === "read") {
      sessionAllowRead.push(path);
      if (choice === "💾 Allow and save to config") {
        if (!config.denyRead.some((d) => resolveHome(d, home) === path)) {
          config.denyRead = config.denyRead.filter(
            (d) => resolveHome(d, home) !== path,
          );
        }
        saveConfig(config, home);
      }
    } else {
      sessionAllowWrite.push(path);
      if (choice === "💾 Allow and save to config") {
        if (!config.allowWrite.some((d) => resolveHome(d, home) === path)) {
          config.allowWrite.push(path);
        }
        saveConfig(config, home);
      }
    }

    return true;
  }

  // ── sandboxed bash operations ──────────────────────────────────────────────

  function getEffectiveBwrapArgs() {
    const config = loadConfig(home);
    const effAllowWrite = effectiveAllowWrite(config.allowWrite, sessionAllowWrite);
    const effDenyRead = effectiveDenyRead(config.denyRead, sessionAllowRead, home);
    return { config, effAllowWrite, effDenyRead };
  }

  function createBwrapBashOps(
    allowWrite: string[],
    denyRead: string[],
  ): BashOperations {
    return {
      async exec(command, cwd, { onData, signal, timeout }) {
        const fullCmd = buildBwrapCommand(command, allowWrite, denyRead, home);

        return new Promise((resolve, reject) => {
          const child = spawn(fullCmd[0], fullCmd.slice(1), {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });

          let timedOut = false;
          let timeoutHandle: NodeJS.Timeout | undefined;

          if (timeout !== undefined && timeout > 0) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              try {
                process.kill(-child.pid!, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }, timeout * 1000);
          }

          child.stdout?.on("data", onData);
          child.stderr?.on("data", onData);

          child.on("error", (err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reject(err);
          });

          const onAbort = () => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          child.on("close", (code) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
              reject(new Error("aborted"));
            } else if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
            } else {
              resolve({ exitCode: code ?? 0 });
            }
          });
        });
      },
    };
  }

  // ── status helpers ─────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    if (!sandboxEnabled) {
      ctx.ui.setStatus("fs-sandbox", "🔒 FS: disabled");
      return;
    }
    const { effAllowWrite } = getEffectiveBwrapArgs();
    ctx.ui.setStatus(
      "fs-sandbox",
      ctx.ui.theme.fg("accent", `🔒 FS: ${effAllowWrite.length} write paths`),
    );
  }

  function formatConfig(ctx: ExtensionContext): void {
    const config = loadConfig(home);
    const { effAllowWrite, effDenyRead } = getEffectiveBwrapArgs();
    const lines: string[] = [
      `FS-Sandbox: ${sandboxEnabled ? "🟢 enabled" : "🔴 disabled"}`,
      "──────────────",
      `Allow Write (${effAllowWrite.length}):`,
      ...(effAllowWrite.length > 0
        ? effAllowWrite.map((p) => `  • ${p}`)
        : ["  (none)"]),
      "",
      `Hidden (denyRead) (${effDenyRead.length}):`,
      ...(effDenyRead.length > 0
        ? effDenyRead.map((p) => `  • ${p}`)
        : ["  (none)"]),
      sessionAllowWrite.length > 0
        ? [``, `Session write allowances:`, ...sessionAllowWrite.map((p) => `  • ${p}`)]
        : [],
      sessionAllowRead.length > 0
        ? [``, `Session read allowances:`, ...sessionAllowRead.map((p) => `  • ${p}`)]
        : [],
      "",
      "Network: unrestricted",
    ];
    ctx.ui.notify(lines.flat().join("\n"), "info");
  }

  // ── session lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!checkBwrap()) {
      ctx.ui.notify("bwrap not found — fs-sandbox cannot start", "error");
      return;
    }
    ensureDefaultConfig(home);

    const config = loadConfig(home);
    if (config.enabled) {
      sandboxEnabled = true;
      sandboxInitialized = true;
      updateStatus(ctx);
      ctx.ui.notify("FS sandbox enabled", "info");
    } else {
      ctx.ui.setStatus("fs-sandbox", "🔒 FS: disabled");
    }
  });

  pi.on("session_shutdown", async () => {
    sandboxEnabled = false;
    sandboxInitialized = false;
    sessionAllowWrite.length = 0;
    sessionAllowRead.length = 0;
  });

  // ── bash tool override ─────────────────────────────────────────────────────

  pi.registerTool({
    ...localBash,
    label: "bash (fs-sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }

      // Wrapper with retry logic: if bwrap blocks a write, we detect it,
      // prompt the user, and retry with updated effective config.
      const runBash = (): ReturnType<typeof localBash.execute> => {
        const { effAllowWrite, effDenyRead } = getEffectiveBwrapArgs();
        const sandboxedBash = createBashToolDefinition(localCwd, {
          operations: createBwrapBashOps(effAllowWrite, effDenyRead),
        });
        return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
      };

      let result = await runBash();

      // Post-execution check: detect blocked write in stderr
      if (ctx?.hasUI && result.content?.length) {
        const outputText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(outputText);
        if (blockedPath) {
          const allowed = await promptAllow(ctx, "write", blockedPath);
          if (allowed) {
            onUpdate?.({
              content: [{ type: "text", text: `\n--- Write access granted for "${blockedPath}", retrying ---\n` }],
              details: {},
            });
            result = await runBash();
          }
        }
      }

      return result;
    },
  });

  // ── user_bash (!cmd / !!cmd) ──────────────────────────────────────────────

  pi.on("user_bash", () => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    const { effAllowWrite, effDenyRead } = getEffectiveBwrapArgs();
    return { operations: createBwrapBashOps(effAllowWrite, effDenyRead) };
  });

  // ── tool_call interception (read/write/edit) ──────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    const config = loadConfig(home);

    // read — block if path is in effective denyRead
    if (isToolCallEventType<"read", { path: string }>("read", event)) {
      const path = event.input.path;
      const effDeny = effectiveDenyRead(config.denyRead, sessionAllowRead, home);
      if (isDenyRead(path, effDeny, home)) {
        // Prompt user for permission
        if (ctx?.hasUI) {
          const allowed = await promptAllow(ctx, "read", path);
          if (allowed) return undefined; // Allow — let the tool proceed
        }
        return {
          block: true,
          reason: `FS sandbox: read denied for "${path}" (in denyRead)`,
        };
      }
    }

    // write / edit — block if path is NOT in effective allowWrite
    if (
      isToolCallEventType<"write", { path: string }>("write", event) ||
      isToolCallEventType<"edit", { path: string; oldText: string; newText: string }>("edit", event)
    ) {
      const path = event.input.path;
      const effAllow = effectiveAllowWrite(config.allowWrite, sessionAllowWrite);
      if (!isAllowWrite(path, effAllow, home)) {
        if (ctx?.hasUI) {
          const allowed = await promptAllow(ctx, "write", path);
          if (allowed) return undefined; // Allow — let the tool proceed
        }
        return {
          block: true,
          reason: `FS sandbox: write denied for "${path}" (not in allowWrite)`,
        };
      }
    }

    return undefined;
  });

  // ── commands ──────────────────────────────────────────────────────────────

  pi.registerCommand("fs-sandbox", {
    description: "Show fs-sandbox status and effective config",
    handler: async (_args, ctx) => {
      formatConfig(ctx);
    },
  });

  pi.registerCommand("fs-sandbox-enable", {
    description: "Enable filesystem sandboxing",
    handler: async (_args, ctx) => {
      if (!checkBwrap()) {
        ctx.ui.notify("bwrap not found", "error");
        return;
      }
      sandboxEnabled = true;
      sandboxInitialized = true;

      const config = loadConfig(home);
      config.enabled = true;
      saveConfig(config, home);

      updateStatus(ctx);
      ctx.ui.notify("🔒 FS sandbox enabled", "info");
    },
  });

  pi.registerCommand("fs-sandbox-disable", {
    description: "Disable filesystem sandboxing",
    handler: async (_args, ctx) => {
      sandboxEnabled = false;

      const config = loadConfig(home);
      config.enabled = false;
      saveConfig(config, home);

      ctx.ui.setStatus("fs-sandbox", "🔒 FS: disabled");
      ctx.ui.notify("🔓 FS sandbox disabled", "info");
    },
  });
}
