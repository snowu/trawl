---
name: trawl
description: Validate and show Mermaid diagrams with the `trawl` CLI. Use after writing or editing any mermaid block (```mermaid in .md, or .mmd files) to catch syntax errors, when the user asks to see/preview/open a diagram, or to find existing diagrams in a repo. Not for generating images to embed in docs unless asked (use `trawl render` then).
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

## Don't

- Don't run bare `trawl`, `trawl --all` or `trawl --choose`: they open an interactive picker meant for humans and will
  hang without a terminal.
