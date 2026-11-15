# SSD Micro Project: Distributed Chat Cluster & Backstage Observability

A high-performance **Secure Software Design (SSD) micro-project** featuring a **Discord-like chat interface** paired with an interactive **Backstage Systems Observability & Architecture Hub**, backed by an L4 Network Load Balancer, a Redis stream linearizer, and **AWS CloudWatch** telemetry integration.

## Key Features

1. **Discord-Style Chat Interface**:
   - Modern Discord-like dark mode theme with guild rail, text channels (`#general`, `#architecture`, `#production-alerts`, `#simulation-feed`), and active member list.
   - Real-time messages with atomic sequence tags (`seq #1`, `seq #2`...) proving per-room linearizability.
   - Typing indicators and built-in "Simulate Drop & Catchup" button to test zero-loss gap repair.

2. **Backstage Real-Time Architecture & Systems Dashboard**:
   - Dynamic interactive SVG request-flow diagram:
     `Client Fleet` ➔ `API Gateway (Ingress)` ➔ `Network Load Balancer (NLB)` ➔ `Gateway Nodes (gw-1, gw-2, gw-3)` ➔ `Redis Backplane` ➔ `AWS CloudWatch & Store`
   - Animated packet particles stream along conduits in real time as user or simulation requests flow.
   - Click on any architecture node to inspect its internal state, SSD design patterns, and fault-tolerance mechanics.

3. **Real-Time Traffic & Load Simulation Generator**:
   - Interactive control panel with sliders for **Concurrent Virtual Clients** (1 to 100) and **Request Rate** (1 to 50 req/sec).
   - Traffic patterns: **Steady Load**, **Traffic Surge Burst**, **High-Load DDoS Throttling (HTTP 429 / TokenBucket)**, and **Chaos Failover**.
   - Live metrics meters: Total requests, Successfully Delivered, Throttled, and Hop Latencies.

4. **AWS CloudWatch Integration (AWS Learner Lab $50 Credits)**:
   - Configurable from Backstage UI with AWS Access Key ID, Secret Key, Session Token (`voclabs`), and Region (`us-east-1`).
   - Streams custom metrics to the `SSDMicroProject/ChatCluster` CloudWatch namespace (`RequestsPerSec`, `ActiveConnections`, `DeliveryLatency`, `RateLimitedRequests`).
   - Includes graceful local fallback telemetry mode when offline or without active AWS credentials.

5. **Multi-Service & Cloud Health Grid**:
   - Real-time health, cost tier, and latency monitoring for AWS CloudWatch, Redis Streams, L4 Network Load Balancer, Stateful WebSocket Workers, and DynamoDB Audit Archive.

6. **View Modes**:
   - Top-bar switcher with **💬 Discord Chat**, **🎛️ Backstage Observability**, and **⚡ Split Screen (Side-by-Side)** mode.

## System Guarantees

| Guarantee | How |
|---|---|
| **Per-room total order (linearizable publish)** | One atomic Redis Lua script: dedupe → `INCR` seq → `XADD` log → `PUBLISH`. Redis is single-threaded, so the script is the linearization point. |
| **No loss / no duplicates across failures** | Pub/sub is at-most-once, so every message is *also* in a Redis Stream. Gateways repair seq gaps from the log; clients resume from `lastSeq`, dedupe by seq and retry sends with an idempotency key (`cid`). |
| **Fault tolerance** | Node crash, rolling restart, Redis link reset, Redis half-open link (blackhole), Redis latency — all injected in tests; delivery invariants hold. |
| **Multi-tenant security** | JWT with tenant claim, tenant-namespaced keys/channels, strict identifier validation, optional per-token room ACL, per-connection rate limit, per-tenant connection quota, payload caps, slow-consumer cut-off. |

```
 browsers / ResilientClient / Simulator
            │  ws://…/ws?token=JWT
            ▼
   ┌─────────────────┐  AWS: Network Load Balancer (TCP :80 → :8080, health: /readyz)
   │  L4 load balancer│  local: nginx (docker-compose) or tests/helpers/tcp-lb.ts
   └───┬─────┬─────┬─┘
       ▼     ▼     ▼
     gw-1  gw-2  gw-3      stateful: sockets + per-room lastSeq in memory, but disposable
       └─────┼─────┘
             ▼
   Redis  (pub/sub = fast path,  Stream = durable path,  ZSET = presence,  INCR = sequencer)
             ▼
   AWS CloudWatch (Learner Lab metrics namespace: SSDMicroProject/ChatCluster)
```

## Quick start

```bash
npm install
npm test                      # 15 tests, unit + observability + backplane
npm run test:integration      # needs redis-server on PATH (spawns its own)
npm run test:fault            # fault injection (node kill, Redis sever/blackhole/latency, rolling restart)
npm run bench                 # local benchmark suite -> bench/results/latest.md

# Run locally with zero dependencies (in-memory mode, ready for demos):
BACKPLANE=memory DEV_TOKENS=true npm start
# Open http://localhost:8080 in your browser!

# ...or run the full multi-node cluster with Docker:
docker compose up --build     # nginx -> 3 gateways -> redis
```

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) · [`docs/AWS-AND-COSTS.md`](docs/AWS-AND-COSTS.md) · [`docs/HANDOVER.md`](docs/HANDOVER.md)

## Deploying to Render with Learner Lab credentials

1. **Push to GitHub**: Push your commits to `main` on GitHub.
2. **Connect as Blueprint on Render**: In the Render Dashboard, select **New +** $\to$ **Blueprint** and pick this repository. Render automatically uses [`render.yaml`](render.yaml) and enables auto-deploy on push to `main`.
3. **Environment Variables**: Variables are provisioned automatically via `render.yaml` with generated secrets (`JWT_SECRET`, `AUTH_PASSWORD`). Set environment variables once with **NO AWS keys** — AWS credentials must never be baked into env vars, Docker images, or the repository.
4. **Enter AWS Credentials via UI**: After each AWS Academy Learner Lab session starts:
   - Open the deployed app URL.
   - Log in.
   - Click the **CloudWatch / AWS Credentials** status pill in the top header.
   - Paste the whole AWS CLI credentials block from Learner Lab (*AWS Details* $\to$ *Show*).
   - Set the region to `us-east-1` and provide your S3 bucket name (or leave blank for local fallback).
   - Click **Save & Connect**.

> **Important Deployment & Runtime Notes:**
> - **Free instance sleep:** Free Render web services sleep after ~15 minutes of inactivity. Open the URL a few minutes before a live demo to wake it up.
> - **Credential persistence:** Credentials survive restarts for up to 4 hours **only when `BACKPLANE=redis`** (stored encrypted in Redis with TTL). In in-memory mode (`BACKPLANE=memory`), credentials must be re-pasted in the UI pill after any restart.
> - **Security:** Keys and session tokens are never stored in environment variables or committed to the repository.


## Wire protocol (JSON text frames)

Client → server: `join {room,lastSeq?}` (idempotent; doubles as *resume*), `leave`, `msg {room,text,cid}`, `typing`, `ping`.
Server → client: `welcome`, `joined {head,from,truncated,members}`, `msg {room,seq,user,text,ts,cid}`, `ack {cid,seq,dup}`, `presence`, `members`, `typing`, `error {code}`, `reconnect`, `pong`.

Auth: `ws://host/ws?token=<JWT HS256 {sub, tid, rooms?}>`. Mint one: `npm run token -- alice acme general,random`.
Health: `/healthz` (liveness) · `/readyz` (503 when draining or Redis unreachable) · `/metrics` (JSON).
