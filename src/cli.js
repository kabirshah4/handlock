import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectAgents,
  installClaude,
  installCodex,
  installCopilot,
  installPreCommit,
  syncOpenCode,
} from './adapters.js'
import { detectAgent, exemptPaths, loadConfig, repoRoot } from './config.js'
import { appendResult, isActive, renderHandoff, setStatus } from './handoff.js'
import { runHook } from './hook.js'
import { canEdit, findConflicts, loadHandoffs } from './locks.js'

const HELP = `handlock: your coding agents can't step on each other.

Usage:
  handlock init [--agents claude,codex,copilot,opencode] [--dir <path>]
  handlock new --to <agent> --from <agent> --title <text> --own <a,b> [--deny <c>] [--project <p>] [--context <text>] [--done-when <a;b>]
  handlock list [--all]
  handlock claim <handoff>
  handlock done <handoff> [--result <text>]
  handlock release <handoff> [--force <reason>]
  handlock check <agent> <path...>
  handlock sync                    regenerate OpenCode deny rules
  handlock hook <agent>            (called by agent hooks; tool call JSON on stdin)
  handlock precommit               (called by the git pre-commit hook)

<handoff> is a file path or any part of its file name or title.
Handoffs folder: ./handoffs, or "dir" in .handlock.json, or $HANDLOCK_DIR.`

function parseArgs(argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opt[key] = true
      else {
        opt[key] = next
        i++
      }
    } else pos.push(a)
  }
  return { pos, opt }
}

const split = (v, sep = ',') =>
  typeof v === 'string'
    ? v
        .split(sep)
        .map(s => s.trim())
        .filter(Boolean)
    : []

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function findHandoff(handoffs, query) {
  if (!query) throw new Error('Name a handoff: a file path or part of its name or title.')
  if (fs.existsSync(query)) {
    const abs = path.resolve(query)
    const h = handoffs.find(x => path.resolve(x.file) === abs)
    if (h) return h
  }
  const q = query.toLowerCase()
  const hits = handoffs.filter(h => path.basename(h.file).toLowerCase().includes(q) || h.title.toLowerCase().includes(q))
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) throw new Error(`No handoff matches "${query}".`)
  throw new Error(`"${query}" matches ${hits.length} handoffs:\n${hits.map(h => `  ${h.file}`).join('\n')}`)
}

function gitDir(root) {
  try {
    return path.resolve(root, execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root }).toString().trim())
  } catch {
    return null
  }
}

function afterChange(cfg) {
  const handoffs = loadHandoffs(cfg.dir)
  const dir = gitDir(cfg.root)
  if (fs.existsSync(path.join(cfg.root, 'opencode.json')) && dir) syncOpenCode(cfg.root, handoffs, dir)
  return handoffs
}

function hookCommand() {
  const script = fileURLToPath(new URL('../bin/handlock.js', import.meta.url))
  if (script.includes(`${path.sep}_npx${path.sep}`)) return 'npx -y handlock hook'
  try {
    const onPath = execFileSync('which', ['handlock'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(script)) return 'handlock hook'
  } catch {}
  return `node "${script}" hook`
}

function setAndWrite(h, status, resultLine) {
  let text = fs.readFileSync(h.file, 'utf8')
  text = setStatus(text, status)
  if (resultLine) text = appendResult(text, resultLine)
  fs.writeFileSync(h.file, text)
}

export async function main(argv) {
  const [cmd, ...rest] = argv
  const { pos, opt } = parseArgs(rest)
  if (!cmd || cmd === 'help' || opt.help) {
    console.log(HELP)
    return 0
  }
  if (cmd === 'hook') return runHook(pos[0] ?? 'unknown')

  const root = repoRoot()
  const cfg = loadConfig(root)
  const out = (...a) => console.log(...a)

  switch (cmd) {
    case 'init': {
      if (typeof opt.dir === 'string') {
        fs.writeFileSync(path.join(root, '.handlock.json'), `${JSON.stringify({ dir: opt.dir }, null, 2)}\n`)
        Object.assign(cfg, loadConfig(root))
      }
      fs.mkdirSync(cfg.dir, { recursive: true })
      const agents = typeof opt.agents === 'string' ? split(opt.agents) : detectAgents()
      const hc = hookCommand()
      out(`handlock: handoffs folder ${path.relative(root, cfg.dir) || '.'}`)
      const notes = []
      for (const a of agents) {
        if (a === 'claude') out(`  claude    ${path.relative(root, installClaude(root, hc))}`)
        else if (a === 'codex') {
          out(`  codex     ${path.relative(root, installCodex(root, hc))}`)
          notes.push('Codex: trust this project and approve the hook once (run `codex`, then /hooks).')
        } else if (a === 'copilot') {
          out(`  copilot   ${path.relative(root, installCopilot(root, hc))}`)
          notes.push('Copilot: repo hooks only run in trusted folders. Trust this folder when Copilot asks.')
        } else if (a === 'opencode') {
          const dir = gitDir(root)
          const { file } = syncOpenCode(root, loadHandoffs(cfg.dir), dir ?? path.join(root, '.git'))
          out(`  opencode  ${path.relative(root, file)} (deny rules, kept in sync)`)
          notes.push('OpenCode: file-tool edits are enforced; shell writes are caught at commit.')
        } else out(`  ${a}: unknown agent, skipped`)
      }
      const pc = installPreCommit(root, hc)
      out(pc ? `  git       ${path.relative(root, pc)}` : '  git       not a git repo: no pre-commit backstop')
      if (notes.length) out(`\n${notes.map(n => `- ${n}`).join('\n')}`)
      out(`\nNext: handlock new --to codex --from claude --title "..." --own src/file.js`)
      return 0
    }

    case 'new': {
      for (const k of ['to', 'from', 'title']) if (typeof opt[k] !== 'string') throw new Error(`--${k} is required.`)
      const owns = split(opt.own)
      if (owns.length === 0) throw new Error('--own needs at least one path, e.g. --own src/a.js,src/b/**')
      const draft = {
        type: 'handoff',
        status: 'open',
        to: opt.to,
        title: opt.title,
        owns,
        deny: [],
        denyAllElse: false,
        file: '(new)',
      }
      const clash = findConflicts([...loadHandoffs(cfg.dir), draft]).filter(c => c.a === draft || c.b === draft)
      if (clash.length) {
        const c = clash[0]
        const other = c.a === draft ? c.b : c.a
        throw new Error(`${c.a === draft ? c.pathA : c.pathB} overlaps "${other.title}" (owner: ${other.to}, ${other.file}). Finish or release that handoff first.`)
      }
      const date = today()
      const name = `${date} ${opt.project ? `${opt.project} - ` : ''}${opt.to} ${slug(opt.title)}.md`
      const file = path.join(cfg.dir, name)
      if (fs.existsSync(file)) throw new Error(`${file} already exists.`)
      fs.mkdirSync(cfg.dir, { recursive: true })
      fs.writeFileSync(
        file,
        renderHandoff({
          from: opt.from,
          to: opt.to,
          project: typeof opt.project === 'string' ? opt.project : '',
          title: opt.title,
          owns,
          deny: split(opt.deny),
          context: typeof opt.context === 'string' ? opt.context : '',
          doneWhen: split(opt['done-when'], ';'),
          date,
        }),
      )
      afterChange(cfg)
      out(`Created ${path.relative(process.cwd(), file)}\n${opt.to} now owns: ${owns.join(', ')}`)
      return 0
    }

    case 'list': {
      const all = loadHandoffs(cfg.dir)
      const shown = opt.all ? all : all.filter(isActive)
      if (shown.length === 0) {
        out(opt.all ? 'No handoffs.' : 'No open handoffs. Nothing is locked.')
        return 0
      }
      for (const h of shown) {
        out(`${h.status.padEnd(11)} ${h.from || '?'} -> ${h.to}  ${h.title}`)
        if (isActive(h)) for (const p of h.owns) out(`            locks ${p}`)
        out(`            ${path.relative(process.cwd(), h.file)}`)
      }
      const conflicts = findConflicts(all)
      for (const c of conflicts) out(`CONFLICT: ${c.pathA} (${c.a.to}) overlaps ${c.pathB} (${c.b.to})`)
      return conflicts.length ? 1 : 0
    }

    case 'claim':
    case 'done':
    case 'release': {
      const h = findHandoff(loadHandoffs(cfg.dir), pos[0])
      if (cmd === 'claim') setAndWrite(h, 'in_progress')
      if (cmd === 'done') setAndWrite(h, 'done', typeof opt.result === 'string' ? opt.result : null)
      if (cmd === 'release') {
        const who = detectAgent()
        const why = typeof opt.force === 'string' ? opt.force : 'released'
        setAndWrite(h, 'cancelled', `Lock released by ${who} on ${today()}: ${why}`)
      }
      afterChange(cfg)
      out(`${h.title}: ${cmd === 'claim' ? 'in_progress' : cmd === 'done' ? 'done, locks released' : 'cancelled, locks released'}`)
      return 0
    }

    case 'check': {
      const [agent, ...paths] = pos
      if (!agent || paths.length === 0) throw new Error('Usage: handlock check <agent> <path...>')
      const handoffs = loadHandoffs(cfg.dir)
      let code = 0
      for (const p of paths) {
        const v = canEdit(handoffs, agent, p, { exempt: exemptPaths(cfg) })
        out(`${v.allowed ? (v.warn ? 'warn ' : 'ok   ') : 'BLOCK'} ${p}${v.reason ? `  ${v.reason}` : ''}`)
        if (!v.allowed) code = 1
      }
      return code
    }

    case 'sync': {
      const dir = gitDir(root)
      const { file, managed } = syncOpenCode(root, loadHandoffs(cfg.dir), dir ?? path.join(root, '.git'))
      out(`${path.relative(root, file)}: ${managed.length} deny rule(s) for OpenCode`)
      return 0
    }

    case 'precommit': {
      const agent = detectAgent()
      const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT'], { cwd: root })
        .toString()
        .split('\n')
        .filter(Boolean)
      const handoffs = loadHandoffs(cfg.dir)
      let blocked = 0
      for (const p of staged) {
        const v = canEdit(handoffs, agent, p, { exempt: exemptPaths(cfg) })
        if (!v.allowed) {
          blocked++
          console.error(`handlock: ${v.reason}`)
        } else if (v.warn) console.error(`handlock (warning): ${v.reason}`)
      }
      if (blocked) console.error(`handlock: commit blocked (${blocked} locked file(s), committing as ${agent}). Set HANDLOCK_AGENT if that's wrong.`)
      return blocked ? 1 : 0
    }

    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`)
      return 1
  }
}
