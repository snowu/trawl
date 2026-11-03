variable "name" {
  description = "Name prefix for every resource (one deployment per docs repo)."
  type        = string
  default     = "trawl-docs"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name: lowercase letters, digits and dashes, 2-31 characters."
  }
}

variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}

# ── Network ──────────────────────────────────────────────────────────────────────────────────────────────────────

variable "vpc_id" {
  description = "VPC to run in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets (2+ AZs) for the internal ALB and the tasks. Tasks need outbound HTTPS (NAT or proxy) to Google and GitHub, plus ECR/Logs/Secrets Manager (NAT or VPC endpoints)."
  type        = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "An ALB needs subnets in at least two availability zones."
  }
}

variable "allowed_cidrs" {
  description = "Who can reach the ALB: your VPN / office ranges. Nothing else gets in."
  type        = list(string)
  validation {
    condition     = length(var.allowed_cidrs) > 0 && !contains(var.allowed_cidrs, "0.0.0.0/0")
    error_message = "allowed_cidrs must list your private ranges; 0.0.0.0/0 is refused."
  }
}

variable "certificate_arn" {
  description = "ACM certificate for hostname (an internal ALB still serves HTTPS only)."
  type        = string
}

variable "hostname" {
  description = "Hostname people use, e.g. trawl.internal.example.com. Must match the certificate and the Google OAuth redirect URI."
  type        = string
}

variable "route53_zone_id" {
  description = "Private hosted zone to add hostname to; empty to manage DNS yourself."
  type        = string
  default     = ""
}

variable "alb_access_logs_bucket" {
  description = "S3 bucket for ALB access logs (recommended); empty to disable."
  type        = string
  default     = ""
}

variable "waf_acl_arn" {
  description = "Your own regional WAFv2 web ACL to attach to the ALB instead of the one this module creates."
  type        = string
  default     = ""
}

variable "create_waf" {
  description = "Create a WAF web ACL (AWS managed rules, per-address rate limit, logged with tokens and cookies redacted) when waf_acl_arn is empty."
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "Requests per 5 minutes from one address before the WAF blocks it. Behind a VPN that NATs everyone to one address, raise it."
  type        = number
  default     = 3000
}

variable "egress_cidrs" {
  description = "Where tasks may connect on 443. Set to your egress proxy / firewall ranges to stop them reaching anything else; the default relies on an egress firewall (README)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "egress_prefix_list_ids" {
  description = "Prefix lists tasks may reach on 443 too (e.g. the S3 gateway endpoint's, for ECR image layers)."
  type        = list(string)
  default     = []
}

# ── Runtime ──────────────────────────────────────────────────────────────────────────────────────────────────────

variable "image" {
  description = "Container image, pinned by digest: <account>.dkr.ecr.<region>.amazonaws.com/trawl@sha256:..."
  type        = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Pin the image by digest (@sha256:...), not a tag."
  }
}

variable "create_ecr_repository" {
  description = "Create a private ECR repository (immutable tags, scan on push) to push the image to."
  type        = bool
  default     = true
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64; must match the image."
  type        = string
  default     = "X86_64"
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "X86_64 or ARM64."
  }
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "log_retention_days" {
  type    = number
  default = 365
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for logs and secrets; empty for AWS-managed keys."
  type        = string
  default     = ""
}

# ── App ──────────────────────────────────────────────────────────────────────────────────────────────────────────

variable "allowed_domains" {
  description = "Google Workspace domains allowed to sign in (checked on the ID token's hd claim)."
  type        = list(string)
}

variable "google_client_id" {
  description = "Google OAuth client ID (Web application, Internal). Its secret goes in the Secrets Manager secret."
  type        = string
}

variable "github_repo" {
  description = "Docs repo, owner/name. The GitHub App must be installed on it."
  type        = string
}

variable "github_branch" {
  type    = string
  default = "main"
}

variable "docs_paths" {
  description = "Only publish these folders of the repo (empty: the whole repo)."
  type        = list(string)
  default     = []
}

variable "github_app_id" {
  description = "GitHub App ID. Its private key goes in the Secrets Manager secret."
  type        = string
}

variable "github_app_installation_id" {
  description = "Installation ID of the App on the org (optional; looked up from the repo otherwise)."
  type        = string
  default     = ""
}

variable "requesters" {
  description = "Who may file change requests: emails, @domain, or *."
  type        = list(string)
  default     = []
}

variable "proposers" {
  description = "Who may open pull requests (implies requester): emails, @domain, or *."
  type        = list(string)
  default     = []
}

variable "session_hours" {
  type    = number
  default = 8
}

variable "token_days" {
  description = "Lifetime of personal MCP tokens (they sit in plain text in people's Claude config: keep it short)."
  type        = number
  default     = 14
  validation {
    condition     = var.token_days >= 1 && var.token_days <= 90
    error_message = "token_days: 1 to 90."
  }
}

variable "tokens_not_before" {
  description = "ISO timestamp: tokens issued before it stop working (revoke everyone, e.g. after an incident)."
  type        = string
  default     = ""
}

variable "blocked_users" {
  description = "Emails refused outright: their sessions and tokens stop working and they can't sign in (offboarding, incidents)."
  type        = list(string)
  default     = []
}

variable "revoked_tokens" {
  description = "Token ids (jti, from the audit log's token-issued events) to revoke."
  type        = list(string)
  default     = []
}

variable "sync_minutes" {
  description = "How often to check the docs branch for new commits."
  type        = number
  default     = 10
}
