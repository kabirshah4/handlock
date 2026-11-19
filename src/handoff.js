// Parse and write handoff notes: markdown with YAML-ish frontmatter.

export const ACTIVE = new Set(['open', 'in_progress'])
export const STATUSES = ['open', 'in_progress', 'done', 'cancelled']

const SECTION_OWN = /^files you own$/i
const SECTION_DENY = /^don'?t touch$/i
const EVERYTHING_ELSE = /^(everything else|all other files|\*)$/i

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(?:#.*)?$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(m[0].length) }
}

function listItems(lines) {
  const out = []
  for (const line of lines) {
    const m = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line)
    if (!m) continue
    let item = m[1]
    const code = /^`([^`]+)`/.exec(item)
    if (code) item = code[1]
    else item = item.replace(/\s+[-–—(].*$/, '').trim()
    if (item) out.push(item)
  }
  return out
}

export function parseHandoff(text, file = '') {
  const { meta, body } = parseFrontmatter(text)
  const sections = {}
  let title = ''
  let current = null
  for (const line of body.split(/\r?\n/)) {
    const h1 = /^#\s+(.+)/.exec(line)
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      current = h2[1]
      sections[current] = []
    } else if (h1 && !title) {
      title = h1[1].trim()
    } else if (current) {
      sections[current].push(line)
    }
  }
  const find = re => Object.keys(sections).find(k => re.test(k.trim()))
  const ownKey = find(SECTION_OWN)
  const denyKey = find(SECTION_DENY)
  const owns = ownKey ? listItems(sections[ownKey]) : []
  const denyRaw = denyKey ? listItems(sections[denyKey]) : []
  const denyAllElse = denyRaw.some(d => EVERYTHING_ELSE.test(d))
  const deny = denyRaw.filter(d => !EVERYTHING_ELSE.test(d))
  return {
    file,
    title,
    type: meta.type ?? '',
    from: meta.from ?? '',
    to: meta.to ?? '',
    project: meta.project ?? '',
    status: (meta.status ?? 'open').toLowerCase(),
    created: meta.created ?? '',
    owns,
    deny,
    denyAllElse,
    meta,
  }
}

export function isActive(h) {
  return h.type === 'handoff' && ACTIVE.has(h.status) && h.to !== ''
}

export function setStatus(text, status) {
  if (/^---\r?\n[\s\S]*?\nstatus:.*$/m.test(text)) {
    return text.replace(/^(status:\s*).*$/m, `$1${status}`)
  }
  return text.replace(/^---\r?\n/, `---\nstatus: ${status}\n`)
}

export function appendResult(text, line) {
  if (/^## Result\s*$/m.test(text)) {
    return text.replace(/^## Result\s*$/m, m => `${m}\n${line}`)
  }
  return `${text.trimEnd()}\n\n## Result\n${line}\n`
}

export function renderHandoff({ from, to, project = '', title, owns = [], deny = [], context = '', doneWhen = [], date }) {
  const list = items => (items.length ? items.map(i => `- \`${i}\``).join('\n') : '- ')
  return `---
type: handoff
from: ${from}
to: ${to}
project: ${project}
status: open
created: ${date}
---
# ${title}

## Context
${context || "(What the receiving agent needs to know. Link files, don't paste them.)"}

## Files you own
${list(owns)}

## Don't touch
${deny.length ? list(deny) : '- everything else'}

## Done when
${doneWhen.length ? doneWhen.map(d => `- [ ] ${d}`).join('\n') : '- [ ] '}

## Result
(The receiving agent fills this in.)
`
}
