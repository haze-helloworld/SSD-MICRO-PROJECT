# Handover context (read this first, or paste the block at the bottom into a new chat)

## State of the project
Everything below is implemented and was run in the authoring environment unless marked ⚠.

| Area | Status |
|---|---|
| Gateway (auth, rooms, ordering, gap repair, presence, drain, rate limit, quotas, slow consumer) | ✅ done, tested |
| Redis backplane (Lua publish, Streams log, presence ZSET, reconnect, half-open watchdog) | ✅ done, tested on Redis 7.0 |
| Memory backplane (fallback + test double with outage/loss simulation) | ✅ |
| ResilientClient + browser UI | ✅ client tested; ⚠ browser UI only syntax-checked + endpoints smoke-tested, never opened in a real browser |
| Tests: 14 unit, 5 integration, 6 fault injection | ✅ all pass |
| Benchmarks | ✅ local numbers only (1 vCPU sandbox) |
| docker-compose + nginx | ⚠ written, never run (no Docker in sandbox) |
| Terraform (NLB + EC2 + ElastiCache) | ⚠ written from provider docs, never planned/applied |

## How to run
`npm install && npm test` → then see README. Redis tests need `redis-server` on PATH (`brew/apt install redis`).

## Design decisions you will be asked about
1. **Why Lua?** Sequencing, log append and fan-out must be one atomic step, otherwise pub/sub order can differ from log order and gap repair becomes ambiguous.
2. **Why both pub/sub and Streams?** Pub/sub = latency, Streams = durability/replay. Either alone fails the guarantee set.
3. **Why reject writes when Redis is down (CP)?** Local-only fan-out forks the room history across nodes.
4. **Why is a stateful gateway acceptable?** Its state is a cache; clients carry `lastSeq`, Redis carries the log → any node can serve any client after a resume.
5. **Why `cid` idempotency?** The only safe way to retry a publish whose ack was lost.
6. **Linearizability claim, precisely:** publish is linearizable per room at the Redis script; delivery is a single total order seen identically by all receivers (sequential consistency per room), not real-time bounded.

## Known limitation: seq rewind  (best "future work" item — or implement it)
`seq` lives in Redis. If Redis loses data (restart without persistence, or failover to a replica that missed the last writes), the counter can go backwards; clients ignore `seq <= lastSeq`, so they would **drop new messages** until seq passes their old value. Fix: store a random `epoch` in Redis (`SETNX {t:r}:epoch`), include it in `joined` and every `msg`; when a client sees a new epoch it resets `lastSeq`. ~40 lines in `redis.ts`, `gateway.ts`, `client.ts` + one fault test (`FLUSHALL` mid-stream). Mitigation without code: ElastiCache Multi-AZ with replicas, Redis AOF.

## Other TODO / polish ideas (rough priority)
1. Run Tier 2 on AWS once → screenshots (NLB targets healthy, ElastiCache), a benchmark table with the generator on a separate instance, and a real failover demo (stop an instance).
2. Open the UI in two browser tabs; click "Simulate connection drop"; screen-record it for the demo.
3. Architecture + sequence diagrams for the report (message path, failover path, gap repair). The ASCII in README/ARCHITECTURE is the source.
4. Prometheus `/metrics` format (currently JSON) + a Grafana screenshot if time allows.
5. Epoch fix above; per-tenant cross-node quotas; RS256/JWKS auth; first-frame auth instead of query token.
6. Compare against a "naive" baseline (pub/sub only, no seq/log) with the same fault tests to *show* the guarantees matter — easy: add a `NaiveBackplane` and run `fault.test.ts`; it should lose messages in F1/F2/F4.

## Suggested 5-minute demo
1. `docker compose up`; two browser tabs, different usernames, same server+channel → chat.
2. Header shows "online via gw2" vs "gw3" → cross-node delivery.
3. `docker stop <gw>` (or "Simulate connection drop") while typing → reconnects, resumes, no gaps (#seq numbers contiguous).
4. `npm run test:fault` on screen → show F1-F6 green.
5. Show `bench/results/latest.md`.

## Paste-into-new-chat context block
```
Project: ws-backplane — "Stateful WebSocket server cluster with broadcast pub/sub backplane", college System Design micro project.
Primitives: Network Load Balancer + Redis (ElastiCache / Redis Enterprise). Layer built: stateful WS gateway cluster with guarantees:
per-room total order, no loss/dup across failures, fault tolerance, multi-tenant security. Case app: mini Discord.
Stack: Node 22 + TypeScript (tsx), ws, ioredis, jsonwebtoken, node:test. Cost constraint: free/cheap, $50 AWS credits, fallbacks required.
Done: gateway, Redis + memory backplanes (atomic Lua publish: dedupe+INCR seq+XADD log+PUBLISH), ResilientClient (resume from lastSeq, dedupe, idempotent retry),
browser UI, 14 unit + 5 integration + 6 fault-injection tests (all passing), local benchmark suite, docker-compose+nginx, Terraform (untested), docs/.
Not done / unverified: Terraform apply, docker compose run, browser UI in real browser, AWS benchmark numbers, seq-epoch fix (see docs/HANDOVER.md).
Repo layout: src/{gateway,client,auth,config}.ts, src/backplane/{index,redis,memory}.ts, tests/{unit,integration,fault}.test.ts + tests/helpers, bench/bench.ts, infra/aws/main.tf, docs/.
```
