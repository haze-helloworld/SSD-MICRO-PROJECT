import { randomUUID } from 'node:crypto';

export interface Config {
  port: number;
  nodeId: string;
  jwtSecret: string;
  backplane: 'redis' | 'memory';
  redisUrl: string;
  devTokens: boolean; // exposes POST /dev/token (demo only!)
  maxPayload: number; // max WS frame bytes
  maxText: number; // max chat text length
  rateBurst: number; // token bucket capacity (msgs)
  rateRefillPerSec: number; // token bucket refill
  maxConnsPerTenant: number; // per node
  maxBufferBytes: number; // slow-consumer cut-off
  historyOnJoin: number; // messages replayed to a brand-new joiner
  streamMaxLen: number; // approx. messages retained per room (for resume)
  dedupeTtlSec: number; // idempotency window
  presenceTtlMs: number;
  presenceRefreshMs: number;
  heartbeatMs: number; // ws ping interval
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(+v) ? +v : d);

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8080),
    nodeId: env.NODE_ID || `node-${randomUUID().slice(0, 6)}`,
    jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
    backplane: env.BACKPLANE === 'redis' ? 'redis' : (env.BACKPLANE === 'memory' ? 'memory' : (env.REDIS_URL ? 'redis' : 'memory')),
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    devTokens: env.DEV_TOKENS !== 'false',
    maxPayload: num(env.MAX_PAYLOAD, 8 * 1024),
    maxText: num(env.MAX_TEXT, 2000),
    rateBurst: num(env.RATE_BURST, 40),
    rateRefillPerSec: num(env.RATE_REFILL, 20),
    maxConnsPerTenant: num(env.MAX_CONNS_PER_TENANT, 5000),
    maxBufferBytes: num(env.MAX_BUFFER_BYTES, 1024 * 1024),
    historyOnJoin: num(env.HISTORY_ON_JOIN, 50),
    streamMaxLen: num(env.STREAM_MAXLEN, 2000),
    dedupeTtlSec: num(env.DEDUPE_TTL_SEC, 300),
    presenceTtlMs: num(env.PRESENCE_TTL_MS, 30000),
    presenceRefreshMs: num(env.PRESENCE_REFRESH_MS, 10000),
    heartbeatMs: num(env.HEARTBEAT_MS, 15000),
    ...overrides,
  };
}
