| scenario | nodes | conns | publish/s | deliveries/s | e2e p50 | p95 | p99 | ack p95 | errors | divergent rooms | max stall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 scale: 1 node | 1 | 200 | 200 | 1972 | 5 ms | 29.4 ms | 57 ms | 32.5 ms | 0 | 0 | -  |
| S2 scale: 3 nodes | 3 | 200 | 200 | 1961 | 9.9 ms | 41 ms | 80.3 ms | 36.8 ms | 0 | 0 | -  |
| S3 fan-out: 3 nodes, 1000 conns | 3 | 1000 | 250 | 4787 | 71.8 ms | 230.1 ms | 274.6 ms | 230.2 ms | 0 | 0 | -  |
| S4 failover: kill 1 of 3 under load | 3 | 200 | 200 | 1967 | 8.9 ms | 43.9 ms | 73.7 ms | 44 ms | 0 | 0 | 488 ms |
