# pi-fs-sandbox

**Filesystem-only sandbox for pi via bwrap — no network isolation.**

A [pi](https://pi.dev) extension that restricts filesystem access for bash commands using [bubblewrap](https://github.com/containers/bubblewrap) (bwrap), while keeping full network access. Features permission dialogs, granular allowRead overrides, reject-all mode, SSH/git support, and subagent compatibility.

## Why not pi-sandbox?

The full [pi-sandbox](https://github.com/oddsjam/pi-sandbox) uses `@anthropic-ai/sandbox-runtime` which **always** applies network isolation and requires a SOCKS proxy for allowed domains. This extension:

- ✅ Uses raw `bwrap` directly — no extra dependencies beyond bwrap itself
- ✅ **No network isolation** — `--unshare-net` is never passed
- ✅ Minimal config — single file `~/.pi/fs-sandbox/config.json`
- ✅ Permission dialogs with 6 options
- ✅ `sandbox_request` tool for explicit access requests
- ✅ **Granular denyRead/allowRead** — allow specific files in hidden dirs
- ✅ Reject-all mode for unattended runs (`Alt+R`)
- ✅ SSH/git push works out of the box
- ✅ Subagent compatible (no UI dialogs in subagent context)

## Architecture

```
bash(touch /path)                    read/write/edit tool
       │                                    │
       ▼                                    ▼
   bwrap --ro-bind / /              tool_call interception
   --bind /tmp ...                  denyRead / allowWrite
   --tmpfs ~/.ssh  OR                     │
   --bind empty id_ed25519               │
       │                                    │
  EROFS / empty file                blocked → dialog?
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
  --tmpfs ~/.ssh           # OR: hide entire directory (no allowRead)
  --bind /tmp/.empty ~/.ssh/id_ed25519  # OR: hide specific file
  --dev /dev               # pseudo-fs
  --proc /proc
  --unshare-ipc --unshare-pid --unshare-uts
  -- bash -c "your command"
```

### denyRead + allowRead granularity

Use `allowRead` to make specific files accessible inside a denyRead directory:

```json
{
  "denyRead": ["~/.ssh"],
  "allowRead": ["~/.ssh/*.pub"]
}
```

bwrap behavior changes based on whether a denyRead directory has allowRead overrides:

| Scenario | bash behavior | `read` tool behavior |
|----------|--------------|---------------------|
| `denyRead: ["~/.ssh"]` (no allowRead) | `--tmpfs` hides everything | blocked (denyRead) |
| `denyRead: ["~/.ssh"]` + `allowRead: ["~/.ssh/*.pub"]` | Dir is visible; non-`.pub` files bound to empty placeholder | `.pub` allowed by allowRead, rest blocked |
| `denyRead: ["~/.ssh/id_ed25519"]` (file-level) | File replaced with empty | blocked (denyRead) |

When `allowRead` has patterns under a denyRead directory:
1. The directory is **not** tmpfs'd (bash can list files)
2. The extension **enumerates** the directory contents
3. Files matching `allowRead` patterns stay visible
4. Files NOT matching `allowRead` are bound to an **empty placeholder** (`/tmp/.fs-sandbox-empty`)
5. The `read` tool checks `allowRead` separately — only matching paths are allowed

This gives you **file-level granularity** even though bwrap operates at the mount level.

### When bash is blocked

The extension appends a hint:

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
[🚫 Deny for session]
[💾 Allow and save]
[⛔ Deny and save]
[✏️ Edit, allow, save]
[✏️ Edit, deny, save]
```

Options:
- **Allow/Deny for session** — immediate, no config change
- **Allow/Deny and save** — persists to config
- **Edit, allow/deny, save** — edit the path (e.g. add glob `~/.ssh/*.pub`) then save

After allowing, the path is added to session allowances. The LLM retries only the failed command.

### Reject-all mode

For unattended runs: all dialogs are auto-rejected, no waiting. The LLM sees:

```
🔇 Sandbox is in reject-all mode. Continue with what you can,
but do NOT attempt to bypass the sandbox.
```

Toggle with `/fs-sandbox-reject` or **`Alt+R`**. Persists across `/reload`.

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
  "allowRead": [],
  "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/git", "~/.config/gh"],
  "denyWrite": []
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Auto-enable on session start |
| `allowWrite` | Paths writable inside bwrap; everything else is read-only |
| `allowRead` | File patterns that override denyRead (tool-level + bwrap granular) |
| `denyRead` | Paths hidden inside bwrap (directories → `--tmpfs`, files → empty bind) |
| `denyWrite` | Paths explicitly denied write access (even if parent is in allowWrite) |

The config file itself is **protected** — cannot be modified via `write`/`edit`/`sandbox_request`. Only through extension dialogs and `/fs-sandbox-*` commands.

## Commands

| Command | Description |
|---------|-------------|
| `/fs-sandbox` | Show status and effective config (with session allowances) |
| `/fs-sandbox-enable` | Enable sandboxing |
| `/fs-sandbox-disable` | Disable sandboxing |
| `/fs-sandbox-reject` | Toggle reject-all mode (`Alt+R`) |

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
│   ├── bwrap.ts      # bwrap argument builder (--bind, --tmpfs, enumeration)
│   └── paths.ts      # Path matching with glob support
├── package.json
└── README.md
```

## Requirements

- Linux with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap` in PATH)
- pi (`npm install -g @earendil-works/pi-coding-agent`)
