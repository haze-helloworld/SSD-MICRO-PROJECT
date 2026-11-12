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
    awsExtra?: {
      dynamoArchived: number;
      s3Backups: number;
      s3Bucket?: string;
      snsAlerts: number;
    };
  }): ServiceHealth[] {
    const extra = context.awsExtra || { dynamoArchived: 0, s3Backups: 0, s3Bucket: 'ssd-chat-backups-948302796328', snsAlerts: 0 };
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
        name: 'Amazon DynamoDB (Audit Archive)',
        type: 'Storage',
        status: context.awsConnected ? 'healthy' : 'standby',
        latencyMs: context.awsConnected ? 12 : 3.4,
        costTier: 'AWS Free Tier',
        details: 'Durable immutable archive of message sequences with tenant partition key',
        metrics: {
          'Table': 'SSDMicroProject_MessageAudit',
          'Archived Items': extra.dynamoArchived,
          'Retention TTL': '7 Days',
        },
      },
      {
        id: 's3-backup',
        name: 'Amazon S3 (Transcript & Media Vault)',
        type: 'Storage',
        status: context.awsConnected ? 'healthy' : 'standby',
        latencyMs: context.awsConnected ? 22 : 4.0,
        costTier: 'AWS Free Tier',
        details: 'Cloud storage bucket storing full JSON transcripts and chat attachments',
        metrics: {
          'Bucket': extra.s3Bucket || 'ssd-chat-backups-948302796328',
          'Snapshots Saved': extra.s3Backups,
          'Access Mode': 'Pre-signed URL / Private',
        },
      },
      {
        id: 'sns-alerts',
        name: 'Amazon SNS (Threat & DDoS Alerting)',
        type: 'AWS',
        status: context.awsConnected ? 'healthy' : 'standby',
        latencyMs: context.awsConnected ? 18 : 2.5,
        costTier: 'AWS Free Tier',
        details: 'Publishes security event notifications for DDoS bursts, token bucket limits, and anomalies',
        metrics: {
          'Topic': 'SSDMicroProject_Alerts',
          'Alerts Published': extra.snsAlerts,
          'Subscribers': 'Email / Pager / SecOps',
        },
      },
    ];
  }
}

