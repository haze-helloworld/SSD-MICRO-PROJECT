import { randomUUID } from 'node:crypto';

export interface TraceHop {
  from: string;
  to: string;
  protocol: 'HTTP' | 'WSS' | 'TCP' | 'REDIS' | 'AWS-SDK';
  latencyMs: number;
  status: 'ok' | 'throttled' | 'error' | 'repaired';
  description: string;
}

export interface RequestTrace {
  id: string;
  timestamp: number;
  client: string;
  room: string;
  type: 'msg' | 'join' | 'ping' | 'auth';
  status: 'delivered' | 'rate_limited' | 'gap_filled' | 'failed';
  totalLatencyMs: number;
  gatewayNode: string;
  hops: TraceHop[];
}

export interface SimulationConfig {
  clients: number;
  ratePerSec: number; // messages per second total
  pattern: 'steady' | 'spike' | 'ddos' | 'chaos';
  rooms: string[];
}

export class SimulationManager {
  private active = false;
  private timer: NodeJS.Timeout | null = null;
  private traces: RequestTrace[] = [];
  private maxTraces = 60;
  private config: SimulationConfig = {
    clients: 10,
    ratePerSec: 5,
    pattern: 'steady',
    rooms: ['general', 'random', 'dev'],
  };
  private stats = {
    totalSent: 0,
    totalDelivered: 0,
    totalThrottled: 0,
    totalErrors: 0,
    avgLatencyMs: 12,
  };

  constructor(private triggerMessage: (user: string, room: string, text: string) => Promise<{ ok: boolean; node: string; seq?: number; error?: string }>) {}

  start(cfg?: Partial<SimulationConfig>) {
    if (cfg) {
      this.config = { ...this.config, ...cfg };
    }
    this.stop();
    this.active = true;

    const intervalMs = Math.max(50, Math.floor(1000 / Math.max(1, this.config.ratePerSec)));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();

    return this.getStatus();
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.getStatus();
  }

  async triggerSpike(count = 50) {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(this.tick(true));
    }
    await Promise.all(promises);
    return this.getStatus();
  }

  recordTrace(trace: RequestTrace) {
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
  }

  getTraces() {
    return this.traces;
  }

  getStatus() {
    return {
      active: this.active,
      config: this.config,
      stats: this.stats,
      recentTracesCount: this.traces.length,
    };
  }

  private async tick(isSpike = false) {
    if (!this.active && !isSpike) return;

    this.stats.totalSent++;
    const clientId = `sim-bot-${Math.floor(Math.random() * this.config.clients) + 1}`;
    const room = this.config.rooms[Math.floor(Math.random() * this.config.rooms.length)];
    const textSample = [
      'Checking service latency via API Gateway',
      'Benchmark payload packet',
      'Testing linear sequence ordering in Redis backplane',
      'Observability telemetry stream ping',
      'Simulated user message #linearizable',
    ];
    const text = textSample[Math.floor(Math.random() * textSample.length)];

    const traceId = randomUUID().slice(0, 8);
    const startTime = Date.now();
    const hops: TraceHop[] = [];

    // Hop 1: Client -> API Gateway (Auth & Ingress)
    const hop1Latency = Math.floor(Math.random() * 4) + 1;
    hops.push({
      from: 'Client Fleet',
      to: 'API Gateway / Ingress',
      protocol: 'WSS',
      latencyMs: hop1Latency,
      status: 'ok',
      description: `JWT authentication verified for ${clientId}`,
    });

    // Hop 2: API Gateway -> Load Balancer
    const hop2Latency = Math.floor(Math.random() * 3) + 1;
    hops.push({
      from: 'API Gateway / Ingress',
      to: 'Network Load Balancer',
      protocol: 'TCP',
      latencyMs: hop2Latency,
      status: 'ok',
      description: 'Layer 4 TCP flow-hash distribution',
    });

    // Handle DDoS/Spike pattern throttling demonstration
    const isThrottled = this.config.pattern === 'ddos' && Math.random() < 0.35;

    if (isThrottled) {
      this.stats.totalThrottled++;
      hops.push({
        from: 'Network Load Balancer',
        to: 'Gateway Cluster',
        protocol: 'TCP',
        latencyMs: 1,
        status: 'throttled',
        description: 'TokenBucket rate-limit exceeded (HTTP 429)',
      });

      this.recordTrace({
        id: traceId,
        timestamp: startTime,
        client: clientId,
        room,
        type: 'msg',
        status: 'rate_limited',
        totalLatencyMs: hop1Latency + hop2Latency + 1,
        gatewayNode: 'gw-ingress',
        hops,
      });
      return;
    }

    try {
      const res = await this.triggerMessage(clientId, room, text);
      const gwNode = res.node || 'gw-1';

      // Hop 3: Load Balancer -> Specific Gateway Node
      const hop3Latency = Math.floor(Math.random() * 5) + 2;
      hops.push({
        from: 'Network Load Balancer',
        to: gwNode,
        protocol: 'TCP',
        latencyMs: hop3Latency,
        status: 'ok',
        description: `Routed to node ${gwNode} (readyz: 200 OK)`,
      });

      // Hop 4: Gateway Node -> Redis Backplane
      const hop4Latency = Math.floor(Math.random() * 6) + 3;
      hops.push({
        from: gwNode,
        to: 'Redis Backplane',
        protocol: 'REDIS',
        latencyMs: hop4Latency,
        status: 'ok',
        description: `Atomic Lua script executed: INCR seq=#${res.seq ?? 1} + XADD stream + PUBLISH`,
      });

      // Hop 5: Redis Backplane -> AWS CloudWatch & Multi-Cloud Store
      const hop5Latency = Math.floor(Math.random() * 8) + 4;
      hops.push({
        from: 'Redis Backplane',
        to: 'AWS CloudWatch & Store',
        protocol: 'AWS-SDK',
        latencyMs: hop5Latency,
        status: 'ok',
        description: 'PutMetricData telemetry batch and audit persistence',
      });

      const totalLatency = hop1Latency + hop2Latency + hop3Latency + hop4Latency + hop5Latency;
      this.stats.totalDelivered++;
      this.stats.avgLatencyMs = Math.round((this.stats.avgLatencyMs * 0.9) + (totalLatency * 0.1));

      this.recordTrace({
        id: traceId,
        timestamp: startTime,
        client: clientId,
        room,
        type: 'msg',
        status: 'delivered',
        totalLatencyMs: totalLatency,
        gatewayNode: gwNode,
        hops,
      });
    } catch (err: any) {
      this.stats.totalErrors++;
      hops.push({
        from: 'Gateway Cluster',
        to: 'Redis Backplane',
        protocol: 'REDIS',
        latencyMs: 10,
        status: 'error',
        description: err.message || 'Backplane publish error',
      });

      this.recordTrace({
        id: traceId,
        timestamp: startTime,
        client: clientId,
        room,
        type: 'msg',
        status: 'failed',
        totalLatencyMs: hop1Latency + hop2Latency + 10,
        gatewayNode: 'cluster',
        hops,
      });
    }
  }
}

