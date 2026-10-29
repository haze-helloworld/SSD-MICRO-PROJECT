# Running it for (almost) free, with an AWS-credits path

## Tiers — use the cheapest one that proves your point

| Tier | What | Cost | Use for |
|---|---|---|---|
| 0 | `docker compose up` (nginx → 3 gateways → Redis) | $0 | All development, all tests, all demo rehearsals |
| 0b | No Docker: `BACKPLANE=memory npm start` | $0 | Single-node fallback if Docker/Redis are unavailable on demo day |
| 1 | Local gateways + **managed free Redis**: Redis Cloud free (30 MB) or Upstash free. Set `REDIS_URL=rediss://…` | $0 | Showing it works against a real hosted Redis without paying for ElastiCache. Caveat: free plans cap throughput / commands, so don't run the benchmark suite there |
| 2 | **Real AWS** (`infra/aws`): NLB + 2×t4g.small + ElastiCache `cache.t4g.micro` | spends credits, roughly $0.07-0.10 per hour for the whole stack (*my estimate from memory — check the AWS pricing calculator for your region before applying*) | The "real primitives" run for the report: screenshots, one benchmark pass, one failover demo. **Then `terraform destroy`.** |

The NLB and ElastiCache are the two items billed by the hour even when idle — they are what you are renting the credits for. A 2-3 hour benchmark session is a few dollars; leaving it up for a month is not.

## Tier 2 runbook

```bash
cd infra/aws
terraform init
terraform plan  -var repo_url=https://github.com/<you>/ws-backplane.git -var jwt_secret=$(openssl rand -hex 24)
terraform apply -var repo_url=… -var jwt_secret=…   # ~10 min (ElastiCache is the slow part)
terraform output ws_url                              # ws://<nlb-dns>/ws

# benchmark FROM A SEPARATE small instance in the same region (or your laptop for a latency-realistic view)
npm run bench -- --target "$(terraform output -raw ws_url)" --scenario fanout --rooms 50 --clients 20 --rate 5 --secs 30
# token: the bench mints tokens with JWT_SECRET (export the same value)

# real failover demo: stop one gateway while a client is chatting
aws ec2 stop-instances --instance-ids <id>      # NLB health check marks it unhealthy; clients resume on the other node

terraform destroy …                              # DO THIS
```

Set a **AWS Budgets alert at $10 and $25** before you apply anything.

## Things only the real NLB teaches you (mention in the report)

* **NLB TCP idle timeout is 350 s.** Silent sockets get reset. The gateway sends WS pings every 15 s, so connections stay alive, and the heartbeat loop reaps peers that stop answering.
* **Health checks decide who gets *new* connections only.** Existing sockets on an unhealthy node are not moved — they break and clients resume. That's why `/readyz` returns 503 while draining or while Redis is unreachable, and why resume must be a first-class feature.
* **Cross-zone load balancing** is enabled in the Terraform for even spread; it adds inter-AZ data charges.
* NLB targets by *instance* preserve the client IP, so the gateway security group must allow client CIDRs (tighten it).
* ElastiCache with `transit_encryption_enabled` needs `rediss://` — the Terraform already does this; ioredis enables TLS from the scheme.
* **Persistence / failover caveat:** a single-node ElastiCache that restarts (or an async-replica failover that loses its last writes) can *rewind* the per-room `seq`. See HANDOVER → "known limitation: seq rewind".

## Fallback matrix (what to do when X is down)

| If this is unavailable… | Do this |
|---|---|
| AWS credits / account problem | Tier 0 compose + screenshots of earlier runs; fault tests run fully locally |
| ElastiCache | Redis Cloud / Upstash free via `REDIS_URL`, or the compose Redis |
| Any Redis at all | `BACKPLANE=memory` single node (guarantees hold within one process; cross-node demos won't work) |
| Docker | Run `npm start` in 3 terminals with different `PORT`s against a local `redis-server`, plus `nginx` or just point clients at different ports |
| Internet at the venue | Everything above runs offline |
