# handlock

**Your coding agents can't step on each other.**

You run Claude Code, Codex, Copilot and OpenCode on the same repo. handlock turns a handoff note into a file lock that every agent's own hooks enforce. If one agent tries to edit a file another agent owns, the edit is refused and the agent is told whose file it is and which note to read.

![Claude Code gets blocked from editing a file locked to Codex](demo/demo.gif)

## How it works

A handoff is a plain markdown note (it works in an Obsidian vault as-is):

```markdown
---
type: handoff
from: Claude
to: Codex
status: open
---
# Rewrite the parser

## Files you own
- `src/parser.js`
- `tests/parser/**`

## Don't touch
- everything else
```

While it's `open` or `in_progress`:

- **Codex** may edit `src/parser.js` and `tests/parser/**`. Every other agent is blocked from them.
- **"Don't touch: everything else"** keeps Codex inside its own files (except the handoffs folder and handlock's config).
- **Humans** get a warning, never a block.
- Two open handoffs can't claim the same file. `handlock new` refuses the overlap.
- `done` or `cancelled` releases the lock.

There's no lock server and no database: the note is the lock.

## Install

```sh
npx handlock init
```

This detects which agents you have and wires each one up:

| Agent | Where it's enforced | Live block |
|---|---|---|
| Claude Code | `PreToolUse` hook in `.claude/settings.json` | Yes |
| Codex | `PreToolUse` hook in `.codex/hooks.json` | Yes (trust the project and approve the hook once) |
| GitHub Copilot CLI | `PreToolUse` hook in `.github/hooks/handlock.json` | Yes (folder must be trusted) |
| OpenCode | per-path `permission.edit` deny rules in `opencode.json`, kept in sync | Yes for file edits |
| Anything else | git pre-commit hook | At commit time |

Agents also write through the shell (Codex wrote with `python3 -c` in testing). So a shell command that mentions a locked file is blocked unless every part of it is read-only (`cat`, `grep`, `sed -n`, `git diff`, ...). The git pre-commit hook is the last line of defense for anything that slips through.

Each result above was verified against the real agent CLIs. See [docs/support-table.md](docs/support-table.md).

## Usage

```sh
handlock new --to codex --from claude --title "Rewrite parser" --own src/parser.js,tests/parser/**
handlock list                 # open handoffs and what they lock
handlock claim parser         # mark in progress
handlock done parser --result "Shipped, tests green."
handlock release parser --force "Codex crashed"   # clear a stale lock, logged in the note
handlock check codex src/parser.js                # would this edit be allowed?
```

`<handoff>` can be a file path or any part of its file name or title.

The handoffs folder is `./handoffs` by default. Point it anywhere, such as a shared Obsidian vault:

```json
// .handlock.json
{ "dir": "~/Documents/AI Team/Handoffs" }
```

or set `HANDLOCK_DIR`.

## Pre-commit and agent identity

Hooks know which agent is calling. At commit time handlock guesses from the environment (`CLAUDECODE`, `CODEX_THREAD_ID`, ...). Set `HANDLOCK_AGENT=<name>` to be explicit. An unknown committer is treated as a human: warned, not blocked.

## Develop

```sh
npm test            # node:test, no dependencies
vhs demo/demo.tape  # re-record the demo (needs claude on PATH)
```

## License

MIT
