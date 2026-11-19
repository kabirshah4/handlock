// Pull the file paths a tool call would write, from any agent's hook payload.

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm
const PATCH_MOVE = /^\*\*\* Move to:\s*(.+?)\s*$/gm
const KEY_FIELDS = ['file_path', 'notebook_path', 'path', 'filePath', 'target_file', 'filename']

function fromPatch(text) {
  const out = []
  for (const re of [PATCH_FILE, PATCH_MOVE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) out.push(m[1])
  }
  return out
}

function unquote(t) {
  return t.replace(/^(['"])(.*)\1$/, '$2')
}

// Best effort: redirections, tee, and common file-mutating commands.
export function fromShell(cmd) {
  const out = []
  const text = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^\1$/gm, '')
  const redirect = /(?:^|[^<>&\d])>>?\s*([^\s;&|<>]+)/g
  let m
  while ((m = redirect.exec(text))) out.push(unquote(m[1]))
  const tokens = text.split(/[;&|\n]+/)
  for (const seg of tokens) {
    const words = seg.trim().split(/\s+/).map(unquote)
    const head = words[0]
    if (!head) continue
    const args = words.slice(1).filter(w => w && !w.startsWith('-'))
    if (head === 'tee' || head === 'touch' || head === 'rm' || head === 'truncate') out.push(...args)
    else if ((head === 'mv' || head === 'cp') && args.length >= 2) out.push(...args)
    else if (head === 'sed' && words.some(w => /^-i/.test(w))) out.push(...args.slice(1))
    else if (head === 'apply_patch' || head === 'git' && words[1] === 'apply') {
      // patch body handled below
    }
  }
  out.push(...fromPatch(cmd))
  return out.filter(p => p && p !== '/dev/null' && !p.startsWith('&'))
}

/** @returns {string[]} candidate paths (as written by the agent; may be absolute) */
export function pathsFromToolCall(payload) {
  const input = payload?.tool_input ?? payload?.toolInput ?? payload?.input ?? {}
  const tool = String(payload?.tool_name ?? payload?.toolName ?? payload?.tool ?? '')
  const out = []
  if (typeof input === 'string') {
    out.push(...fromPatch(input))
    if (/bash|shell|exec|command/i.test(tool)) out.push(...fromShell(input))
    return [...new Set(out)]
  }
  for (const k of KEY_FIELDS) if (typeof input[k] === 'string') out.push(input[k])
  if (Array.isArray(input.edits)) for (const e of input.edits) if (e?.file_path) out.push(e.file_path)
  if (typeof input.patch === 'string') out.push(...fromPatch(input.patch))
  if (typeof input.input === 'string') out.push(...fromPatch(input.input))
  const cmd = Array.isArray(input.command) ? input.command.join(' ') : input.command ?? input.cmd
  if (typeof cmd === 'string') out.push(...fromShell(cmd))
  return [...new Set(out)]
}

const RO_SHELL = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'ag', 'ls', 'wc', 'nl', 'file', 'stat', 'diff', 'echo', 'printf', 'pwd', 'cd', 'which', 'tree', 'find', 'fd', 'bat', 'jq', 'true'])
const RO_GIT = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch'])

/** The shell command in a tool call, or null when it isn't a shell call. */
export function shellCommand(payload) {
  const tool = String(payload?.tool_name ?? payload?.toolName ?? '')
  const input = payload?.tool_input ?? payload?.toolInput ?? {}
  if (typeof input === 'string') return /bash|shell|exec|command/i.test(tool) ? input : null
  const cmd = Array.isArray(input.command) ? input.command.join(' ') : input.command ?? input.cmd
  return typeof cmd === 'string' ? cmd : null
}

/**
 * True only when every part of the command is a known read-only command. Output
 * redirects count as writes unless `ignoreRedirects` (the caller checked their targets).
 */
export function isReadOnlyShell(cmd, { ignoreRedirects = false } = {}) {
  const body = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^\1$/gm, '')
  if (!ignoreRedirects && /(?:^|[^<>&\d])>>?\s*[^\s&]/.test(body.replace(/\d?>\s*\/dev\/null/g, ''))) return false
  return body
    .split(/&&|\|\||[;|\n]/)
    .map(s => s.trim().split(/\s+/))
    .filter(w => w[0])
    .every(w => {
      if (w[0] === 'sed') return !w.some(x => /^-i/.test(x)) && !w.some(x => /\bw\s/.test(x))
      if (w[0] === 'git') return RO_GIT.has(w[1] ?? '')
      if (w[0] === 'find') return !w.some(x => x === '-delete' || x === '-exec' || x === '-execdir')
      return RO_SHELL.has(w[0])
    })
}

const READ_ONLY = /^(read|view|glob|grep|ls|list|search|webfetch|websearch|todo\w*|task\w*|notebookread)$/i

export function isReadOnlyTool(payload) {
  return READ_ONLY.test(String(payload?.tool_name ?? payload?.toolName ?? ''))
}
