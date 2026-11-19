# Agent support table (verified 2026-11-18)

Each agent was given a hook that refuses writes to `target.txt`, then asked to create it.

| Agent | Version | Mechanism | Live block? | Notes |
|---|---|---|---|---|
| Claude Code | current | `PreToolUse` hook in `.claude/settings.json`, exit 2 | Yes | Model reports the block and stops. |
| Codex | 0.170.0 | `PreToolUse` in the project's `.codex/hooks.json` | Yes | Hooks need one-time trust (`/hooks` in the TUI, or `--dangerously-bypass-hook-trust` for automation). Codex wrote via the **shell** (`cat > file`), not a file tool, so the hook must parse shell commands and `apply_patch` input for paths. |
| GitHub Copilot CLI | 1.0.114 | `PreToolUse` in `.github/hooks/*.json` (also reads `.claude/settings.json` hooks) | Yes | Repo hooks run only in **trusted folders**; untrusted folders skip them silently (logged). Reports "Denied by preToolUse hook". |
| OpenCode | 2.3.2 | `permission.edit` path rules in `opencode.json` | Yes | 2.x plugin `tool.before` hooks didn't fire for us; static per-path deny rules did. Adapter rewrites `opencode.json` rules from open handoffs. Shell writes are not covered: pre-commit backstop. |

## Design consequences
- Shell commands are a write path for every agent. Path detection in shell input is best effort, so the git pre-commit hook stays mandatory.
- `init` must check trust state (Codex hook trust, Copilot trusted folders) and tell the user, since an untrusted folder silently disables enforcement.
- OpenCode is enforced by config sync rather than a hook: every `new/claim/done/release` regenerates its deny list.

## End-to-end run with handlock (2026-11-18)

Fresh repo, `handlock init --agents claude,codex,opencode`, then a handoff giving `src/parser.js` to Copilot. Each agent was asked to add a line to that file:

| Agent | Result |
|---|---|
| Claude Code | Blocked: `BLOCKED by handlock: src/parser.js is locked by handoff "Rewrite parser" (owner: copilot)` |
| OpenCode | Blocked: `Permission denied: edit` (synced deny rule) |
| Codex | First run **got through** by writing with `python3 -c`. Fixed: shell commands that mention a locked path are blocked unless every part is read-only. Rerun: blocked. |
| git pre-commit | Committing the change as Codex: `commit blocked (1 locked file(s))` |

Copilot was not rerun end to end (repo hooks need a trusted folder), but the hook output format is the one verified above.
