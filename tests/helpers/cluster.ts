import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { signToken } from '../../src/auth.js';
import { ResilientClient } from '../../src/client.js';

export const SECRET = 'test-secret';
export const redisAvailable = (): boolean => spawnSync('redis-server', ['--version']).status === 0;

export async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function waitFor(cond: () => Promise<boolean>, ms: number, what: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

export interface RedisProc {
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}
export async function startRedis(): Promise<RedisProc> {
  const port = await freePort();
  const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  await waitFor(
    () =>
      new Promise<boolean>((res) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => (s.destroy(), res(true)));
        s.once('error', () => res(false));
      }),
    5000,
    'redis',
  );
  return {
    port,
    proc,
    stop: async () => {
      proc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

export interface NodeProc {
  id: string;
  port: number;
  proc: ChildProcess;
  kill(sig?: NodeJS.Signals): Promise<void>;
  metrics(): Promise<any>;
}
export async function startNode(id: string, redisUrl: string, env: Record<string, string> = {}): Promise<NodeProc> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ID: id,
      REDIS_URL: redisUrl,
      JWT_SECRET: SECRET,
      LOG_LEVEL: process.env.TEST_LOG ?? 'silent',
      PRESENCE_REFRESH_MS: '500',
      PRESENCE_TTL_MS: '2000',
      HEARTBEAT_MS: '2000',
      RATE_BURST: '100000',
      RATE_REFILL: '100000',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const get = async (p: string) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200, 20000, `${id} ready`);
  return {
    id,
    port,
    proc,
    kill: async (sig = 'SIGKILL') => {
      if (proc.exitCode !== null || proc.signalCode !== null) return; // already dead
      proc.kill(sig);
      await new Promise((r) => proc.once('exit', r));
    },
    metrics: () => get('/metrics'),
  };
}

export function mkClient(lbPort: number, user: string, rooms: string[], tenant = 't1', allowed?: string[]) {
  const token = signToken(SECRET, { user, tenant, rooms: allowed });
  return new ResilientClient({ urls: [`ws://127.0.0.1:${lbPort}/ws`], token, rooms });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
