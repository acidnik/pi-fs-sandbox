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
 * When a blocked access is detected, the user is prompted with options:
 *   1. Allow for session       — temporary, no config change
 *   2. Allow and save          — persist to config
 *   3. Edit path and save      — edit path mask, then save to config
 *   4. Reject for session      — keep blocked this session
 *   5. Reject and save         — persist block to config
 *   6. Edit, reject and save   — edit path mask, persist block to config
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
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { buildBwrapArgs, buildBwrapCommand } from "./src/bwrap.ts";
import { loadConfig, saveConfig, ensureDefaultConfig, resolveHome } from "./src/config.ts";
import { isAllowWrite, isDenyRead, isDenyWrite, matchesAnyPrefix } from "./src/paths.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

type AllowanceKind = "read" | "write";

function effectiveAllowWrite(
  configAllowWrite: string[],
  sessionAllow: string[],
  sessionReject: string[],
  home: string,
): string[] {
  // Start with config + session allowances, then remove session rejects
  let result = [...new Set([...configAllowWrite, ...sessionAllow])];
  result = result.filter((p) => !matchesAnyPrefix(p, sessionReject, home));
  return result;
}

function effectiveDenyRead(
  configDenyRead: string[],
  sessionAllow: string[],
  sessionReject: string[],
  home: string,
): string[] {
  // Start with config + session rejects
  let result = [...new Set([...configDenyRead, ...sessionReject])];

  // Remove a deny pattern if the user allowed a path that falls under it.
  // E.g. denyRead has `~/.ssh`, user allowed `/home/nik/.ssh/id_rsa` →
  // remove `~/.ssh` from effective denyRead so bwrap doesn't --tmpfs it.
  result = result.filter((denyPattern) => {
    return !sessionAllow.some((allowedPath) => matchesAnyPrefix(allowedPath, [denyPattern], home));
  });

  return result;
}

function effectiveDenyWrite(
  configDenyWrite: string[],
  sessionReject: string[],
): string[] {
  return [...new Set([...configDenyWrite, ...sessionReject])];
}

/** Extract a blocked write path from bwrap stderr output. */
function extractBlockedWritePath(stderr: string): string | null {
  const patterns = [
    /cannot touch '([^']+)'/,
    /cannot create directory '([^']+)'/,
    /cannot create regular file '([^']+)'/,
    /cannot open '([^']+)'/,
    /cannot create file '([^']+)'/,
    // Generic EROFS pattern (sometimes path is before the colon)
    /'([^']+)': Read-only file system/,
    /([^\s:]+): Read-only file system/,
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

  // Session-level allowances / rejections
  const sessionAllowWrite: string[] = [];
  const sessionAllowRead: string[] = [];
  const sessionRejectWrite: string[] = [];
  const sessionRejectRead: string[] = [];

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

  const SELECT_ALLOW_SESSION = "🔓 Allow for session";
  const SELECT_ALLOW_SAVE   = "💾 Allow and save";
  const SELECT_EDIT_ALLOW   = "✏️ Edit path and save";
  const SELECT_REJECT_SESSION = "🚫 Reject for session";
  const SELECT_REJECT_SAVE  = "⛔ Reject and save";
  const SELECT_EDIT_REJECT  = "✏️ Edit, reject and save";

  /**
   * Show a 6-option dialog when sandbox blocks an operation.
   * Returns true if the tool call should proceed (allow variants).
   */
  async function promptAllow(
    ctx: ExtensionContext,
    kind: AllowanceKind,
    path: string,
  ): Promise<boolean> {
    const config = loadConfig(home);

    const readTitle = `📖 Read blocked: "${path}"`;
    const writeTitle = `📝 Write blocked: "${path}"`;

    const choice = await ctx.ui.select(
      kind === "read" ? readTitle : writeTitle,
      [
        SELECT_ALLOW_SESSION,
        SELECT_ALLOW_SAVE,
        SELECT_EDIT_ALLOW,
        SELECT_REJECT_SESSION,
        SELECT_REJECT_SAVE,
        SELECT_EDIT_REJECT,
      ],
    );

    if (!choice) return false;

    // ── Allow for session (immediate) ──────────────────────────────────────
    if (choice === SELECT_ALLOW_SESSION) {
      if (kind === "read") sessionAllowRead.push(path);
      else sessionAllowWrite.push(path);
      return true;
    }

    // ── Allow and save (immediate) ─────────────────────────────────────────
    if (choice === SELECT_ALLOW_SAVE) {
      const finalPath = path;
      if (kind === "read") {
        sessionAllowRead.push(finalPath);
        config.denyRead = config.denyRead.filter(
          (d) => resolveHome(d, home) !== finalPath,
        );
      } else {
        sessionAllowWrite.push(finalPath);
        if (!config.allowWrite.includes(finalPath)) {
          config.allowWrite.push(finalPath);
        }
        // Remove from denyWrite if it was there
        config.denyWrite = (config.denyWrite ?? []).filter(
          (d) => resolveHome(d, home) !== finalPath,
        );
      }
      saveConfig(config, home);
      return true;
    }

    // ── Edit path and save ─────────────────────────────────────────────────
    if (choice === SELECT_EDIT_ALLOW) {
      const edited = await ctx.ui.input(
        `Edit path to allow (current: ${path})`,
        path,
      );
      const finalPath = (edited ?? path).trim();
      if (kind === "read") {
        sessionAllowRead.push(finalPath);
        // Remove edited path from denyRead if present
        config.denyRead = config.denyRead.filter(
          (d) => resolveHome(d, home) !== finalPath,
        );
      } else {
        sessionAllowWrite.push(finalPath);
        if (!config.allowWrite.includes(finalPath)) {
          config.allowWrite.push(finalPath);
        }
        config.denyWrite = (config.denyWrite ?? []).filter(
          (d) => resolveHome(d, home) !== finalPath,
        );
      }
      saveConfig(config, home);
      return true;
    }

    // ── Reject for session (immediate) ─────────────────────────────────────
    if (choice === SELECT_REJECT_SESSION) {
      // Ensure path is NOT in session allowances
      if (kind === "read") {
        // Remove from allow if previously granted
        const idx = sessionAllowRead.indexOf(path);
        if (idx !== -1) sessionAllowRead.splice(idx, 1);
        sessionRejectRead.push(path);
      } else {
        const idx = sessionAllowWrite.indexOf(path);
        if (idx !== -1) sessionAllowWrite.splice(idx, 1);
        sessionRejectWrite.push(path);
      }
      return false;
    }

    // ── Reject and save (immediate) ────────────────────────────────────────
    if (choice === SELECT_REJECT_SAVE) {
      const finalPath = path;
      if (kind === "read") {
        // Add to denyRead config
        if (!config.denyRead.some((d) => resolveHome(d, home) === finalPath)) {
          config.denyRead.push(finalPath);
        }
        const idx = sessionAllowRead.indexOf(finalPath);
        if (idx !== -1) sessionAllowRead.splice(idx, 1);
        sessionRejectRead.push(finalPath);
      } else {
        // Add to denyWrite config
        if (!(config.denyWrite ?? []).some((d) => resolveHome(d, home) === finalPath)) {
          config.denyWrite = [...(config.denyWrite ?? []), finalPath];
        }
        // Remove from allowWrite if exact match
        config.allowWrite = config.allowWrite.filter(
          (d) => resolveHome(d, home) !== finalPath,
        );
        const idx = sessionAllowWrite.indexOf(finalPath);
        if (idx !== -1) sessionAllowWrite.splice(idx, 1);
        sessionRejectWrite.push(finalPath);
      }
      saveConfig(config, home);
      return false;
    }

    // ── Edit, reject and save ──────────────────────────────────────────────
    if (choice === SELECT_EDIT_REJECT) {
      const edited = await ctx.ui.input(
        `Edit path to block (current: ${path})`,
        path,
      );
      const finalPath = (edited ?? path).trim();
      if (kind === "read") {
        if (!config.denyRead.some((d) => resolveHome(d, home) === finalPath)) {
          config.denyRead.push(finalPath);
        }
        const idx = sessionAllowRead.indexOf(finalPath);
        if (idx !== -1) sessionAllowRead.splice(idx, 1);
        sessionRejectRead.push(finalPath);
      } else {
        if (!(config.denyWrite ?? []).some((d) => resolveHome(d, home) === finalPath)) {
          config.denyWrite = [...(config.denyWrite ?? []), finalPath];
        }
        config.allowWrite = config.allowWrite.filter(
          (d) => resolveHome(d, home) !== finalPath,
        );
        const idx = sessionAllowWrite.indexOf(finalPath);
        if (idx !== -1) sessionAllowWrite.splice(idx, 1);
        sessionRejectWrite.push(finalPath);
      }
      saveConfig(config, home);
      return false;
    }

    return false;
  }

  // ── sandboxed bash operations ──────────────────────────────────────────────

  function getEffectiveConfig() {
    const config = loadConfig(home);
    const effAllowWrite = effectiveAllowWrite(
      config.allowWrite, sessionAllowWrite, sessionRejectWrite, home,
    );
    const effDenyRead = effectiveDenyRead(
      config.denyRead, sessionAllowRead, sessionRejectRead, home,
    );
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
    const { effAllowWrite } = getEffectiveConfig();
    ctx.ui.setStatus(
      "fs-sandbox",
      ctx.ui.theme.fg("accent", `🔒 FS: ${effAllowWrite.length} write paths`),
    );
  }

  function formatConfig(ctx: ExtensionContext): void {
    const config = loadConfig(home);
    const { effAllowWrite, effDenyRead } = getEffectiveConfig();
    const effDenyWrite = effectiveDenyWrite(config.denyWrite ?? [], sessionRejectWrite);

    const lines: string[] = [
      `FS-Sandbox: ${sandboxEnabled ? "🟢 enabled" : "🔴 disabled"}`,
      "──────────────",
      `Allow Write (${effAllowWrite.length}):`,
      ...(effAllowWrite.length > 0
        ? effAllowWrite.map((p) => `  • ${p}`)
        : ["  (none)"]),
      "",
      `Deny Write (${effDenyWrite.length}):`,
      ...(effDenyWrite.length > 0
        ? effDenyWrite.map((p) => `  • ${p}`)
        : ["  (none)"]),
      "",
      `Hidden (denyRead) (${effDenyRead.length}):`,
      ...(effDenyRead.length > 0
        ? effDenyRead.map((p) => `  • ${p}`)
        : ["  (none)"]),
      ...(sessionAllowWrite.length > 0
        ? [``, `Session write allowances:`, ...sessionAllowWrite.map((p) => `  • ${p}`)]
        : []),
      ...(sessionAllowRead.length > 0
        ? [``, `Session read allowances:`, ...sessionAllowRead.map((p) => `  • ${p}`)]
        : []),
      ...(sessionRejectWrite.length > 0
        ? [``, `Session write rejects:`, ...sessionRejectWrite.map((p) => `  • ${p}`)]
        : []),
      ...(sessionRejectRead.length > 0
        ? [``, `Session read rejects:`, ...sessionRejectRead.map((p) => `  • ${p}`)]
        : []),
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
    sessionRejectWrite.length = 0;
    sessionRejectRead.length = 0;
  });

  // ── bash tool override ─────────────────────────────────────────────────────

  pi.registerTool({
    ...localBash,
    label: "bash (fs-sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }

      const runBash = (): ReturnType<typeof localBash.execute> => {
        const { effAllowWrite, effDenyRead } = getEffectiveConfig();
        const sb = createBashToolDefinition(localCwd, {
          operations: createBwrapBashOps(effAllowWrite, effDenyRead),
        });
        return sb.execute(id, params, signal, onUpdate, ctx);
      };

      let result = await runBash();

      // Post-execution: detect sandbox-blocked operation in stderr.
      // We DON'T show a dialog here (ctx.ui.select() may not work in
      // the tool execute callback). Instead we append a hint to the
      // output telling the LLM to retry via a separate tool call.
      // The LLM can then use `read` or `write` tools, which DO trigger
      // dialogs via the tool_call handler.
      try {
        const outputText = result.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("") ?? "";

        const blockedPath = extractBlockedWritePath(outputText);
        if (blockedPath) {
          const msg = [
            "",
            `--- FS-SANDBOX: "${blockedPath}" blocked (not in allowWrite) ---`,
            `Use sandbox_request(access: "write", path: "${blockedPath}") to ask the user for permission.`,
            `Once granted, retry ONLY the command that failed, not the entire pipeline.`,
            "",
          ].join("\n");
          const textContent = result.content?.filter((c: any) => c.type === "text") ?? [];
          if (textContent.length > 0) {
            textContent[0] = { type: "text", text: textContent[0].text + msg };
            result = { ...result, content: textContent };
          }
        }
      } catch {
        // Ignore parse errors
      }

      return result;
    },
  });

  // ── sandbox_request tool ──────────────────────────────────────────────────
  //
  // The LLM calls this when a bash command fails with a sandbox block.
  // We show the permission dialog (if supported) or silently grant/deny.
  // Once allowed, the effective config is updated and the LLM retries.

  pi.registerTool({
    name: "sandbox_request",
    label: "Sandbox Request",
    description: "Ask the user to grant filesystem access (read or write) to a specific path",
    promptSnippet: "Request user permission for sandbox-restricted paths",
    promptGuidelines: [
      'Use sandbox_request when a bash command fails with "Read-only file system" or "FS-SANDBOX" in the output',
      'Pass the exact path from the error and whether you need "read" or "write" access',
      'If granted, retry the original command — the path will be accessible',
    ],
    parameters: Type.Object({
      access: StringEnum(["read", "write"]),
      path: Type.String({ description: "Path to request access for" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(home);

      // For write requests, also check denyWrite
      if (params.access === "write") {
        const effDenyWritePaths = effectiveDenyWrite(config.denyWrite ?? [], sessionRejectWrite);
        if (isDenyWrite(params.path, effDenyWritePaths, home)) {
          return {
            content: [{ type: "text", text: `❌ Access denied: "${params.path}" is in denyWrite` }],
            details: { granted: false, path: params.path, access: params.access },
            isError: true,
          };
        }
      }

      const allowed = await promptAllow(ctx, params.access, params.path);
      if (allowed) {
        return {
          content: [{
            type: "text",
            text: [
              `✅ User granted ${params.access} access to: ${params.path}`,
              `If the previously blocked operation was part of a multi-command pipeline. Retry ONLY the command that failed, not the entire pipeline.`,
            ].join("\n"),
          }],
          details: { granted: true, path: params.path, access: params.access },
        };
      }
      return {
        content: [{ type: "text", text: `❌ User denied ${params.access} access to: ${params.path}` }],
        details: { granted: false, path: params.path, access: params.access },
        isError: true,
      };
    },
  });

  // ── user_bash (!cmd / !!cmd) ──────────────────────────────────────────────

  pi.on("user_bash", () => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    const { effAllowWrite, effDenyRead } = getEffectiveConfig();
    return { operations: createBwrapBashOps(effAllowWrite, effDenyRead) };
  });

  // ── tool_call interception (read/write/edit) ──────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    const config = loadConfig(home);

    // ── read ────────────────────────────────────────────────────────────────
    if (isToolCallEventType<"read", { path: string }>("read", event)) {
      const path = event.input.path;
      const effDeny = effectiveDenyRead(config.denyRead, sessionAllowRead, sessionRejectRead, home);

      if (isDenyRead(path, effDeny, home)) {
        const allowed = await promptAllow(ctx, "read", path);
        if (allowed) return undefined;
        return {
          block: true,
          reason: `FS sandbox: read denied for "${path}"`,
        };
      }
    }

    // ── write / edit ─────────────────────────────────────────────────────────
    if (
      isToolCallEventType<"write", { path: string }>("write", event) ||
      isToolCallEventType<"edit", { path: string; oldText: string; newText: string }>("edit", event)
    ) {
      const path = event.input.path;
      const effAllow = effectiveAllowWrite(config.allowWrite, sessionAllowWrite, sessionRejectWrite, home);
      const effDenyWritePaths = effectiveDenyWrite(config.denyWrite ?? [], sessionRejectWrite);

      // First check denyWrite (hard block)
      if (isDenyWrite(path, effDenyWritePaths, home)) {
        return {
          block: true,
          reason: `FS sandbox: write denied for "${path}" (in denyWrite)`,
        };
      }

      // Then check allowWrite
      if (!isAllowWrite(path, effAllow, home)) {
        const allowed = await promptAllow(ctx, "write", path);
        if (allowed) return undefined;
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
      sandboxInitialized = false;
      sessionAllowWrite.length = 0;
      sessionAllowRead.length = 0;
      sessionRejectWrite.length = 0;
      sessionRejectRead.length = 0;

      const config = loadConfig(home);
      config.enabled = false;
      saveConfig(config, home);

      ctx.ui.setStatus("fs-sandbox", "🔒 FS: disabled");
      ctx.ui.notify("🔓 FS sandbox disabled", "info");
    },
  });
}
