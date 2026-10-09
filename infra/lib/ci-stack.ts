import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CiStackProps extends cdk.StackProps {
  /** 'owner/repo' on GitHub, for descriptions and outputs. */
  readonly repository: string;
  /**
   * The prefix of the OIDC `sub` claim this repository actually presents.
   *
   * Not `repo:owner/name`, which is what every guide shows and what this
   * started as. GitHub has **immutable subject claims** on, so the claim
   * carries numeric ids instead:
   *
   *   repo:amos-dev1@331334617/flightsquare@1378642522:ref:refs/heads/main
   *
   * That is strictly better — a subject pinned to ids survives a rename and
   * cannot be claimed by somebody who deletes the repository and recreates
   * the name — and it means a trust policy written against the names can
   * never match. It fails as `Not authorized to perform
   * sts:AssumeRoleWithWebIdentity`, and CloudTrail redacts the claim on a
   * denied exchange, so the policy looks correct from every angle except the
   * one that counts.
   *
   * Read it back with:
   *   gh api repos/<owner>/<name>/actions/oidc/customization/sub
   */
  readonly subjectPrefix: string;
  /** Which branch may deploy. One, deliberately. */
  readonly branch: string;
  /** The CDK bootstrap qualifier, from the CDKToolkit stack. */
  readonly qualifier: string;
}

/**
 * What GitHub Actions is allowed to do in this account.
 *
 * Its own stack, not part of FlightSquareStack, because this is the role that
 * *deploys* that stack: defining it there would mean a bad deploy could remove
 * the credentials needed to fix it. This one changes about once a year.
 *
 * No access keys anywhere. GitHub mints a short-lived OIDC token per job, AWS
 * exchanges it for temporary credentials, and the trust policy below decides
 * who may do that — so there is no secret in the repository to leak, rotate or
 * forget.
 */
export class CiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    /*
      One provider per account; GitHub's issuer is fixed.

      `thumbprintList` is required by the API and is no longer what AWS checks
      for this issuer — it verifies the certificate chain against its own
      trust store. The documented value is kept so the resource is accepted
      and nobody has to wonder why it is blank.
    */
    const provider = new iam.CfnOIDCProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
      thumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    /*
      The condition is the whole security boundary, and `sub` is the part that
      matters: without it, *any* GitHub repository in the world could assume
      this role, because they all present tokens from the same issuer.

      Pinned to one branch of one repository. A pull request from a fork
      produces `repo:owner/name:pull_request`, which does not match — so a
      stranger opening a PR cannot deploy, which is the attack this shape of
      trust policy exists to prevent. Production is a different account with no
      role at all yet, by request.
    */
    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'flightsquare-ci-deploy',
      description: `GitHub Actions deploys ${props.repository}@${props.branch}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.FederatedPrincipal(
        provider.attrArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `${props.subjectPrefix}:ref:refs/heads/${props.branch}`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    /*
      CDK does not deploy with these credentials — it assumes the bootstrap
      roles and works through those. So the broad permissions a deploy needs
      live there, already scoped by the bootstrap, and this role only needs to
      be allowed to step into them. That is why there is no `*` on
      cloudformation or iam below.
    */
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-${props.qualifier}-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${props.qualifier}-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${props.qualifier}-image-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${props.qualifier}-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );

    // Pushing the images. GetAuthorizationToken has no resource to scope to —
    // it is the login call — but the push itself is limited to our two repos.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrLogin',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
          'ecr:BatchGetImage',
          'ecr:DescribeImages',
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/fs-dev-api`,
          `arn:aws:ecr:${this.region}:${this.account}:repository/fs-dev-web`,
        ],
      }),
    );

    /*
      Running the migrations, and reading how they ended.

      `iam:PassRole` is the one that looks alarming and is not optional: to
      start a task you must be permitted to hand ECS the roles that task runs
      as. It is scoped by the service that may receive them, so this cannot be
      used to attach those roles to anything else.
    */
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunMigrations',
        actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:ListTasks'],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': `arn:aws:ecs:${this.region}:${this.account}:cluster/fs-dev-tasks` } },
      }),
    );
    /*
      Reading the task definition, for the log group the migration output goes
      to, and then reading that log.

      Separate from the statement above because `ecs:DescribeTaskDefinition`
      does not support the `ecs:cluster` condition key — a task definition is
      not attached to a cluster — so folding it in there silently denies it.
      Both of these were missing until a policy simulation said so, and the
      failure would have landed on the one step that exists to turn a bad
      migration red.
    */
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTaskDefinition',
        actions: ['ecs:DescribeTaskDefinition'],
        // No resource-level permissions for this action; `*` is the only
        // thing AWS accepts, and it reveals task definitions in this account
        // and nothing else.
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadMigrationLogs',
        actions: ['logs:GetLogEvents', 'logs:DescribeLogStreams'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:FlightSquareDev-*:*`],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassTaskRoles',
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/FlightSquareDev-*`],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );

    // The deploy script reads stack outputs — the migration task's definition,
    // its subnets and security group, and the digest of whichever image it is
    // not rebuilding.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/FlightSquareDev/*`],
      }),
    );

    new cdk.CfnOutput(this, 'RoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'TrustedSubject', {
      value: `${props.subjectPrefix}:ref:refs/heads/${props.branch}`,
    });
  }
}
