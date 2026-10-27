#!/usr/bin/env bash
# Installs trawl:
#   1. builds the binary -> ~/.local/bin/trawl
#   2. asks which folders trawl scans (`trawl roots pick`) -> ~/.config/trawl/config.json
#   3. a shell keybind (zsh/bash), alt+m by default, that opens the picker
#   4. the Claude Code skill -> ~/.claude/skills/trawl
# Re-runnable: each step replaces what a previous run installed.
#
# Flags: --yes (no prompts, take defaults), --no-keybind, --no-skill
set -eu

ASSUME_YES=0 KEYBIND=1 SKILL=1
for arg in "$@"; do
  case "$arg" in
    --yes)        ASSUME_YES=1 ;;
    --no-keybind) KEYBIND=0 ;;
    --no-skill)   SKILL=0 ;;
    *) echo "unknown flag: $arg (expected --yes, --no-keybind, --no-skill)" >&2; exit 2 ;;
  esac
done
[[ -t 0 ]] || ASSUME_YES=1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DEST="${TRAWL_BIN_DIR:-$HOME/.local/bin}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/trawl"
CONF="$CONF_DIR/config.json"
FENCE_OPEN='# >>> trawl >>>'
FENCE_CLOSE='# <<< trawl <<<'

if [[ -t 1 ]]; then
  RESET=$'\033[0m' BOLD=$'\033[1m' GREEN=$'\033[38;5;114m' YELLOW=$'\033[38;5;179m' CYAN=$'\033[38;5;80m' DIM=$'\033[38;5;244m'
else
  RESET="" BOLD="" GREEN="" YELLOW="" CYAN="" DIM=""
fi
section() { printf '\n%s== %s ==%s\n' "$BOLD$CYAN" "$1" "$RESET"; }
note() { printf '%s%s%s\n' "$YELLOW" "$1" "$RESET"; }
dim() { printf '%s%s%s\n' "$DIM" "$1" "$RESET"; }
ok() { printf '%s%s%s\n' "$GREEN" "$1" "$RESET"; }

# ask_yn <question> <default y|n>: sets REPLY_YN to y or n. Takes the default under --yes.
ask_yn() {
  local hint="[y/N]" reply
  [[ "$2" == y ]] && hint="[Y/n]"
  if [[ "$ASSUME_YES" -eq 1 ]]; then REPLY_YN="$2"; return; fi
  while true; do
    printf '%s%s %s %s' "$CYAN" "$1" "$hint" "$RESET"
    read -r reply || reply=""
    case "$reply" in
      y|Y) REPLY_YN=y; return ;;
      n|N) REPLY_YN=n; return ;;
      "")  REPLY_YN="$2"; return ;;
      *)   note "Please answer y or n." ;;
    esac
  done
}

# ask_value <question> <default>: sets REPLY_VALUE. Takes the default under --yes.
ask_value() {
  REPLY_VALUE="$2"
  [[ "$ASSUME_YES" -eq 1 ]] && return
  printf '%s%s [%s]: %s' "$CYAN" "$1" "$2" "$RESET"
  read -r REPLY_VALUE || REPLY_VALUE=""
  [[ -n "$REPLY_VALUE" ]] || REPLY_VALUE="$2"
}

# replace_fence <file> <line...>: swaps the file's trawl block for these lines (appends one if absent).
replace_fence() {
  local file="$1" tmp; shift
  touch "$file"
  tmp="$(mktemp)"
  awk -v fo="$FENCE_OPEN" -v fc="$FENCE_CLOSE" '$0 == fo { skip = 1; next } $0 == fc { skip = 0; next } !skip' "$file" > "$tmp"
  { [[ -s "$tmp" && "$(tail -c1 "$tmp")" != "" ]] && echo; printf '%s\n' "$FENCE_OPEN" "$@" "$FENCE_CLOSE"; } >> "$tmp"
  cat "$tmp" > "$file" && rm -f "$tmp"
}

printf '%strawl install%s\n' "$BOLD" "$RESET"

# ── 1. Binary ────────────────────────────────────────────────────────────
section "Building trawl"
if ! command -v bun >/dev/null 2>&1; then
  note "error: bun not found. Install it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
# Built into bin/ first so a failed build can't leave a half-written binary on $PATH; `install`
# unlinks the old file, so this works even while an trawl is running.
(cd "$DIR" && bun install --frozen-lockfile >/dev/null && bun run --silent build >/dev/null)
mkdir -p "$BIN_DEST"
install -m755 "$DIR/bin/trawl" "$BIN_DEST/trawl"
ok "trawl $("$BIN_DEST/trawl" --version) -> $BIN_DEST/trawl"
case ":$PATH:" in
  *":$BIN_DEST:"*) ;;
  *) note "$BIN_DEST is not on your \$PATH; add: export PATH=\"$BIN_DEST:\$PATH\"" ;;
esac

# ── 2. Folders ───────────────────────────────────────────────────────────
section "Folders to scan"
TRAWL="$BIN_DEST/trawl"

pick_roots=1
if [[ -n "$("$TRAWL" roots 2>/dev/null)" ]]; then
  dim "Configured:"
  "$TRAWL" roots | sed 's/^/  /'
  ask_yn "Change them?" n
  [[ "$REPLY_YN" == y ]] || pick_roots=0
fi

if [[ "$pick_roots" -eq 1 && "$ASSUME_YES" -eq 0 ]]; then
  dim "\`trawl\` scans these folders. Change them any time with \`trawl roots pick\` or \`trawl roots add DIR\`."
  if command -v fzf >/dev/null 2>&1; then
    # Run from the clone so its folders (e.g. examples/) are listed first, even when the clone is outside ~.
    (cd "$DIR" && "$TRAWL" roots pick >/dev/null) || true
  else
    ask_value "Folder to scan (fzf not found; add more later with \`trawl roots add DIR\`)" "$HOME/code"
    "$TRAWL" roots add "${REPLY_VALUE/#\~/$HOME}" >/dev/null || true
  fi
fi

if [[ -z "$("$TRAWL" roots 2>/dev/null)" ]]; then
  default_root="$HOME/code"
  [[ -d "$default_root" ]] || default_root="$HOME"
  "$TRAWL" roots add "$default_root" >/dev/null 2>&1
  note "No folders picked; using $default_root (change with: trawl roots pick)."
fi
ok "Scanning:"
"$TRAWL" roots | sed 's/^/  /'

# ── 3. Keybind ───────────────────────────────────────────────────────────
section "Keybind"

if [[ "$KEYBIND" -eq 1 ]]; then
  dim "A shell keybind that opens trawl from any prompt, in any terminal, inside tmux/herdr too."
  ask_yn "Install it?" y
  [[ "$REPLY_YN" == y ]] || KEYBIND=0
fi

if [[ "$KEYBIND" -eq 1 ]]; then
  while true; do
    ask_value "alt+? opens trawl" m
    case "$REPLY_VALUE" in
      # Readline/zle word editing (alt+b/d/f) and fzf's cd widget (alt+c) live on these.
      [bcdf]) note "alt+$REPLY_VALUE is taken by shell word editing or fzf, pick another letter." ;;
      [a-z])  KEY="$REPLY_VALUE"; break ;;
      *)      note "One lowercase letter, please." ;;
    esac
  done
  mkdir -p "$CONF_DIR"

  # alt+<letter> reaches the shell as ESC followed by the letter.
  cat > "$CONF_DIR/keybinds.zsh" <<ZSH
# Generated by trawl install.sh; re-run it to change the key.
_trawl() { trawl </dev/tty; zle reset-prompt; }
zle -N _trawl
for _trawl_km in emacs viins vicmd; do
  bindkey -M \$_trawl_km '^[$KEY' _trawl   # alt+$KEY
done
unset _trawl_km
ZSH

  cat > "$CONF_DIR/keybinds.bash" <<BASH
# Generated by trawl install.sh; re-run it to change the key.
[[ \$- == *i* ]] || return 0
bind -x '"\\e$KEY": trawl </dev/tty'   # alt+$KEY
BASH

  rcs=()
  [[ -f "$HOME/.zshrc" || "${SHELL:-}" == */zsh ]] && rcs+=(zsh)
  [[ -f "$HOME/.bashrc" || "${SHELL:-}" == */bash ]] && rcs+=(bash)
  for sh in ${rcs[@]+"${rcs[@]}"}; do
    replace_fence "$HOME/.${sh}rc" "[ -f \"$CONF_DIR/keybinds.$sh\" ] && . \"$CONF_DIR/keybinds.$sh\""
    ok "~/.${sh}rc sources $CONF_DIR/keybinds.$sh"
  done
  ok "alt+$KEY opens trawl (ctrl+f inside it narrows to chosen folders)"
  [[ "$(uname)" == Darwin ]] && dim "macOS: set your terminal's Option key to act as Alt/Meta (e.g. iTerm2 'Esc+') for it to fire."
fi

# ── 4. Claude Code skill ─────────────────────────────────────────────────
section "Claude Code skill"
if [[ "$SKILL" -eq 1 && -d "$HOME/.claude" ]]; then
  dim "Teaches Claude Code to run \`trawl check\` on diagrams it writes and \`trawl open\` to show them to you."
  ask_yn "Install it to ~/.claude/skills/trawl?" y
  if [[ "$REPLY_YN" == y ]]; then
    mkdir -p "$HOME/.claude/skills/trawl"
    cp "$DIR/skill/SKILL.md" "$HOME/.claude/skills/trawl/SKILL.md"
    ok "Installed ~/.claude/skills/trawl/SKILL.md"
  fi
elif [[ "$SKILL" -eq 1 ]]; then
  dim "No ~/.claude found; skipping. Re-run after installing Claude Code to add the skill."
fi

section "Done"
dim "Restart your shell (or source your rc file), then press alt+${KEY:-m} or run: trawl"
