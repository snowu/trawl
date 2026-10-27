#!/usr/bin/env bash
# Removes everything install.sh put on this machine:
#   - the binary (~/.local/bin/trawl)
#   - config and generated keybind files (~/.config/trawl) and the render cache (~/.cache/trawl)
#   - the `# >>> trawl >>>` block in ~/.zshrc / ~/.bashrc
#   - the Claude Code skill (~/.claude/skills/trawl)
# Lists what it found and asks before deleting anything. Safe to re-run.
#
# Flags: --yes (don't ask)
set -eu

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    *) echo "unknown flag: $arg (expected --yes)" >&2; exit 2 ;;
  esac
done

BIN="${TRAWL_BIN_DIR:-$HOME/.local/bin}/trawl"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/trawl"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/trawl"
SKILL_DIR="$HOME/.claude/skills/trawl"
FENCE_OPEN='# >>> trawl >>>'
FENCE_CLOSE='# <<< trawl <<<'

if [[ -t 1 ]]; then
  RESET=$'\033[0m' BOLD=$'\033[1m' GREEN=$'\033[38;5;114m' YELLOW=$'\033[38;5;179m' CYAN=$'\033[38;5;80m' DIM=$'\033[38;5;244m'
else
  RESET="" BOLD="" GREEN="" YELLOW="" CYAN="" DIM=""
fi

paths=() rcs=()
for p in "$BIN" "$CONF_DIR" "$CACHE_DIR" "$SKILL_DIR"; do
  [[ -e "$p" ]] && paths+=("$p")
done
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [[ -f "$rc" ]] && grep -qxF "$FENCE_OPEN" "$rc" && rcs+=("$rc")
done

printf '%strawl uninstall%s\n' "$BOLD" "$RESET"
if [[ ${#paths[@]} -eq 0 && ${#rcs[@]} -eq 0 ]]; then
  printf '%sNothing to remove: trawl is not installed.%s\n' "$DIM" "$RESET"
  exit 0
fi

printf '%sWill remove:%s\n' "$DIM" "$RESET"
for p in ${paths[@]+"${paths[@]}"}; do printf '  %s\n' "$p"; done
for rc in ${rcs[@]+"${rcs[@]}"}; do printf '  the trawl block in %s\n' "$rc"; done

if [[ "$ASSUME_YES" -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    printf '%sNot a terminal: re-run with --yes to remove without asking.%s\n' "$YELLOW" "$RESET" >&2
    exit 1
  fi
  printf '%sProceed? [y/N] %s' "$CYAN" "$RESET"
  read -r reply || reply=""
  [[ "$reply" == [yY] ]] || { printf 'Aborted, nothing removed.\n'; exit 0; }
fi

for p in ${paths[@]+"${paths[@]}"}; do rm -rf -- "$p"; done
for rc in ${rcs[@]+"${rcs[@]}"}; do
  tmp="$(mktemp)"
  awk -v fo="$FENCE_OPEN" -v fc="$FENCE_CLOSE" '$0 == fo { skip = 1; next } $0 == fc { skip = 0; next } !skip' "$rc" > "$tmp"
  # cat (not mv) keeps the rc's permissions and any symlink (dotfile managers) intact.
  cat "$tmp" > "$rc" && rm -f "$tmp"
done

printf '%sDone. Open a new shell to drop the keybinds from this session.%s\n' "$GREEN" "$RESET"
