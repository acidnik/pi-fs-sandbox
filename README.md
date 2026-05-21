# pi-fs-sandbox

**Filesystem-only sandbox for pi via bwrap — no network isolation.**

A [pi](https://pi.dev) extension that restricts filesystem access for bash commands using [bubblewrap](https://github.com/containers/bubblewrap) (bwrap), while keeping full network access.

## Why not pi-sandbox?

The full [pi-sandbox](https://github.com/oddsjam/pi-sandbox) uses `@anthropic-ai/sandbox-runtime` which **always** applies network isolation and requires a SOCKS proxy for allowed domains. This extension:

- ✅ Uses raw `bwrap` directly — no extra dependencies beyond bwrap itself
- ✅ **No network isolation** — `--unshare-net` is never passed
- ✅ Minimal config — single file `~/.pi/agent/fs-sandbox.json`
- ✅ Clean implementation — no TUI wizard, no project-level configs

## How it works

```text
bwrap \
  --ro-bind / / \          # everything read-only
  --bind /home/me/proj /   # writable paths
  --tmpfs /home/me/.ssh \  # hidden paths (denyRead)
  --dev /dev \             # pseudo-fs
  --proc /proc \
  --unshare-ipc --unshare-pid --unshare-uts \  # basic isolation
  -- bash -c "your command"
```

- `bash` tool runs inside bwrap
- `read/write/edit` tools are intercepted at the `tool_call` level (policy check)
- Network is **fully unrestricted**

## Installation

```bash
# From GitHub
mkdir -p ~/.pi/agent/extensions/fs-sandbox
git clone https://github.com/acidnik/pi-fs-sandbox ~/.pi/agent/extensions/fs-sandbox

# Or as a pi package (once published)
pi install @acidnik/pi-fs-sandbox
```

## Config

Located at `~/.pi/agent/fs-sandbox.json`:

```json
{
  "enabled": false,
  "allowWrite": [],
  "denyRead": [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.config/git",
    "~/.config/gh"
  ]
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Auto-enable on session start (default: `false`) |
| `allowWrite` | Paths writable inside bwrap; everything else is read-only |
| `denyRead` | Paths hidden inside bwrap via `--tmpfs` (empty directory) |

**Note:** `denyRead` takes precedence — a path in both will be hidden.

## Commands

| Command | Description |
|---------|-------------|
| `/fs-sandbox` | Show current status and effective config |
| `/fs-sandbox-enable` | Enable filesystem sandboxing |
| `/fs-sandbox-disable` | Disable filesystem sandboxing |

## Requirements

- Linux with [bubblewrap](https://github.com/containers/bubblewrap) installed (`bwrap` in PATH)
- pi (install via `npm install -g @earendil-works/pi-coding-agent`)
