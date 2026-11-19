import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide } from '../src/hook.js'
import { parseHandoff } from '../src/handoff.js'
import { fromShell, pathsFromToolCall } from '../src/paths.js'

// Payloads as each agent actually sent them (docs/support-table.md).
const claude = { tool_name: 'Write', tool_input: { file_path: '/repo/src/a.js', content: 'x' }, cwd: '/repo' }
const codexShell = { tool_name: 'Bash', tool_input: { command: "cat > src/a.js <<'EOF'\nhello > not-a-file\nEOF" }, cwd: '/repo' }
const copilotPatch = { tool_name: 'Edit', tool_input: '*** Begin Patch\n*** Add File: src/a.js\n+hello\n*** End Patch\n', cwd: '/repo' }

test('paths: Claude file tool', () => {
  assert.deepEqual(pathsFromToolCall(claude), ['/repo/src/a.js'])
})

test('paths: Codex shell heredoc (body ignored)', () => {
  assert.deepEqual(pathsFromToolCall(codexShell), ['src/a.js'])
})

test('paths: Copilot apply_patch string', () => {
  assert.deepEqual(pathsFromToolCall(copilotPatch), ['src/a.js'])
})

test('paths: MultiEdit, patch moves', () => {
  assert.deepEqual(pathsFromToolCall({ tool_name: 'MultiEdit', tool_input: { file_path: 'a', edits: [{ file_path: 'b' }] } }), ['a', 'b'])
  assert.deepEqual(pathsFromToolCall({ tool_name: 'apply_patch', tool_input: { input: '*** Update File: a\n*** Move to: b\n' } }), ['a', 'b'])
})

test('shell: redirects, tee, sed -i, mv, rm; ignores fd redirects', () => {
  assert.deepEqual(fromShell('echo hi >> log.txt'), ['log.txt'])
  assert.deepEqual(fromShell('ls 2>&1 | tee out.txt'), ['out.txt'])
  assert.deepEqual(fromShell("sed -i '' 's/a/b/' src/a.js"), ['src/a.js'])
  assert.deepEqual(fromShell('mv a.js b.js && rm -f c.js'), ['a.js', 'b.js', 'c.js'])
  assert.deepEqual(fromShell('npm test 2>/dev/null'), [])
})

const handoffs = [
  parseHandoff('---\ntype: handoff\nto: Claude\nstatus: open\n---\n# Parser\n## Files you own\n- `src/a.js`\n', 'handoffs/p.md'),
]

test('decide: blocks Codex and Copilot, allows the owner', () => {
  const ctx = { root: '/repo', handoffs }
  assert.equal(decide(codexShell, 'codex', ctx).allowed, false)
  assert.equal(decide(copilotPatch, 'copilot', ctx).allowed, false)
  assert.equal(decide(claude, 'claude', ctx).allowed, true)
})

test('decide: read-only tools and paths outside the repo pass', () => {
  const ctx = { root: '/repo', handoffs }
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: '/repo/src/a.js' } }, 'codex', ctx).allowed, true)
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: '/elsewhere/src/a.js' } }, 'codex', ctx).allowed, true)
})

test('decide: shell commands mentioning a locked file are blocked unless read-only', () => {
  const ctx = { root: '/repo', handoffs }
  const sh = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' })
  // the Codex workaround seen in the real end-to-end run
  assert.equal(decide(sh(`python3 -c 'from pathlib import Path; p=Path("src/a.js"); p.write_text("x")'`), 'codex', ctx).allowed, false)
  assert.equal(decide(sh("node -e \"require('fs').writeFileSync('src/a.js','x')\""), 'codex', ctx).allowed, false)
  assert.equal(decide(sh("sed -n '1,5p' src/a.js"), 'codex', ctx).allowed, true)
  assert.equal(decide(sh('cat src/a.js | grep parse'), 'codex', ctx).allowed, true)
  assert.equal(decide(sh('git diff src/a.js'), 'codex', ctx).allowed, true)
  assert.equal(decide(sh('cat src/a.js > copy.js'), 'codex', ctx).allowed, true) // writes copy.js, not the lock
  assert.equal(decide(sh('cat x > src/a.js'), 'codex', ctx).allowed, false)
  assert.equal(decide(sh('npm test'), 'codex', ctx).allowed, true)
  assert.equal(decide(sh("python3 -c 'open(\"src/a.js\",\"w\")'"), 'claude', ctx).allowed, true) // the owner
})
