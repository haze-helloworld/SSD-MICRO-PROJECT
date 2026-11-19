// Ambient module declarations for AWS SDK packages so VS Code and TypeScript
// never complain with TS2307 when running outside of Docker or with partial node_modules.

declare module '@aws-sdk/client-dynamodb' {
  export const DynamoDBClient: any;
  export const CreateTableCommand: any;
  export const DescribeTableCommand: any;
}

declare module '@aws-sdk/lib-dynamodb' {
  export const DynamoDBDocumentClient: any;
  export const PutCommand: any;
  export const QueryCommand: any;
}

declare module '@aws-sdk/client-s3' {
  export const S3Client: any;
  export const PutObjectCommand: any;
  export const GetObjectCommand: any;
  export const CreateBucketCommand: any;
}

declare module '@aws-sdk/client-sns' {
  export const SNSClient: any;
  export const PublishCommand: any;
  export const CreateTopicCommand: any;
}

declare module '@aws-sdk/client-cloudwatch' {
  export const CloudWatchClient: any;
  export const PutMetricDataCommand: any;
  export const GetMetricDataCommand: any;
  export type MetricDatum = any;
}

