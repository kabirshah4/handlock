// The lock resolver: who may edit which path, derived from open handoffs.

import fs from 'node:fs'
import path from 'node:path'

import { matches, normalize, overlaps } from './glob.js'
import { isActive, parseHandoff } from './handoff.js'

export function sameAgent(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function loadHandoffs(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const file = path.join(dir, name)
    try {
      const h = parseHandoff(fs.readFileSync(file, 'utf8'), file)
      if (h.type === 'handoff') out.push(h)
    } catch {
      // unreadable note: skip it rather than block everyone
    }
  }
  return out
}

/**
 * Decide whether `agent` may edit `relPath` (relative to the repo root).
 * Unknown agents (humans) are warned, never blocked. `exempt` paths (the handoffs
 * folder, handlock's own config) stay writable under "everything else".
 * @returns {{ allowed: boolean, warn?: boolean, reason?: string, handoff?: object }}
 */
export function canEdit(handoffs, agent, relPath, { exempt = [] } = {}) {
  const p = normalize(relPath)
  const active = handoffs.filter(isActive)
  const isHuman = !agent || agent === 'human'

  for (const h of active) {
    const owned = h.owns.some(pat => matches(pat, p))
    if (owned && (isHuman || !sameAgent(h.to, agent))) {
      const reason = `${p} is locked by handoff "${h.title}" (owner: ${h.to}). Read ${h.file}.`
      if (isHuman) return { allowed: true, warn: true, reason, handoff: h }
      return { allowed: false, reason, handoff: h }
    }
  }

  if (!isHuman) {
    for (const h of active) {
      if (!sameAgent(h.to, agent)) continue
      if (h.deny.some(pat => matches(pat, p))) {
        return { allowed: false, reason: `Handoff "${h.title}" says don't touch ${p}. Read ${h.file}.`, handoff: h }
      }
      if (h.denyAllElse && !h.owns.some(pat => matches(pat, p)) && !exempt.some(pat => matches(pat, p))) {
        return {
          allowed: false,
          reason: `Handoff "${h.title}" limits ${h.to} to its own files; ${p} is not one of them. Read ${h.file}.`,
          handoff: h,
        }
      }
    }
  }
  return { allowed: true }
}

/** Pairs of active handoffs (different owners) that claim overlapping paths. */
export function findConflicts(handoffs) {
  const active = handoffs.filter(isActive)
  const out = []
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      if (sameAgent(a.to, b.to)) continue
      for (const pa of a.owns) {
        for (const pb of b.owns) {
          if (overlaps(pa, pb)) out.push({ a, b, pathA: pa, pathB: pb })
        }
      }
    }
  }
  return out
}

/** Paths owned by agents other than `agent`, for config-driven adapters. */
export function ownedByOthers(handoffs, agent) {
  const out = []
  for (const h of handoffs.filter(isActive)) {
    if (sameAgent(h.to, agent)) continue
    for (const pat of h.owns) out.push({ pattern: normalize(pat), owner: h.to, handoff: h })
  }
  return out
}
