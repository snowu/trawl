# trawl docs Worker

One Cloudflare Worker per docs repo, serving two things at one URL:

- `/`: the review site (`trawl site`), for people to browse docs and diagrams and request changes.
- `/mcp`: a remote MCP server over the same published docs, for people whose Claude (claude.ai, Claude Desktop,
  Claude Code, Cursor, ...) should read them, look at diagrams and propose changes without installing anything.

| Tool | |
|---|---|
| `search`, `read`, `list_diagrams`, `get_diagram` | find and read the published docs; refs are `docs/a.md#id` (site links work too) |
| `render` | a published diagram as a PNG image, or new Mermaid as SVG after a syntax check |
| `check` | Mermaid syntax check |
| `request_change` | files a GitHub issue labelled `trawl` (needs `GITHUB_TOKEN`) |
| `propose_change` | opens a PR replacing one diagram's source, edited against the live file on the branch (needs `GITHUB_TOKEN`) |

Requests and PRs carry `<!-- trawl:ref FILE#ID -->`, so a coding agent with the trawl skill can pick issues up, and
the `pr-diff` action posts before/after images on the PRs.

## Deploy

```sh
cd worker && bun install
TRAWL_DOCS=~/code/shop bun run build      # trawl site ~/code/shop -o worker/public (default: this repo)
npx wrangler login
npx wrangler secret put TRAWL_KEY         # any long random string: openssl rand -hex 24
npx wrangler secret put GITHUB_TOKEN      # optional: fine-grained, that repo only, Issues + Contents + Pull requests: write
bun run deploy                            # → https://trawl-docs.<you>.workers.dev
```

Rename the Worker per repo with `name` in `wrangler.jsonc`. The repo and branch the write tools use come from the
site build; override them with the `GITHUB_REPO` / `GITHUB_BRANCH` vars.

Then add the MCP server in Claude as a custom connector with the URL `https://trawl-docs.<you>.workers.dev/mcp/<TRAWL_KEY>`
(the key in the path works with every client; clients that can send headers may use `/mcp` with
`Authorization: Bearer <TRAWL_KEY>` instead). Share that URL only with the people who should have it.

### Access

- `/mcp` refuses every request until `TRAWL_KEY` is set (or `PUBLIC_MCP=true`, for public docs only).
- The site itself is public at the workers.dev URL. For private docs, put the Worker behind
  [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (free for small teams: one
  login with Google/GitHub/email codes), and exempt `/mcp*` with a bypass rule since it has its own key.
- The GitHub token can only do what you grant it; scope it to the one docs repo. PRs and issues are created as the
  token's owner.

### Keep it in sync from CI

```yaml
# .github/workflows/docs-worker.yml in the docs repo
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with: { repository: snowu/trawl, path: .trawl-src }
      - uses: oven-sh/setup-bun@v2
      - run: cd .trawl-src && bun install --frozen-lockfile && bun src/cli.ts site "$GITHUB_WORKSPACE" -o worker/public --repo "$GITHUB_REPOSITORY" --branch main
      - run: cd .trawl-src/worker && bun install && npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## Develop

```sh
printf 'TRAWL_KEY=devkey\n' > .dev.vars
bun run build && bun run dev              # http://127.0.0.1:8787, MCP at /mcp/devkey
```
