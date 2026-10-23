# ait: AI tmux

A terminal dashboard for many Claude Code sessions, built as a thin layer over tmux.
It shows each session's state (waiting / running / idle / done), alerts you once when a
session starts waiting for you, and jumps into any session with one key.
The same operations are available as a small local HTTP API (`npm start`).

No npm dependencies. Everything uses Node built-ins.

## 1. Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22 or newer | everything |
| tmux | 3.2 or newer | the dashboard and sessions (not needed to run `npm test` or `/health`) |
| Claude Code (`claude`) | any with hooks | launching sessions; must be on `PATH`, in a folder that is not world-writable |
| macOS or Linux | | Windows is not supported |

Check versions: `node -v`, `tmux -V`, `claude --version`.

## 2. Install

