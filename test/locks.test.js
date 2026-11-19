import assert from 'node:assert/strict'
import { test } from 'node:test'

import { matches, overlaps } from '../src/glob.js'
import { parseHandoff, setStatus, appendResult } from '../src/handoff.js'
import { canEdit, findConflicts, ownedByOthers } from '../src/locks.js'

const note = ({ to = 'Codex', status = 'open', owns = ['src/a.js'], deny = ['everything else'], title = 'T' } = {}) =>
  parseHandoff(
    `---
type: handoff
from: Claude
to: ${to}
project: demo
status: ${status}   # comment
created: 2026-11-18
---
# ${title}

## Files you own
${owns.map(o => `- \`${o}\``).join('\n')}

## Don't touch
${deny.map(d => `- ${d}`).join('\n')}

## Done when
- [ ] tests pass
`,
    `handoffs/${title}.md`,
  )

test('glob: exact, *, **, directory prefix', () => {
  assert.ok(matches('src/a.js', 'src/a.js'))
  assert.ok(matches('./src/a.js', 'src/a.js'))
  assert.ok(!matches('src/a.js', 'src/ab.js'))
  assert.ok(matches('src/*.js', 'src/b.js'))
  assert.ok(!matches('src/*.js', 'src/x/b.js'))
  assert.ok(matches('src/**', 'src/x/y/z.ts'))
  assert.ok(matches('src/**/*.ts', 'src/z.ts'))
  assert.ok(matches('tests/fixtures', 'tests/fixtures/ref.html'))
  assert.ok(!matches('', 'anything'))
})

test('glob: overlaps', () => {
  assert.ok(overlaps('src/**', 'src/a.js'))
  assert.ok(overlaps('src/a.js', 'src/a.js'))
  assert.ok(overlaps('src/**', 'src/x/*.js'))
  assert.ok(!overlaps('src/a.js', 'src/b.js'))
  assert.ok(!overlaps('docs/**', 'src/**'))
})

test('parse: real AI Team note shape', () => {
  const h = note({ owns: ['~/x/extract-design.js', 'tests/fixtures/ref.html'] })
  assert.equal(h.to, 'Codex')
  assert.equal(h.status, 'open')
  assert.deepEqual(h.owns, ['~/x/extract-design.js', 'tests/fixtures/ref.html'])
  assert.equal(h.denyAllElse, true)
  assert.deepEqual(h.deny, [])
})

test('parse: plain list items with trailing notes', () => {
  const h = parseHandoff('---\ntype: handoff\nto: A\n---\n# x\n## Files you own\n- src/a.js (the parser)\n- [ ] src/b.js\n', 'f')
  assert.deepEqual(h.owns, ['src/a.js', 'src/b.js'])
})

test('owner may edit its files', () => {
  assert.deepEqual(canEdit([note()], 'codex', 'src/a.js'), { allowed: true })
})

test('another agent is blocked from owned files', () => {
  const v = canEdit([note()], 'claude', 'src/a.js')
  assert.equal(v.allowed, false)
  assert.match(v.reason, /locked by handoff "T" \(owner: Codex\)/)
})

test('humans are warned, not blocked', () => {
  const v = canEdit([note()], 'human', 'src/a.js')
  assert.equal(v.allowed, true)
  assert.equal(v.warn, true)
})

test('"everything else" limits the receiving agent to its own files', () => {
  assert.equal(canEdit([note()], 'codex', 'src/other.js').allowed, false)
  assert.equal(canEdit([note()], 'claude', 'src/other.js').allowed, true)
})

test('explicit don\'t-touch paths deny the receiver only', () => {
  const h = note({ deny: ['package.json'] })
  assert.equal(canEdit([h], 'codex', 'package.json').allowed, false)
  assert.equal(canEdit([h], 'codex', 'src/free.js').allowed, true)
  assert.equal(canEdit([h], 'claude', 'package.json').allowed, true)
})

test('unowned files are free (opt-in locking)', () => {
  assert.equal(canEdit([note({ deny: [] })], 'opencode', 'README.md').allowed, true)
})

test('done and cancelled handoffs release locks', () => {
  assert.equal(canEdit([note({ status: 'done' })], 'claude', 'src/a.js').allowed, true)
  assert.equal(canEdit([note({ status: 'cancelled' })], 'claude', 'src/a.js').allowed, true)
  assert.equal(canEdit([note({ status: 'in_progress' })], 'claude', 'src/a.js').allowed, false)
})

test('agent names compare case-insensitively', () => {
  assert.equal(canEdit([note({ to: 'Codex' })], 'CODEX', 'src/a.js').allowed, true)
})

test('conflicts: overlapping claims by different owners', () => {
  const a = note({ to: 'Codex', owns: ['src/**'], title: 'A' })
  const b = note({ to: 'OpenCode', owns: ['src/x.js'], title: 'B' })
  const c = note({ to: 'Codex', owns: ['src/y.js'], title: 'C' })
  const found = findConflicts([a, b, c])
  assert.equal(found.length, 1)
  assert.equal(found[0].b.title, 'B')
})

test('ownedByOthers skips the agent\'s own and inactive handoffs', () => {
  const list = ownedByOthers([note({ to: 'Claude' }), note({ to: 'OpenCode', owns: ['x'] }), note({ status: 'done', owns: ['y'] })], 'opencode')
  assert.deepEqual(list.map(x => x.pattern), ['src/a.js'])
})

test('setStatus and appendResult edit the note in place', () => {
  const text = '---\ntype: handoff\nstatus: open\n---\n# T\n\n## Result\n(fill)\n'
  const out = appendResult(setStatus(text, 'done'), 'Shipped.')
  assert.match(out, /status: done/)
  assert.match(out, /## Result\nShipped\./)
})
