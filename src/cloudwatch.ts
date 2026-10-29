import {
  CloudWatchClient,
  PutMetricDataCommand,
  GetMetricDataCommand,
  type MetricDatum,
} from '@aws-sdk/client-cloudwatch';

export interface CloudWatchCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

export interface MetricSnapshot {
  timestamp: number;
  requestsTotal: number;
  requestsPerSec: number;
  activeConnections: number;
  deliveryLatencyMs: number;
  rateLimitedCount: number;
  gapsFilledCount: number;
  redisOpsCount: number;
}

export class CloudWatchService {
  private client: CloudWatchClient | null = null;
  private creds: CloudWatchCredentials | null = null;
  private namespace = 'SSDMicroProject/ChatCluster';
  private metricBuffer: MetricSnapshot[] = [];
  private maxBufferSize = 120; // 20 minutes of 10s intervals
  private flushTimer: NodeJS.Timeout | null = null;
  private lastRequests = 0;
  private lastFlush = Date.now();
  private awsConnected = false;
  private lastAwsError: string | null = null;
  private lastAwsSyncTime: number | null = null;

  constructor() {
    // Check if environment variables already contain AWS credentials
    const envKey = process.env.AWS_ACCESS_KEY_ID;
    const envSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const envToken = process.env.AWS_SESSION_TOKEN;
    const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

    if (envKey && envSecret) {
      this.configure({
        accessKeyId: envKey,
        secretAccessKey: envSecret,
        sessionToken: envToken,
        region: envRegion,
      });
    }

    // Start background telemetry tick (runs every 5 seconds)
    this.flushTimer = setInterval(() => void this.telemetryTick(), 5000);
    this.flushTimer.unref();
  }

  configure(creds: CloudWatchCredentials) {
    this.creds = creds;
    try {
      this.client = new CloudWatchClient({
        region: creds.region || 'us-east-1',
        credentials: {
          accessKeyId: creds.accessKeyId.trim(),
          secretAccessKey: creds.secretAccessKey.trim(),
          sessionToken: creds.sessionToken?.trim() || undefined,
        },
      });
      this.lastAwsError = null;
      return { success: true };
    } catch (err: any) {
      this.lastAwsError = err.message || String(err);
      this.awsConnected = false;
      return { success: false, error: this.lastAwsError };
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string; error?: string }> {
    if (!this.client || !this.creds) {
      return {
        success: false,
        message: 'No AWS credentials configured yet.',
        error: 'Missing AWS credentials',
      };
    }

    try {
      // Send a test metric datum to verify credentials and permissions
      const command = new PutMetricDataCommand({
        Namespace: this.namespace,
        MetricData: [
          {
            MetricName: 'Heartbeat',
            Value: 1,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Environment', Value: 'LearnerLab' },
              { Name: 'Service', Value: 'BackstageGateway' },
            ],
            Timestamp: new Date(),
          },
        ],
      });

      await this.client.send(command);
      this.awsConnected = true;
      this.lastAwsError = null;
      this.lastAwsSyncTime = Date.now();
      return {
        success: true,
        message: `Successfully connected to AWS CloudWatch (${this.creds.region}) and published heartbeat metric!`,
      };
    } catch (err: any) {
      this.awsConnected = false;
      this.lastAwsError = err.message || String(err);
      return {
        success: false,
        message: 'Failed to put metric to AWS CloudWatch.',
        error: this.lastAwsError || 'Unknown error',
      };
    }
  }

  recordSnapshot(snap: Omit<MetricSnapshot, 'timestamp' | 'requestsPerSec'>) {
    const now = Date.now();
    const elapsedSec = Math.max(1, (now - this.lastFlush) / 1000);
    const rps = Math.max(0, Math.round(((snap.requestsTotal - this.lastRequests) / elapsedSec) * 10) / 10);
    this.lastRequests = snap.requestsTotal;
    this.lastFlush = now;

    const fullSnap: MetricSnapshot = {
      ...snap,
      timestamp: now,
      requestsPerSec: rps,
    };

    this.metricBuffer.push(fullSnap);
    if (this.metricBuffer.length > this.maxBufferSize) {
      this.metricBuffer.shift();
    }

    return fullSnap;
  }

  private async telemetryTick() {
    if (this.metricBuffer.length === 0) return;
    const latest = this.metricBuffer[this.metricBuffer.length - 1];

    if (this.client && this.creds) {
      try {
        const metricData: MetricDatum[] = [
          {
            MetricName: 'RequestsPerSec',
            Value: latest.requestsPerSec,
            Unit: 'Count/Second',
            Dimensions: [{ Name: 'Cluster', Value: 'DiscordChat' }],
            Timestamp: new Date(),
          },
          {
            MetricName: 'ActiveConnections',
            Value: latest.activeConnections,
            Unit: 'Count',
            Dimensions: [{ Name: 'Cluster', Value: 'DiscordChat' }],
            Timestamp: new Date(),
          },
          {
            MetricName: 'DeliveryLatency',
            Value: latest.deliveryLatencyMs,
            Unit: 'Milliseconds',
            Dimensions: [{ Name: 'Cluster', Value: 'DiscordChat' }],
            Timestamp: new Date(),
          },
          {
            MetricName: 'RateLimitedRequests',
            Value: latest.rateLimitedCount,
            Unit: 'Count',
            Dimensions: [{ Name: 'Cluster', Value: 'DiscordChat' }],
            Timestamp: new Date(),
          },
        ];

        const cmd = new PutMetricDataCommand({
          Namespace: this.namespace,
          MetricData: metricData,
        });

        await this.client.send(cmd);
        this.awsConnected = true;
        this.lastAwsSyncTime = Date.now();
        this.lastAwsError = null;
      } catch (err: any) {
        this.awsConnected = false;
        this.lastAwsError = err.message || String(err);
      }
    }
  }

  getMetrics() {
    return {
      awsConnected: this.awsConnected,
      lastAwsError: this.lastAwsError,
      lastAwsSyncTime: this.lastAwsSyncTime,
      region: this.creds?.region || 'us-east-1',
      hasCredentials: Boolean(this.creds?.accessKeyId && this.creds?.secretAccessKey),
      hasSessionToken: Boolean(this.creds?.sessionToken),
      namespace: this.namespace,
      dataPoints: this.metricBuffer,
    };
  }

  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

