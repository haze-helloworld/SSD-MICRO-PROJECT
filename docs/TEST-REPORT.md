# Test & benchmark report

Environment of these runs: authoring sandbox — **1 vCPU, 4 GB RAM, Node 22, Redis 7.0.15 on localhost**, load generator, 1-3 gateways, the LB and Redis **all sharing that one core**. Treat the numbers as a correctness baseline, **not** as capacity figures (see caveats). Re-run on your machine / AWS and replace the table.

## Functional + fault results

| Suite | Command | Result |
|---|---|---|
| Unit / in-process (memory backplane, multi-node simulation) | `npm test` | **14 / 14 pass** |
| Integration (3 gateway processes + real Redis + L4 LB) | `npm run test:integration` | **5 / 5 pass** |
| Fault injection (real processes, chaos proxy in front of Redis) | `npm run test:fault` | **6 / 6 pass** |

Acceptance criteria used for every fault scenario (3 senders × 100 msgs, 4 receivers, fault injected ~300 ms in):
1. every `send()` is eventually acked (no lost writes);
2. every receiver sees seq 1..300 **exactly once, in order**, with identical text order at all receivers.

| # | Fault | Observed |
|---|---|---|
| F1 | Redis link reset for 2 s (RST + refuse) | invariants hold; no client reconnects needed (sockets to gateways stay up) |
| F2 | Redis link **blackholed** 3 s (half-open) | invariants hold; watchdog bounced the dead links |
| F3 | +120 ms latency on gateway↔Redis | invariants hold; gaps detected and repaired from the log |
| F4 | One gateway **SIGKILL**ed mid-stream | invariants hold; 3 clients reconnected to survivors and resumed |
| F5 | Rolling restart of all 3 gateways (SIGTERM → drain) | invariants hold; 12 client reconnects, zero loss |
| F6 | Node crash: ghost users on dead node | removed from the member list within the presence TTL |

Other covered behaviour: JWT rejection (missing/forged/expired → 401), tenant isolation (unit + real Redis), room ACL claim, rate limiting, oversize/malformed frames, idempotent publish (same node and across nodes), history on join + resume across nodes, lost pub/sub deliveries repaired from the log, full backplane outage with retry + catch-up, slow-consumer cut-off, presence join/leave.

### A bug the tests caught in the *test harness* (worth a sentence in the report)
The first F3 run failed: the chaos proxy reordered bytes when latency was switched off (a naive `setTimeout` per chunk), which corrupts the Redis protocol stream — something real TCP never does. Fixed by giving each direction a monotonic release clock. The gateway code was not at fault.

## Benchmarks (local, 10 s per scenario)

| scenario | nodes | conns | publish/s | deliveries/s | e2e p50 | p95 | p99 | ack p95 | errors | divergent rooms | max stall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 scale: 1 node | 1 | 200 | 200 | 1972 | 5 ms | 29.4 ms | 57 ms | 32.5 ms | 0 | 0 | -  |
| S2 scale: 3 nodes | 3 | 200 | 200 | 1961 | 9.9 ms | 41 ms | 80.3 ms | 36.8 ms | 0 | 0 | -  |
| S3 fan-out: 3 nodes, 1000 conns | 3 | 1000 | 250 | 4787 | 71.8 ms | 230.1 ms | 274.6 ms | 230.2 ms | 0 | 0 | -  |
| S4 failover: kill 1 of 3 under load | 3 | 200 | 200 | 1967 | 8.9 ms | 43.9 ms | 73.7 ms | 44 ms | 0 | 0 | 488 ms |

Reading it:
* **0 send errors, 0 divergent rooms** in every scenario: every receiver in a room ended on the same last seq.
* **S1 vs S2:** 3 nodes looks *slower* than 1 node here only because 3 gateways + the load generator + Redis fight over one core. Horizontal scaling can only be demonstrated with separate CPUs (AWS run, or a multi-core laptop).
* **S3:** 1000 sockets, ~4.8k deliveries/s on one core; p99 ≈ 275 ms is the saturated generator, not the design.
* **S4:** gateway killed under load (publishing never stopped): zero errors, zero divergence, longest delivery stall at a receiver ≈ 0.5 s (reconnect backoff + resume).

### Caveats to state honestly in the write-up
* Single-core sandbox; generator and system under test share CPU.
* Latency is measured inside one process (no clock skew) but includes the generator's own event-loop delay.
* The Terraform/NLB path and the Docker compose path were **not** executed in the authoring environment (no AWS, no Docker there); the local TCP LB and local Redis stand in for them. Run Tier 2 once and add screenshots + a benchmark table from it.
