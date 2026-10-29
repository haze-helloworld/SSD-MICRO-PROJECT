/**
 * Benchmarks: end-to-end fan-out latency / throughput, horizontal scaling, and failover stall.
 *
 *   npm run bench                                   # local: spawns Redis + gateways + TCP LB, runs all scenarios
 *   npm run bench -- --scenario fanout --nodes 3 --rooms 50 --clients 20 --rate 5 --secs 20
 *   npm run bench -- --target ws://<nlb-dns>:80/ws --scenario fanout   # against a deployed stack (AWS NLB)
 *   REDIS_URL=rediss://... npm run bench            # local gateways, remote Redis (ElastiCache / Upstash / Redis Cloud)
 *
 * Latency = (receiver clock - sender clock) inside ONE load-generator process, so there is no clock skew.
 * Run the generator on a separate box for real numbers: it is a Node process and will saturate a core around ~10-20k msgs/s.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ResilientClient } from '../src/client.js';
import type { StoredMsg } from '../src/types.js';
import { mkClient, startNode, startRedis, sleep, type NodeProc } from '../tests/helpers/cluster.js';
import { TcpLb } from '../tests/helpers/tcp-lb.js';
import { signToken } from '../src/auth.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []),
);
const SECRET = process.env.JWT_SECRET || 'test-secret';

interface Cfg {
  name: string;
  nodes: number;
  rooms: number;
  clients: number; // per room
  rate: number; // msgs/sec per room (1 sender per room)
  secs: number;
}
const pct = (a: number[], p: number) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Env {
  lb: { port: number };
  nodes: NodeProc[];
  target?: string;
  stop(): Promise<void>;
  tokenFor(user: string): string;
}

async function setup(nodes: number): Promise<Env> {
  if (args.target) {
    return { lb: { port: 0 }, nodes: [], target: String(args.target), stop: async () => undefined, tokenFor: (u) => signToken(SECRET, { user: u, tenant: 'bench' }) };
  }
  const external = process.env.REDIS_URL;
  const redis = external ? null : await startRedis();
  const url = external ?? `redis://127.0.0.1:${redis!.port}`;
  const ns = await Promise.all(Array.from({ length: nodes }, (_, i) => startNode(`b${i + 1}`, url)));
  const lb = await new TcpLb(ns.map((n) => n.port)).start();
  return {
    lb,
    nodes: ns,
    stop: async () => {
      await lb.stop();
      await Promise.all(ns.map((n) => n.kill()));
      await redis?.stop();
    },
    tokenFor: (u) => signToken(SECRET, { user: u, tenant: 'bench' }),
  };
}

function mk(env: Env, user: string, room: string): ResilientClient {
  const urls = [env.target ?? `ws://127.0.0.1:${env.lb.port}/ws`];
  return new ResilientClient({ urls, token: env.tokenFor(user), rooms: [room], sendDeadlineMs: 20_000 });
}

async function scenario(cfg: Cfg, failover = false) {
  const env = await setup(cfg.nodes);
  const clients: ResilientClient[] = [];
  const e2e: number[] = [];
  const ack: number[] = [];
  let deliveries = 0;
  let published = 0;
  let acked = 0;
  let sendErrors = 0;
  const lastArrival = new Map<ResilientClient, number>();
  let maxStall = 0;
  const stalls: number[] = [];

  // connect in batches to avoid a SYN storm in a single process
  const all: Array<{ c: ResilientClient; room: string; sender: boolean }> = [];
  for (let r = 0; r < cfg.rooms; r++) for (let i = 0; i < cfg.clients; i++) all.push({ c: mk(env, `u${r}_${i}`, `room${r}`), room: `room${r}`, sender: i === 0 });
  for (let i = 0; i < all.length; i += 100) {
    await Promise.all(all.slice(i, i + 100).map((x) => x.c.connect()));
  }
  all.forEach((x) => clients.push(x.c));

  let measuring = false;
  for (const { c } of all) {
    c.on('msg', (m: StoredMsg) => {
      if (!measuring) return;
      const t = Number(m.text);
      if (!Number.isFinite(t)) return;
      deliveries++;
      e2e.push(performance.now() - t);
      const now = performance.now();
      const prev = lastArrival.get(c);
      if (prev !== undefined) {
        const gap = now - prev;
        // a receiver in a room gets cfg.rate msgs/sec, so anything beyond ~3x the nominal period is a stall
        if (gap > (3000 / cfg.rate)) stalls.push(gap);
        maxStall = Math.max(maxStall, gap);
      }
      lastArrival.set(c, now);
    });
  }

  await sleep(500);
  measuring = true;
  const t0 = performance.now();
  const timers = all
    .filter((x) => x.sender)
    .map((x) =>
      setInterval(() => {
        const t = performance.now();
        published++;
        x.c.send(x.room, String(t)).then(
          () => (acked++, ack.push(performance.now() - t)),
          () => sendErrors++,
        );
      }, 1000 / cfg.rate),
    );

  let killedAt = 0;
  if (failover && env.nodes.length > 1) {
    await sleep((cfg.secs * 1000) / 3);
    killedAt = performance.now() - t0;
    env.nodes[0] && (env.lb as TcpLb).remove(env.nodes[0].port);
    await env.nodes[0].kill('SIGKILL');
    await sleep((cfg.secs * 1000 * 2) / 3);
  } else {
    await sleep(cfg.secs * 1000);
  }
  timers.forEach(clearInterval);
  await sleep(1500); // drain
  measuring = false;
  const elapsed = (performance.now() - t0 - 1500) / 1000;

  // integrity check: every receiver has exactly the same last seq per room (no holes)
  const byRoom = new Map<string, Set<number>>();
  for (const { c, room } of all) (byRoom.get(room) ?? byRoom.set(room, new Set()).get(room)!).add(c.lastSeq(room));
  const divergent = [...byRoom.values()].filter((s) => s.size > 1).length;

  clients.forEach((c) => c.close());
  await env.stop();

  return {
    name: cfg.name,
    nodes: cfg.nodes,
    connections: all.length,
    rooms: cfg.rooms,
    publishRatePerSec: cfg.rooms * cfg.rate,
    published,
    acked,
    sendErrors,
    deliveries,
    deliveriesPerSec: Math.round(deliveries / elapsed),
    e2eMs: { p50: r1(pct(e2e, 50)), p95: r1(pct(e2e, 95)), p99: r1(pct(e2e, 99)), max: r1(Math.max(0, ...e2e.slice(0, 1e6))) },
    ackMs: { p50: r1(pct(ack, 50)), p95: r1(pct(ack, 95)), p99: r1(pct(ack, 99)) },
    divergentRooms: divergent,
    ...(failover ? { killedAtSec: r1(killedAt / 1000), maxStallMs: Math.round(maxStall), stallsOver3Periods: stalls.length, p95StallMs: Math.round(pct(stalls, 95)) } : {}),
  };
}

const which = String(args.scenario ?? 'all');
const secs = Number(args.secs ?? 15);
const custom: Cfg | null = args.rooms
  ? { name: 'custom', nodes: Number(args.nodes ?? 3), rooms: Number(args.rooms), clients: Number(args.clients ?? 10), rate: Number(args.rate ?? 5), secs }
  : null;

const plan: Array<{ cfg: Cfg; failover?: boolean }> = custom
  ? [{ cfg: custom, failover: which === 'failover' }]
  : [
      { cfg: { name: 'S1 scale: 1 node', nodes: 1, rooms: 20, clients: 10, rate: 10, secs } },
      { cfg: { name: 'S2 scale: 3 nodes', nodes: 3, rooms: 20, clients: 10, rate: 10, secs } },
      { cfg: { name: 'S3 fan-out: 3 nodes, 1000 conns', nodes: 3, rooms: 50, clients: 20, rate: 5, secs } },
      { cfg: { name: 'S4 failover: kill 1 of 3 under load', nodes: 3, rooms: 20, clients: 10, rate: 10, secs: Math.max(secs, 15) }, failover: true },
    ].filter((p) => which === 'all' || p.cfg.name.toLowerCase().includes(which));

const results = [];
for (const p of plan) {
  process.stderr.write(`\n>>> ${p.cfg.name}\n`);
  const r = await scenario(p.cfg, p.failover);
  console.log(JSON.stringify(r));
  results.push(r);
}

mkdirSync('bench/results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`bench/results/${stamp}.json`, JSON.stringify(results, null, 2));
const md = [
  '| scenario | nodes | conns | publish/s | deliveries/s | e2e p50 | p95 | p99 | ack p95 | errors | divergent rooms | max stall |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.map(
    (r: any) =>
      `| ${r.name} | ${r.nodes} | ${r.connections} | ${r.publishRatePerSec} | ${r.deliveriesPerSec} | ${r.e2eMs.p50} ms | ${r.e2eMs.p95} ms | ${r.e2eMs.p99} ms | ${r.ackMs.p95} ms | ${r.sendErrors} | ${r.divergentRooms} | ${r.maxStallMs ?? '-'} ${r.maxStallMs ? 'ms' : ''} |`,
  ),
].join('\n');
writeFileSync('bench/results/latest.md', md + '\n');
console.log('\n' + md);
process.exit(0);
