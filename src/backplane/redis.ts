import { Redis } from 'ioredis';
import type { Logger } from '../logger.js';
import type { EventPayload, RoomRef, StoredMsg } from '../types.js';
import type { Backplane, BackplaneHandlers, HistoryResult } from './index.js';
import { uniqueUsers } from './index.js';

/**
 * Key / channel layout. The `{tenant:room}` hash tag keeps every key of a room in one slot,
 * so this also works with Redis Cluster mode (ElastiCache cluster-mode-enabled / Redis Enterprise).
 *   {t:r}:seq       INCR counter  -> per-room gap-free sequence
 *   {t:r}:log       STREAM        -> replay log, entry id = "<seq>-0"
 *   {t:r}:dd:<cid>  STRING        -> idempotency key (value = seq), TTL = dedupe window
 *   {t:r}:pres      ZSET          -> member "<user>#<connId>", score = expiry (ms)
 *   {t:r}:m         PUB/SUB chan  -> sequenced messages
 *   {t:r}:e         PUB/SUB chan  -> ephemeral events (presence/typing)
 */
const base = (r: RoomRef) => `{${r.tenant}:${r.room}}`;
const CHAN_RE = /^\{([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)\}:(m|e)$/;

/**
 * ATOMIC publish: dedupe check + sequence + durable log append + fan-out in ONE script.
 * Because PUBLISH happens inside the same script that assigned the seq, pub/sub order == log order == seq order.
 * Redis is single-threaded, so this is the linearization point for a room.
 */
const PUBLISH_LUA = `
if ARGV[6] ~= '' then
  local ex = redis.call('GET', KEYS[3])
  if ex then return {tonumber(ex), 1} end
end
local seq = redis.call('INCR', KEYS[1])
local payload = cjson.encode({t='msg', room=ARGV[2], seq=seq, user=ARGV[3], text=ARGV[4], ts=tonumber(ARGV[5]), cid=ARGV[6]})
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[7], seq .. '-0', 'p', payload)
if ARGV[6] ~= '' then redis.call('SET', KEYS[3], seq, 'EX', ARGV[8]) end
redis.call('PUBLISH', ARGV[1], payload)
return {seq, 0}
`;

export interface RedisBackplaneOpts {
  url: string;
  log: Logger;
  streamMaxLen?: number;
  dedupeTtlSec?: number;
  watchdogMs?: number;
}

export class RedisBackplane implements Backplane {
  readonly kind = 'redis';
  private cmd!: Redis;
  private sub!: Redis;
  private handlers: BackplaneHandlers | null = null;
  private cmdReady = false;
  private subReady = false;
  private up = false;
  private channels = new Set<string>();
  private watchdog?: NodeJS.Timeout;
  private stopped = false;
  private cmdDownAt = Date.now();
  private subDownAt = Date.now();

  constructor(private o: RedisBackplaneOpts) {}

  get isUp() {
    return this.up;
  }
  setHandlers(h: BackplaneHandlers) {
    this.handlers = h;
  }

  private recompute() {
    const now = this.cmdReady && this.subReady;
    if (now && !this.up) {
      this.up = true;
      this.o.log.info('backplane up');
      this.handlers?.onUp();
    } else if (!now && this.up) {
      this.up = false;
      this.o.log.warn('backplane down');
      this.handlers?.onDown();
    }
  }

  async start() {
    const common = {
      retryStrategy: (n: number) => Math.min(100 * 2 ** Math.min(n, 5), 2000),
      reconnectOnError: () => false as const,
      keepAlive: 5000,
      connectTimeout: 3000,
    };
    // Command connection: fail fast while down (never queue writes silently - the caller retries with the same cid).
    this.cmd = new Redis(this.o.url, { ...common, enableOfflineQueue: false, commandTimeout: 2000, maxRetriesPerRequest: 1 });
    this.sub = new Redis(this.o.url, { ...common, autoResubscribe: true });
    this.cmd.defineCommand('rpublish', { numberOfKeys: 3, lua: PUBLISH_LUA });

    // Absorb connection errors (we handle them through close/ready transitions).
    this.cmd.on('error', (e: Error) => this.o.log.debug('cmd error', { err: e.message }));
    this.sub.on('error', (e: Error) => this.o.log.debug('sub error', { err: e.message }));

    this.cmd.on('ready', () => {
      this.cmdReady = true;
      this.recompute();
    });
    this.cmd.on('close', () => {
      this.cmdReady = false;
      this.cmdDownAt = Date.now();
      this.recompute();
    });
    this.sub.on('ready', () => {
      // Belt and braces: re-issue SUBSCRIBE for everything we track (idempotent) BEFORE declaring ourselves up.
      const chans = [...this.channels];
      const done = chans.length ? this.sub.subscribe(...chans).catch(() => undefined) : Promise.resolve();
      void done.then(() => {
        this.subReady = true;
        this.recompute();
      });
    });
    this.sub.on('close', () => {
      this.subReady = false;
      this.subDownAt = Date.now();
      this.recompute();
    });

    this.sub.on('message', (channel: string, message: string) => {
      const m = CHAN_RE.exec(channel);
      if (!m) return;
      try {
        const ref = { tenant: m[1], room: m[2] };
        const data = JSON.parse(message);
        if (m[3] === 'm') this.handlers?.onMessage(ref, data as StoredMsg);
        else this.handlers?.onEvent(ref, data as EventPayload);
      } catch (e) {
        this.o.log.warn('bad backplane payload', { channel, err: String(e) });
      }
    });

    // Half-open TCP detection (blackholed network / silent NLB idle drop): PING both links, bounce on failure.
    this.watchdog = setInterval(() => void this.probe(), this.o.watchdogMs ?? 2000);
    this.watchdog.unref();

    // Wait briefly for first connect, but never block startup: the gateway is useful (health, auth) even if Redis is late.
    await new Promise<void>((res) => {
      const t = setTimeout(res, 1500);
      const poll = setInterval(() => {
        if (this.up) {
          clearTimeout(t);
          clearInterval(poll);
          res();
        }
      }, 25);
      setTimeout(() => clearInterval(poll), 1600);
    });
  }

  private async probe() {
    if (this.stopped) return;
    const withTimeout = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 1500))]);
    // A reconnect that connected at TCP level but never completes the handshake (blackholed) would hang forever: bounce it.
    if (!this.cmdReady && Date.now() - this.cmdDownAt > 4000) {
      this.cmdDownAt = Date.now();
      this.cmd.disconnect(true);
    }
    if (!this.subReady && Date.now() - this.subDownAt > 4000) {
      this.subDownAt = Date.now();
      this.sub.disconnect(true);
    }
    if (this.cmdReady) {
      try {
        await withTimeout(this.cmd.ping());
      } catch (e) {
        this.o.log.warn('cmd link unhealthy, bouncing', { err: String(e) });
        this.cmd.disconnect(true);
      }
    }
    if (this.subReady) {
      try {
        await withTimeout(this.sub.ping());
      } catch (e) {
        this.o.log.warn('sub link unhealthy, bouncing', { err: String(e) });
        this.sub.disconnect(true);
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.cmd?.disconnect();
    this.sub?.disconnect();
  }

  async publish(ref: RoomRef, m: { user: string; text: string; cid: string }) {
    const b = base(ref);
    const res = (await (this.cmd as any).rpublish(
      `${b}:seq`,
      `${b}:log`,
      `${b}:dd:${m.cid || 'none'}`,
      `${b}:m`,
      ref.room,
      m.user,
      m.text,
      Date.now(),
      m.cid,
      this.o.streamMaxLen ?? 2000,
      this.o.dedupeTtlSec ?? 300,
    )) as [number, number];
    return { seq: Number(res[0]), duplicate: res[1] === 1 };
  }

  async publishEvent(ref: RoomRef, ev: EventPayload) {
    await this.cmd.publish(`${base(ref)}:e`, JSON.stringify(ev));
  }

  async subscribe(ref: RoomRef) {
    const chans = [`${base(ref)}:m`, `${base(ref)}:e`];
    chans.forEach((c) => this.channels.add(c));
    if (this.subReady) await this.sub.subscribe(...chans);
    // else: will be subscribed in the 'ready' handler on (re)connect
  }
  async unsubscribe(ref: RoomRef) {
    const chans = [`${base(ref)}:m`, `${base(ref)}:e`];
    chans.forEach((c) => this.channels.delete(c));
    if (this.subReady) await this.sub.unsubscribe(...chans).catch(() => undefined);
  }

  async head(ref: RoomRef) {
    const v = await this.cmd.get(`${base(ref)}:seq`);
    return v ? Number(v) : 0;
  }

  async history(ref: RoomRef, afterSeq: number, upToSeq: number | undefined, limit: number): Promise<HistoryResult> {
    const start = `${afterSeq + 1}-0`;
    const end = upToSeq === undefined ? '+' : `${upToSeq}-0`;
    const rows = (await this.cmd.xrange(`${base(ref)}:log`, start, end, 'COUNT', limit)) as Array<[string, string[]]>;
    const msgs = rows.map(([, f]) => JSON.parse(f[1]) as StoredMsg);
    return { msgs };
  }

  async presenceSync(ref: RoomRef, localMembers: string[], ttlMs: number) {
    const key = `${base(ref)}:pres`;
    const now = Date.now();
    const p = this.cmd.pipeline();
    if (localMembers.length) p.zadd(key, ...localMembers.flatMap((m) => [now + ttlMs, m]));
    p.zremrangebyscore(key, '-inf', now);
    p.zrange(key, 0, -1);
    p.pexpire(key, ttlMs * 3);
    const out = await p.exec();
    if (!out) throw new Error('pipeline failed');
    const rangeIdx = localMembers.length ? 2 : 1;
    const [err, members] = out[rangeIdx] as [Error | null, string[]];
    if (err) throw err;
    return uniqueUsers(members);
  }
  async presenceRemove(ref: RoomRef, member: string) {
    await this.cmd.zrem(`${base(ref)}:pres`, member);
  }
  async presenceList(ref: RoomRef) {
    const key = `${base(ref)}:pres`;
    const now = Date.now();
    const out = await this.cmd.pipeline().zremrangebyscore(key, '-inf', now).zrange(key, 0, -1).exec();
    if (!out) throw new Error('pipeline failed');
    return uniqueUsers((out[1][1] as string[]) ?? []);
  }
}
