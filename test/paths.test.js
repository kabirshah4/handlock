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

// Review findings (2026-11-19): a blocked agent must not be able to unlock things itself.
const lockedTo = (to, from, owns, file = '/repo/handoffs/p.md', title = 'Parser') =>
  parseHandoff(`---\ntype: handoff\nfrom: ${from}\nto: ${to}\nstatus: open\n---\n# ${title}\n## Files you own\n${owns.map(o => `- \`${o}\``).join('\n')}\n`, file)

const rctx = { root: '/repo', handoffs: [lockedTo('claude', 'human', ['src/parser.js']), lockedTo('copilot', 'claude', ['lib/**'], '/repo/handoffs/lib.md', 'Lib')], notesDir: 'handoffs' }
const bash = command => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' })
const write = file_path => ({ tool_name: 'Write', tool_input: { file_path }, cwd: '/repo' })

test('review #1: block message tells the agent to ask the user, not how to unlock', () => {
  const v = decide(write('/repo/src/parser.js'), 'codex', rctx)
  assert.equal(v.allowed, false)
  assert.doesNotMatch(v.reason, /handlock release/)
  assert.match(v.reason, /tell the user/)
})

test('review #1: blocked agents cannot release, finish or force someone else\'s lock', () => {
  assert.equal(decide(bash('handlock release parser'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('npx handlock done parser --result x'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('handlock release parser --force "stale"'), 'claude', rctx).allowed, false)
  assert.equal(decide(bash('HANDLOCK_AGENT=claude handlock release parser'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('handlock done parser --result "shipped"'), 'claude', rctx).allowed, true) // the owner
  assert.equal(decide(bash('handlock done lib'), 'claude', rctx).allowed, true) // the author
  assert.equal(decide(bash('handlock list'), 'codex', rctx).allowed, true)
})

test('review #2: only a note\'s from/to may edit it; config is human-only', () => {
  assert.equal(decide(write('/repo/handoffs/p.md'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash("sed -i '' 's/status: open/status: done/' handoffs/p.md"), 'codex', rctx).allowed, false)
  assert.equal(decide(write('/repo/handoffs/p.md'), 'claude', rctx).allowed, true)
  assert.equal(decide(write('/repo/handoffs/new-task.md'), 'codex', rctx).allowed, true)
  assert.equal(decide(bash('git add handoffs/p.md && git commit -m x'), 'codex', rctx).allowed, true)
  for (const f of ['.claude/settings.json', 'opencode.json', '.codex/hooks.json', '.git/hooks/pre-commit', '.handlock.json']) {
    assert.equal(decide(write(`/repo/${f}`), 'claude', rctx).allowed, false, f)
  }
  assert.equal(decide(bash("python3 -c \"import json; open('opencode.json','w')\""), 'opencode', rctx).allowed, false)
})

test('review #3: shell check no longer over-blocks globbed folders', () => {
  assert.equal(decide(bash('npm test lib'), 'codex', rctx).allowed, true)
  assert.equal(decide(bash('node scripts/build.js lib'), 'codex', rctx).allowed, true)
  assert.equal(decide(bash("python3 -c \"open('lib/x.js','w')\""), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('rm -rf lib'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('git checkout -- lib'), 'codex', rctx).allowed, false)
})

test('review #3: shell check catches cd-relative and bare-name writes', () => {
  assert.equal(decide(bash(`cd src && python3 -c "open('parser.js','w').write('x')"`), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('cd src; node -e "require(\'fs\').writeFileSync(\'parser.js\',\'x\')"'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash('cd src && cat parser.js'), 'codex', rctx).allowed, true)
  assert.equal(decide(bash('rm -rf src'), 'codex', rctx).allowed, false)
})

test('agents cannot skip the pre-commit hook', () => {
  for (const c of ['git commit --no-verify -m x', 'git commit -nm x', 'git commit -am x -n', 'git -c core.hooksPath=/dev/null commit -m x', 'git config core.hooksPath /tmp/h']) {
    assert.equal(decide(bash(c), 'codex', rctx).allowed, false, c)
  }
  assert.equal(decide(bash('git commit -m "handle -n flag"'), 'codex', rctx).allowed, true)
  assert.equal(decide(bash('git commit -am "x"'), 'codex', rctx).allowed, true)
})

test('whole-tree resets and deletes are blocked while someone else holds a lock', () => {
  for (const c of ['git checkout .', 'git checkout -- .', 'git restore .', 'git reset --hard', 'git reset --hard HEAD~1', 'git stash', 'git stash -u', 'git clean -fd', 'rm -rf *', 'rm -rf .', 'cd src && rm -rf ./*']) {
    assert.equal(decide(bash(c), 'codex', rctx).allowed, false, c)
  }
  for (const c of ['git stash list', 'git checkout -b feature', 'git restore docs/a.md', 'git reset HEAD docs/a.md', 'rm -rf build']) {
    assert.equal(decide(bash(c), 'codex', rctx).allowed, true, c)
  }
  const mine = { root: '/repo', handoffs: [lockedTo('codex', 'human', ['src/**'])], notesDir: 'handoffs' }
  assert.equal(decide(bash('git stash'), 'codex', mine).allowed, true) // no one else holds a lock
})

test('review: handlock invoked by a quoted path with spaces is still checked', () => {
  assert.equal(decide(bash('node "/Users/me/my projects/bin/handlock.js" release parser --force stale'), 'codex', rctx).allowed, false)
  assert.equal(decide(bash("'/opt/x y/handlock' done parser"), 'codex', rctx).allowed, false)
})
