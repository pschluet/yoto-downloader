import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface AuthStackProps extends cdk.StackProps {
  readonly adminEmail: string;
}

/**
 * Cognito User Pool gating the whole app. Login is a custom in-app form (no
 * Hosted UI/domain) calling Cognito's own InitiateAuth/RespondToAuthChallenge
 * APIs directly — see src/lib/auth.ts and src/proxy.ts in the app.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false, // only admins create accounts (AdminCreateUser)
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient("WebClient", {
      authFlows: {
        userPassword: true, // USER_PASSWORD_AUTH, called directly from src/lib/auth.ts
      },
      // REFRESH_TOKEN_AUTH is implicitly always allowed by Cognito; these
      // just set how long the issued tokens are valid for. Kept in sync
      // with REFRESH_TOKEN_MAX_AGE_SECONDS in src/lib/auth.ts.
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    const adminsGroup = new cognito.CfnUserPoolGroup(this, "AdminsGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "Admins",
    });
    new cognito.CfnUserPoolGroup(this, "UsersGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "Users",
    });

    // Provisions the initial admin at deploy time — no password in code;
    // Cognito auto-generates one and emails it, forcing a change on first
    // sign-in. Safe to redeploy: UsernameExistsException is swallowed.
    const provisionAdmin = new AwsCustomResource(this, "ProvisionAdminUser", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "adminCreateUser",
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: props.adminEmail,
          UserAttributes: [
            { Name: "email", Value: props.adminEmail },
            { Name: "email_verified", Value: "true" },
          ],
          // AdminCreateUser defaults this to SMS — since no phone number is
          // ever collected here, that would silently fail to deliver the
          // temporary password at all.
          DesiredDeliveryMediums: ["EMAIL"],
        },
        physicalResourceId: PhysicalResourceId.of(`admin-user-${props.adminEmail}`),
        ignoreErrorCodesMatching: "UsernameExistsException",
      },
      // Cognito's AdminCreateUser/AdminAddUserToGroup have been stable for
      // years — no need for the custom resource provider to fetch the
      // latest AWS SDK at deploy time, so use the one already built into
      // its Lambda runtime (faster, and one less moving part).
      installLatestAwsSdk: false,
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });

    const addAdminToGroup = new AwsCustomResource(this, "AddAdminToGroup", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "adminAddUserToGroup",
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: props.adminEmail,
          GroupName: "Admins",
        },
        physicalResourceId: PhysicalResourceId.of(`admin-group-${props.adminEmail}`),
      },
      installLatestAwsSdk: false,
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.userPool.userPoolArn] }),
    });
    addAdminToGroup.node.addDependency(provisionAdmin);
    addAdminToGroup.node.addDependency(adminsGroup);
  }
}
