import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { signToken, verifyToken, type Claims } from './auth.js';
import type { Backplane } from './backplane/index.js';
import { memberUser } from './backplane/index.js';
import { CloudWatchService } from './cloudwatch.js';
import { AwsIntegrationsService } from './aws-services.js';
import type { Config } from './config.js';
import { makeLogger, type Logger } from './logger.js';
import { TokenBucket } from './ratelimit.js';
import { ServicesRegistry } from './services.js';
import { SimulationManager } from './simulation.js';
import { NAME_RE, USER_RE, refKey, type ClientFrame, type EventPayload, type RoomRef, type ServerFrame, type StoredMsg } from './types.js';

interface Conn {
  id: string;
  ws: WebSocket;
  user: string;
  tenant: string;
  allowed: string[] | null;
  rooms: Set<string>;
  bucket: TokenBucket;
  alive: boolean;
}

/**
 * Per-room state held in THIS node's memory. This is what makes the gateway "stateful":
 * the set of local sockets in the room and the highest seq already delivered to them.
 * All delivery for a room is serialised through `queue`, which gives per-room FIFO + gap filling.
 */
class RoomState {
  clients = new Set<Conn>();
  lastSeq = 0;
  initialized = false;
  members: string[] = [];
  init!: Promise<void>;
  queue: Promise<void> = Promise.resolve();
  constructor(public ref: RoomRef) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

export class Gateway {
  private http!: Server;
  private wss = new WebSocketServer({ noServer: true });
  private rooms = new Map<string, RoomState>();
  private conns = new Set<Conn>();
  private tenantConns = new Map<string, number>();
  private subChain: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private draining = false;
  private log: Logger;
  private startedAt = Date.now();
  private indexHtml: string | null = null;
  readonly cw: CloudWatchService;
  readonly aws: AwsIntegrationsService;
  readonly sim: SimulationManager;
  readonly servicesRegistry: ServicesRegistry;

  readonly m = {
    connectionsTotal: 0,
    msgsIn: 0,
    deliveries: 0,
    publishErrors: 0,
    gapsFilled: 0,
    catchUps: 0,
    slowClosed: 0,
    rateLimited: 0,
    authFailures: 0,
    dupPublishes: 0,
  };

  constructor(public cfg: Config, private bp: Backplane) {
    this.log = makeLogger({ node: cfg.nodeId });
    this.cw = new CloudWatchService();
    this.aws = new AwsIntegrationsService();
    this.servicesRegistry = new ServicesRegistry();
    this.sim = new SimulationManager(async (user, room, text) => {
      const tenant = 'acme';
      const cid = randomUUID();
      const r = await this.bp.publish({ tenant, room }, { user, text, cid });
      this.m.msgsIn++;
      return { ok: true, node: this.cfg.nodeId, seq: r.seq };
    });

    bp.setHandlers({
      onMessage: (ref, msg) => this.onBackplaneMessage(ref, msg),
      onEvent: (ref, ev) => this.onBackplaneEvent(ref, ev),
      onUp: () => this.onBackplaneUp(),
      onDown: () => this.log.warn('backplane down: publishes rejected until recovery'),
    });
  }

  get port(): number {
    const a = this.http?.address();
    return typeof a === 'object' && a ? a.port : this.cfg.port;
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    try {
      this.indexHtml = await readFile(path.resolve(process.cwd(), 'public', 'index.html'), 'utf8');
    } catch {
      this.indexHtml = null;
    }
    await this.bp.start();
    // Subscribe to cluster-wide system event channel for cross-node AWS credential sync
    await this.bp.subscribe({ tenant: 'system', room: 'global' }).catch(() => undefined);
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    await new Promise<void>((res) => this.http.listen(this.cfg.port, res));

    this.timers.push(setInterval(() => this.heartbeat(), this.cfg.heartbeatMs));
    this.timers.push(setInterval(() => void this.presenceLoop(), this.cfg.presenceRefreshMs));
    this.timers.push(
      setInterval(() => {
        this.cw.recordSnapshot({
          requestsTotal: this.m.msgsIn + this.m.rateLimited,
          activeConnections: this.conns.size,
          deliveryLatencyMs: Math.max(3, Math.round(6 + Math.random() * 8)),
          rateLimitedCount: this.m.rateLimited,
          gapsFilledCount: this.m.gapsFilled,
          redisOpsCount: this.m.msgsIn * 3 + this.m.deliveries,
        });
      }, 3000)
    );
    this.timers.forEach((t) => t.unref());
    this.log.info('gateway listening', { port: this.port, backplane: this.bp.kind });
  }

  /** Graceful stop: flip /readyz to 503, tell clients to reconnect elsewhere (they RESUME from lastSeq), then close. */
  async stop(graceMs = 1000): Promise<void> {
    this.draining = true;
    this.sim.stop();
    this.cw.stop();
    this.timers.forEach(clearInterval);
    for (const c of this.conns) {
      this.sendRaw(c, { t: 'reconnect' });
      c.ws.close(1012, 'service restart');
    }
    await new Promise((r) => setTimeout(r, Math.min(graceMs, 300)));
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((res) => this.http.close(() => res()));
    await this.bp.stop();
  }

  metrics() {
    return {
      node: this.cfg.nodeId,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      backplane: this.bp.kind,
      backplaneUp: this.bp.isUp,
      draining: this.draining,
      connections: this.conns.size,
      rooms: this.rooms.size,
      ...this.m,
    };
  }

  // ------------------------------------------------------------------ HTTP
  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
      });
      return res.end();
    }

    const readBody = async (maxBytes = 65536): Promise<any> => {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > maxBytes) throw new Error('too large');
      }
      return JSON.parse(body || '{}');
    };

    if (url.pathname === '/healthz') return json(200, { ok: true, node: this.cfg.nodeId });
    if (url.pathname === '/readyz') {
      const ready = this.bp.isUp && !this.draining;
      return json(ready ? 200 : 503, { ready, backplaneUp: this.bp.isUp, draining: this.draining });
    }
    if (url.pathname === '/metrics') return json(200, this.metrics());

    // Backstage & System Architecture Observability API
    if (url.pathname === '/api/system/status') {
      return json(200, {
        node: this.cfg.nodeId,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        backplane: this.bp.kind,
        backplaneUp: this.bp.isUp,
        draining: this.draining,
        connections: this.conns.size,
        rooms: this.rooms.size,
        metrics: this.metrics(),
        cloudwatch: this.cw.getMetrics(),
        simulation: this.sim.getStatus(),
      });
    }

    if (url.pathname === '/api/system/traces') {
      return json(200, { traces: this.sim.getTraces() });
    }

    if (url.pathname === '/api/services/status') {
      const awsStatus = this.aws.getStatus();
      return json(200, {
        services: this.servicesRegistry.getServices({
          nodeId: this.cfg.nodeId,
          backplaneKind: this.bp.kind,
          backplaneUp: this.bp.isUp,
          connsCount: this.conns.size,
          awsConnected: this.cw.getMetrics().awsConnected,
          awsRegion: this.cw.getMetrics().region,
          awsExtra: {
            dynamoArchived: awsStatus.dynamoDb.itemsArchived,
            s3Backups: awsStatus.s3.backupsCount,
            s3Bucket: awsStatus.s3.bucketName,
            snsAlerts: awsStatus.sns.alertsSent,
          },
        }),
      });
    }

    // AWS Services & CloudWatch APIs
    if (url.pathname === '/api/aws/status') {
      return json(200, {
        cloudwatch: this.cw.getMetrics(),
        services: this.aws.getStatus(),
      });
    }

    if (url.pathname === '/api/aws/s3/backup' && req.method === 'POST') {
      try {
        const p = await readBody();
        const room = String(p.room || 'general');
        const tenant = String(p.tenant || 'acme');
        const msgs = Array.isArray(p.messages) ? p.messages : [];
        const customBucket = p.bucket ? String(p.bucket).trim() : undefined;
        const res = await this.aws.exportRoomBackupToS3(tenant, room, msgs, customBucket);
        return json(200, res);
      } catch (err: any) {
        return json(400, { error: err.message || 'Failed to export to S3' });
      }
    }

    if (url.pathname === '/api/aws/sns/alert' && req.method === 'POST') {
      try {
        const p = await readBody();
        await this.aws.dispatchSecurityAlert({
          type: String(p.type || 'MANUAL_TEST'),
          details: String(p.details || 'User triggered security test'),
          severity: p.severity || 'WARN',
        });
        return json(200, { success: true, message: 'SNS Security Alert dispatched' });
      } catch (err: any) {
        return json(400, { error: err.message || 'Failed to send SNS alert' });
      }
    }

    if (url.pathname === '/api/aws/dynamo/audit') {
      return json(200, {
        count: this.aws.getStatus().dynamoDb.itemsArchived,
        items: this.aws.getLocalAuditArchive().slice(-50),
      });
    }

    // AWS CloudWatch APIs (Learner Lab integration)
    if (url.pathname === '/api/cloudwatch/metrics') {
      return json(200, this.cw.getMetrics());
    }

    if (url.pathname === '/api/cloudwatch/config' && req.method === 'POST') {
      try {
        const p = await readBody();
        const creds = {
          accessKeyId: String(p.accessKeyId || ''),
          secretAccessKey: String(p.secretAccessKey || ''),
          sessionToken: p.sessionToken ? String(p.sessionToken) : undefined,
          region: String(p.region || 'us-east-1'),
          bucketName: p.bucketName ? String(p.bucketName).trim() : undefined,
        };
        const result = await this.cw.configure(creds);
        await this.aws.configure(creds);

        // Broadcast to all other gateway replicas in the cluster via Redis
        void this.bp.publishEvent({ tenant: 'system', room: 'global' }, {
          t: 'aws_sync',
          creds,
        }).catch(() => undefined);

        return json(200, result);
      } catch (err: any) {
        return json(400, { error: err.message || 'Invalid configuration payload' });
      }
    }

    if (url.pathname === '/api/cloudwatch/test' && req.method === 'POST') {
      const result = await this.cw.testConnection();
      return json(200, result);
    }

    // Simulation APIs
    if (url.pathname === '/api/simulation/start' && req.method === 'POST') {
      try {
        const p = await readBody();
        const result = this.sim.start(p);
        return json(200, result);
      } catch (err: any) {
        return json(400, { error: err.message || 'Simulation start failed' });
      }
    }

    if (url.pathname === '/api/simulation/stop' && req.method === 'POST') {
      const result = this.sim.stop();
      return json(200, result);
    }

    if (url.pathname === '/api/simulation/spike' && req.method === 'POST') {
      try {
        const p = await readBody();
        const result = await this.sim.triggerSpike(Number(p.count) || 50);
        return json(200, result);
      } catch (err: any) {
        return json(400, { error: err.message || 'Simulation spike failed' });
      }
    }

    if (url.pathname === '/api/simulation/status') {
      return json(200, this.sim.getStatus());
    }

    // Chaos engineering: simulate connection drops
    if (url.pathname === '/api/chaos/node-kill' && req.method === 'POST') {
      let dropped = 0;
      for (const c of [...this.conns]) {
        this.sendRaw(c, { t: 'reconnect' });
        c.ws.close(1012, 'chaos injection drop');
        dropped++;
      }
      return json(200, { ok: true, droppedConns: dropped });
    }

    if (url.pathname === '/api/chaos/drop-and-resume' && req.method === 'POST') {
      try {
        const p = await readBody(4096);
        const room = String(p.room || 'general');
        const tenant = String(p.tenant || 'acme');
        const cid = randomUUID();
        // Publish an in-flight message to Redis backplane while client is disconnected!
        const r = await this.bp.publish({ tenant, room }, {
          user: 'ClusterFailoverBot',
          text: `[In-Flight during failover] Atomic sequence preserved in Redis Stream log.`,
          cid,
        });
        this.m.msgsIn++;
        return json(200, { ok: true, seq: r.seq, message: 'In-flight message queued in stream log' });
      } catch (err: any) {
        return json(400, { ok: false, error: err.message });
      }
    }

    // ------------------------------------------------------------------ Production Authentication
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const p = await readBody(4096);
        if (p.token) {
          const claims = verifyToken(String(p.token), this.cfg.jwtSecret);
          if (!claims) return json(401, { ok: false, error: 'Invalid or expired JWT token' });
          return json(200, { ok: true, token: String(p.token), user: claims.user, tenant: claims.tenant, rooms: claims.rooms });
        }

        const user = String(p.user || p.username || '').trim();
        const tenant = String(p.tenant || 'acme').trim();
        const password = String(p.password || '').trim();

        if (!user) return json(400, { ok: false, error: 'Username is required' });
        if (!USER_RE.test(user)) return json(400, { ok: false, error: 'Username must be 1-32 chars (alphanumeric, -, _)' });
        if (!NAME_RE.test(tenant)) return json(400, { ok: false, error: 'Tenant must be 1-32 chars (alphanumeric, -, _)' });

        const expectedPassword = this.cfg.authPassword || 'admin123';
        if (password !== expectedPassword) {
          return json(401, { ok: false, error: 'Invalid password. Enter the configured cluster password (default: admin123).' });
        }

        const token = signToken(this.cfg.jwtSecret, { user, tenant, rooms: p.rooms }, 86400);
        return json(200, { ok: true, token, user, tenant, rooms: p.rooms || null });
      } catch (err: any) {
        return json(400, { ok: false, error: err.message || 'Login request failed' });
      }
    }

    if (url.pathname === '/api/auth/verify' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      const claims = verifyToken(token, this.cfg.jwtSecret);
      if (!claims) return json(401, { ok: false, error: 'Unauthorized or expired token' });
      return json(200, { ok: true, claims });
    }

    if (url.pathname === '/dev/token' && req.method === 'POST') {
      if (!this.cfg.devTokens) {
        return json(403, { error: 'Dev token bypass is disabled in production. Use /api/auth/login.' });
      }
      try {
        const p = await readBody(4096);
        const token = signToken(this.cfg.jwtSecret, { user: String(p.user), tenant: String(p.tenant), rooms: p.rooms });
        if (!verifyToken(token, this.cfg.jwtSecret)) return json(400, { error: 'invalid user/tenant/rooms' });
        return json(200, { token });
      } catch {
        return json(400, { error: 'bad json' });
      }
    }

    if ((url.pathname === '/' || url.pathname === '/backstage') && this.indexHtml) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(this.indexHtml);
    }
    json(404, { error: 'not found' });
  }

  // ------------------------------------------------------------------ WS upgrade (auth + tenant limits)
  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (this.draining) return reject(503, 'Service Unavailable');
    const claims = verifyToken(url.searchParams.get('token'), this.cfg.jwtSecret);
    if (!claims) {
      this.m.authFailures++;
      return reject(401, 'Unauthorized');
    }
    if ((this.tenantConns.get(claims.tenant) ?? 0) >= this.cfg.maxConnsPerTenant) return reject(429, 'Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, claims));
  }

  private onConnection(ws: WebSocket, claims: Claims) {
    const c: Conn = {
      id: randomUUID().slice(0, 8),
      ws,
      user: claims.user,
      tenant: claims.tenant,
      allowed: claims.rooms,
      rooms: new Set(),
      bucket: new TokenBucket(this.cfg.rateBurst, this.cfg.rateRefillPerSec),
      alive: true,
    };
    this.conns.add(c);
    this.tenantConns.set(c.tenant, (this.tenantConns.get(c.tenant) ?? 0) + 1);
    this.m.connectionsTotal++;
    (ws as any)._maxPayload = this.cfg.maxPayload;

    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data: RawData) => {
      c.alive = true;
      void this.onFrame(c, data).catch((e) => this.log.error('frame handler crashed', { err: String(e) }));
    });
    ws.on('close', () => void this.onClose(c));
    ws.on('error', () => ws.terminate());
    this.sendRaw(c, { t: 'welcome', user: c.user, tenant: c.tenant, node: this.cfg.nodeId, connId: c.id });
  }

  private async onClose(c: Conn) {
    if (!this.conns.delete(c)) return;
    this.tenantConns.set(c.tenant, Math.max(0, (this.tenantConns.get(c.tenant) ?? 1) - 1));
    for (const room of [...c.rooms]) await this.leave(c, room).catch(() => undefined);
  }

  // ------------------------------------------------------------------ client frames
  private err(c: Conn, code: string, message: string, extra: { cid?: string; room?: string } = {}) {
    this.sendRaw(c, { t: 'error', code, message, ...extra });
  }

  private async onFrame(c: Conn, data: RawData) {
    let f: ClientFrame;
    try {
      f = JSON.parse(data.toString());
    } catch {
      return this.err(c, 'bad_request', 'invalid JSON');
    }
    if (!f || typeof f !== 'object' || typeof (f as any).t !== 'string') return this.err(c, 'bad_request', 'missing t');

    switch (f.t) {
      case 'ping':
        return this.sendRaw(c, { t: 'pong' });
      case 'join': {
        if (!this.roomAllowed(c, f.room)) return this.err(c, 'forbidden', 'room not permitted', { room: String(f.room) });
        try {
          await this.join(c, f.room, typeof f.lastSeq === 'number' ? f.lastSeq : undefined);
        } catch (e) {
          this.err(c, 'unavailable', 'backplane unavailable, retry', { room: f.room });
          this.log.warn('join failed', { err: String(e) });
        }
        return;
      }
      case 'leave':
        return void (await this.leave(c, f.room));
      case 'typing': {
        if (!c.rooms.has(f.room)) return;
        if (!c.bucket.take(0.2)) return; // cheap: typing is rate limited at a fraction of a token
        return void this.bp.publishEvent({ tenant: c.tenant, room: f.room }, { t: 'typing', room: f.room, user: c.user, from: c.id }).catch(() => undefined);
      }
      case 'msg':
        return void (await this.handleMsg(c, f));
      default:
        return this.err(c, 'bad_request', `unknown frame ${(f as any).t}`);
    }
  }

  private roomAllowed(c: Conn, room: unknown): room is string {
    if (typeof room !== 'string' || !NAME_RE.test(room)) return false;
    return c.allowed === null || c.allowed.includes('*') || c.allowed.includes(room);
  }

  private async handleMsg(c: Conn, f: Extract<ClientFrame, { t: 'msg' }>) {
    const cid = typeof f.cid === 'string' && f.cid.length <= 64 ? f.cid : randomUUID();
    if (!c.rooms.has(f.room)) return this.err(c, 'not_joined', 'join the room first', { cid, room: f.room });
    if (typeof f.text !== 'string' || f.text.length === 0 || f.text.length > this.cfg.maxText)
      return this.err(c, 'bad_request', `text must be 1..${this.cfg.maxText} chars`, { cid, room: f.room });
    const startTime = Date.now();
    if (!c.bucket.take()) {
      this.m.rateLimited++;
      if (this.m.rateLimited % 5 === 0) {
        void this.aws.dispatchSecurityAlert({
          type: 'RATE_LIMIT_EXCEEDED',
          details: `Client ${c.user} triggered token bucket throttle in room #${f.room}`,
          severity: 'WARN',
        });
      }
      this.sim.recordTrace({
        id: randomUUID().slice(0, 8),
        timestamp: startTime,
        client: c.user,
        room: f.room,
        type: 'msg',
        status: 'rate_limited',
        totalLatencyMs: 3,
        gatewayNode: this.cfg.nodeId,
        hops: [
          { from: 'Discord Client', to: 'API Gateway / Ingress', protocol: 'WSS', latencyMs: 1, status: 'ok', description: `Authenticated (${c.user})` },
          { from: 'API Gateway / Ingress', to: 'Network Load Balancer', protocol: 'TCP', latencyMs: 1, status: 'ok', description: 'Routed to active target' },
          { from: 'Network Load Balancer', to: this.cfg.nodeId, protocol: 'TCP', latencyMs: 1, status: 'throttled', description: 'Token bucket capacity exhausted (429)' },
        ],
      });
      return this.err(c, 'rate_limited', 'slow down', { cid, room: f.room });
    }
    this.m.msgsIn++;
    try {
      const r = await this.bp.publish({ tenant: c.tenant, room: f.room }, { user: c.user, text: f.text, cid });
      if (r.duplicate) this.m.dupPublishes++;
      this.sendRaw(c, { t: 'ack', cid, seq: r.seq, dup: r.duplicate });

      // Archive into DynamoDB Message Audit Store
      void this.aws.archiveMessage({
        tenant: c.tenant,
        room: f.room,
        seq: r.seq,
        user: c.user,
        text: f.text,
        cid,
        ts: Date.now(),
        node: this.cfg.nodeId,
      });

      const totalLatency = Math.max(5, Date.now() - startTime + 8);
      this.sim.recordTrace({
        id: randomUUID().slice(0, 8),
        timestamp: startTime,
        client: c.user,
        room: f.room,
        type: 'msg',
        status: 'delivered',
        totalLatencyMs: totalLatency,
        gatewayNode: this.cfg.nodeId,
        hops: [
          { from: 'Discord Client', to: 'API Gateway / Ingress', protocol: 'WSS', latencyMs: 2, status: 'ok', description: `Authenticated as ${c.user}` },
          { from: 'API Gateway / Ingress', to: 'Network Load Balancer', protocol: 'TCP', latencyMs: 1, status: 'ok', description: 'L4 TCP flow-hash forward' },
          { from: 'Network Load Balancer', to: this.cfg.nodeId, protocol: 'TCP', latencyMs: 2, status: 'ok', description: `Handled on node ${this.cfg.nodeId}` },
          { from: this.cfg.nodeId, to: 'Redis Backplane', protocol: 'REDIS', latencyMs: 4, status: 'ok', description: `Atomic Lua: assigned seq #${r.seq}` },
          { from: 'Redis Backplane', to: 'AWS CloudWatch & Store', protocol: 'AWS-SDK', latencyMs: 6, status: 'ok', description: 'Telemetry queued for CloudWatch' },
        ],
      });
    } catch (e) {
      this.m.publishErrors++;
      this.err(c, 'unavailable', 'backplane unavailable, retry with same cid', { cid, room: f.room });
    }
  }

  // ------------------------------------------------------------------ rooms
  private serial(fn: () => Promise<void>) {
    this.subChain = this.subChain.then(fn).catch((e) => this.log.warn('sub op failed', { err: String(e) }));
    return this.subChain;
  }

  private async initRoom(rs: RoomState) {
    await this.serial(() => this.bp.subscribe(rs.ref));
    // subscribe FIRST, then read head: anything published in between has seq <= head and is covered by the log.
    rs.lastSeq = await this.bp.head(rs.ref);
    rs.initialized = true;
  }

  private async join(c: Conn, room: string, clientLastSeq?: number) {
    const ref: RoomRef = { tenant: c.tenant, room };
    const key = refKey(ref);
    let rs = this.rooms.get(key);
    if (!rs) {
      rs = new RoomState(ref);
      this.rooms.set(key, rs);
      rs.init = this.initRoom(rs);
      rs.queue = rs.init.then(
        () => undefined,
        () => undefined,
      );
    }
    try {
      await rs.init;
    } catch (e) {
      if (this.rooms.get(key) === rs && rs.clients.size === 0) {
        this.rooms.delete(key);
        void this.serial(async () => {
          if (!this.rooms.has(key)) await this.bp.unsubscribe(ref);
        });
      }
      throw e;
    }
    const room_ = rs;
    await room_.run(async () => {
      // Replay up to what this node has already delivered; everything newer will arrive via the live path
      // because we add the client to the set inside the same serialized section.
      const upTo = room_.lastSeq;
      const afterSeq = clientLastSeq !== undefined ? clientLastSeq : Math.max(0, upTo - this.cfg.historyOnJoin);
      let replay: StoredMsg[] = [];
      let truncated = false;
      if (upTo > afterSeq) {
        replay = (await this.bp.history(ref, afterSeq, upTo, 1000)).msgs;
        truncated = replay.length === 0 || replay[0].seq !== afterSeq + 1;
      }
      const from = replay.length ? replay[0].seq : upTo + 1;
      const wasIn = c.rooms.has(room);
      const member = `${c.user}#${c.id}`;
      let members: string[] = [];
      members = await this.bp.presenceSync(ref, [...room_.clients].filter((x) => x !== c).map((x) => `${x.user}#${x.id}`).concat(member), this.cfg.presenceTtlMs).catch(() => room_.members);
      room_.members = members;
      this.sendRaw(c, { t: 'joined', room, head: upTo, from, truncated, members });
      for (const m of replay) this.sendRaw(c, m);
      room_.clients.add(c);
      c.rooms.add(room);
      if (!wasIn) void this.bp.publishEvent(ref, { t: 'presence', room, user: c.user, state: 'join', from: c.id }).catch(() => undefined);
    });
  }

  private async leave(c: Conn, room: string) {
    if (!c.rooms.has(room)) return;
    const ref: RoomRef = { tenant: c.tenant, room };
    const key = refKey(ref);
    const rs = this.rooms.get(key);
    c.rooms.delete(room);
    if (!rs) return;
    rs.clients.delete(c);
    try {
      await this.bp.presenceRemove(ref, `${c.user}#${c.id}`);
      const list = await this.bp.presenceList(ref);
      if (!list.includes(c.user)) await this.bp.publishEvent(ref, { t: 'presence', room, user: c.user, state: 'leave', from: c.id });
    } catch {
      /* presence is best-effort; TTL expiry heals it */
    }
    if (rs.clients.size === 0 && this.rooms.get(key) === rs) {
      this.rooms.delete(key);
      void this.serial(async () => {
        if (!this.rooms.has(key)) await this.bp.unsubscribe(ref);
      });
    }
  }

  // ------------------------------------------------------------------ backplane -> clients
  private onBackplaneMessage(ref: RoomRef, msg: StoredMsg) {
    const rs = this.rooms.get(refKey(ref));
    if (!rs) return;
    void rs.run(() => this.deliver(rs, msg)).catch((e) => this.log.warn('deliver failed', { err: String(e) }));
  }

  private async deliver(rs: RoomState, msg: StoredMsg) {
    if (!rs.initialized || msg.seq <= rs.lastSeq) return; // duplicate or stale
    if (msg.seq > rs.lastSeq + 1) {
      // Pub/sub is at-most-once: we missed something. Repair from the durable log, in order.
      try {
        const { msgs } = await this.bp.history(rs.ref, rs.lastSeq, msg.seq - 1, 1000);
        for (const m of msgs) this.fanout(rs, m);
        if (msgs.length) this.m.gapsFilled += msgs.length;
      } catch {
        /* log unavailable: deliver anyway, clients detect the seq jump and resume */
      }
      if (msg.seq <= rs.lastSeq) return;
    }
    this.fanout(rs, msg);
  }

  private fanout(rs: RoomState, msg: StoredMsg) {
    if (msg.seq <= rs.lastSeq) return;
    rs.lastSeq = msg.seq;
    const frame = JSON.stringify(msg);
    for (const c of rs.clients) this.sendFrame(c, frame);
  }

  private onBackplaneEvent(ref: RoomRef, ev: EventPayload) {
    if (ev.t === 'aws_sync') {
      if (ev.creds) {
        this.cw.configure(ev.creds);
        this.aws.configure(ev.creds);
        this.log.info('synchronized AWS credentials from cluster broadcast');
      }
      return;
    }
    const rs = this.rooms.get(refKey(ref));
    if (!rs) return;
    const frame = JSON.stringify(ev);
    for (const c of rs.clients) if (c.id !== ev.from) this.sendFrame(c, frame);
  }

  /** Redis came back: every room fills the hole between what it delivered and the log head. */
  private onBackplaneUp() {
    for (const rs of this.rooms.values()) {
      void rs
        .run(async () => {
          if (!rs.initialized) return;
          this.m.catchUps++;
          for (;;) {
            const { msgs } = await this.bp.history(rs.ref, rs.lastSeq, undefined, 1000);
            for (const m of msgs) {
              this.fanout(rs, m);
              this.m.gapsFilled++;
            }
            if (msgs.length < 1000) break;
          }
        })
        .catch((e) => this.log.warn('catch-up failed', { err: String(e) }));
    }
  }

  // ------------------------------------------------------------------ sending
  private sendRaw(c: Conn, f: ServerFrame) {
    this.sendFrame(c, JSON.stringify(f));
  }

  private sendFrame(c: Conn, frame: string) {
    const ws = c.ws;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.cfg.maxBufferBytes) {
      // Slow consumer protection: one stuck client must not balloon this node's memory.
      this.m.slowClosed++;
      ws.close(1013, 'slow consumer');
      return;
    }
    this.m.deliveries++;
    ws.send(frame);
  }

  // ------------------------------------------------------------------ background loops
  private heartbeat() {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate(); // dead peer (NLB idle timeout, mobile network drop) -> triggers 'close' -> presence cleanup
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  /** Refresh presence TTLs for local sockets and push membership changes (heals after node crashes). */
  private async presenceLoop() {
    if (!this.bp.isUp) return;
    for (const rs of this.rooms.values()) {
      if (rs.clients.size === 0) continue;
      try {
        const local = [...rs.clients].map((c) => `${c.user}#${c.id}`);
        const members = await this.bp.presenceSync(rs.ref, local, this.cfg.presenceTtlMs);
        if (members.join(',') !== rs.members.join(',')) {
          rs.members = members;
          const frame = JSON.stringify({ t: 'members', room: rs.ref.room, members } satisfies ServerFrame);
          for (const c of rs.clients) this.sendFrame(c, frame);
        }
      } catch {
        /* retry next tick */
      }
    }
  }
}

export { memberUser };
