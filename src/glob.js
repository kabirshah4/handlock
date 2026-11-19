// Minimal glob matching: `**` (any depth), `*` (within a segment), `?`.
// A pattern ending in `/` or naming a directory also covers everything under it.

const cache = new Map()

function toRegExp(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`)
}

export function normalize(p) {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}

export function matches(pattern, path) {
  const pat = normalize(pattern)
  if (pat === '' ) return false
  let re = cache.get(pat)
  if (!re) {
    re = toRegExp(pat)
    cache.set(pat, re)
  }
  return re.test(normalize(path))
}

// Whether two patterns could both match some path (conservative: used for conflicts).
export function overlaps(a, b) {
  const pa = normalize(a)
  const pb = normalize(b)
  if (matches(pa, pb) || matches(pb, pa)) return true
  const fixed = p => p.split(/[*?]/)[0]
  const fa = fixed(pa)
  const fb = fixed(pb)
  const hasGlob = p => /[*?]/.test(p)
  if (hasGlob(pa) && hasGlob(pb)) return fa.startsWith(fb) || fb.startsWith(fa)
  return false
}
