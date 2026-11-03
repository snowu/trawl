output "url" {
  description = "Where people open trawl (and the /mcp endpoint for Claude)."
  value       = local.public_url
}

output "google_redirect_uri" {
  description = "Add this as an authorized redirect URI on the Google OAuth client."
  value       = "${local.public_url}/auth/callback"
}

output "alb_dns_name" {
  description = "Point hostname here if you manage DNS yourself."
  value       = aws_lb.trawl.dns_name
}

output "secret_arn" {
  description = "Put TRAWL_SECRET, GOOGLE_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY in this secret (README)."
  value       = aws_secretsmanager_secret.trawl.arn
}

output "ecr_repository_url" {
  description = "Push the image here (when create_ecr_repository)."
  value       = var.create_ecr_repository ? aws_ecr_repository.trawl[0].repository_url : null
}

output "log_group" {
  description = "Application and audit logs (JSON lines; audit events have kind=audit)."
  value       = aws_cloudwatch_log_group.trawl.name
}
