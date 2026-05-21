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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashToolDefinition,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { buildBwrapArgs, buildBwrapCommand } from "./src/bwrap.ts";
import { loadConfig, saveConfig, ensureDefaultConfig } from "./src/config.ts";
import { isAllowWrite, isDenyRead } from "./src/paths.ts";

export default function (pi: ExtensionAPI) {
  const home = homedir();
  const localCwd = process.cwd();
  const localBash = createBashToolDefinition(localCwd);

  // ── state ──────────────────────────────────────────────────────────────────

  let sandboxEnabled = false;
  let sandboxInitialized = false;

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

  // ── sandboxed bash operations ──────────────────────────────────────────────

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

  function updateStatus(ctx: any): void {
    if (!sandboxEnabled) {
      ctx.ui.setStatus("fs-sandbox", "🔒 FS: disabled");
      return;
    }
    const config = loadConfig(home);
    const { writablePaths, hiddenPaths } = buildBwrapArgs(
      config.allowWrite,
      config.denyRead,
      home,
    );
    const writeSummary = writablePaths.length > 0
      ? writablePaths.map((p) => p.split("/").pop()).join(", ")
      : "none";
    const hideCount = hiddenPaths.length;
    ctx.ui.setStatus(
      "fs-sandbox",
      ctx.ui.theme.fg("accent", `🔒 FS: ${writablePaths.length} write paths`),
    );
  }

  function formatConfig(ctx: any): void {
    const config = loadConfig(home);
    const { writablePaths, hiddenPaths } = buildBwrapArgs(
      config.allowWrite,
      config.denyRead,
      home,
    );
    const lines: string[] = [
      `FS-Sandbox: ${sandboxEnabled ? "🟢 enabled" : "🔴 disabled"}`,
      "──────────────",
      `Allow Write (${writablePaths.length}):`,
      ...(writablePaths.length > 0
        ? writablePaths.map((p) => `  • ${p}`)
        : ["  (none)"]),
      "",
      `Hidden (denyRead) (${hiddenPaths.length}):`,
      ...(hiddenPaths.length > 0
        ? hiddenPaths.map((p) => `  • ${p}`)
        : ["  (none)"]),
      "",
      "Network: unrestricted",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  }

  // ── session lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!checkBwrap()) {
      ctx.ui.notify("bwrap not found — fs-sandbox cannot start", "error");
      return;
    }
    ensureDefaultConfig(home);

    // Auto-enable if config says so
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
  });

  // ── bash tool override ─────────────────────────────────────────────────────

  pi.registerTool({
    ...localBash,
    label: "bash (fs-sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }
      const config = loadConfig(home);
      const sandboxedBash = createBashToolDefinition(localCwd, {
        operations: createBwrapBashOps(config.allowWrite, config.denyRead),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
    },
  });

  // ── user_bash (!cmd / !!cmd) ──────────────────────────────────────────────

  pi.on("user_bash", () => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    const config = loadConfig(home);
    return { operations: createBwrapBashOps(config.allowWrite, config.denyRead) };
  });

  // ── tool_call interception (read/write/edit) ──────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    const config = loadConfig(home);

    // read — ask user if path is in denyRead
    if (isToolCallEventType<"read", { path: string }>("read", event)) {
      const path = event.input.path;
      if (isDenyRead(path, config.denyRead, home)) {
        const allow = await ctx.ui.confirm(
          "FS sandbox",
          `Read "${path}"? This path is in denyRead.`,
        );
        if (!allow) {
          return {
            block: true,
            reason: `FS sandbox: read denied for "${path}" — blocked by user`,
          };
        }
        // User allowed — let it through
        return undefined;
      }
    }

    // write / edit — ask user if path is NOT in allowWrite
    if (
      isToolCallEventType<"write", { path: string }>("write", event) ||
      isToolCallEventType<"edit", { path: string; oldText: string; newText: string }>("edit", event)
    ) {
      const path = event.input.path;
      if (!isAllowWrite(path, config.allowWrite, home)) {
        const allow = await ctx.ui.confirm(
          "FS sandbox",
          `Write to "${path}"? This path is not in allowWrite.`,
        );
        if (!allow) {
          return {
            block: true,
            reason: `FS sandbox: write denied for "${path}" — blocked by user`,
          };
        }
        // User allowed — let it through
        return undefined;
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

      // Persist enabled state
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
