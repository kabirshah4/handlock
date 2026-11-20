# handlock

**Your coding agents can't step on each other.**

You run Claude Code, Codex, Copilot and OpenCode on the same repo. handlock turns a handoff note into a file lock that every agent's own hooks enforce. If one agent tries to edit a file another agent owns, the edit is refused and the agent is told whose file it is and which note to read.

![Claude Code gets blocked from editing a file locked to Codex](https://raw.githubusercontent.com/kabirshah4/handlock/main/demo/demo.gif)

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

> Not on npm yet. Until it is, clone this repo and run `node bin/handlock.js init` (or `npm link` to get a `handlock` command).

```sh
npx handlock init   # once published
```

This detects which agents you have and wires each one up:

| Agent | Where it's enforced | Live block |
|---|---|---|
| Claude Code | `PreToolUse` hook in `.claude/settings.json` | Yes |
| Codex | `PreToolUse` hook in `.codex/hooks.json` | Yes (trust the project and approve the hook once) |
| GitHub Copilot CLI | `PreToolUse` hook in `.github/hooks/handlock.json` | Yes (folder must be trusted)¹ |
| OpenCode | per-path `permission.edit` deny rules in `opencode.json`, kept in sync | Yes for file edits |
| Anything else | git pre-commit hook | At commit time |

Agents also write through the shell (Codex wrote with `python3 -c` in testing). The hook pulls path-like tokens out of every shell command, including ones inside quoted code and after `cd`, and blocks the command if any of them is someone else's locked file. Read-only commands (`cat`, `grep`, `sed -n`, `git diff`, ...) are always allowed. The git pre-commit hook is the last line of defense.

## The lock protects itself

A blocked agent is told to ask the user, not how to unlock the file. Beyond that:

- Only a handoff's own `from`/`to` agent may edit its note or run `handlock claim/done/release` on it. This is checked live in the hook and again at commit (against the committed version of the note, so changing `to:` doesn't grant itself).
- `--force` is for humans only.
- Agents can't change handlock's own config (`.claude/settings.json`, `.codex/hooks.json`, `opencode.json`, `.handlock.json`, git hooks) or set `HANDLOCK_AGENT`.
- Agents can't skip the pre-commit hook (`git commit --no-verify`, `core.hooksPath`).
- While another agent holds a lock, commands that wipe the whole tree without naming files (`git checkout .`, `git reset --hard`, `git stash`, `git clean -f`, `rm -rf *`) are blocked.

In testing, Codex was told to unlock a file by every route (`release --force`, `apply_patch` on the note, then the edit). It was blocked each time and reported back instead.

## Limits, stated plainly

- **Shell writes are best effort.** A command that builds a path out of pieces (`open('par' + 'ser.js')`) gets past the live check. The pre-commit hook still catches it, as long as it can tell who's committing.
- **"Don't touch: everything else" covers file-tool edits live.** Shell writes to unowned files are only caught at commit.
- **No lock server means races are possible.** `handlock new` checks for overlapping claims, then writes the note. Two agents creating handoffs at the same instant could both succeed. `handlock list` reports any overlap.
- **Trust matters.** Codex ignores project hooks in an untrusted project, and Copilot ignores repo hooks in an untrusted folder. In both cases there's no live enforcement, only pre-commit.
- **handlock guards the repo, not your home folder.** An agent that edits its own user-level settings (`~/.claude`, `~/.codex`) to turn hooks off gets past the live check. Keep those agents' permission prompts on for files outside the project.

Claude Code, Codex and OpenCode were tested end to end against a real handlock lock. ¹Copilot's blocking was verified with a test hook that uses the same output format, but it hasn't been rerun against handlock itself. Details: [docs/support-table.md](docs/support-table.md).

## Usage

```sh
handlock new --to codex --from claude --title "Rewrite parser" --own src/parser.js,tests/parser/**
handlock list                 # open handoffs and what they lock
handlock claim parser         # mark in progress
handlock done parser --result "Shipped, tests green."
handlock release parser --force "Codex crashed"   # humans only: clear a stale lock, logged in the note
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

Hooks know which agent is calling. At commit time handlock guesses from the environment (`CLAUDECODE`, `CODEX_THREAD_ID`, ...). Set `HANDLOCK_AGENT=<name>` in each agent's launch environment to be explicit; an agent nested inside another (say, Codex started from a Claude Code shell) inherits the outer agent's markers otherwise. An unknown committer is treated as a human: warned, not blocked.

## Develop

```sh
npm test            # node:test, no dependencies
vhs demo/demo.tape  # re-record the demo (needs claude on PATH)
HANDLOCK_LOG=/tmp/h.log  # log every hook payload (agents that pass env to hooks)
```

## License

MIT
