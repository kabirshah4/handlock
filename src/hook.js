// The one hook every agent calls: `handlock hook <agent>` with the tool call on stdin.
// Output works for Claude Code, Codex and Copilot alike (verified in docs/support-table.md):
// the reason on stderr, a deny decision on stdout, exit code 2.
//
// The hook is the one place that knows for certain which agent is acting, so it also
// guards the lock itself: the notes, handlock's config, and the handlock CLI.

import fs from 'node:fs'
import path from 'node:path'

import { INFRA, loadConfig, repoRoot, toRepoPath } from './config.js'
import { matches, normalize } from './glob.js'
import { isActive } from './handoff.js'
import { canEdit, loadHandoffs, sameAgent } from './locks.js'
import { isReadOnlyShell, isReadOnlyTool, pathsFromToolCall, shellCommand } from './paths.js'

const ASK = "Don't work around this, edit the note, or release the lock yourself: tell the user and let them decide."

const DESTRUCTIVE = /^(rm|mv|rsync|rmdir|shred|truncate)$/
const GIT_DESTRUCTIVE = /^(checkout|restore|clean|reset|rm|mv|stash)$/
const GIT_SAFE = /^(add|commit|push|fetch|status|diff|log|show)$/

function isParty(h, agent) {
  return sameAgent(h.to, agent) || sameAgent(h.from, agent)
}

function noteAt(handoffs, root, rel) {
  return handoffs.find(h => toRepoPath(root, h.file, root) === rel)
}

/** Path-like tokens in a shell command, including those inside quotes and code strings. */
export function shellTokens(cmd) {
  const out = new Set()
  for (const t of cmd.split(/[\s'"`()[\]{},;=+|&<>]+/)) {
    const tok = t.replace(/^[:@]+|[:.]+$/g, '')
    if (tok.length >= 2 && /^[\w.~/-]+$/.test(tok) && !/^-/.test(tok) && /[A-Za-z]/.test(tok)) out.add(tok)
  }
  return [...out]
}

function cdTargets(cmd, cwd) {
  const bases = [cwd]
  const re = /(?:^|[;&|]\s*)(?:cd|pushd)\s+(['"]?)([^\s;&|'"]+)\1/g
  let m
  while ((m = re.exec(cmd))) bases.push(path.resolve(bases[bases.length - 1], m[2]))
  return bases
}

function segments(cmd) {
  return cmd
    .split(/&&|\|\||[;|\n]/)
    .map(s => s.trim().split(/\s+/).map(w => w.replace(/^['"]+|['"]+$/g, '')))
    .filter(w => w[0])
}

// Skipping the pre-commit hook: `git commit --no-verify` / `-n`, or pointing git at other hooks.
function bypassesCommitHook(w) {
  if (w[0] !== 'git') return false
  if (w.some(x => /^core\.hookspath/i.test(x))) return true
  const at = w.indexOf('commit')
  return at > 0 && w.slice(at + 1).some(x => x === '--no-verify' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(x))
}

// Commands that reset or delete the whole tree without naming any file.
function wipesTree(w) {
  const [c, sub, ...rest] = w
  const everything = x => /^(\.|\.\/|\*|\.\/\*|:\/|:\/:)$/.test(x)
  if (c === 'rm') return w.slice(1).some(everything)
  if (c !== 'git') return false
  if (sub === 'reset') return rest.some(x => /^--(hard|merge|keep)$/.test(x))
  if (sub === 'stash') return !rest[0] || /^(push|save|-)/.test(rest[0])
  if (sub === 'clean') return rest.some(x => x === '--force' || /^-[a-zA-Z]*f/.test(x))
  if (sub === 'checkout' || sub === 'restore') return rest.some(x => everything(x) || x === '-f' || x === '--force')
  return false
}

function blockedShell(cmd, agent, { root, handoffs, cwd, notesDir }) {
  // Spoofing who you are, or pointing handlock at another folder, is never an agent's call.
  if (/\bHANDLOCK_(AGENT|DIR)\s*=/.test(cmd) || /\bexport\s+HANDLOCK_/.test(cmd)) {
    return `agents may not set HANDLOCK_AGENT or HANDLOCK_DIR. ${ASK}`
  }

  // Quoted text (commit messages, code strings) can't count as flags here.
  const unquoted = segments(cmd.replace(/"[^"]*"|'[^']*'/g, '""'))
  if (unquoted.some(bypassesCommitHook)) return `agents may not skip handlock's pre-commit hook (--no-verify, core.hooksPath). ${ASK}`

  const others = handoffs.filter(h => isActive(h) && !sameAgent(h.to, agent))
  if (others.length && unquoted.some(wipesTree)) {
    const h = others[0]
    return `this command resets or deletes files across the whole repo, including files locked by handoff "${h.title}" (owner: ${h.to}). Read ${h.file}. Name the files you mean instead. ${ASK}`
  }

  // The handlock CLI: only a handoff's own from/to agent may change its status; --force is human-only.
  for (const w of segments(cmd)) {
    const at = w.findIndex(x => /(^|\/)handlock(\.js)?$/.test(x))
    if (at < 0) continue
    const sub = w[at + 1]
    if (!/^(release|done|claim)$/.test(sub ?? '')) continue
    if (w.includes('--force')) return `\`handlock ${sub} --force\` is for humans only. ${ASK}`
    const q = (w[at + 2] ?? '').replace(/^['"]|['"]$/g, '').toLowerCase()
    const hits = handoffs.filter(h => q && (path.basename(h.file).toLowerCase().includes(q) || h.title.toLowerCase().includes(q)))
    const foreign = hits.find(h => !isParty(h, agent))
    if (foreign) return `only ${foreign.from || 'its author'} or ${foreign.to} may run \`handlock ${sub}\` on "${foreign.title}". ${ASK}`
  }

  if (isReadOnlyShell(cmd, { ignoreRedirects: true })) return null

  const bases = cdTargets(cmd, cwd)
  const heads = segments(cmd)
  const destructive = heads.some(w => DESTRUCTIVE.test(w[0]) || (w[0] === 'git' && GIT_DESTRUCTIVE.test(w[1] ?? '')) || (w[0] === 'find' && w.includes('-delete')))
  const onlyGitSafe = heads.every(w => (w[0] === 'git' && GIT_SAFE.test(w[1] ?? '')) || /(^|\/)handlock(\.js)?$/.test(w[0]) || w[0] === 'node' && /handlock(\.js)?$/.test(w[1] ?? ''))
  const active = handoffs.filter(isActive)

  for (const tok of shellTokens(cmd)) {
    for (const base of bases) {
      const rel = toRepoPath(root, tok, base)
      if (rel === null || rel === '') continue

      if (!onlyGitSafe && INFRA.some(p => matches(p, rel))) return `${rel} is handlock's own config; only a human may change it. ${ASK}`

      if (notesDir && matches(notesDir, rel) && !onlyGitSafe) {
        const note = noteAt(handoffs, root, rel)
        if (note && !isParty(note, agent)) return `${rel} is the handoff note for "${note.title}"; only ${note.from || 'its author'} or ${note.to} may change it. ${ASK}`
        if (!note && rel === notesDir && destructive) return `this command would remove the handoffs folder. ${ASK}`
      }

      for (const h of active) {
        if (sameAgent(h.to, agent)) continue
        for (const pat of h.owns) {
          const p = normalize(pat)
          const literal = !/[*?]/.test(p)
          const hit =
            matches(p, rel) ||
            (literal && !tok.includes('/') && path.basename(p) === tok) ||
            (destructive && (p.startsWith(`${rel}/`) || rel === '.'))
          if (hit) {
            return `this shell command touches ${literal ? p : rel}, which is locked by handoff "${h.title}" (owner: ${h.to}). Read ${h.file}. Read-only commands (cat, grep, git diff...) are fine. ${ASK}`
          }
        }
      }
    }
  }
  return null
}

export function decide(payload, agent, { root, handoffs, notesDir = null }) {
  if (isReadOnlyTool(payload)) return { allowed: true }
  const cwd = payload?.cwd ?? process.cwd()

  for (const raw of pathsFromToolCall(payload)) {
    const rel = toRepoPath(root, raw, cwd)
    if (rel === null) continue
    if (INFRA.some(p => matches(p, rel))) {
      return { allowed: false, reason: `${rel} is handlock's own config; only a human may change it. ${ASK}` }
    }
    if (notesDir && matches(notesDir, rel)) {
      const note = noteAt(handoffs, root, rel)
      if (note && !isParty(note, agent)) {
        return { allowed: false, reason: `${rel} is the handoff note for "${note.title}"; only ${note.from || 'its author'} or ${note.to} may change it. ${ASK}`, handoff: note }
      }
      continue // a party editing its note, or a new note: allowed
    }
    const verdict = canEdit(handoffs, agent, rel, { exempt: notesDir ? [notesDir] : [] })
    if (!verdict.allowed) return { ...verdict, reason: `${verdict.reason} ${ASK}` }
  }

  const cmd = shellCommand(payload)
  if (cmd && agent && agent !== 'human') {
    const reason = blockedShell(cmd, agent, { root, handoffs, cwd, notesDir })
    if (reason) return { allowed: false, reason }
  }
  return { allowed: true }
}

export async function runHook(agent, stdin = process.stdin) {
  let text = ''
  for await (const chunk of stdin) text += chunk
  let payload
  try {
    payload = JSON.parse(text || '{}')
  } catch {
    return 0 // not a payload we understand: never break the agent
  }
  if (process.env.HANDLOCK_LOG) {
    try {
      fs.appendFileSync(process.env.HANDLOCK_LOG, `${agent} ${text.replace(/\n/g, ' ')}\n`)
    } catch {}
  }
  let verdict
  try {
    const root = repoRoot(payload.cwd ?? process.cwd())
    const cfg = loadConfig(root)
    verdict = decide(payload, agent, { root, handoffs: loadHandoffs(cfg.dir), notesDir: toRepoPath(root, cfg.dir, root) })
  } catch (e) {
    process.stderr.write(`handlock: ${e.message}\n`)
    return 0 // fail open on our own errors; pre-commit still checks
  }
  if (verdict.allowed) return 0
  const reason = `BLOCKED by handlock: ${verdict.reason}`
  process.stderr.write(`${reason}\n`)
  process.stdout.write(
    `${JSON.stringify({
      decision: 'block',
      reason,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })}\n`,
  )
  return 2
}
