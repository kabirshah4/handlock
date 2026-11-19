# Record with: vhs demo/demo.tape   (needs claude on PATH)
Output demo/demo.gif
Set Shell "zsh"
Set FontSize 17
Set Width 1400
Set Height 720
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Hide
Type "demo/setup.sh /tmp/handlock-demo && cd /tmp/handlock-demo && export PATH=$PWD/bin:$PATH && setopt interactivecomments && clear" Enter
Sleep 2s
Show

Type "# Codex is rewriting the parser. Lock it to Codex:" Enter
Type 'handlock new --to codex --from claude --title "Rewrite parser" --own src/parser.js' Enter
Sleep 1.5s
Type "# Now Claude Code tries to edit the same file:" Enter
Type `claude -p "Add a comment '// v2' at the top of src/parser.js. If you can't, say why."` Enter
Sleep 45s
Sleep 4s
Type "git diff --stat src/   # parser untouched" Enter
Sleep 3s
