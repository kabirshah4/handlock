import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/handlock.js', import.meta.url))

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handlock-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  return dir
}

function run(cwd, args, { input, env = {} } = {}) {
  const clean = { ...process.env }
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'HANDLOCK_AGENT', 'HANDLOCK_DIR']) delete clean[k]
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, env: { ...clean, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('end to end: init, new, hook blocks, conflict, done releases', () => {
  const dir = repo()
  let r = run(dir, ['init', '--agents', 'claude,codex,copilot,opencode'])
  assert.equal(r.code, 0, r.err)
  for (const f of ['.claude/settings.json', '.codex/hooks.json', '.github/hooks/handlock.json', 'opencode.json', '.git/hooks/pre-commit']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} missing`)
  }

  r = run(dir, ['new', '--to', 'claude', '--from', 'human', '--title', 'Write parser', '--own', 'src/parser.js'])
  assert.equal(r.code, 0, r.err)

  // OpenCode deny rule synced
  const oc = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'))
  assert.equal(oc.permission.edit['src/parser.js'], 'deny')

  // Codex writing via shell is blocked with exit 2 and a deny decision
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > src/parser.js' }, cwd: dir })
  r = run(dir, ['hook', 'codex'], { input: payload })
  assert.equal(r.code, 2)
  assert.match(r.err, /BLOCKED by handlock: src\/parser.js is locked by handoff "Write parser" \(owner: claude\)/)
  assert.equal(JSON.parse(r.out).permissionDecision, 'deny')

  // the owner passes
  r = run(dir, ['hook', 'claude'], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/parser.js') }, cwd: dir }) })
  assert.equal(r.code, 0)

  // overlapping claim refused
  r = run(dir, ['new', '--to', 'codex', '--from', 'claude', '--title', 'Refactor', '--own', 'src/**'])
  assert.equal(r.code, 1)
  assert.match(r.err, /overlaps "Write parser"/)

  // check command
  r = run(dir, ['check', 'copilot', 'src/parser.js', 'README.md'])
  assert.equal(r.code, 1)
  assert.match(r.out, /BLOCK src\/parser.js/)
  assert.match(r.out, /ok\s+README.md/)

  // done releases the lock and the OpenCode rule
  r = run(dir, ['done', 'parser', '--result', 'Shipped.'])
  assert.equal(r.code, 0, r.err)
  r = run(dir, ['hook', 'codex'], { input: payload })
  assert.equal(r.code, 0)
  const oc2 = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'))
  assert.equal(oc2.permission.edit['src/parser.js'], undefined)
})

test('pre-commit blocks an agent committing someone else\'s file, warns humans', () => {
  const dir = repo()
  run(dir, ['init', '--agents', 'claude'])
  run(dir, ['new', '--to', 'claude', '--from', 'human', '--title', 'Parser', '--own', 'src/parser.js'])
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src/parser.js'), 'x')
  execFileSync('git', ['add', '-A'], { cwd: dir })

  let r = run(dir, ['precommit'], { env: { HANDLOCK_AGENT: 'codex' } })
  assert.equal(r.code, 1)
  assert.match(r.err, /commit blocked/)

  r = run(dir, ['precommit'], { env: { HANDLOCK_AGENT: 'claude' } })
  assert.equal(r.code, 0)

  r = run(dir, ['precommit'])
  assert.equal(r.code, 0)
  assert.match(r.err, /warning/)
})

test('init merges into existing Claude settings and is idempotent', () => {
  const dir = repo()
  fs.mkdirSync(path.join(dir, '.claude'))
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }))
  run(dir, ['init', '--agents', 'claude'])
  run(dir, ['init', '--agents', 'claude'])
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'))
  assert.equal(cfg.model, 'x')
  assert.equal(cfg.hooks.PreToolUse.length, 2)
  const pc = fs.readFileSync(path.join(dir, '.git/hooks/pre-commit'), 'utf8')
  assert.equal(pc.match(/# >>> handlock/g).length, 1)
})

test('malformed hook input never breaks the agent', () => {
  const dir = repo()
  const r = run(dir, ['hook', 'codex'], { input: 'not json' })
  assert.equal(r.code, 0)
})
