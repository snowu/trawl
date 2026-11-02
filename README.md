# trawl

Search every markdown doc on your machine, find every Mermaid diagram in them, preview diagrams in the terminal and
open them as crisp PNGs in [feh](https://feh.finalrewind.org/) (or as SVGs in your browser). Agents get the same
through an MCP server: search and read your docs, check, render (as images they can look at) and edit diagrams.

![trawl: lint, open the picker with alt+m, browse real rendered previews, filter, zoom, view source, export](demo/trawl-demo.gif)

- Scans `.md` files for ` ```mermaid ` / `~~~mermaid` blocks and whole `.mmd` files, labelling each diagram with the
  nearest markdown heading.
- Renders without a browser or Chromium: [pele](https://github.com/obsidianmd/pele) draws the SVG,
  [resvg](https://github.com/linebender/resvg) rasterizes it with a bundled Inter font, so PNGs look the same on every
  machine.
- Previews the real rendered diagram inside the picker in terminals that support inline images: the kitty protocol
  (Ghostty, kitty, WezTerm) or sixel (Windows Terminal 1.22+, foot, Konsole, xterm -ti vt340, ...; detected by
  asking the terminal). Elsewhere (Alacritty, tmux, ...) it falls back to colored box-drawing art
  ([beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid): flowchart, sequence, state, class, ER and XY
  charts; other types show their source). `TRAWL_IMAGES=0`, `=kitty` or `=sixel` overrides the detection, and `TRAWL_CELL=9x18` the measured cell size in
pixels if images come out the wrong size.
- `trawl check` doubles as a Mermaid linter for CI.
- `trawl find` (alt+k) searches every doc and section in your folders and the repo you're in: live results in fzf,
  the matching section as preview, enter opens it in `$EDITOR` at that line. A full-text index (SQLite) is updated
  incrementally, so searching thousands of notes stays instant.
- `trawl mcp` is an MCP server for Claude Code, Claude Desktop, Cursor or any MCP client (see [MCP](#mcp)).

## Install

Needs [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`); fzf and feh are optional but recommended.

```sh
git clone https://github.com/snowu/trawl && cd trawl && ./install.sh
```

The installer, re-runnable at any time:

1. builds the binary into `~/.local/bin/trawl`,
2. asks which folders trawl scans (`trawl roots pick`: fzf over `~`, or type any path),
3. adds a shell keybind to `~/.zshrc` / `~/.bashrc`: **alt+m** (letter configurable) opens the picker on the repo
   you're in,
4. adds **alt+k**, which searches your docs (`trawl find`),
5. installs a [Claude Code](https://claude.com/claude-code) skill (`~/.claude/skills/trawl`) so agents run
   `trawl check` on diagrams they write and `trawl open` to show them to you. With Figma's MCP connected
   (`claude plugin install figma@claude-plugins-official`, then `/mcp` → figma → Authenticate) they can also publish
   diagrams as editable FigJam boards and pull boards back into your markdown as Mermaid; just ask.
6. registers `trawl mcp` as a user-scoped MCP server in Claude Code (`claude mcp add -s user trawl -- trawl mcp`).

`./install.sh --yes` takes every default without asking; `--no-keybind`, `--no-skill` and `--no-mcp` skip those
steps.
The keybind works in any terminal and inside tmux/herdr, wherever you are at a zsh or bash prompt (on macOS, set the
terminal's Option key to send Esc/Meta).

Prebuilt binaries for linux/macOS x64/arm64 are also attached to [Releases](../../releases) if you only want the CLI.

### Uninstall

```sh
./uninstall.sh          # lists what it found, asks, then removes it; --yes to skip the question
```

It removes the binary, `~/.config/trawl` (config + generated keybind files), `~/.cache/trawl` (renders and the
search index), `~/.claude/skills/trawl`, the `trawl` MCP server registration and the `# >>> trawl >>>` block in `~/.zshrc` / `~/.bashrc`. Nothing else in your rc files
is touched.

### Clean install

From your clone, remove any previous install and install again:

```sh
./uninstall.sh --yes && ./install.sh
exec "$SHELL"   # reload your rc so the keybind is live
```

Then check it works (`examples/` in the repo has mock diagrams of every common type, plus one broken one):

```sh
trawl check examples   # broken/typo.md:11 reported, 15/16 diagrams OK, exit 1
trawl examples         # picker over the examples
trawl --all            # picker over your configured folders
```

## Usage

```sh
trawl                      # picker over the git repo you're in (the alt+m keybind); from ~, your configured folders
trawl --all                # picker over all your configured folders
trawl docs ../other-repo   # picker over these folders/files
trawl -b docs              # open in the browser instead of feh
trawl open docs/a.md:40    # open the diagram at line 40 straight away (no picker)
trawl list docs            # path:line  type  title, one per line (pipe-friendly)
trawl check docs           # syntax errors with file:line, exit 1 if any
trawl render docs -o out   # write every diagram to out/ as PNG (--format svg for SVG)

trawl find                 # search all your docs (fzf; alt+k)
trawl find refund policy   # same, starting from a query
trawl find --plain refund  # path:line  section › breadcrumb  snippet (scripts, agents)
trawl find -i ~/notes q    # only in this folder (repeatable)
trawl show a.md:40         # print the section at line 40 (or a.md#heading-slug, a.md#diagram-id)
trawl index                # update the index now and print what it holds (--rebuild to start over)
```

`find` searches your configured folders plus the repo you're in. Every word must match (prefixes and plurals
count: `refund` finds "refunds"); headings weigh more than body text. An empty query lists recently edited docs.
The fzf view lists sections with text of their own: diagram-only sections and `.mmd` files are left to the diagram
view (`--plain`, used by scripts and agents, still includes them; `--prose` leaves them out there too). The preview renders the section (with its subsections) for the terminal, highlights what you typed
and draws its diagrams: as images in sixel terminals (Windows Terminal, foot, ...), else as box art. Keys: enter opens
the section in `$VISUAL`/`$EDITOR`, ctrl-o opens the diagrams in that section, ctrl-/ widens the preview, ctrl-y
copies `path:line`, and **ctrl-s** (or alt+m) switches to the diagram picker over the same folders, keeping what you
typed. In the picker, ctrl-s (or alt+k) switches back.

### Diagram ids

Each diagram has an id that stays put while lines move around it, so agents, links and reviews can point at it as
`file.md#id`. By default it is the nearest heading as a slug (`## Order Lifecycle` → `order-lifecycle`, repeats get
`-2`, `-3`). Pin one that survives renaming the heading with either:

````md
```mermaid id=checkout-flow
flowchart LR
  ...
```
````

or a `%% trawl:id checkout-flow` line inside the diagram (works in `.mmd` files too).

Configured folders:

```sh
trawl roots                # list them
trawl roots pick           # choose with fzf (anything under ~, tab for several, or type a path)
trawl roots add ~/notes    # add / remove without fzf
trawl roots remove ~/notes
```

They live in `~/.config/trawl/config.json` as `{ "roots": ["~/code", "~/notes"] }` if you prefer editing it.
Dependency and build folders are never scanned (`node_modules`, `vendor`, `target`, `dist`, `site-packages`, Go's
`pkg/mod`, dot-folders, ...); skip more with `"ignore": ["worktrees", "~/old-notes"]` (a bare name skips that folder
name anywhere, a path skips that folder).

`trawl doctor` prints what trawl detects (image support, cell size, fzf, folders): include it in bug reports.

Picker keys:

| Key | Action |
|---|---|
| type | filter: every word must match the title, path or diagram type |
| ↑/↓, ctrl-p/ctrl-n, PgUp/PgDn | move |
| tab | mark / unmark (enter then opens all marked) |
| enter | open in feh (falls back to the browser when feh isn't installed) |
| ctrl-o | open in the browser |
| ctrl-f | choose subfolders of what's being scanned (fzf), then reopen on just those |
| ctrl-a | reopen on all your configured folders |
| ←/→ | previous / next folder |
| shift ←/→ | pan a wide text preview |
| mouse | click a row to select it, wheel over the list to move; over an image: wheel zooms, drag pans, right-click resets |
| ctrl-s, alt+k | switch to the docs view (search), keeping the filter |
| ctrl-t | toggle preview between diagram and source |
| ctrl-y | copy the mermaid source (marked: all of them, as fenced blocks) |
| esc | clear the filter, or quit |

The list is grouped by folder. Broken diagrams are marked ✗; selecting one shows the syntax error with its line
instead of a preview.

Rendered files are cached in `$XDG_CACHE_HOME/trawl` (default `~/.cache/trawl`), keyed by diagram source.

Directories are walked recursively, skipping dot-directories (`.git`, `.venv`, ...) and `node_modules`, `dist`,
`build`, `vendor`, `__pycache__`.

## MCP

`trawl mcp` speaks MCP on stdio. The installer registers it for Claude Code; for other clients add
`"trawl": { "command": "trawl", "args": ["mcp"] }` to their MCP config. Its scope is your configured folders plus
the repo it was started in.

| Tool | What it does |
|---|---|
| `search` | full-text search over docs and sections; empty query = recently edited docs |
| `read` | a section (`file:LINE`, `file#heading-slug`) or a whole file |
| `list_diagrams` | every diagram as `path#id`, type, title; optional word filter |
| `get_diagram` | one diagram's source, location and whether it parses |
| `check` | syntax-check raw source, one diagram, or every diagram under some folders |
| `render` | a diagram or raw source as a PNG image the agent can look at (or SVG text) |
| `update_diagram` | replace one diagram's source in place; refuses source that doesn't parse and files outside trawl's folders |

## Review site (for product and design)

```sh
trawl site -o site          # static site of this repo's docs and diagrams
trawl site --serve          # build it into a temp folder and open it in the browser
```

A reader, not an editor: a folder tree and search on the left, each doc rendered with its diagrams inline, a gallery of
every diagram (filter by type), click to zoom and pan, light and dark. Every diagram has:

- **Request a change**: opens a GitHub issue pre-filled with the diagram's `file#id`, a link back and its current
  Mermaid, labelled `trawl`. Ask an agent to "pick up the diagram requests" and it edits the source and opens a PR
  (the skill knows how), which the PR action below then illustrates.
- **Discussion** (issues mentioning that diagram), **FigJam** (when `.trawl/links.json` maps `file#id` to a board;
  the skill writes it when it publishes), **Mermaid** source, **Copy**, **Link**.

Raw HTML in the markdown is shown as text, so a doc can't run script in the shared site. The repo and branch come
from `git remote`; override with `--repo OWNER/NAME --branch NAME`. The output is plain files (`index.html`,
`trawl.json`, `d/*.svg|png`): host it anywhere. Publish it with GitHub Pages:

```yaml
# .github/workflows/docs-site.yml
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  site:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deploy.outputs.page_url }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: snowu/trawl/actions/site@main
      - id: deploy
        uses: actions/deploy-pages@v4
```

(Pages on a private repo needs a paid plan; the folder works on Cloudflare Pages or any static host too.)

## Diagram diffs on pull requests

```sh
trawl diff origin/main            # what this branch (incl. uncommitted work) adds, changes or removes
trawl diff origin/main HEAD -o previews --comment comment.md --image-url URL
```

Diagrams are matched by id since the merge base, so a moved diagram isn't a change and a renamed heading (derived id)
shows as removed + added; give important diagrams an explicit `id=`. In CI, the `pr-diff` action renders before/after
PNGs, pushes them to a `trawl-previews` branch and keeps one comment on the PR up to date:

```yaml
# .github/workflows/diagrams.yml
on: { pull_request: { paths: ['**/*.md', '**/*.mmd'] } }
permissions: { contents: write, pull-requests: write }
jobs:
  diff:
    if: github.event.pull_request.head.repo.full_name == github.repository   # forks get a read-only token
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: snowu/trawl/actions/pr-diff@main
        # with: { site-url: https://you.github.io/repo/ }
```

## Hosted: site + remote MCP for the whole team

[`worker/`](worker/README.md) deploys one Cloudflare Worker per docs repo that serves the review site at `/` and a
remote MCP server at `/mcp`. Product and design add that URL to their Claude as a connector and can then ask it to
find a flow, show it (rendered), and turn "the refund flow should send failed payments to support" into a change
request issue or a ready PR, without cloning anything. Locked by a shared key; the write tools need a GitHub token
scoped to that repo.

```
 people ─── browser ──▶  site (/)          ─┐
 their Claude ── MCP ─▶  /mcp/<key>         ├─ reads trawl.json + rendered diagrams (built by `trawl site`)
                         request_change ────┼─▶ GitHub issue (label trawl) ─▶ agent with the trawl skill ─▶ PR
                         propose_change ────┘─▶ GitHub PR ─▶ pr-diff action: before/after comment ─▶ merge ─▶ redeploy
```

## Try it

`examples/` has mock diagrams of every common type (flowchart, sequence, class, ER, state, gantt, pie, timeline,
mindmap, gitGraph, journey, XY and quadrant charts) in nested folders, plus one deliberately broken diagram:

```sh
trawl examples             # picker (ctrl+f to narrow to examples/ subfolders)
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
