import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface WebStackProps extends cdk.StackProps {
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
}

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * The Next.js app itself, run via the Lambda Web Adapter (see Dockerfile),
 * behind a Function URL with response streaming enabled — required for the
 * /api/jobs/[id]/events polling stream (see src/app/api/jobs/[id]/events/route.ts).
 */
export class WebStack extends cdk.Stack {
  public readonly functionUrl: lambda.FunctionUrl;
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    this.function = new lambda.DockerImageFunction(this, "WebFunction", {
      code: lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      // Comfortably above the events route's own ~25s polling ceiling.
      timeout: cdk.Duration.seconds(60),
      environment: {
        JOBS_TABLE_NAME: props.table.tableName,
        FILES_BUCKET_NAME: props.bucket.bucketName,
        TRACKS_QUEUE_URL: props.queue.queueUrl,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
      },
    });

    this.functionUrl = this.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    props.table.grantReadWriteData(this.function);
    // read: presigned URLs + zip streaming + admin cookie status/test (src/lib/cookies.ts);
    // write: admin cookie upload/delete (config/cookies.txt).
    props.bucket.grantReadWrite(this.function);
    props.queue.grantSendMessages(this.function);

    // Admin* Cognito APIs are privileged — scope tightly to this one pool.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:ListUsers",
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );
  }
}
