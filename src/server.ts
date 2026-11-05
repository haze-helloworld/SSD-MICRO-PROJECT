try { process.loadEnvFile?.(); } catch {}
import { RedisBackplane } from './backplane/redis.js';
import { MemoryBackplane } from './backplane/memory.js';
import type { Backplane } from './backplane/index.js';
import { loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { makeLogger } from './logger.js';

const cfg = loadConfig();
const log = makeLogger({ node: cfg.nodeId });

let bp: Backplane;
if (cfg.backplane === 'memory') {
  log.warn('BACKPLANE=memory: single-node mode, messages are NOT shared across processes');
  bp = new MemoryBackplane();
} else {
  bp = new RedisBackplane({ url: cfg.redisUrl, log, streamMaxLen: cfg.streamMaxLen, dedupeTtlSec: cfg.dedupeTtlSec });
}

const gw = new Gateway(cfg, bp);
await gw.start();

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { sig });
  await gw.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
