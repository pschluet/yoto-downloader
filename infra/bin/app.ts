#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack";
import { DataStack } from "../lib/data-stack";
import { EdgeStack } from "../lib/edge-stack";
import { GithubDeployStack } from "../lib/github-deploy-stack";
import { WebStack } from "../lib/web-stack";
import { WorkerStack } from "../lib/worker-stack";

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT ?? "435432815368";
const region = "us-east-2";
const domainName = "yoto.pauldev.io";
const hostedZoneDomain = "pauldev.io";
const adminEmail = "paul@paulschlueter.com";
const githubRepo = "pschluet/yoto-downloader";

const env = { account, region };

const data = new DataStack(app, "YotoDataStack", { env });
const auth = new AuthStack(app, "YotoAuthStack", { env, adminEmail });

const worker = new WorkerStack(app, "YotoWorkerStack", {
  env,
  table: data.table,
  bucket: data.bucket,
  queue: data.queue,
});
worker.addStackDependency(data);

const web = new WebStack(app, "YotoWebStack", {
  env,
  crossRegionReferences: true,
  table: data.table,
  bucket: data.bucket,
  queue: data.queue,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
});
web.addStackDependency(data);
web.addStackDependency(auth);

const edge = new EdgeStack(app, "YotoEdgeStack", {
  env: { account, region: "us-east-1" }, // CloudFront/ACM certs must live here
  crossRegionReferences: true,
  domainName,
  hostedZoneDomain,
  functionUrl: web.functionUrl,
});
edge.addStackDependency(web);

// Deployed manually, once — see the class doc comment for why.
new GithubDeployStack(app, "YotoGithubDeployStack", { env, githubRepo });
