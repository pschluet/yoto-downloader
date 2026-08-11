import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/**
 * Stateful resources: the job/track table, the finished-file bucket, and the
 * per-track work queue. Kept in their own stack since these almost never
 * change shape once running, unlike the Lambda function stacks that deploy
 * on every push to main.
 */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly bucket: s3.Bucket;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, "JobsTable", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.bucket = new s3.Bucket(this, "FilesBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.deadLetterQueue = new sqs.Queue(this, "TracksDeadLetterQueue", {
      retentionPeriod: cdk.Duration.days(4),
    });

    this.queue = new sqs.Queue(this, "TracksQueue", {
      // A bit longer than the worker Lambda's own timeout (see
      // worker-stack.ts), per SQS's guidance that visibility timeout should
      // exceed the consumer's processing time.
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });
  }
}
