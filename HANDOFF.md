# Handoff: trawl (2026-11-03)

Pick up here on another machine. Delete this file before merging PR #15.

## Where things are

- **main**: v0.2.0 is released, with linux and macOS binaries. It includes:
  - the index and `trawl find`/`show` (alt+k fzf)
  - stable diagram IDs
  - `trawl mcp` (stdio)
  - the review site and `trawl diff`, plus GitHub Actions for both
  - sixel images in Windows Terminal
  - docs and diagram views (switch between them with ctrl-s)
  - `trawl doctor`
- **`hosted-aws`, PR #15**: open and not merged; all CI checks pass. It adds `trawl serve`, the self-hosted docs site and MCP server for running inside a company VPC.
  - Google Workspace sign-in (OIDC with PKCE, `hd` allow list)
  - personal MCP tokens created on `/connect`
  - roles: read, request, propose
  - a GitHub App for syncing docs and writing back
  - an audit log as JSON lines
  - a hardened Dockerfile: distroless, non-root, read-only filesystem
  - a Terraform module at `deploy/aws/terraform`: Fargate behind an internal ALB
  - `deploy/aws/README.md` has the security model, setup steps and runbook
- **`worker/`**: the Cloudflare variant. It shares `DocsServer` with `trawl serve` and is **not deployed** on purpose.

Nothing is deployed anywhere. Don't deploy without an explicit go-ahead.

## Setup on a new machine

```sh
git clone git@github.com:snowu/trawl.git && cd trawl && git switch hosted-aws
mise use -g bun@1.4.4         # or install bun 1.4.4 another way; newer bun rewrites bun.lock, don't commit that churn
bun install
bun test                      # expect 107 passing
bunx tsc --noEmit
./install.sh                  # optional: installs the CLI, the alt+k keybind and the MCP registration
```

Requirements:
- fzf 0.60 or newer, for `trawl find`
- Terraform 1.6 or newer and Checkov, for `deploy/aws/terraform`

Checks for the Terraform module:
- `terraform fmt -check`
- `terraform init -backend=false && terraform validate`
- `checkov -d .` should report 94 passed and 1 documented skip (secret rotation)

## Next steps

1. Review PR #15, merge it, and tag **v0.3.0**. The deploy README references the module as `?ref=v0.3.0`. Pushing a `v*` tag builds the release binaries.
2. Company pilot. Steps 1 and 2 need someone with admin rights at the company.
   1. Create a Google OAuth client. The consent screen must be "Internal" and the redirect is `https://<host>/auth/callback`.
   2. Create an org-owned GitHub App with Contents, Issues and Pull requests set to read and write. Install it on the docs repo only.
   3. Build and push the image, then apply the module with the image pinned by digest.
   4. Put the values into the secret with `aws secretsmanager put-secret-value`. They never go through Terraform.
   5. Allow outbound traffic to Google, `api.github.com`, and the AWS endpoints.
3. Not built yet, in priority order:
   - **Scaling out.** Rate limits live in memory, so the service runs as a single task. Running more tasks needs DynamoDB or Redis.
   - **Token revocation without a redeploy.** Today revocation is done with `revoked_tokens` / `tokens_not_before`, and each change needs an apply.
   - **Kitty images in the fzf preview.** Only sixel is done there; the picker already handles kitty.
   - **Cleanup:** delete the old `index-and-mcp` remote branch.

## Things that bit us

- **Merged PRs.** The user may merge a PR right after it's opened. Check `gh pr view N --json state` before pushing more commits to its branch.
- **Bun on WSL.** Bun isn't on PATH there; use `mise x bun@1.4.4 -- …`.
- **WSL and Windows Terminal images.**
  - ConPTY reports the pixel size as 0 and resets it to 0 after fzf starts.
  - trawl writes the size only when it is 0, and repairs it every 250ms while fzf runs.
  - It never touches a nonzero size, so native terminals are unaffected.
- **No git in the container.** The image is distroless and has no `git`. All git calls go through `runGit` in `src/git.ts`, which reports "not a repo" instead of throwing.
- **Killing processes.** `pkill -f name` can kill your own shell. Use a `[n]ame` pattern.
- **Visual checks.**
  - The site: headless Chromium.
  - Sixel: record a tmux pane with `pipe-pane`, then replay it into xterm.js with addon-image.
