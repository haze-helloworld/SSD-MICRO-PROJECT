/**
 * Integration tests against a REAL Redis (spawned locally) and 3 real gateway processes behind a TCP load balancer
 * (local stand-in for the NLB).   Requires `redis-server` on PATH.   npm run test:integration
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { signToken } from '../src/auth.js';
import type { StoredMsg } from '../src/types.js';
import { mkClient, redisAvailable, sleep, SECRET, startNode, startRedis, type NodeProc, type RedisProc } from './helpers/cluster.js';
import { TcpLb } from './helpers/tcp-lb.js';

const skip = !redisAvailable();
describe('integration: 3 gateways + Redis backplane behind L4 LB', { skip: skip && 'redis-server not installed' }, () => {
  let redis: RedisProc;
  let nodes: NodeProc[] = [];
  let lb: TcpLb;

  before(async () => {
    redis = await startRedis();
    nodes = await Promise.all([1, 2, 3].map((i) => startNode(`n${i}`, `redis://127.0.0.1:${redis.port}`)));
    lb = await new TcpLb(nodes.map((n) => n.port)).start();
  });
  after(async () => {
    await lb?.stop();
    await Promise.all(nodes.map((n) => n.kill()));
    await redis?.stop();
  });

  const collect = (c: ReturnType<typeof mkClient>) => {
    const got: StoredMsg[] = [];
    c.on('msg', (m: StoredMsg) => got.push(m));
    return got;
  };

  it('LB spreads connections over all gateway nodes (stateful cluster)', async () => {
    const cs = Array.from({ length: 9 }, (_, i) => mkClient(lb.port, `u${i}`, ['spread']));
    await Promise.all(cs.map((c) => c.connect()));
    const seen = new Set(cs.map((c) => c.node));
    cs.forEach((c) => c.close());
    assert.equal(seen.size, 3);
  });

  it('Lua publish is the linearization point: 400 concurrent sends => seqs exactly 1..400 at every receiver', async () => {
    const senders = Array.from({ length: 8 }, (_, i) => mkClient(lb.port, `s${i}`, ['atomic']));
    const rx = Array.from({ length: 3 }, (_, i) => mkClient(lb.port, `r${i}`, ['atomic']));
    await Promise.all([...senders, ...rx].map((c) => c.connect()));
    const logs = rx.map(collect);
    await Promise.all(senders.flatMap((s, si) => Array.from({ length: 50 }, (_, i) => s.send('atomic', `s${si}-${i}`))));
    await Promise.all(rx.map((c) => c.waitFor(() => c.lastSeq('atomic') === 400, 5000)));
    for (const l of logs) {
      assert.deepEqual(l.map((m) => m.seq), Array.from({ length: 400 }, (_, i) => i + 1));
      assert.equal(new Set(l.map((m) => m.text)).size, 400);
      assert.deepEqual(l.map((m) => m.text), logs[0].map((m) => m.text));
    }
    [...senders, ...rx].forEach((c) => c.close());
  });

  it('idempotency key survives across nodes (retry through a different gateway is a no-op)', async () => {
    const tok = signToken(SECRET, { user: 'dup', tenant: 't1' });
    const open = (port: number) =>
      new Promise<{ ws: WebSocket; frames: any[] }>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
        const frames: any[] = [];
        ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
        ws.on('open', () => (ws.send(JSON.stringify({ t: 'join', room: 'idem' })), setTimeout(() => res({ ws, frames }), 150)));
      });
    const a = await open(nodes[0].port);
    const b = await open(nodes[1].port);
    a.ws.send(JSON.stringify({ t: 'msg', room: 'idem', text: 'pay $5', cid: 'order-77' }));
    await sleep(100);
    b.ws.send(JSON.stringify({ t: 'msg', room: 'idem', text: 'pay $5', cid: 'order-77' }));
    await sleep(200);
    const ackA = a.frames.find((f) => f.t === 'ack');
    const ackB = b.frames.find((f) => f.t === 'ack');
    assert.equal(ackA.dup, false);
    assert.equal(ackB.dup, true);
    assert.equal(ackA.seq, ackB.seq);
    assert.equal(a.frames.filter((f) => f.t === 'msg').length, 1);
    a.ws.close();
    b.ws.close();
  });

  it('tenant isolation holds on the shared Redis (keys & channels namespaced per tenant)', async () => {
    const acme = mkClient(lb.port, 'alice', ['general'], 'acme');
    const globex = mkClient(lb.port, 'bob', ['general'], 'globex');
    await Promise.all([acme.connect(), globex.connect()]);
    const g = collect(globex);
    const a = collect(acme);
    await acme.send('general', 'acme secret');
    await sleep(200);
    assert.equal(g.length, 0);
    assert.equal(a.length, 1);
    acme.close();
    globex.close();
  });

  it('history/resume works when the client lands on a different node', async () => {
    const tx = mkClient(lb.port, 'tx', ['resume']);
    await tx.connect();
    for (let i = 1; i <= 20; i++) await tx.send('resume', `m${i}`);
    const rx = mkClient(lb.port, 'rx', ['resume']);
    const got = collect(rx);
    await rx.connect();
    await sleep(150);
    assert.equal(got.length, 20);
    rx.kill();
    for (let i = 21; i <= 30; i++) await tx.send('resume', `m${i}`);
    await rx.waitFor(() => rx.lastSeq('resume') === 30, 5000);
    assert.deepEqual(got.map((m) => m.seq), Array.from({ length: 30 }, (_, i) => i + 1));
    tx.close();
    rx.close();
  });
});
