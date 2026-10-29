export interface ServiceHealth {
  id: string;
  name: string;
  type: 'AWS' | 'Infra' | 'Compute' | 'Storage' | 'Network';
  status: 'healthy' | 'degraded' | 'unhealthy' | 'standby';
  latencyMs: number;
  costTier: 'AWS Learner Lab ($50)' | 'Free Local Container' | 'AWS Free Tier';
  details: string;
  metrics: Record<string, string | number>;
}

export class ServicesRegistry {
  getServices(context: {
    nodeId: string;
    backplaneKind: string;
    backplaneUp: boolean;
    connsCount: number;
    awsConnected: boolean;
    awsRegion: string;
  }): ServiceHealth[] {
    return [
      {
        id: 'api-gateway',
        name: 'API Gateway & Ingress',
        type: 'Network',
        status: 'healthy',
        latencyMs: 1.8,
        costTier: 'AWS Free Tier',
        details: 'JWT HS256 Token authentication, tenant validation & TLS termination',
        metrics: {
          'Protocol': 'WSS / HTTP 1.1',
          'Auth Engine': 'HMAC-SHA256',
          'Tenant Isolation': 'Strict',
        },
      },
      {
        id: 'nlb',
        name: 'Network Load Balancer (NLB)',
        type: 'Network',
        status: 'healthy',
        latencyMs: 0.9,
        costTier: 'Free Local Container',
        details: 'L4 TCP flow-hash load balancer with active /readyz health checks',
        metrics: {
          'Algorithm': 'Flow-hash / Least-conn',
          'Health Interval': '3s',
          'Timeout': '350s (Keep-Alive)',
        },
      },
      {
        id: 'gw-cluster',
        name: `Gateway Cluster (${context.nodeId})`,
        type: 'Compute',
        status: 'healthy',
        latencyMs: 2.1,
        costTier: 'Free Local Container',
        details: 'Stateful WebSocket node managing client sockets, gap filling, and FIFO queues',
        metrics: {
          'Active Node': context.nodeId,
          'Local Sockets': context.connsCount,
          'State Mode': 'Ephemeral Stateful',
        },
      },
      {
        id: 'redis-backplane',
        name: 'Redis Backplane (Pub/Sub + Streams)',
        type: 'Storage',
        status: context.backplaneUp ? 'healthy' : 'unhealthy',
        latencyMs: 1.2,
        costTier: 'Free Local Container',
        details: 'Single-threaded linearization point: atomic Lua scripts for total order sequencing',
        metrics: {
          'Engine': context.backplaneKind.toUpperCase(),
          'Fast Path': 'Pub/Sub',
          'Durable Path': 'Streams (XADD)',
        },
      },
      {
        id: 'aws-cloudwatch',
        name: 'AWS CloudWatch (Learner Lab)',
        type: 'AWS',
        status: context.awsConnected ? 'healthy' : 'standby',
        latencyMs: context.awsConnected ? 28 : 0,
        costTier: 'AWS Learner Lab ($50)',
        details: 'Cloud monitoring & custom telemetry namespace: SSDMicroProject/ChatCluster',
        metrics: {
          'Namespace': 'SSDMicroProject/ChatCluster',
          'Region': context.awsRegion,
          'Status': context.awsConnected ? 'Streaming Metrics' : 'Ready (Enter Keys)',
        },
      },
      {
        id: 'dynamo-audit',
        name: 'Message Audit Store (DynamoDB / Local)',
        type: 'Storage',
        status: 'healthy',
        latencyMs: 3.4,
        costTier: 'AWS Free Tier',
        details: 'Durable archive of message sequences with idempotency key indexing',
        metrics: {
          'Partition Key': 'tenant#room',
          'Sort Key': 'seq (Number)',
          'Consistency': 'Strong Read',
        },
      },
    ];
  }
}

