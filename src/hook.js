// The one hook every agent calls: `handlock hook <agent>` with the tool call on stdin.
// Output works for Claude Code, Codex and Copilot alike (verified in docs/support-table.md):
// the reason on stderr, a deny decision on stdout, exit code 2.

import { exemptPaths, loadConfig, repoRoot, toRepoPath } from './config.js'
import { canEdit, loadHandoffs } from './locks.js'
import { isActive } from './handoff.js'
import { sameAgent } from './locks.js'
import { isReadOnlyShell, isReadOnlyTool, pathsFromToolCall, shellCommand } from './paths.js'

export function decide(payload, agent, { root, handoffs, exempt = [] }) {
  if (isReadOnlyTool(payload)) return { allowed: true }
  const cwd = payload?.cwd ?? process.cwd()
  for (const raw of pathsFromToolCall(payload)) {
    const rel = toRepoPath(root, raw, cwd)
    if (rel === null) continue
    const verdict = canEdit(handoffs, agent, rel, { exempt })
    if (!verdict.allowed) return verdict
  }
  // Shell can write files in ways no parser sees (python -c, node -e, scripts), so a
  // shell command that mentions another agent's file is blocked unless it is read-only.
  const cmd = shellCommand(payload)
  // Redirect targets were path-checked above, so they don't make a read-only command a write.
  if (cmd && !isReadOnlyShell(cmd, { ignoreRedirects: true }) && agent && agent !== 'human') {
    for (const h of handoffs.filter(isActive)) {
      if (sameAgent(h.to, agent)) continue
      for (const pat of h.owns) {
        const fixed = pat.replace(/^\.\//, '').split(/[*?]/)[0].replace(/\/$/, '')
        if (fixed.length >= 3 && cmd.includes(fixed)) {
          return {
            allowed: false,
            reason: `this shell command mentions ${fixed}, which is locked by handoff "${h.title}" (owner: ${h.to}). Read ${h.file}. Read-only commands (cat, grep, git diff...) are allowed.`,
            handoff: h,
          }
        }
      }
    }
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
  let verdict
  try {
    const root = repoRoot(payload.cwd ?? process.cwd())
    const cfg = loadConfig(root)
    verdict = decide(payload, agent, { root, handoffs: loadHandoffs(cfg.dir), exempt: exemptPaths(cfg) })
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
