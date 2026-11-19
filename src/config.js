// Where the repo root and the handoffs folder are.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return cwd
  }
}

export function loadConfig(root) {
  const file = path.join(root, '.handlock.json')
  let cfg = {}
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`.handlock.json is not valid JSON: ${e.message}`)
    }
  }
  const raw = process.env.HANDLOCK_DIR ?? cfg.dir ?? 'handoffs'
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw
  return { ...cfg, root, dir: path.resolve(root, expanded) }
}

export const INFRA = ['.handlock.json', 'opencode.json', '.claude/settings.json', '.codex/hooks.json', '.github/hooks/handlock.json']

/** Paths every agent may always touch: the handoffs folder (inside the repo) and handlock config. */
export function exemptPaths(cfg) {
  const rel = toRepoPath(cfg.root, cfg.dir, cfg.root)
  return rel ? [rel, ...INFRA] : INFRA
}

export function toRepoPath(root, p, cwd = process.cwd()) {
  const abs = path.resolve(cwd, p)
  let rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null // outside the repo: not ours
  return rel.split(path.sep).join('/')
}

const ENV_HINTS = [
  ['claude', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']],
  ['codex', ['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']],
  ['opencode', ['OPENCODE', 'OPENCODE_SESSION']],
  ['copilot', ['COPILOT_CLI', 'COPILOT_AGENT_SESSION_ID']],
]

/** Best-effort guess of which agent is running this process (for pre-commit). */
export function detectAgent(env = process.env) {
  if (env.HANDLOCK_AGENT) return env.HANDLOCK_AGENT
  for (const [agent, vars] of ENV_HINTS) if (vars.some(v => env[v])) return agent
  return 'human'
}
