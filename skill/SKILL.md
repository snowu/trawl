---
name: trawl
description: Validate and show Mermaid diagrams with the `trawl` CLI. Use after writing or editing any mermaid block (```mermaid in .md, or .mmd files) to catch syntax errors, when the user asks to see/preview/open a diagram, or to find existing diagrams in a repo. Not for generating images to embed in docs unless asked (use `trawl render` then). Also for sending diagrams to Figma/FigJam or pulling FigJam boards back into the repo as Mermaid.
---

# trawl

`trawl` finds Mermaid diagrams in `.md` (```mermaid / ~~~mermaid fences) and `.mmd` files, checks their syntax, and
opens them as PNGs in feh (or SVGs in the browser). It renders without a browser, so it is fast and safe to run.

## After writing or editing a diagram: always check it

```sh
trawl check path/to/file.md      # or a directory
```

- Exit 0: every diagram parses.
- Exit 1: one `path:LINE: ...` block per broken diagram, with the offending source line and a caret. Fix the line and
  re-run until it exits 0. Do not tell the user a diagram is done while `check` fails.
- Common causes: `;` inside a sequence `Note` or message (it ends the statement; reword or use `,`), unquoted labels
  containing `()[]{}`, `end` as a bare node id.

## Showing a diagram to the user

```sh
trawl open path/to/file.md:LINE  # the diagram at/above LINE; omit :LINE to open every diagram in the file
trawl open -b file.md            # browser (SVG) instead of feh
```

It returns immediately; the viewer runs detached. Offer this after creating or changing a diagram the user will care
about, instead of describing the diagram in prose.

## Finding diagrams

```sh
trawl list [paths...]            # path:line<TAB>type<TAB>nearest heading, one per diagram
```

## Exporting

```sh
trawl render [paths...] -o DIR [--format png|svg]
```

Only when the user wants image files (e.g. to attach to a PR or Notion page).

## Figma / FigJam (needs the Figma MCP server)

Only when the user asks to send diagrams to Figma or bring them back, and the `figma` MCP tools are connected
(`claude plugin install figma@claude-plugins-official`, then `/mcp` → figma → Authenticate).

**Budget by seat.** Call `whoami` first (it doesn't count). A `View`/`Collab` seat, on any plan including free
Starter, gets only 20 MCP calls a month: there, say how many calls a request will take before publishing more than one
diagram, pass `includeImagesOfNodes: false` to `get_figjam`, and don't re-read a board just to verify it. `Full`/`Dev`
seats get 200 a day (more on Enterprise), so just go. With several plans, ask which one to publish to.

### Publish: diagram → editable FigJam

`generate_diagram` takes Mermaid and supports flowchart, sequence, state, gantt and ER. Load the
`figma:figma-generate-diagram` skill first (Figma requires it).

1. Find it with `trawl list`, run `trawl check` on it: never publish a diagram that doesn't parse.
2. Adapt the source for FigJam: quote labels with special characters (`{"Score > 0.8?"}`, `-->|"50%"|`), expand `a & b
   --> c` into separate edges, drop sequence `Note`s and all gantt styling, no emojis or `\n`, no `end` as an id.
   Styles keep only `fill`/`stroke` and FigJam can't set text color, so swap saturated fills for light ones (e.g.
   `fill:#CDF4D3,stroke:#66D575` green, `#FFE0C2/#FF9E42` orange, `#FFCDC2/#FF7556` red).
3. Use the `planKey` from `whoami`, then `generate_diagram` named after the diagram's heading. Several diagrams: pass the
   first result's `fileKey` to the rest so they share one board instead of littering drafts.
4. Give the user the returned link.

### Publish: pixel-exact, or types FigJam can't build

Pie, mindmap, class, journey, timeline, quadrant, gitGraph, xychart: `trawl render FILE -o DIR --format svg`, then
upload the SVG into the user's Figma file with `upload_assets` (needs that file's key and edit access).

### Pull: FigJam board → Mermaid in the repo

1. From `figma.com/board/FILEKEY/...?node-id=1-2` call `get_figjam` with that fileKey and nodeId `1:2` (`0:1` is the
   whole board).
2. The XML lists `<shape-with-text name=SHAPE>label</shape-with-text>` and `<connector connectorStart=ID
   connectorEnd=ID>label</connector>`. Map shapes: `SQUARE` → `["…"]`, `ROUNDED_RECTANGLE` → `(["…"])`, `DIAMOND` →
   `{"…"}`, `ENG_DATABASE` → `[("…")]`, `PREDEFINED_PROCESS` → `[["…"]]`, `PARALLELOGRAM_RIGHT` → `[/"…"/]`,
   `ELLIPSE` → `(("…"))`, `HEXAGON` → `{{"…"}}`; connectors → `a -->|"label"| b`. Name nodes in camelCase after their labels (`fraudScore`, not the XML's `1:12`;
   underscores break re-publishing). Unescape `&gt;` etc. Pick `TD` or
   `LR` from the shapes' x/y spread. Colors are not in the XML.
3. Write it as a ```mermaid block under a heading in the markdown file the user names, `trawl check` it, then offer
   `trawl open`.

## Don't

- Don't run bare `trawl` or `trawl PATH` (no subcommand): it opens an interactive picker meant for humans and will
  hang without a terminal. Same for `trawl roots pick`.
