import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface WorkerStackProps extends cdk.StackProps {
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
}

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * The SQS-triggered worker that actually runs yt-dlp/ffmpeg — one message
 * per track (see src/lib/queue.ts / src/worker/handler.ts in the app).
 */
export class WorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    const fn = new lambda.DockerImageFunction(this, "WorkerFunction", {
      code: lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
        file: "Dockerfile.worker",
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      // A bit under the queue's 6-minute visibility timeout (data-stack.ts),
      // and comfortably covers the download + one 1.5s auto-retry.
      timeout: cdk.Duration.minutes(5),
      environment: {
        JOBS_TABLE_NAME: props.table.tableName,
        FILES_BUCKET_NAME: props.bucket.bucketName,
      },
    });

    // Caps how many tracks download concurrently, matching the local/Docker
    // version's in-process pool of 3.
    fn.addEventSource(
      new SqsEventSource(props.queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
        maxConcurrency: 3,
      }),
    );

    props.table.grantReadWriteData(fn);
    props.bucket.grantWrite(fn);
    // Read-only, and only under config/ — the worker needs the admin-uploaded
    // cookies.txt (see src/lib/cookies.ts) but has no business reading job files.
    props.bucket.grantRead(fn, "config/*");
  }
}
