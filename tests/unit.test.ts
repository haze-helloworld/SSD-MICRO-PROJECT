/**
 * Unit / in-process tests. Several Gateway instances share one MemoryHub => behaves like a cluster sharing a backplane.
 * No Redis, no Docker needed:  npm test
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { signToken } from '../src/auth.js';
import { MemoryBackplane, MemoryHub } from '../src/backplane/memory.js';
import { ResilientClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { TokenBucket } from '../src/ratelimit.js';
import type { StoredMsg } from '../src/types.js';

process.env.LOG_LEVEL = 'silent';
const SECRET = 's3cret';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});

async function cluster(n: number, cfg: Partial<ReturnType<typeof loadConfig>> = {}) {
  const hub = new MemoryHub();
  const gws: Gateway[] = [];
  for (let i = 0; i < n; i++) {
    const g = new Gateway(
      loadConfig({ port: 0, nodeId: `n${i}`, jwtSecret: SECRET, presenceRefreshMs: 200, heartbeatMs: 5000, rateBurst: 1e6, rateRefillPerSec: 1e6, ...cfg }, {}),
      new MemoryBackplane(hub),
    );
    await g.start();
    gws.push(g);
    cleanup.push(() => g.stop(0));
  }
  return { hub, gws };
}
const url = (g: Gateway) => `ws://127.0.0.1:${g.port}/ws`;
const tok = (user: string, tenant = 't1', rooms?: string[]) => signToken(SECRET, { user, tenant, rooms });
function client(g: Gateway, user: string, rooms: string[], tenant = 't1', allowed?: string[]) {
  const c = new ResilientClient({ urls: [url(g)], token: tok(user, tenant, allowed), rooms });
  cleanup.push(() => c.close());
  return c;
}
function collect(c: ResilientClient) {
  const got: StoredMsg[] = [];
  c.on('msg', (m: StoredMsg) => got.push(m));
  return got;
}
function rawWs(g: Gateway, token: string): Promise<{ ws: WebSocket; frames: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url(g)}?token=${token}`);
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    cleanup.push(() => ws.terminate());
  });
}

describe('token bucket', () => {
  it('allows burst then throttles then refills', () => {
    let t = 0;
    const b = new TokenBucket(3, 1, () => t);
    assert.ok(b.take() && b.take() && b.take());
    assert.equal(b.take(), false);
    t += 1000;
    assert.ok(b.take());
    assert.equal(b.take(), false);
  });
});

describe('security', () => {
  it('rejects missing / forged / expired tokens at the HTTP upgrade (401) before any socket exists', async () => {
    const { gws } = await cluster(1);
    const statuses: number[] = [];
    for (const token of ['', 'garbage', signToken('wrong-secret', { user: 'a', tenant: 't1' }), signToken(SECRET, { user: 'a', tenant: 't1' }, -10)]) {
      await new Promise<void>((res) => {
        const ws = new WebSocket(`${url(gws[0])}?token=${token}`);
        ws.on('unexpected-response', (_q, r) => (statuses.push(r.statusCode!), r.resume(), res()));
        ws.on('error', () => res());
      });
    }
    assert.deepEqual(statuses, [401, 401, 401, 401]);
    assert.equal(gws[0].m.authFailures, 4);
  });

  it('isolates tenants: same room name, different tenant => no cross-talk', async () => {
    const { gws } = await cluster(2);
    const a = client(gws[0], 'alice', ['general'], 'acme');
    const b = client(gws[1], 'bob', ['general'], 'globex');
    const a2 = client(gws[1], 'amy', ['general'], 'acme');
    await Promise.all([a.connect(), b.connect(), a2.connect()]);
    const gotB = collect(b);
    const gotA2 = collect(a2);
    await a.send('general', 'acme-only secret');
    await sleep(150);
    assert.equal(gotB.length, 0, 'globex must never see acme traffic');
    assert.equal(gotA2.length, 1);
    assert.equal(gotA2[0].text, 'acme-only secret');
  });

  it('enforces the rooms claim in the token', async () => {
    const { gws } = await cluster(1);
    const { ws, frames } = await rawWs(gws[0], tok('eve', 't1', ['general']));
    ws.send(JSON.stringify({ t: 'join', room: 'secret' }));
    ws.send(JSON.stringify({ t: 'join', room: '../../etc' }));
    ws.send(JSON.stringify({ t: 'join', room: 'general' }));
    await sleep(150);
    const errs = frames.filter((f) => f.t === 'error').map((f) => f.code);
    assert.deepEqual(errs, ['forbidden', 'forbidden']);
    assert.ok(frames.some((f) => f.t === 'joined' && f.room === 'general'));
  });

  it('rate limits per connection', async () => {
    const { gws } = await cluster(1, { rateBurst: 5, rateRefillPerSec: 1 });
    const { ws, frames } = await rawWs(gws[0], tok('spam'));
    ws.send(JSON.stringify({ t: 'join', room: 'general' }));
    await sleep(100);
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ t: 'msg', room: 'general', text: `m${i}`, cid: `c${i}` }));
    await sleep(300);
    const limited = frames.filter((f) => f.t === 'error' && f.code === 'rate_limited').length;
    const acked = frames.filter((f) => f.t === 'ack').length;
    assert.ok(limited >= 20, `expected throttling, got ${limited}`);
    assert.ok(acked >= 5 && acked <= 7);
  });

  it('rejects oversized text and malformed frames without crashing', async () => {
    const { gws } = await cluster(1, { maxText: 100 });
    const { ws, frames } = await rawWs(gws[0], tok('x'));
    ws.send(JSON.stringify({ t: 'join', room: 'general' }));
    await sleep(80);
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'msg', room: 'general', text: 'a'.repeat(101), cid: 'big' }));
    ws.send(JSON.stringify({ t: 'msg', room: 'general', text: 'ok', cid: 'fine' }));
    await sleep(150);
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'bad_request'));
    assert.ok(frames.some((f) => f.t === 'ack' && f.cid === 'fine'));
  });
});

describe('ordering & delivery', () => {
  it('total order per room across nodes: every client sees the same gap-free sequence', async () => {
    const { gws } = await cluster(3);
    const cs = [client(gws[0], 'a', ['r']), client(gws[1], 'b', ['r']), client(gws[2], 'c', ['r']), client(gws[2], 'd', ['r'])];
    await Promise.all(cs.map((c) => c.connect()));
    const logs = cs.map(collect);
    await Promise.all(
      cs.slice(0, 3).flatMap((c, ci) => Array.from({ length: 40 }, (_, i) => c.send('r', `c${ci}-m${i}`))),
    );
    await Promise.all(cs.map((c) => c.waitFor(() => c.lastSeq('r') === 120, 3000)));
    for (const l of logs) {
      assert.deepEqual(l.map((m) => m.seq), Array.from({ length: 120 }, (_, i) => i + 1));
      assert.deepEqual(l.map((m) => m.text), logs[0].map((m) => m.text), 'identical order everywhere');
    }
    // per-sender FIFO is NOT promised for concurrent sends, but the *global* order is identical for everyone (linearized by the backplane).
  });

  it('idempotent publish: same cid twice => same seq, one broadcast', async () => {
    const { gws } = await cluster(2);
    const rx = client(gws[1], 'rx', ['r']);
    await rx.connect();
    const got = collect(rx);
    const { ws, frames } = await rawWs(gws[0], tok('tx'));
    ws.send(JSON.stringify({ t: 'join', room: 'r' }));
    await sleep(80);
    for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ t: 'msg', room: 'r', text: 'once', cid: 'same-id' }));
    await sleep(200);
    const acks = frames.filter((f) => f.t === 'ack');
    assert.equal(acks.length, 3);
    assert.ok(acks.every((a) => a.seq === acks[0].seq));
    assert.deepEqual(acks.map((a) => a.dup), [false, true, true]);
    assert.equal(got.length, 1);
  });

  it('new joiner gets recent history; resuming client gets exactly what it missed', async () => {
    const { gws } = await cluster(2, { historyOnJoin: 5 });
    const tx = client(gws[0], 'tx', ['r']);
    await tx.connect();
    for (let i = 1; i <= 10; i++) await tx.send('r', `m${i}`);
    const late = client(gws[1], 'late', ['r']);
    const lateGot = collect(late);
    await late.connect();
    await sleep(100);
    assert.deepEqual(lateGot.map((m) => m.text), ['m6', 'm7', 'm8', 'm9', 'm10']);

    // disconnect, miss traffic, resume
    late.kill();
    for (let i = 11; i <= 15; i++) await tx.send('r', `m${i}`);
    await late.waitFor(() => late.lastSeq('r') === 15, 5000);
    assert.deepEqual(lateGot.map((m) => m.seq), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'no loss, no duplicates across reconnect');
  });
});

describe('fault tolerance (in-process)', () => {
  it('lost pub/sub deliveries are repaired from the log (gap fill) and clients never see a hole', async () => {
    const { gws, hub } = await cluster(2);
    const tx = client(gws[0], 'tx', ['r']);
    const rx = client(gws[1], 'rx', ['r']);
    await Promise.all([tx.connect(), rx.connect()]);
    const got = collect(rx);
    await tx.send('r', 'm1');
    await rx.waitFor(() => got.length === 1, 1000);
    const victim = [...hub.members][1];
    hub.muted.add(victim); // node 2's subscription silently loses messages 2..5
    for (let i = 2; i <= 5; i++) await tx.send('r', `m${i}`);
    await sleep(100);
    assert.equal(got.length, 1);
    hub.muted.delete(victim);
    await tx.send('r', 'm6'); // seq jump 1 -> 6 detected on node 2 => fill 2..5 from the log
    await rx.waitFor(() => got.length === 6, 2000);
    assert.deepEqual(got.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
    assert.ok(gws[1].m.gapsFilled >= 4);
  });

  it('backplane outage: publishes are rejected+retried (no silent loss), recovery catch-up delivers everything once', async () => {
    const { gws, hub } = await cluster(2);
    const tx = client(gws[0], 'tx', ['r']);
    const rx = client(gws[1], 'rx', ['r']);
    await Promise.all([tx.connect(), rx.connect()]);
    const got = collect(rx);
    await tx.send('r', 'before');
    hub.setDown(true);
    const during = Promise.all([tx.send('r', 'during-1'), tx.send('r', 'during-2')]); // retried with same cid until Redis is back
    await sleep(700);
    assert.ok(gws[0].m.publishErrors >= 1, 'gateway must surface errors instead of dropping');
    hub.setDown(false);
    const acks = await during;
    await rx.waitFor(() => got.length === 3, 3000);
    assert.deepEqual(got.map((m) => m.text).sort(), ['before', 'during-1', 'during-2']);
    assert.deepEqual(got.map((m) => m.seq), [1, 2, 3]);
    assert.equal(new Set(acks.map((a) => a.seq)).size, 2);
  });

  it('node loss: clients reconnect to a surviving node and resume without loss', async () => {
    const { gws } = await cluster(2);
    const tx = client(gws[0], 'tx', ['r']);
    const rx = new ResilientClient({ urls: [url(gws[1]), url(gws[0])], token: tok('rx'), rooms: ['r'] }); // fallback list
    cleanup.push(() => rx.close());
    await Promise.all([tx.connect(), rx.connect()]);
    const got = collect(rx);
    for (let i = 1; i <= 5; i++) await tx.send('r', `m${i}`);
    await gws[1].stop(0); // node 1 dies (graceful here; abrupt kill is covered in fault.test.ts)
    for (let i = 6; i <= 10; i++) await tx.send('r', `m${i}`);
    await rx.waitFor(() => got.length === 10, 8000);
    assert.deepEqual(got.map((m) => m.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(rx.node, 'n0');
  });

  it('slow consumer is cut off instead of growing node memory without bound', async () => {
    const { gws } = await cluster(1, { maxBufferBytes: 20_000, maxText: 2000 });
    const slow = await rawWs(gws[0], tok('slow'));
    slow.ws.send(JSON.stringify({ t: 'join', room: 'r' }));
    await sleep(100);
    (slow.ws as any)._socket.pause(); // stops reading => server-side send buffer fills
    const tx = client(gws[0], 'tx', ['r']);
    await tx.connect();
    const text = 'x'.repeat(2000);
    for (let i = 0; i < 4000 && gws[0].m.slowClosed === 0; i++) {
      tx.send('r', text).catch(() => undefined);
      if (i % 100 === 0) await sleep(10);
    }
    await sleep(300);
    assert.ok(gws[0].m.slowClosed >= 1);
  });
});

describe('presence', () => {
  it('announces join/leave across nodes and lists unique members', async () => {
    const { gws } = await cluster(2);
    const a = client(gws[0], 'alice', ['r']);
    const b = client(gws[1], 'bob', ['r']);
    const events: any[] = [];
    b.on('presence', (e) => events.push(e));
    let members: string[] = [];
    b.on('members', (_r, m) => (members = m));
    await b.connect();
    await a.connect();
    await sleep(200);
    assert.ok(events.some((e) => e.user === 'alice' && e.state === 'join'));
    a.close();
    await sleep(300);
    assert.ok(events.some((e) => e.user === 'alice' && e.state === 'leave'));
    await sleep(400); // presence loop sync
    assert.deepEqual(members, ['bob']);
  });
});
