# trawl

Find every Mermaid diagram in a set of folders, preview it in the terminal, and open it as a crisp PNG in
[feh](https://feh.finalrewind.org/) (or as an SVG in your browser).

- Scans `.md` files for ` ```mermaid ` / `~~~mermaid` blocks and whole `.mmd` files, labelling each diagram with the
  nearest markdown heading.
- Renders without a browser or Chromium: [pele](https://github.com/obsidianmd/pele) draws the SVG,
  [resvg](https://github.com/linebender/resvg) rasterizes it with a bundled Inter font, so PNGs look the same on every
  machine.
- Previews diagrams as box-drawing art in the terminal ([beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid);
  flowchart, sequence, state, class, ER and XY charts; other types show their source).
- `trawl check` doubles as a Mermaid linter for CI.

## Install

Needs [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`); fzf and feh are optional but recommended.

```sh
git clone https://github.com/snowu/trawl && cd trawl && ./install.sh
```

The installer, re-runnable at any time:

1. builds the binary into `~/.local/bin/trawl`,
2. asks (with fzf) which folders to scan, saved to `~/.config/trawl/config.json`,
3. adds two shell keybinds to `~/.zshrc` / `~/.bashrc` (letters configurable):
   - **ctrl+alt+d**: picker over every diagram in your folders,
   - **ctrl+alt+f**: choose folders with fzf first, then the picker,
4. installs a [Claude Code](https://claude.com/claude-code) skill (`~/.claude/skills/trawl`) so agents run
   `trawl check` on diagrams they write and `trawl open` to show them to you.

`./install.sh --yes` takes every default without asking; `--no-keybind` and `--no-skill` skip those steps.
The keybinds work in any terminal and inside tmux/herdr, wherever you are at a zsh or bash prompt (on macOS, set the
terminal's Option key to send Esc/Meta).

Prebuilt binaries for linux/macOS x64/arm64 are also attached to [Releases](../../releases) if you only want the CLI.

### Uninstall

```sh
./uninstall.sh          # lists what it found, asks, then removes it; --yes to skip the question
```

It removes the binary, `~/.config/trawl` (config + generated keybind files), `~/.cache/trawl`,
`~/.claude/skills/trawl` and the `# >>> trawl >>>` block in `~/.zshrc` / `~/.bashrc`. Nothing else in your rc files
is touched.

### Clean install, to try it out

Install from a fresh clone and point trawl at the mock diagrams in `examples/` (run `./uninstall.sh` from any clone
first if you installed before):

```sh
rm -rf /tmp/trawl-test
git clone https://github.com/snowu/trawl /tmp/trawl-test
cd /tmp/trawl-test && ./install.sh   # in the folder step, pick /tmp/trawl-test/examples
exec "$SHELL"                        # reload your rc so the keybinds are live
```

Or without any prompts:

```sh
cd /tmp/trawl-test && ./install.sh --yes
echo '{"roots": ["/tmp/trawl-test/examples"]}' > ~/.config/trawl/config.json
exec "$SHELL"
```

Then check it works:

```sh
trawl check /tmp/trawl-test/examples   # expect: broken/typo.md:11 reported, 15/16 diagrams OK, exit 1
trawl list /tmp/trawl-test/examples    # 16 diagrams, every common type
trawl --all                            # picker over the examples (same as ctrl+alt+d)
trawl --choose                         # fzf over examples/ subfolders first (same as ctrl+alt+f)
trawl open /tmp/trawl-test/examples/planning/roadmap.md:6   # the gantt chart, straight into feh
```

## Usage

```sh
trawl                      # pick from every diagram under the current directory
trawl --all                # ... under every configured folder (the ctrl+alt+d keybind)
trawl --choose             # pick folders with fzf, then diagrams (the ctrl+alt+f keybind)
trawl docs ../other-repo   # several roots (directories or files)
trawl -b docs              # open in the browser instead of feh
trawl open docs/a.md:40    # open the diagram at line 40 straight away (no picker)
trawl list docs            # path:line  type  title, one per line (pipe-friendly)
trawl check docs           # syntax errors with file:line, exit 1 if any
trawl render docs -o out   # write every diagram to out/ as PNG (--format svg for SVG)
```

`--all`/`--choose` read `~/.config/trawl/config.json`:

```json
{ "roots": ["~/code", "~/notes"] }
```

Picker keys:

| Key | Action |
|---|---|
| type | filter: every word must match the title, path or diagram type |
| ↑/↓, ctrl-p/ctrl-n, PgUp/PgDn | move |
| tab | mark / unmark (enter then opens all marked) |
| enter | open in feh (falls back to the browser when feh isn't installed) |
| ctrl-o | open in the browser |
| ←/→ | pan a wide preview |
| ctrl-t | toggle preview between diagram and source |
| esc | clear the filter, or quit |

Rendered files are cached in `$XDG_CACHE_HOME/trawl` (default `~/.cache/trawl`), keyed by diagram source.

Directories are walked recursively, skipping dot-directories (`.git`, `.venv`, ...) and `node_modules`, `dist`,
`build`, `vendor`, `__pycache__`.

## Try it

`examples/` has mock diagrams of every common type (flowchart, sequence, class, ER, state, gantt, pie, timeline,
mindmap, gitGraph, journey, XY and quadrant charts) in nested folders, plus one deliberately broken diagram:

```sh
trawl examples             # picker
trawl --choose             # pick examples/ subfolders (add the repo to your roots first)
trawl check examples       # reports examples/broken/typo.md:11
```

## Development

```sh
bun install
bun test
bun run typecheck
bun run build              # single binary in bin/trawl
bun src/cli.ts docs        # run from source
```

Releases: push a `v*` tag and CI attaches binaries for linux/macOS x64/arm64.

`stubs/react-devtools-core` is a no-op stand-in for an optional Ink import that otherwise breaks
`bun build --compile`.

## License

MIT. Bundled Inter font: SIL Open Font License 1.1 (`fonts/OFL.txt`).
