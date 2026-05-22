# pi-fs-sandbox

**Filesystem-only sandbox for pi via bwrap — no network isolation.**

A [pi](https://pi.dev) extension that restricts filesystem access for bash commands using [bubblewrap](https://github.com/containers/bubblewrap) (bwrap), while keeping full network access. Features permission dialogs, reject-all mode, SSH/git support, and subagent compatibility.

## Why not pi-sandbox?

The full [pi-sandbox](https://github.com/oddsjam/pi-sandbox) uses `@anthropic-ai/sandbox-runtime` which **always** applies network isolation and requires a SOCKS proxy for allowed domains. This extension:

- ✅ Uses raw `bwrap` directly — no extra dependencies beyond bwrap itself
- ✅ **No network isolation** — `--unshare-net` is never passed
- ✅ Minimal config — single file `~/.pi/fs-sandbox/config.json`
- ✅ Permission dialogs with 6 options
- ✅ `sandbox_request` tool for explicit access requests
- ✅ Reject-all mode for unattended runs (`Ctrl+R`)
- ✅ SSH/git push works out of the box
- ✅ Subagent compatible (no UI dialogs in subagent context)

## Architecture

```
bash(touch /path)                    read/write/edit tool
       │                                    │
       ▼                                    ▼
   bwrap --ro-bind / /              tool_call interception
       │                              denyRead / allowWrite
       │                                    │
  EROFS / tmpfs                     blocked → dialog?
       │                                    │
  FS-SANDBOX hint ──→ sandbox_request ◄────┘
                        tool
                     (permission dialog)
```

Two-layer protection:
1. **bash** — runs inside `bwrap` with `--ro-bind / /` (OS-level, cannot bypass)
2. **read/write/edit** — intercepted at `tool_call` level (policy check in JS)

## How it works

```text
bwrap \
  --ro-bind / / \          # everything read-only
  --bind /tmp /tmp         # writable paths (allowWrite)
  --tmpfs ~/.ssh           # hidden paths (denyRead)
  --dev /dev               # pseudo-fs
  --proc /proc
  --unshare-ipc --unshare-pid --unshare-uts
  -- bash -c "your command"
```

### When bash is blocked

The command fails with `Read-only file system` or `No such file`. The extension detects this and appends a hint:

```
--- FS-SANDBOX: "/path" blocked (read) ---
File is hidden. Use sandbox_request(access: "read", path: "/path")
Once granted, retry ONLY the command that failed.
```

The LLM then calls `sandbox_request` to ask for permission.

### Permission dialog (`sandbox_request`)

When a path is blocked, the user sees:

```
📝 Write blocked: "/home/nik/file.txt"

[🔓 Allow for session]
[💾 Allow and save]
[✏️ Edit path and save]
[🚫 Reject for session]
[⛔ Reject and save]
[✏️ Edit, reject and save]
```

After allowing, the path is added to session allowances. The LLM retries only the failed command.

### Reject-all mode

For unattended runs: all dialogs are auto-rejected, no waiting. The LLM sees:

```
🔇 Sandbox is in reject-all mode. Continue with what you can,
but do NOT attempt to bypass the sandbox.
```

Toggle with `/fs-sandbox-reject` or **`Ctrl+R`**. Persists across `/reload`.

## Installation

```bash
git clone https://github.com/acidnik/pi-fs-sandbox ~/.pi/agent/extensions/fs-sandbox
```

Or symlink for development:

```bash
ln -sf ~/src/pi-fs-sandbox ~/.pi/agent/extensions/fs-sandbox
```

## Config

Located at `~/.pi/fs-sandbox/config.json` (separate from `~/.pi/agent/`, NOT in allowWrite):

```json
{
  "enabled": true,
  "allowWrite": ["/tmp", "."],
  "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/git", "~/.config/gh"],
  "denyWrite": []
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Auto-enable on session start |
| `allowWrite` | Paths writable inside bwrap; everything else is read-only |
| `denyRead` | Paths hidden inside bwrap via `--tmpfs` (shown as empty) |
| `denyWrite` | Paths explicitly denied write access (even if parent is in allowWrite) |

The config file itself is **protected** — cannot be modified via `write`/`edit`/`sandbox_request`. Only through extension dialogs and `/fs-sandbox-*` commands.

## Commands

| Command | Description |
|---------|-------------|
| `/fs-sandbox` | Show status and effective config (with session allowances) |
| `/fs-sandbox-enable` | Enable sandboxing |
| `/fs-sandbox-disable` | Disable sandboxing |
| `/fs-sandbox-reject` | Toggle reject-all mode (`Ctrl+R`) |

## SSH / Git

SSH works through the system's ssh-agent. The extension sets:

- `--tmpfs /etc/ssh/ssh_config.d` — fixes systemd SSH config ownership issue
- `GIT_SSH_COMMAND` with `StrictHostKeyChecking=no` — bypasses missing known_hosts

Git push/pull works. SSH keys stay hidden in `denyRead` — authentication goes through the agent socket.

## File structure

```
pi-fs-sandbox/
├── index.ts          # Extension entry point
├── src/
│   ├── config.ts     # Config read/write, JSON with trailing comma fix
│   ├── bwrap.ts      # bwrap argument builder (--bind, --tmpfs)
│   └── paths.ts      # Path matching with glob support
├── package.json
└── README.md
```

## Requirements

- Linux with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap` in PATH)
- pi (`npm install -g @earendil-works/pi-coding-agent`)
