import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

export interface EdgeStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly hostedZoneDomain: string;
  readonly functionUrl: lambda.FunctionUrl;
}

/**
 * Everything that has to live in us-east-1 for CloudFront: the ACM cert,
 * the distribution itself, and the Route53 record. Must be deployed with
 * `crossRegionReferences: true` since the Function URL it fronts lives in
 * the app's home region (see bin/app.ts).
 */
export class EdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneDomain,
    });

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Function URLs require specific headers/cookies/query strings to reach
    // the origin (auth cookies included) — ALL_VIEWER_EXCEPT_HOST_HEADER is
    // AWS's recommended origin request policy for exactly this origin type.
    const dynamicBehavior: cloudfront.BehaviorOptions = {
      origin: new origins.FunctionUrlOrigin(props.functionUrl, {
        // Comfortably above the events route's ~25s polling ceiling
        // (src/app/api/jobs/[id]/events/route.ts) without needing an AWS
        // quota increase (the max configurable here without one is 60s).
        readTimeout: cdk.Duration.seconds(59),
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: dynamicBehavior,
      additionalBehaviors: {
        // Content-hashed and immutable — safe to cache aggressively at the
        // edge, unlike everything else (pages/API routes), which must never
        // be cached.
        "/_next/static/*": {
          ...dynamicBehavior,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        },
      },
      domainNames: [props.domainName],
      certificate,
    });

    new route53.ARecord(this, "AliasRecord", {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new cdk.CfnOutput(this, "SiteUrl", { value: `https://${props.domainName}` });
  }
}
