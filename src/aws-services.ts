import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { CloudWatchCredentials } from './cloudwatch.js';

export interface AuditMessageRecord {
  tenant: string;
  room: string;
  seq: number;
  user: string;
  text: string;
  cid: string;
  ts: number;
  node: string;
}

export interface AwsServicesStatus {
  dynamoDb: {
    enabled: boolean;
    tableName: string;
    itemsArchived: number;
    lastError: string | null;
  };
  s3: {
    enabled: boolean;
    bucketName: string;
    backupsCount: number;
    lastBackupTs: number | null;
    lastError: string | null;
  };
  sns: {
    enabled: boolean;
    topicArn: string;
    alertsSent: number;
    lastAlert: string | null;
    lastError: string | null;
  };
}

export class AwsIntegrationsService {
  private dynamoDoc: DynamoDBDocumentClient | null = null;
  private s3Client: S3Client | null = null;
  private snsClient: SNSClient | null = null;

  private creds: CloudWatchCredentials | null = null;
  private tableName = 'SSDMicroProject_MessageAudit';
  private bucketName = 'ssd-microproject-chat-backups';
  private topicArn = 'arn:aws:sns:us-east-1:123456789012:SSDMicroProject_Alerts';

  private localAuditArchive: AuditMessageRecord[] = [];
  private itemsArchived = 0;
  private backupsCount = 0;
  private lastBackupTs: number | null = null;
  private alertsSent = 0;
  private lastAlert: string | null = null;

  private dynamoError: string | null = null;
  private s3Error: string | null = null;
  private snsError: string | null = null;

  constructor() {
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
  }

  configure(creds: CloudWatchCredentials) {
    this.creds = creds;
    const awsConfig = {
      region: creds.region || 'us-east-1',
      credentials: {
        accessKeyId: creds.accessKeyId.trim(),
        secretAccessKey: creds.secretAccessKey.trim(),
        sessionToken: creds.sessionToken?.trim() || undefined,
      },
    };

    try {
      const ddbClient = new DynamoDBClient(awsConfig);
      this.dynamoDoc = DynamoDBDocumentClient.from(ddbClient);
      this.s3Client = new S3Client(awsConfig);
      this.snsClient = new SNSClient(awsConfig);
      this.dynamoError = null;
      this.s3Error = null;
      this.snsError = null;
      return { success: true };
    } catch (err: any) {
      const msg = err.message || String(err);
      this.dynamoError = msg;
      this.s3Error = msg;
      this.snsError = msg;
      return { success: false, error: msg };
    }
  }

  /**
   * 1. DynamoDB: Asynchronously records an immutable audit log entry of every linear chat message.
   */
  async archiveMessage(record: AuditMessageRecord): Promise<void> {
    this.itemsArchived++;
    this.localAuditArchive.push(record);
    if (this.localAuditArchive.length > 500) {
      this.localAuditArchive.shift();
    }

    if (!this.dynamoDoc) return;

    try {
      await this.dynamoDoc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `${record.tenant}#${record.room}`,
            sk: record.seq,
            user: record.user,
            text: record.text,
            cid: record.cid,
            ts: record.ts,
            node: record.node,
            ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
          },
        })
      );
      this.dynamoError = null;
    } catch (err: any) {
      this.dynamoError = err.message || String(err);
    }
  }

  /**
   * 2. Amazon S3: Export room transcript & snapshots to S3 bucket.
   */
  async exportRoomBackupToS3(tenant: string, room: string, messages: any[]): Promise<{ ok: boolean; path: string; error?: string }> {
    const key = `backups/${tenant}/${room}/snapshot-${Date.now()}.json`;
    const body = JSON.stringify({
      tenant,
      room,
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    }, null, 2);

    this.backupsCount++;
    this.lastBackupTs = Date.now();

    if (!this.s3Client) {
      return { ok: true, path: `s3://${this.bucketName}/${key} (simulated local backup)` };
    }

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        })
      );
      this.s3Error = null;
      return { ok: true, path: `s3://${this.bucketName}/${key}` };
    } catch (err: any) {
      this.s3Error = err.message || String(err);
      return { ok: false, path: key, error: this.s3Error || undefined };
    }
  }

  /**
   * 3. Amazon SNS: Dispatches critical security, rate-limiting or DDoS alerts.
   */
  async dispatchSecurityAlert(event: { type: string; details: string; severity: 'INFO' | 'WARN' | 'CRITICAL' }): Promise<void> {
    this.alertsSent++;
    this.lastAlert = `[${event.severity}] ${event.type}: ${event.details}`;

    if (!this.snsClient) return;

    try {
      await this.snsClient.send(
        new PublishCommand({
          TopicArn: this.topicArn,
          Subject: `[SSD Micro-Project Alert] ${event.type}`,
          Message: JSON.stringify({
            timestamp: new Date().toISOString(),
            service: 'SSD-Gateway-Cluster',
            ...event,
          }, null, 2),
        })
      );
      this.snsError = null;
    } catch (err: any) {
      this.snsError = err.message || String(err);
    }
  }

  getStatus(): AwsServicesStatus {
    return {
      dynamoDb: {
        enabled: Boolean(this.dynamoDoc),
        tableName: this.tableName,
        itemsArchived: this.itemsArchived,
        lastError: this.dynamoError,
      },
      s3: {
        enabled: Boolean(this.s3Client),
        bucketName: this.bucketName,
        backupsCount: this.backupsCount,
        lastBackupTs: this.lastBackupTs,
        lastError: this.s3Error,
      },
      sns: {
        enabled: Boolean(this.snsClient),
        topicArn: this.topicArn,
        alertsSent: this.alertsSent,
        lastAlert: this.lastAlert,
        lastError: this.snsError,
      },
    };
  }

  getLocalAuditArchive(): AuditMessageRecord[] {
    return this.localAuditArchive;
  }
}
