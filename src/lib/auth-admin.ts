import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// Unlike src/lib/auth.ts, these are the privileged Admin* Cognito APIs —
// they act on the pool itself rather than a specific user's own session, so
// they require real IAM credentials (the web Lambda's execution role,
// scoped to this one User Pool ARN in CDK) and must run server-side only.

let clientInstance: CognitoIdentityProviderClient | undefined;

function client(): CognitoIdentityProviderClient {
  if (!clientInstance) clientInstance = new CognitoIdentityProviderClient({});
  return clientInstance;
}

function userPoolId(): string {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) throw new Error("COGNITO_USER_POOL_ID is not set.");
  return id;
}

/**
 * Creates a user with no password set — Cognito auto-generates one and
 * emails it, forcing a change on first login (FORCE_CHANGE_PASSWORD status).
 */
export async function adminCreateUser(email: string): Promise<void> {
  await client().send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId(),
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
}

export async function adminAddUserToGroup(email: string, groupName: string): Promise<void> {
  await client().send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId(),
      Username: email,
      GroupName: groupName,
    }),
  );
}

export type UserSummary = {
  email: string;
  status: string | undefined;
  enabled: boolean | undefined;
  createdAt: Date | undefined;
};

export async function listUsers(): Promise<UserSummary[]> {
  const res = await client().send(new ListUsersCommand({ UserPoolId: userPoolId(), Limit: 60 }));
  return (res.Users ?? []).map((u) => ({
    email: u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username ?? "",
    status: u.UserStatus,
    enabled: u.Enabled,
    createdAt: u.UserCreateDate,
  }));
}
