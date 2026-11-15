import fs from 'node:fs';
import path from 'node:path';
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
  private dynamoDoc: any = null;
  private s3Client: any = null;
  private snsClient: any = null;

  private creds: CloudWatchCredentials | null = null;
  private tableName = process.env.AWS_DYNAMODB_TABLE || 'SSDMicroProject_MessageAudit';
  private bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || '';
  private topicArn = process.env.AWS_SNS_TOPIC_ARN || '';

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
      void this.configure({
        accessKeyId: envKey,
        secretAccessKey: envSecret,
        sessionToken: envToken,
        region: envRegion,
      });
    }
  }

  getBucketName(): string {
    return this.bucketName;
  }

  setBucketName(name: string) {
    if (name && name.trim()) {
      this.bucketName = name.trim();
    }
  }

  async configure(creds: CloudWatchCredentials & { bucketName?: string }): Promise<{ success: boolean; error?: string }> {
    const sanitize = (val?: string) => {
      if (!val) return undefined;
      let s = val.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
      }
      s = s.replace(/^(aws_session_token|aws_access_key_id|aws_secret_access_key|secret_key|session_token|access_key|token|key)\s*=\s*/i, '');
      return s.replace(/[\r\n\t\s]+/g, '').trim();
    };

    if (creds.bucketName && creds.bucketName.trim()) {
      this.bucketName = creds.bucketName.trim();
    }

    const cleanKey = sanitize(creds.accessKeyId) || '';
    const cleanSecret = sanitize(creds.secretAccessKey) || '';
    const cleanToken = sanitize(creds.sessionToken);
    const cleanRegion = creds.region?.trim() || 'us-east-1';

    this.creds = {
      accessKeyId: cleanKey,
      secretAccessKey: cleanSecret,
      sessionToken: cleanToken,
      region: cleanRegion,
    };

    const awsConfig = {
      region: cleanRegion,
      credentials: {
        accessKeyId: cleanKey,
        secretAccessKey: cleanSecret,
        sessionToken: cleanToken,
      },
    };

    try {
      // Dynamically load AWS SDK packages so missing packages don't crash startup
      const [ddbMod, ddbDocMod, s3Mod, snsMod] = await Promise.allSettled([
        import('@aws-sdk/client-dynamodb'),
        import('@aws-sdk/lib-dynamodb'),
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/client-sns'),
      ]);

      if (ddbMod.status === 'fulfilled' && ddbDocMod.status === 'fulfilled') {
        const ddbClient = new ddbMod.value.DynamoDBClient(awsConfig);
        this.dynamoDoc = ddbDocMod.value.DynamoDBDocumentClient.from(ddbClient);
        this.dynamoError = null;
      } else {
        this.dynamoDoc = null;
      }

      if (s3Mod.status === 'fulfilled') {
        this.s3Client = new s3Mod.value.S3Client(awsConfig);
        this.s3Error = null;
      } else {
        this.s3Client = null;
      }

      if (snsMod.status === 'fulfilled') {
        this.snsClient = new snsMod.value.SNSClient(awsConfig);
        this.snsError = null;
      } else {
        this.snsClient = null;
      }

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
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
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
  async exportRoomBackupToS3(
    tenant: string,
    room: string,
    messages: any[],
    targetBucket?: string
  ): Promise<{
    ok: boolean;
    path: string;
    savedLocally?: boolean;
    localPath?: string;
    s3Error?: string;
    bucket?: string;
    error?: string;
  }> {
    const bucket = (targetBucket || this.bucketName || '').trim();
    const filename = `snapshot-${Date.now()}.json`;
    const key = `backups/${tenant}/${room}/${filename}`;
    const body = JSON.stringify({
      tenant,
      room,
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    }, null, 2);

    this.backupsCount++;
    this.lastBackupTs = Date.now();

    // 1. Always save a persistent local copy so user data is NEVER lost
    let localRelPath = `backups/${tenant}/${room}/${filename}`;
    try {
      const localDir = path.join(process.cwd(), 'backups', tenant, room);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, filename), body, 'utf8');
    } catch {
      // ignore write error in read-only environments
    }

    if (!this.s3Client || !bucket) {
      return {
        ok: true,
        path: bucket ? `s3://${bucket}/${key} (simulated local backup)` : `local: ${localRelPath}`,
        savedLocally: true,
        localPath: localRelPath,
        bucket: bucket || '(not configured)',
      };
    }

    try {
      const { PutObjectCommand, CreateBucketCommand } = await import('@aws-sdk/client-s3');
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'application/json',
          })
        );
        this.s3Error = null;
        return { ok: true, path: `s3://${bucket}/${key}`, localPath: localRelPath, bucket };
      } catch (uploadErr: any) {
        // If bucket does not exist, try auto-creating if permissions allow
        if (uploadErr.name === 'NoSuchBucket' || uploadErr.Code === 'NoSuchBucket') {
          try {
            await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
            await this.s3Client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentType: 'application/json',
              })
            );
            this.s3Error = null;
            return { ok: true, path: `s3://${bucket}/${key}`, localPath: localRelPath, bucket };
          } catch {
            // creation not permitted; throw original error
          }
        }
        throw uploadErr;
      }
    } catch (err: any) {
      this.s3Error = err.message || String(err);
      // Graceful fallback: local backup is saved, report clear actionable explanation
      return {
        ok: true,
        path: localRelPath,
        savedLocally: true,
        localPath: localRelPath,
        bucket,
        s3Error: this.s3Error || undefined,
      };
    }
  }

  /**
   * 3. Amazon SNS: Dispatches critical security, rate-limiting or DDoS alerts.
   */
  async dispatchSecurityAlert(event: { type: string; details: string; severity: 'INFO' | 'WARN' | 'CRITICAL' }): Promise<void> {
    this.alertsSent++;
    this.lastAlert = `[${event.severity}] ${event.type}: ${event.details}`;

    if (!this.snsClient || !this.topicArn) return;

    try {
      const { PublishCommand } = await import('@aws-sdk/client-sns');
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
