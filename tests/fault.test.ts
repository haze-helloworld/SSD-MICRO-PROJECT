/**
 * FAULT INJECTION against real processes. For every scenario the acceptance criteria are the same:
 *   (1) every send is eventually acked           -> no lost writes
 *   (2) every receiver sees seq 1..N exactly once, in order -> no loss, no duplicates, no reordering
 * Scenarios: Redis link severed, Redis link blackholed (half-open), Redis latency, gateway SIGKILL, rolling restart.
 *   npm run test:fault
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ResilientClient } from '../src/client.js';
import type { StoredMsg } from '../src/types.js';
import { mkClient, redisAvailable, sleep, startNode, startRedis, type NodeProc, type RedisProc } from './helpers/cluster.js';
import { FaultProxy } from './helpers/fault-proxy.js';
import { TcpLb } from './helpers/tcp-lb.js';

const skip = !redisAvailable();
const ROOM = 'chaos';
const SENDERS = 3;
const PER_SENDER = 100;
const N = SENDERS * PER_SENDER;

describe('fault injection', { skip: skip && 'redis-server not installed' }, () => {
  let redis: RedisProc;
  let proxy: FaultProxy;
  let nodes: NodeProc[];
  let lb: TcpLb;
  const clients: ResilientClient[] = [];

  beforeEach(async () => {
    redis = await startRedis();
    proxy = await new FaultProxy(redis.port).start();
    nodes = await Promise.all([1, 2, 3].map((i) => startNode(`n${i}`, `redis://127.0.0.1:${proxy.port}`)));
    lb = await new TcpLb(nodes.map((n) => n.port)).start();
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await lb.stop();
    await Promise.all(nodes.map((n) => n.kill().catch(() => undefined)));
    await proxy.stop();
    await redis.stop();
  });

  /** Runs the workload, calls `fault()` shortly after it starts, and asserts the delivery invariants. */
  async function run(fault: () => Promise<void>) {
    const senders = Array.from({ length: SENDERS }, (_, i) => mkClient(lb.port, `s${i}`, [ROOM]));
    const receivers = Array.from({ length: 4 }, (_, i) => mkClient(lb.port, `r${i}`, [ROOM]));
    clients.push(...senders, ...receivers);
    await Promise.all(clients.map((c) => c.connect()));
    const logs = receivers.map((r) => {
      const l: StoredMsg[] = [];
      r.on('msg', (m: StoredMsg) => l.push(m));
      return l;
    });

    const t0 = Date.now();
    const work = Promise.all(
      senders.map(async (s, si) => {
        for (let i = 0; i < PER_SENDER; i++) {
          await s.send(ROOM, `s${si}-${i}`);
          await sleep(8);
        }
      }),
    );
    await sleep(300);
    await fault();
    await work; // (1) every send acked
    await Promise.all(receivers.map((r) => r.waitFor(() => r.lastSeq(ROOM) === N, 25_000)));
    const elapsed = Date.now() - t0;

    for (const l of logs) {
      assert.equal(l.length, N, 'receiver message count');
      assert.deepEqual(l.map((m) => m.seq), Array.from({ length: N }, (_, i) => i + 1), 'gap-free, in order, no duplicates');
      assert.equal(new Set(l.map((m) => m.text)).size, N, 'no message lost or duplicated at the application level');
      assert.deepEqual(l.map((m) => m.text), logs[0].map((m) => m.text), 'all receivers saw identical order');
    }
    return { elapsed, reconnects: clients.reduce((a, c) => a + c.reconnects, 0), gaps: clients.reduce((a, c) => a + c.gaps, 0) };
  }

  it('F1  Redis connection severed for 2s (RST on every link, refused while down)', async () => {
    const r = await run(async () => {
      proxy.sever();
      await sleep(2000);
      proxy.heal();
    });
    console.log('F1', r);
  });

  it('F2  Redis link BLACKHOLED for 3s (half-open: sockets stay up, bytes vanish) - watchdog must detect and heal', async () => {
    const r = await run(async () => {
      proxy.blackhole(true);
      await sleep(3000);
      proxy.heal();
    });
    console.log('F2', r);
  });

  it('F3  +120ms latency on the backplane path (cross-AZ-ish) - ordering and delivery unaffected', async () => {
    const r = await run(async () => {
      proxy.latency(120);
      await sleep(1500);
      proxy.latency(0);
    });
    console.log('F3', r);
  });

  it('F4  gateway node SIGKILLed mid-stream (its sockets die; LB sends reconnects to survivors)', async () => {
    const r = await run(async () => {
      const victim = nodes[0];
      lb.remove(victim.port); // NLB health check pulls the target
      await victim.kill('SIGKILL');
    });
    console.log('F4', r);
    assert.ok(r.reconnects >= 1, 'at least one client had to reconnect');
  });

  it('F5  rolling restart of all gateways (SIGTERM -> graceful drain -> replacement joins)', async () => {
    const r = await run(async () => {
      for (let i = 0; i < nodes.length; i++) {
        const old = nodes[i];
        lb.remove(old.port);
        await old.kill('SIGTERM');
        const fresh = await startNode(`n${i + 1}b`, `redis://127.0.0.1:${proxy.port}`);
        nodes[i] = fresh;
        lb.add(fresh.port);
      }
    });
    console.log('F5', r);
  });

  it('F6  presence heals after a node crash: dead node\'s users disappear within the TTL', async () => {
    const alive = mkClient(lb.port, 'survivor', [ROOM]);
    clients.push(alive);
    let members: string[] = [];
    alive.on('members', (_r: string, m: string[]) => (members = m));
    await alive.connect();
    // park ghost users on a specific node by connecting directly (bypassing the LB)
    const victim = nodes.find((n) => n.id !== alive.node)!;
    const { signToken } = await import('../src/auth.js');
    const { SECRET } = await import('./helpers/cluster.js');
    const { ResilientClient } = await import('../src/client.js');
    const ghosts = ['ghost1', 'ghost2'].map(
      (u) => new ResilientClient({ urls: [`ws://127.0.0.1:${victim.port}/ws`], token: signToken(SECRET, { user: u, tenant: 't1' }), rooms: [ROOM] }),
    );
    await Promise.all(ghosts.map((g) => g.connect()));
    await sleep(1200);
    assert.ok(members.includes('ghost1'), `ghosts should be visible, got ${members}`);
    lb.remove(victim.port);
    await victim.kill('SIGKILL'); // no clean 'leave' ever published
    ghosts.forEach((g) => g.close());
    await alive.waitFor(() => !members.includes('ghost1') && !members.includes('ghost2'), 8000);
    assert.deepEqual(members, ['survivor']);
  });
});
