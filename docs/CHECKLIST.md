# Agent handoff locks: build checklist

## Phase 0: Setup
- [x] Create git repo
- [x] Write design doc (docs/designs/agent-handoff-locks.md)
- [x] Build checklist mod

## Phase 1: Verify agent hooks can block writes
- [x] Claude Code: PreToolUse blocks Edit/Write
- [x] Codex: find hook mechanism, test a block
- [x] OpenCode: find plugin hook, test a block
- [x] Copilot: find hook mechanism, test a block
- [x] Write support table

## Phase 2: Core and CLI
- [x] Scaffold Node package (zero deps, node:test)
- [x] Handoff note parser (frontmatter + sections)
- [x] Lock resolver: canEdit(agent, path)
- [x] Conflict detection between open handoffs
- [x] CLI: new, claim, done, release, list, check
- [x] Tests for every lock rule

## Phase 3: Enforcement
- [x] Claude Code adapter
- [x] git pre-commit backstop
- [x] Codex adapter
- [x] OpenCode adapter
- [x] Copilot adapter
- [x] End-to-end test: a non-owner edit gets blocked

## Phase 4: Init and docs
- [x] `init` command: detect agents, install hooks
- [x] README with demo section and support table
- [x] Record demo (agent gets blocked)

## Phase 5: Ship
- [x] CI workflow (macOS + Linux)
- [x] First commit
- [x] GitHub repo (private)
- [ ] npm publish (needs your OK)

## Phase 6: Review fixes
- [x] Block message says ask the user, no unlock hint
- [x] Only from/to may claim, done or release; --force human-only
- [x] Notes editable only by their from/to (live + pre-commit)
- [x] handlock config and HANDLOCK_AGENT off-limits to agents
- [x] Token-based shell check (cd, bare names, no prefix over-block)
- [x] README: npm note, Copilot footnote, limits, races
- [x] Move checklist to docs/, fix duplicate import
- [x] Real Codex self-unlock attack: blocked on every route
