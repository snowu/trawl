# Demo videos

| File | What |
| --- | --- |
| `trawl-demo.mp4` / `.gif` | The real TUI in Ghostty: check, alt+m picker, browse, filter, zoom/pan, source, render. |
| `trawl-vibe.mp4` | Motion graphics, no terminal (not in the repo: render it with the steps below). |

`shop/` is the fictional project both videos show (17 diagrams across most Mermaid types).
Everything intermediate lands in `build/` (gitignored).

## TUI demo (`tui/`)

```sh
demo/tui/record.sh             # one take; needs Hyprland, Ghostty, gpu-screen-recorder
python3 demo/tui/stills.py     # backdrop, caption pills, title cards, render payoff
python3 demo/tui/assemble.py   # -> trawl-demo.mp4 + trawl-demo.gif
```

`record.sh` takes over workspace 9 for ~40s: keep your hands off the keyboard and mouse meanwhile.
`director.py` drives a real bash + trawl in a pty inside the recorded Ghostty, typing and clicking on a script,
and logs caption times to `build/tui/timeline.json`. Change the take by editing its scenes.

## Vibe video (`vibe/`)

```sh
python3 demo/vibe/music.py     # synthesizes the soundtrack (stdlib only)
bun demo/vibe/make.ts          # renders every frame with trawl's own resvg setup -> trawl-vibe.mp4
ONLY=12.5 bun demo/vibe/make.ts   # just the frame at 12.5s, to build/vibe/frame.png
```

Scene timings in `make.ts` and hits in `music.py` share one 120 bpm grid; move them together.
