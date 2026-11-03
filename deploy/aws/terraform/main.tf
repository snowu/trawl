# trawl serve on ECS Fargate behind an internal ALB, inside an existing VPC. See ../README.md for the security model,
# the Google OAuth client and GitHub App setup, and the egress the tasks need.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  tags        = merge({ app = "trawl", deployment = var.name }, var.tags)
  public_url  = "https://${var.hostname}"
  ecr_arn     = var.create_ecr_repository ? aws_ecr_repository.trawl[0].arn : "arn:aws:ecr:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:repository/*"
  secret_keys = ["TRAWL_SECRET", "GOOGLE_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]
}

# ── Image registry ───────────────────────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "trawl" {
  count                = var.create_ecr_repository ? 1 : 0
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = var.kms_key_arn == "" ? "AES256" : "KMS"
    kms_key         = var.kms_key_arn == "" ? null : var.kms_key_arn
  }
  tags = local.tags
}

# ── Logs and secrets ─────────────────────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "trawl" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn == "" ? null : var.kms_key_arn
  tags              = local.tags
}

# One JSON secret holding TRAWL_SECRET, GOOGLE_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY. Terraform creates the
# container only: put the values in with the CLI (README), so they never land in Terraform state.
resource "aws_secretsmanager_secret" "trawl" {
  #checkov:skip=CKV2_AWS_57:Values are issued by Google and GitHub and rotated there; rotating TRAWL_SECRET signs everyone out, so it's a manual runbook step (README).
  name                    = "${var.name}/app"
  description             = "trawl serve: session/token signing secret, Google OAuth client secret, GitHub App private key"
  kms_key_id              = var.kms_key_arn == "" ? null : var.kms_key_arn
  recovery_window_in_days = 7
  tags                    = local.tags
}

# ── IAM: the execution role pulls the image, reads the one secret and writes logs; the task role has nothing ──

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "PullImage"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [local.ecr_arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.trawl.arn}:*"]
  }
  statement {
    sid       = "AppSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.trawl.arn]
  }
  dynamic "statement" {
    for_each = var.kms_key_arn == "" ? [] : [1]
    content {
      sid       = "DecryptSecret"
      actions   = ["kms:Decrypt"]
      resources = [var.kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "pull-logs-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# The app itself calls no AWS API: an explicit role with no policies, so nothing is inherited.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

# ── Network ──────────────────────────────────────────────────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "trawl internal ALB: HTTPS from allowed ranges only"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_security_group" "task" {
  name        = "${var.name}-task"
  description = "trawl tasks: only the ALB gets in"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(var.allowed_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from ${each.value}"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  for_each          = toset(var.allowed_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP from ${each.value} (redirected to HTTPS)"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "to trawl tasks"
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "from the ALB"
}

# Security groups can't filter by domain: route this through your egress firewall / proxy and allow only
# accounts.google.com, oauth2.googleapis.com, www.googleapis.com, api.github.com (plus ECR, Logs, Secrets Manager,
# or use VPC endpoints for those). See README.
resource "aws_vpc_security_group_egress_rule" "task_https_out" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to Google sign-in, GitHub API and AWS APIs (restrict at the egress firewall)"
}

resource "aws_lb" "trawl" {
  name                       = var.name
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = var.private_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = true
  dynamic "access_logs" {
    for_each = var.alb_access_logs_bucket == "" ? [] : [1]
    content {
      bucket  = var.alb_access_logs_bucket
      prefix  = var.name
      enabled = true
    }
  }
  tags = local.tags
}

resource "aws_lb_target_group" "trawl" {
  name                 = var.name
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.trawl.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.trawl.arn
  }
  tags = local.tags
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.trawl.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "trawl" {
  count        = var.waf_acl_arn == "" ? 0 : 1
  resource_arn = aws_lb.trawl.arn
  web_acl_arn  = var.waf_acl_arn
}

resource "aws_route53_record" "trawl" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.hostname
  type    = "A"
  alias {
    name                   = aws_lb.trawl.dns_name
    zone_id                = aws_lb.trawl.zone_id
    evaluate_target_health = true
  }
}

# ── ECS ──────────────────────────────────────────────────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "trawl" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_ecs_task_definition" "trawl" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  # Task-local scratch space for the GitHub sync; the root filesystem is read-only.
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([{
    name                   = "trawl"
    image                  = var.image
    essential              = true
    user                   = "65532:65532"
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 8080, protocol = "tcp" }]
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { drop = ["ALL"] }
    }
    environment = [
      { name = "TRAWL_PUBLIC_URL", value = local.public_url },
      { name = "TRAWL_PORT", value = "8080" },
      { name = "TRAWL_ALLOWED_DOMAINS", value = join(",", var.allowed_domains) },
      { name = "GOOGLE_CLIENT_ID", value = var.google_client_id },
      { name = "TRAWL_GITHUB_REPO", value = var.github_repo },
      { name = "TRAWL_GITHUB_BRANCH", value = var.github_branch },
      { name = "TRAWL_DOCS_PATHS", value = join(",", var.docs_paths) },
      { name = "TRAWL_SYNC_MINUTES", value = tostring(var.sync_minutes) },
      { name = "GITHUB_APP_ID", value = var.github_app_id },
      { name = "GITHUB_APP_INSTALLATION_ID", value = var.github_app_installation_id },
      { name = "TRAWL_REQUESTERS", value = join(",", var.requesters) },
      { name = "TRAWL_PROPOSERS", value = join(",", var.proposers) },
      { name = "TRAWL_SESSION_HOURS", value = tostring(var.session_hours) },
      { name = "TRAWL_TOKEN_DAYS", value = tostring(var.token_days) },
      { name = "TRAWL_TOKENS_NOT_BEFORE", value = var.tokens_not_before },
      { name = "TRAWL_REVOKED_TOKENS", value = join(",", var.revoked_tokens) },
      { name = "TMPDIR", value = "/tmp" },
    ]
    secrets = [for k in local.secret_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.trawl.arn}:${k}::" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.trawl.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "trawl"
      }
    }
    stopTimeout = 30
  }])
  tags = local.tags
}

resource "aws_ecs_service" "trawl" {
  name            = var.name
  cluster         = aws_ecs_cluster.trawl.id
  task_definition = aws_ecs_task_definition.trawl.arn
  launch_type     = "FARGATE"
  # One task: rate limits and the GitHub sync are per process. Scale out only after moving those to a shared store.
  desired_count          = 1
  enable_execute_command = false
  propagate_tags         = "SERVICE"
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.trawl.arn
    container_name   = "trawl"
    container_port   = 8080
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}
