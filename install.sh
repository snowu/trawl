#!/usr/bin/env bash
# Installs trawl:
#   1. builds the binary -> ~/.local/bin/trawl
#   2. asks which folders `trawl --all` / `trawl --choose` scan -> ~/.config/trawl/config.json
#   3. shell keybinds (zsh/bash): ctrl+alt+d scans everything, ctrl+alt+f picks folders first
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

# choose_dirs: prints the chosen folders, one per line (empty when none were picked).
choose_dirs() {
  if command -v fzf >/dev/null 2>&1; then
    # Depth-bounded: an unbounded walk of $HOME takes seconds on a big disk.
    find "$HOME" -maxdepth 3 -type d -not -path '*/.*' -not -name node_modules 2>/dev/null \
      | sed "s|^$HOME|~|" \
      | fzf --multi --bind 'tab:toggle+down' --prompt 'folders> ' \
          --header 'Folders trawl scans (tab: select several, enter: confirm)' </dev/tty || true
  else
    dim "fzf not found: type one folder per line, empty line to finish." >&2
    local reply
    while read -r -p '> ' reply && [[ -n "$reply" ]]; do printf '%s\n' "$reply"; done
  fi
}

# json_roots <dir...>: the config file's JSON, paths kept ~-relative so it reads well and travels.
json_roots() {
  local out="" d
  for d in "$@"; do
    [[ "$d" == "$HOME"/* || "$d" == "$HOME" ]] && d="~${d#"$HOME"}"
    d="${d//\\/\\\\}"; d="${d//\"/\\\"}"
    out="${out:+$out, }\"$d\""
  done
  printf '{\n  "roots": [%s]\n}\n' "$out"
}

configure_roots=1
if [[ -f "$CONF" ]]; then
  dim "Current $CONF:"
  dim "$(cat "$CONF")"
  ask_yn "Change the folders?" n
  [[ "$REPLY_YN" == y ]] || configure_roots=0
fi

if [[ "$configure_roots" -eq 1 ]]; then
  roots=()
  if [[ "$ASSUME_YES" -eq 0 ]]; then
    dim "\`trawl --all\` scans these folders; \`trawl --choose\` lets you pick folders inside them."
    while IFS= read -r d; do [[ -n "$d" ]] && roots+=("${d/#\~/$HOME}"); done < <(choose_dirs)
  fi
  if [[ ${#roots[@]} -eq 0 ]]; then
    roots=("$HOME/code")
    [[ -d "$HOME/code" ]] || roots=("$HOME")
    note "No folders picked; using ${roots[0]}."
  fi
  mkdir -p "$CONF_DIR"
  json_roots "${roots[@]}" > "$CONF"
  ok "Wrote $CONF"
  dim "$(cat "$CONF")"
fi

# ── 3. Keybinds ──────────────────────────────────────────────────────────
section "Keybinds"

# ask_key <what> <default>: sets KEY to a letter for ctrl+alt+<letter>.
ask_key() {
  while true; do
    ask_value "ctrl+alt+? to $1" "$2"
    case "$REPLY_VALUE" in
      # ctrl+h/i/j/m are backspace, tab, newline and enter: binding them breaks typing.
      [hijm]) note "ctrl+alt+$REPLY_VALUE collides with backspace/tab/enter, pick another letter." ;;
      [a-z])  KEY="$REPLY_VALUE"; return ;;
      *)      note "One lowercase letter, please." ;;
    esac
  done
}

if [[ "$KEYBIND" -eq 1 ]]; then
  dim "Two shell keybinds that open trawl from any prompt, in any terminal, inside tmux/herdr too."
  ask_yn "Install them?" y
  [[ "$REPLY_YN" == y ]] || KEYBIND=0
fi

if [[ "$KEYBIND" -eq 1 ]]; then
  ask_key "scan all configured folders" d; ALL_KEY="$KEY"
  ask_key "choose folders, then scan" f; CHOOSE_KEY="$KEY"
  if [[ "$ALL_KEY" == "$CHOOSE_KEY" ]]; then
    note "Both keybinds were ctrl+alt+$ALL_KEY; using defaults d and f instead."
    ALL_KEY=d CHOOSE_KEY=f
  fi
  ALL_UP="$(tr '[:lower:]' '[:upper:]' <<<"$ALL_KEY")"
  CHOOSE_UP="$(tr '[:lower:]' '[:upper:]' <<<"$CHOOSE_KEY")"
  mkdir -p "$CONF_DIR"

  # ctrl+alt+<letter> reaches the shell as ESC followed by ctrl+<letter>.
  cat > "$CONF_DIR/keybinds.zsh" <<ZSH
# Generated by trawl install.sh; re-run it to change the keys.
_trawl_all() { trawl --all </dev/tty; zle reset-prompt; }
_trawl_choose() { trawl --choose </dev/tty; zle reset-prompt; }
zle -N _trawl_all
zle -N _trawl_choose
for _trawl_km in emacs viins vicmd; do
  bindkey -M \$_trawl_km '^[^$ALL_UP' _trawl_all        # ctrl+alt+$ALL_KEY
  bindkey -M \$_trawl_km '^[^$CHOOSE_UP' _trawl_choose  # ctrl+alt+$CHOOSE_KEY
done
unset _trawl_km
ZSH

  cat > "$CONF_DIR/keybinds.bash" <<BASH
# Generated by trawl install.sh; re-run it to change the keys.
[[ \$- == *i* ]] || return 0
bind -x '"\\e\\C-$ALL_KEY": trawl --all </dev/tty'        # ctrl+alt+$ALL_KEY
bind -x '"\\e\\C-$CHOOSE_KEY": trawl --choose </dev/tty'  # ctrl+alt+$CHOOSE_KEY
BASH

  rcs=()
  [[ -f "$HOME/.zshrc" || "${SHELL:-}" == */zsh ]] && rcs+=(zsh)
  [[ -f "$HOME/.bashrc" || "${SHELL:-}" == */bash ]] && rcs+=(bash)
  for sh in ${rcs[@]+"${rcs[@]}"}; do
    replace_fence "$HOME/.${sh}rc" "[ -f \"$CONF_DIR/keybinds.$sh\" ] && . \"$CONF_DIR/keybinds.$sh\""
    ok "~/.${sh}rc sources $CONF_DIR/keybinds.$sh"
  done
  ok "ctrl+alt+$ALL_KEY: scan all folders · ctrl+alt+$CHOOSE_KEY: choose folders"
  [[ "$(uname)" == Darwin ]] && dim "macOS: set your terminal's Option key to act as Alt/Meta (e.g. iTerm2 'Esc+') for these to fire."
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
dim "Restart your shell (or source your rc file), then press the keybind or run: trawl --all"
