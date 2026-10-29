# Architecture

## 1. What the raw primitives give you vs. what this layer adds

| Primitive | Raw behaviour | Gap this project closes |
|---|---|---|
| NLB (L4) | Spreads TCP flows. Knows nothing about rooms or users. A client lands on an arbitrary node and may land on a different one after any reconnect. | Make *which node you are on* irrelevant: state is rebuildable (resume from `lastSeq`). |
| Redis pub/sub | Fan-out in microseconds, but **at-most-once**: a subscriber that is disconnected for even 1 ms silently loses messages; no ordering across publishers, no history. | Add sequencing, a durable log, gap repair and idempotent publish. |
| Redis Streams / INCR / Lua | Durable ordered log, atomic server-side scripts. | Use them as the linearization point and replay source. |

## 2. Message path

1. Client sends `msg {room, text, cid}` to whichever gateway it is connected to.
2. Gateway checks: joined? size? rate limit? → calls `backplane.publish`.
3. **One Lua script, atomic in Redis** (`src/backplane/redis.ts`):
   `GET dedupe(cid)` → (hit: return old seq) → `INCR seq` → `XADD log <seq>-0` → `SET dedupe(cid)` → `PUBLISH`.
   Because the `PUBLISH` is inside the script that assigned `seq`, **pub/sub order = log order = seq order**.
4. Every gateway subscribed to that room receives the payload and runs it through the room's serial queue (`RoomState.run`):
   - `seq <= lastSeq` → duplicate, drop.
   - `seq == lastSeq+1` → fan out to local sockets.
   - `seq  > lastSeq+1` → **gap**: `XRANGE` the missing seqs from the log, deliver them first, then this one.
5. Sender gets `ack {seq}`; if the ack never arrives the client retransmits with the **same `cid`** → server answers `dup:true` with the original seq. At-least-once send + dedupe = exactly-once *effect*.

## 3. Why "stateful" and why that is OK

A gateway keeps, per room: the set of local sockets and `lastSeq` (the last seq delivered). That state is **a cache of information that lives durably elsewhere** (Redis log + each client's own `lastSeq`):

- node dies → its sockets break → clients reconnect (jittered backoff) via the NLB to any survivor → `join {lastSeq}` → server replays `lastSeq+1 … nodeHead` from the log, then live traffic continues with no seam (replay and "add to room" happen inside the same serialized section).
- Redis blips → gateway keeps sockets open, rejects publishes with `unavailable` (clients retry), `ioredis` reconnects + re-subscribes, `onUp` triggers a catch-up `XRANGE` for every room.
- Half-open Redis TCP (nothing errors, nothing arrives) → a watchdog `PING`s both links every 2 s and bounces a link that doesn't answer within 1.5 s; also bounces connections stuck mid-handshake.

## 4. Consistency choices (be ready to defend these)

* **CP for writes.** While Redis is unreachable a gateway **rejects** publishes instead of fan-out locally. Local-only fan-out would show different histories on different nodes and break the ordering guarantee. Reads/sockets stay up, so clients see a short pause and then everything arrives in order.
* **Linearizable publish, sequentially consistent delivery.** The order Redis assigns is a single total order per room (linearization point = the Lua script). All receivers see the *same* order. We do not claim bounded real-time staleness of delivery.
* **Rooms are independent.** No cross-room ordering. Keys carry a `{tenant:room}` hash tag so a room stays in one slot if you move to Redis Cluster / Enterprise.
* **Presence is eventually consistent.** `ZSET` with expiry scores, refreshed every 10 s by the gateway that owns the socket. A crashed node's users vanish after the TTL (tested, F6) and `members` frames are pushed by a periodic sync.

## 5. Multi-tenant security model

| Threat | Control |
|---|---|
| Unauthenticated connect | JWT (HS256) verified **during the HTTP upgrade**; failures get `401` and no WebSocket is allocated. |
| Tenant A reading tenant B | Tenant comes only from the verified token (never from the client frame); every key and channel is `{tenant:room}`-prefixed; identifiers must match `^[A-Za-z0-9_-]{1,32}$` so nobody can inject `:`/`{`/`*`/path characters into keys or channels. |
| Privilege inside a tenant | Optional `rooms` claim = allow-list (`["general"]` or `["*"]`). |
| Flooding | Token bucket per connection (default 20 msg/s, burst 40), 2000-char text cap, 8 KB frame cap, `maxConnsPerTenant` per node. |
| Slow/stuck client | If `ws.bufferedAmount` exceeds 1 MB the socket is closed (`1013`) instead of ballooning node memory. |
| Replay of a user's message | `cid` idempotency keys are scoped per room (hash-tagged), TTL 5 min. |

Known gaps (deliberate, list them in the report): HS256 shared secret (use RS256/JWKS in production), token in query string (fine for a demo; use first-frame auth or a short-lived ticket in production), no per-tenant rate limit across nodes, no TLS termination in this repo (put it on the NLB with ACM, or CloudFront).

## 6. Components

| File | Role |
|---|---|
| `src/gateway.ts` | HTTP + WS server, auth, rooms, delivery pipeline, presence loop, heartbeats, graceful drain |
| `src/backplane/index.ts` | `Backplane` interface — the seam between gateway logic and the store |
| `src/backplane/redis.ts` | Redis implementation: Lua publish, Streams, presence, reconnect + watchdog |
| `src/backplane/memory.ts` | In-process implementation + outage/loss simulation (unit tests, zero-dependency fallback) |
| `src/client.ts` | `ResilientClient`: ordering, dedupe, resume, retry with idempotency keys |
| `tests/helpers/fault-proxy.ts` | TCP chaos proxy (sever / blackhole / latency) |
| `tests/helpers/tcp-lb.ts` | Local L4 LB standing in for the NLB |
| `public/index.html` | Discord-style demo UI (same resume logic in ~100 lines of JS) |
