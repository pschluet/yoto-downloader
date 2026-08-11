import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface GithubDeployStackProps extends cdk.StackProps {
  /** e.g. "pschluet/yoto-downloader" */
  readonly githubRepo: string;
}

const OIDC_PROVIDER_ARN_SUFFIX = "oidc-provider/token.actions.githubusercontent.com";

/**
 * The one stack in this app that's deployed manually, once, before the
 * pipeline can run at all (chicken-and-egg: the pipeline needs a role to
 * assume before it can deploy anything, including this role). Mirrors this
 * account's existing `secure-transfer-github-deploy` role exactly: the
 * OIDC provider itself already exists account-wide, so this only adds a
 * new role scoped to this repo, trusting CDK's own bootstrap roles to do
 * the actual deploying rather than granting broad permissions directly.
 */
export class GithubDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);

    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GithubOidcProvider",
      `arn:aws:iam::${this.account}:${OIDC_PROVIDER_ARN_SUFFIX}`,
    );

    const role = new iam.Role(this, "GithubDeployRole", {
      roleName: "yoto-downloader-github-deploy",
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": `repo:${props.githubRepo}:*`,
        },
      }),
      description: "Assumed by GitHub Actions (OIDC) to run `cdk deploy` for yoto-downloader.",
    });

    // CDK's own bootstrap roles (created once per account/region by `cdk
    // bootstrap`, already done here) hold the actual CloudFormation/asset
    // publishing permissions — this role just needs to be allowed to
    // assume them, not to touch AWS resources directly.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [`arn:aws:cloudformation:*:${this.account}:stack/CDKToolkit/*`],
      }),
    );

    new cdk.CfnOutput(this, "RoleArn", { value: role.roleArn });
  }
}
