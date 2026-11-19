// Install handlock into each agent and git. Every writer merges; nothing of the user's is dropped.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ownedByOthers } from './locks.js'

const MARK = /handlock(?:\.js"?)? hook/

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON; fix it or remove it, then rerun.`)
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function hasCommand(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function detectAgents() {
  return ['claude', 'codex', 'copilot', 'opencode'].filter(hasCommand)
}

// Claude Code: PreToolUse in .claude/settings.json (Copilot reads this file too).
export function installClaude(root, cmd) {
  const file = path.join(root, '.claude', 'settings.json')
  const cfg = readJson(file, {})
  cfg.hooks ??= {}
  const list = (cfg.hooks.PreToolUse ??= [])
  const entry = { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: `${cmd} claude` }] }
  const i = list.findIndex(e => e.hooks?.some(h => MARK.test(h.command ?? '')))
  if (i >= 0) list[i] = entry
  else list.push(entry)
  writeJson(file, cfg)
  return file
}

// Codex: PreToolUse in the project's .codex/hooks.json (needs project + hook trust).
export function installCodex(root, cmd) {
  const file = path.join(root, '.codex', 'hooks.json')
  const cfg = readJson(file, {})
  cfg.hooks ??= {}
  const list = (cfg.hooks.PreToolUse ??= [])
  const entry = { hooks: [{ type: 'command', command: `${cmd} codex`, timeout: 10 }] }
  const i = list.findIndex(e => e.hooks?.some(h => MARK.test(h.command ?? '')))
  if (i >= 0) list[i] = entry
  else list.push(entry)
  writeJson(file, cfg)
  return file
}

// Copilot CLI: PreToolUse in .github/hooks/handlock.json (needs a trusted folder).
export function installCopilot(root, cmd) {
  const file = path.join(root, '.github', 'hooks', 'handlock.json')
  writeJson(file, { version: 1, hooks: { PreToolUse: [{ type: 'command', bash: `${cmd} copilot`, timeoutSec: 10 }] } })
  return file
}

// OpenCode: no blocking hook fired in 2.x, so sync per-path deny rules into opencode.json.
export function syncOpenCode(root, handoffs, gitDir) {
  const file = path.join(root, 'opencode.json')
  const stateFile = path.join(gitDir ?? path.join(root, '.git'), 'handlock-opencode.json')
  const cfg = readJson(file, { $schema: 'https://opencode.ai/config.json' })
  const prev = new Set(readJson(stateFile, { managed: [] }).managed)
  let edit = cfg.permission?.edit
  if (typeof edit === 'string') edit = { '*': edit }
  edit = { ...(edit ?? { '*': 'allow' }) }
  for (const p of prev) delete edit[p]
  const managed = []
  for (const { pattern } of ownedByOthers(handoffs, 'opencode')) {
    if (edit[pattern] && !prev.has(pattern)) continue // the user's own rule wins
    edit[pattern] = 'deny'
    managed.push(pattern)
  }
  if (!('*' in edit)) edit = { '*': 'allow', ...edit }
  else {
    const { '*': star, ...rest } = edit
    edit = { '*': star, ...rest } // wildcard first so specific rules override it
  }
  cfg.permission = { ...(cfg.permission ?? {}), edit }
  writeJson(file, cfg)
  writeJson(stateFile, { managed })
  return { file, managed }
}

// git pre-commit: chain to an existing hook rather than replacing it.
export function installPreCommit(root, cmd) {
  let hooksDir
  try {
    hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root }).toString().trim()
  } catch {
    return null
  }
  hooksDir = path.resolve(root, hooksDir)
  fs.mkdirSync(hooksDir, { recursive: true })
  const file = path.join(hooksDir, 'pre-commit')
  const line = `${cmd.replace(/ hook$/, '')} precommit || exit 1`
  const block = `# >>> handlock\n${line}\n# <<< handlock\n`
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n'
  if (text.includes('# >>> handlock')) text = text.replace(/# >>> handlock[\s\S]*?# <<< handlock\n/, block)
  else text = `${text.trimEnd()}\n${block}`
  fs.writeFileSync(file, text, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return file
}
