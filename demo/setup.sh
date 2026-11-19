#!/bin/sh
# Builds the throwaway repo the demo runs in. Usage: demo/setup.sh <dir>
set -e
HL="$(cd "$(dirname "$0")/.." && pwd)/bin/handlock.js"
rm -rf "$1" && mkdir -p "$1/src" && cd "$1"
git init -q -b main
printf 'export function parse(s) {\n  return s.split(",")\n}\n' > src/parser.js
node "$HL" init --agents claude,codex,copilot,opencode >/dev/null
node -e "const f='.claude/settings.json',j=require('./'+f);j.permissions={defaultMode:'acceptEdits'};require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
mkdir -p bin && printf '#!/bin/sh\nexec node "%s" "$@"\n' "$HL" > bin/handlock && chmod +x bin/handlock
git add -A && git commit -qm init
