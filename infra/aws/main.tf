# AWS deployment: Network Load Balancer (TCP) -> N gateway EC2 instances -> ElastiCache Redis (TLS)
# ---------------------------------------------------------------------------------------------
# STATUS: written from the AWS provider docs but NOT applied in the authoring environment (no AWS access there).
#         Run `terraform plan` first, read it, and expect to fix small things (AMI/region/quotas) on first apply.
# COST:   see docs/AWS-AND-COSTS.md. Tear down with `terraform destroy` as soon as benchmarks are done.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

variable "region"         { default = "us-east-1" }
variable "repo_url"       { description = "Git URL of this project (HTTPS, public or with token)" }
variable "jwt_secret"     { sensitive = true }
variable "gateway_count"  { default = 2 }
variable "instance_type"  { default = "t4g.small" }
variable "redis_node"     { default = "cache.t4g.micro" }
variable "dev_tokens"     { default = "false" } # "true" exposes /dev/token + enables the demo UI login. Demo only!

provider "aws" { region = var.region }

data "aws_vpc" "default" { default = true }
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
data "aws_ssm_parameter" "al2023" { name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" }

# ---- security groups
resource "aws_security_group" "gateway" {
  name_prefix = "wsbp-gw-"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    description = "WebSocket traffic via NLB (client IP preserved, so open to clients; tighten with your own CIDRs)"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "wsbp-redis-"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    description     = "Redis only from gateways"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.gateway.id]
  }
}

# ---- Redis backplane (ElastiCache). One node = cheapest; set num_cache_clusters=2 + automatic_failover_enabled for Multi-AZ.
resource "aws_elasticache_subnet_group" "this" {
  name       = "wsbp-redis"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "wsbp-redis"
  description                = "pub/sub + streams backplane"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node
  num_cache_clusters         = 1
  automatic_failover_enabled = false
  port                       = 6379
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
}

# ---- gateways
resource "aws_instance" "gateway" {
  count                       = var.gateway_count
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.instance_type
  subnet_id                   = element(data.aws_subnets.default.ids, count.index)
  vpc_security_group_ids      = [aws_security_group.gateway.id]
  associate_public_ip_address = true # needs outbound internet to clone + pull images (default VPC)
  tags                        = { Name = "wsbp-gw-${count.index + 1}" }

  user_data = <<-EOT
    #!/bin/bash
    set -eux
    dnf install -y docker git
    systemctl enable --now docker
    git clone ${var.repo_url} /opt/app
    cd /opt/app
    docker build -t wsbp .
    docker run -d --restart=always --name gw -p 8080:8080 \
      -e NODE_ID=gw-${count.index + 1} \
      -e JWT_SECRET='${var.jwt_secret}' \
      -e DEV_TOKENS=${var.dev_tokens} \
      -e REDIS_URL='rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379' \
      wsbp
  EOT
}

# ---- Network Load Balancer: plain L4. WebSocket upgrade passes straight through.
resource "aws_lb" "nlb" {
  name                             = "wsbp-nlb"
  load_balancer_type               = "network"
  subnets                          = data.aws_subnets.default.ids
  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "gw" {
  name                 = "wsbp-gw"
  port                 = 8080
  protocol             = "TCP"
  vpc_id               = data.aws_vpc.default.id
  deregistration_delay = 30 # gateways send {t:"reconnect"} on SIGTERM; clients resume elsewhere

  health_check {
    protocol            = "HTTP"
    path                = "/readyz" # 503 while draining or while Redis is unreachable -> NLB stops sending NEW connections
    port                = "8080"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_target_group_attachment" "gw" {
  count            = var.gateway_count
  target_group_arn = aws_lb_target_group.gw.arn
  target_id        = aws_instance.gateway[count.index].id
  port             = 8080
}

resource "aws_lb_listener" "tcp80" {
  load_balancer_arn = aws_lb.nlb.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gw.arn
  }
}

output "nlb_dns"       { value = aws_lb.nlb.dns_name }
output "ws_url"        { value = "ws://${aws_lb.nlb.dns_name}/ws" }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
