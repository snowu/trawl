# trawl on AWS: private docs site + MCP server

`trawl serve` publishes one docs repo inside your VPC:

- **`/`**: the review site (docs rendered with their Mermaid diagrams, search, zoom), for anyone at the company.
- **`/mcp`**: an MCP server, so people's **Claude Code** and **Claude Desktop** can search and read the docs, look at
  diagrams, and (if allowed) file change requests or open pull requests.

Everything runs on infrastructure you own: ECS Fargate in private subnets behind an **internal** ALB. People sign in
with **Google** (company Workspace accounts only). Docs are read from GitHub, and changes are written back to it,
through a **GitHub App** owned by your org.

```
  laptop on VPN ──HTTPS──▶ internal ALB (TLS 1.2+, allowed CIDRs only)
     │                         │
     │ browser: Google sign-in │ ──▶ ECS task (Fargate, private subnet, read-only FS, non-root, no AWS permissions)
     │ Claude: personal token  │        │  egress 443 only: Google OIDC, GitHub API (+ ECR/Logs/Secrets Manager)
     ▼                         ▼        ▼
  accounts.google.com      CloudWatch  api.github.com ◀── GitHub App (repo-scoped, 1-hour installation tokens)
                           (audit log)
```

## Security model

| Concern | Control |
|---|---|
| Network exposure | Internal ALB only; its security group admits `allowed_cidrs` (VPN/office) on 443 (80 redirects). Tasks accept traffic only from the ALB. No public IPs. |
| Transport | TLS 1.2/1.3 (`ELBSecurityPolicy-TLS13-1-2-2021-06`); HSTS; ALB drops invalid headers, strictest desync mitigation; optional WAF. |
| Who gets in (browser) | Google OIDC authorization-code flow with PKCE, `state` and `nonce`. The ID token's signature (Google JWKS), issuer, audience, expiry and nonce are verified, plus `email_verified` and the Workspace domain (`hd`) against `allowed_domains`. Personal Gmail accounts have no `hd` and are refused. |
| Sessions | HMAC-SHA256-signed cookie, `HttpOnly; Secure; SameSite=Lax`, `session_hours` (default 8h). Nothing stored server-side. |
| Who gets in (Claude) | Personal MCP tokens, created by a signed-in user on `/connect` (CSRF-protected form) and shown once. HMAC-signed (separate key from sessions), carrying email, issue time, expiry (`token_days`, default 30) and an id (`jti`). Checked on every call, together with the allowed domain. |
| Revocation | One token: add its `jti` (from the `token-issued` log line) to `revoked_tokens`. Everyone: set `tokens_not_before` to now. Everything incl. sessions: rotate `TRAWL_SECRET`. Each is a redeploy. |
| What people may do | Everyone signed in: read, search, render. `requesters`: also file change requests (GitHub issues). `proposers`: also open pull requests. Roles are read from config on every call, so removing someone takes effect on the next deploy, without waiting for their token to expire. |
| Writes | Only through the GitHub App: repo-scoped, permissions you grant, tokens valid for 1 hour. Issues and PRs say who asked (`Requested by alice@…`). PRs go through your normal review and branch protection; nothing is merged automatically. |
| Abuse | 240 MCP calls/min and 20 writes/hour per person; 1 MB request limit; at most 20 messages per batch. |
| Browser hardening | CSP: scripts and styles allowed only by hash of the exact inline app, no external origins, `frame-ancestors 'none'`. Raw HTML in markdown is rendered as text. `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP, `no-store`. |
| Container | Distroless base (no shell, no package manager), single compiled binary, UID 65532, read-only root filesystem, all Linux capabilities dropped, `/tmp` is a task-local volume. The task role has **no** AWS permissions. The execution role can pull this image, read one secret and write one log group. |
| Secrets | One Secrets Manager secret (optionally CMK-encrypted), injected as env vars by ECS. Terraform creates the secret but never its value, so values never reach Terraform state. |
| Audit | JSON lines to CloudWatch: `kind=auth` (login, denied with reason, token-issued with jti and expiry), `kind=audit` (every MCP tool call: user, tool, ref, ok, outcome of writes, client IP), `kind=sync`. Retention `log_retention_days` (default 365). |
| Supply chain | Image pinned by digest (`@sha256:`; Terraform refuses tags), ECR with immutable tags and scan on push. App dependencies are pinned in `bun.lock`. |

### Known limits of the proof of concept

- **One task.** Rate limits and the docs sync live in memory, so scaling out needs a shared store (DynamoDB or Redis)
  first. A restart resets rate limits, but not sessions or tokens: those are signed, not stored.
- **Tokens are bearer tokens.** They live in each person's Claude config (`~/.claude.json`, or the Claude Desktop
  config) in plain text. Keep `token_days` short, and revoke on offboarding (see Revocation).
- **The site's "Request a change" button** opens a pre-filled issue on github.com under the person's own GitHub
  account. People without GitHub access should use Claude, whose `request_change` tool files through the App.
- **Claude Desktop** reaches the server through `mcp-remote` (run with `npx`, version pinned on `/connect`).
  Review that package, or mirror it internally, before rolling Desktop out.
- **claude.ai on the web can't reach this server**: its connectors connect from Anthropic's cloud, and this endpoint
  is private by design.

## Setup

### 1. Google OAuth client

Google Cloud console → *APIs & Services*:
1. **OAuth consent screen**: user type **Internal**, so only your Workspace can use it.
2. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI:
   `https://<hostname>/auth/callback` (Terraform prints it as `google_redirect_uri`). Keep the client secret for step 4.

### 2. GitHub App (owned by the org)

Org settings → *Developer settings → GitHub Apps → New*:
- Homepage URL: `https://<hostname>`; **Webhook: off**.
- Repository permissions: **Contents: Read and write**, **Issues: Read and write**, **Pull requests: Read and write**,
  Metadata: Read-only. Nothing else, and no organization permissions.
- Where can it be installed: **Only on this account**.
- Create it, note the **App ID**, **generate a private key** (PEM), then **Install** it on the **docs repo only**.
- For a read-only pilot, grant Contents: Read only and leave `requesters`/`proposers` empty.

### 3. Image

```sh
docker build -t trawl:0.3.0 .                      # from the trawl repo root; --platform linux/arm64 for Graviton
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag trawl:0.3.0 <ecr_repository_url>:0.3.0 && docker push <ecr_repository_url>:0.3.0
# Terraform wants the digest: <ecr_repository_url>@sha256:...   (docker inspect --format '{{index .RepoDigests 0}}')
```

(With `create_ecr_repository = true`, apply once with `-target=aws_ecr_repository.trawl` to get the repo first.)

### 4. Terraform

```hcl
module "trawl" {
  source = "github.com/snowu/trawl//deploy/aws/terraform?ref=v0.3.0"

  name               = "trawl-docs"
  vpc_id             = "vpc-..."
  private_subnet_ids = ["subnet-a", "subnet-b"]
  allowed_cidrs      = ["10.0.0.0/8"]           # VPN / office
  certificate_arn    = "arn:aws:acm:..."
  hostname           = "trawl.internal.example.com"
  route53_zone_id    = "Z..."                    # private zone, optional
  image              = "<account>.dkr.ecr.<region>.amazonaws.com/trawl-docs@sha256:..."

  allowed_domains  = ["example.com"]
  google_client_id = "....apps.googleusercontent.com"
  github_repo      = "example-org/product-docs"
  github_app_id    = "123456"
  requesters       = ["@example.com"]            # everyone may file change requests
  proposers        = ["alice@example.com"]       # only Alice opens PRs
}
```

Then set the secret's values (never in Terraform):

```sh
aws secretsmanager put-secret-value --secret-id "$(terraform output -raw secret_arn)" --secret-string "$(jq -n \
  --arg s "$(openssl rand -hex 32)" \
  --arg g "<google client secret>" \
  --rawfile k ./github-app.private-key.pem \
  '{TRAWL_SECRET: $s, GOOGLE_CLIENT_SECRET: $g, GITHUB_APP_PRIVATE_KEY: $k}')"
shred -u github-app.private-key.pem
aws ecs update-service --cluster trawl-docs --service trawl-docs --force-new-deployment
```

### 5. Egress

The task needs outbound HTTPS to:

| Host | Why |
|---|---|
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` | sign-in (token exchange, signing keys) |
| `api.github.com` | docs sync, issues and PRs through the App |
| ECR (`api`, `dkr`), S3 (image layers), CloudWatch Logs, Secrets Manager | image pull, logs, secrets: via NAT, or VPC endpoints |

The task security group allows 443 out. Restrict it to these hosts at your egress firewall or proxy (e.g. AWS Network
Firewall with a domain allowlist).

### 6. Testers

People open `https://<hostname>`, sign in with Google, click **Connect Claude**, create a token, and paste the command
it shows:
- **Claude Code**: `claude mcp add --transport http trawl-docs https://<hostname>/mcp --header "Authorization: Bearer trawl_…"`
- **Claude Desktop**: the JSON shown on the page goes into Settings → Developer → Edit config.

Then they can ask: "find our refund flow and show it to me", "the refund flow should send failed payments to
support: file that as a change request", and so on.

## Runbook

| Task | How |
|---|---|
| Offboard someone | Remove them from Google Workspace (no new sessions). Add their token `jti`s (`kind=auth event=token-issued user=…` in the logs) to `revoked_tokens`, or set `tokens_not_before`, then apply. |
| Suspected token leak | Set `tokens_not_before` to now and apply. Everyone creates a new token on `/connect`. |
| Rotate `TRAWL_SECRET` | Put a new value in the secret, then force a new deployment. Every session and token stops working at once. |
| Rotate the GitHub App key | Generate a new key in the App settings, put it in the secret, redeploy, then delete the old key in GitHub. |
| Rotate the Google client secret | Add a new secret in the Google console, put it in the secret, redeploy, then delete the old one in Google. |
| Who did what | CloudWatch Logs Insights on the log group: `filter kind = "audit" \| fields ts, user, tool, ref, ok, detail \| sort ts desc` |
| Docs look stale | `filter kind = "sync"` shows each sync (commit, counts) or its error. The interval is `sync_minutes` (default 10). A failed sync keeps serving the last good build. |
| Run it locally | `TRAWL_INSECURE_DEV=1 TRAWL_PUBLIC_URL=http://localhost:8080 TRAWL_SITE_DIR=./site … trawl serve` (`trawl site -o site` to build one; http is only allowed for localhost). |
