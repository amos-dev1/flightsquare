import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apprunner from '@aws-cdk/aws-apprunner-alpha';

/**
 * FlightSquare dev environment.
 *
 * COST SHAPE (us-east-1, approximate — verify against current pricing):
 *   RDS db.t4g.small single-AZ, 20GB gp3   ~$23/mo  (Postgres 18; micro is not
 *     offered for RDS PostgreSQL in us-east-1 — see the instance type below)
 *   App Runner 0.25 vCPU / 0.5GB            ~$5-25/mo depending on active time
 *   S3 + ECR + Secrets Manager              ~$2/mo
 *   NAT Gateway                              $0  <- deliberately absent
 *
 * NO NAT GATEWAY. A NAT costs ~$32/mo, more than the rest of this stack
 * combined. The consequence: the API can reach RDS and S3, but has NO
 * outbound internet. Outbound third-party calls (Stripe API, SMTP) will
 * fail. When you need them, either add a NAT here or move those calls to
 * a Lambda in the public subnet. Inbound Stripe webhooks are unaffected —
 * they arrive at App Runner's public endpoint.
 */
export interface FlightSquareStackProps extends cdk.StackProps {
  /** 'dev' | 'prod'. Controls retention, deletion protection, sizing. */
  readonly envName: string;
  /** Image tag in ECR to deploy. Defaults to 'latest'. */
  readonly imageTag?: string;
}

export class FlightSquareStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FlightSquareStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';
    const prefix = `fs-${props.envName}`;

    // ---------------------------------------------------------------
    // Network
    // ---------------------------------------------------------------
    // PUBLIC subnets exist only so the migration task can pull its image
    // from ECR without a NAT. RDS lives in PRIVATE_ISOLATED and is never
    // reachable from the internet.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // S3 gateway endpoint is free and lets the API reach the attachments
    // bucket without egress. Do NOT replace this with a NAT.
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    /*
      SES, privately, instead of a NAT gateway.

      The mail worker is the only thing here that talks to an AWS API over the
      network rather than through a managed integration, and with no NAT it has
      no route to `email.us-east-1.amazonaws.com`. An interface endpoint is
      about $7/month per availability zone against $32/month for a NAT, and the
      traffic never leaves AWS.

      One subnet, not two, which is the whole of the price difference. The ENI
      is reachable from the other AZ across the VPC, so this costs a fraction
      of a cent in cross-AZ transfer and an availability zone's worth of
      redundancy the dev environment does not need. Prod should list both.

      `privateDnsEnabled` is the part that makes it invisible to the
      application: the service registers both `email.us-east-1.api.aws` and
      `email.us-east-1.amazonaws.com` as private DNS names, so the SDK's
      default endpoint resolves to this ENI and `SesTransport` needs no
      endpoint override. Without it the SDK would resolve the public address
      and hang until it timed out.
    */
    const sesEndpoint = new ec2.InterfaceVpcEndpoint(this, 'SesEndpoint', {
      vpc,
      /*
        `'email'`, written out, and NOT `InterfaceVpcEndpointAwsService.SES`.

        That constant resolves to `email-smtp`, which is the SMTP submission
        endpoint. `SesTransport` uses the v2 HTTPS API through
        `@aws-sdk/client-sesv2`, whose endpoint is `com.amazonaws.<region>.email`
        — a different service. Using the constant creates a real endpoint for
        the wrong protocol: nothing errors, the SDK's address simply never
        resolves privately, and with no NAT every send hangs until it times out.

        `email-smtp` is also offered in us-east-1a, 1c and 1d only, while this
        VPC is in 1a and 1b, so the constant would have failed outright in the
        second availability zone.
      */
      service: new ec2.InterfaceVpcEndpointAwsService('email'),
      subnets: { subnets: isProd ? vpc.publicSubnets : [vpc.publicSubnets[0]] },
      privateDnsEnabled: true,
      open: false,
    });

    // ---------------------------------------------------------------
    // Database role credentials
    // ---------------------------------------------------------------
    // Three roles per CLAUDE.md §9: the owner (RDS master, used only by
    // migrations), app_role (the application), admin_role (control plane).
    //
    // CDK generates the app_role and admin_role passwords here; the
    // migrations read these secrets and CREATE ROLE with them. That
    // ordering matters — the secrets must exist before migrations run.
    const mkRoleSecret = (name: string) =>
      new secretsmanager.Secret(this, `${name}Secret`, {
        secretName: `${prefix}/db/${name}`,
        description: `FlightSquare ${props.envName} ${name} database credentials`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: name }),
          generateStringKey: 'password',
          excludePunctuation: true, // keeps libpq connection strings simple
          passwordLength: 32,
        },
      });

    const appRoleSecret = mkRoleSecret('app_role');
    const adminRoleSecret = mkRoleSecret('admin_role');
    // mail_role drains the outbox. Until this existed, `scripts/roles.sh` gave
    // it `unknowable()` — a random password nobody keeps — so the role existed
    // and nothing could log in as it.
    const mailRoleSecret = mkRoleSecret('mail_role');

    // ---------------------------------------------------------------
    // Database
    // ---------------------------------------------------------------
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'FlightSquare Postgres',
      allowAllOutbound: false,
    });

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        /*
          18, not 16, and this is not a preference.

          `db/migrations/0001_foundation.sql` opens by refusing to run on
          anything older: `RAISE EXCEPTION 'PostgreSQL 18+ required for
          uuidv7()'`. Every primary key in the schema is `DEFAULT uuidv7()`,
          which is a PostgreSQL 18 built-in — so on 16.4 the very first
          migration stops dead and the database cannot be created at all.

          `PostgresEngineVersion.of` because this CDK version's enum stops at
          VER_18_3; 18.6 is what RDS offers in us-east-1 and what local
          development runs, which is the version worth matching.
        */
        version: rds.PostgresEngineVersion.of('18.6', '18'),
      }),
      // db.t4g.small in both environments, and the ternary is gone because
      // there is nothing to choose between: **db.t4g.micro is not offered for
      // RDS PostgreSQL in us-east-1 at all** — no engine version, no storage
      // type, no AZ. The first deploy failed on it with "no Availability Zones
      // with sufficient capacity", which reads like a transient shortage and
      // is not one.
      //
      // Dev therefore matches prod exactly, which is worth the ~$10/mo on its
      // own: a dev database on the same family and size actually exercises
      // what prod will do.
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.SMALL,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      publiclyAccessible: false,
      multiAz: isProd,
      allocatedStorage: 20,
      maxAllocatedStorage: isProd ? 200 : 50,
      storageType: rds.StorageType.GP3,
      // Encrypted at rest, with the default aws/rds key.
      //
      // Set now because it cannot be set later: enabling encryption on an
      // existing instance means snapshot, copy-with-encryption, restore and
      // repoint. Free on gp3, and this database holds member personal data and
      // the compliance records §7.2 describes as discoverable after an
      // accident.
      storageEncrypted: true,
      databaseName: 'flightsquare',
      // The master user IS the DDL/migration owner from CLAUDE.md §9.
      credentials: rds.Credentials.fromGeneratedSecret('fsowner', {
        secretName: `${prefix}/db/owner`,
      }),
      /*
        Dev may cross a major version; prod may not without someone deciding to.

        This is what moved the dev instance from 16.4 to 18.6. `cdk diff`
        predicted a replacement — the subnet group looked like it forced one —
        and CloudFormation did an in-place major upgrade instead: the instance
        reported `upgrading 16.4` and came back `available 18.6`. Without this
        flag that update would have been refused.

        Left on for dev: a database that cannot follow the engine version is a
        database that stops matching prod. Prod stays false, where a major
        upgrade should be a decision with a maintenance window attached.
      */
      allowMajorVersionUpgrade: !isProd,
      backupRetention: cdk.Duration.days(isProd ? 14 : 1),
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
      enablePerformanceInsights: isProd,
      cloudwatchLogsExports: ['postgresql'],
    });

    // ---------------------------------------------------------------
    // Attachment storage (replaces local MinIO)
    // ---------------------------------------------------------------
    const attachments = new s3.Bucket(this, 'Attachments', {
      bucketName: `${prefix}-attachments-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      cors: [
        {
          // Presigned PUT from the browser and from Expo.
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ['*'], // TIGHTEN for prod to your web origin
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // ---------------------------------------------------------------
    // Container image
    // ---------------------------------------------------------------
    // PREREQUISITE: api/ needs a Dockerfile, and an image must be pushed
    // to this repo before the App Runner service will come up healthy.
    const repository = new ecr.Repository(this, 'ApiRepo', {
      repositoryName: `${prefix}-api`,
      imageScanOnPush: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
      lifecycleRules: [{ maxImageCount: 20 }],
    });

    // ---------------------------------------------------------------
    // Migration runner
    // ---------------------------------------------------------------
    // A one-off Fargate task, in a PUBLIC subnet with a public IP so it
    // can pull from ECR with no NAT. It runs as the OWNER role; the
    // application never holds those credentials (CLAUDE.md §9).
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${prefix}-tasks`,
    });

    const migrateTask = new ecs.FargateTaskDefinition(this, 'MigrateTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    migrateTask.addContainer('migrate', {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.imageTag ?? 'latest'),
      command: ['npm', 'run', 'migrate'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'migrate',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        NODE_ENV: 'production',
        PGSSLMODE: 'require',
      },
      secrets: {
        // Owner credentials — migrations only.
        DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret!),
        // Migrations read these to CREATE ROLE with the generated passwords.
        APP_ROLE_SECRET: ecs.Secret.fromSecretsManager(appRoleSecret),
        ADMIN_ROLE_SECRET: ecs.Secret.fromSecretsManager(adminRoleSecret),
        MAIL_ROLE_SECRET: ecs.Secret.fromSecretsManager(mailRoleSecret),
      },
    });

    const migrateSg = new ec2.SecurityGroup(this, 'MigrateSg', {
      vpc,
      description: 'FlightSquare migration task',
    });
    dbSecurityGroup.addIngressRule(migrateSg, ec2.Port.tcp(5432), 'migrations');

    // ---------------------------------------------------------------
    // API service
    // ---------------------------------------------------------------
    // App Runner rather than Fargate+ALB: an ALB alone costs more than
    // this entire stack. Public HTTPS endpoint with a managed certificate,
    // which is what lets Expo Go reach it from cell data.
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc,
      description: 'FlightSquare API',
    });
    dbSecurityGroup.addIngressRule(apiSg, ec2.Port.tcp(5432), 'api');

    const vpcConnector = new apprunner.VpcConnector(this, 'VpcConnector', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [apiSg],
    });

    const instanceRole = new iam.Role(this, 'ApiInstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description: 'FlightSquare API runtime role',
    });

    // The API reads ONLY app_role's secret. It must not be able to read
    // the owner's or admin_role's — that is what keeps CLAUDE.md §1.2
    // true at the infrastructure layer, not just in code.
    appRoleSecret.grantRead(instanceRole);
    attachments.grantReadWrite(instanceRole);

    const service = new apprunner.Service(this, 'Api', {
      serviceName: `${prefix}-api`,
      source: apprunner.Source.fromEcr({
        repository,
        tagOrDigest: props.imageTag ?? 'latest',
        imageConfiguration: {
          port: 3000,
          environmentVariables: {
            NODE_ENV: 'production',
            PGSSLMODE: 'require',
            // Bind every interface. The API defaults to 127.0.0.1, which is
            // right on a laptop and fatal here: App Runner health-checks the
            // container from outside it, so a loopback listener is reachable
            // by nobody and the service never stabilises. That failure looks
            // like a crash in the console and is a perfectly healthy process
            // listening on the wrong address.
            FS_API_HOST: '0.0.0.0',
            DB_HOST: database.dbInstanceEndpointAddress,
            DB_PORT: database.dbInstanceEndpointPort,
            DB_NAME: 'flightsquare',
            // Setting the endpoint is what tells the API this is not the MinIO
            // container on loopback. It also means no storage key is passed,
            // so the SDK uses the instance role granted above.
            FS_STORAGE_ENDPOINT: `https://s3.${this.region}.amazonaws.com`,
            FS_STORAGE_REGION: this.region,
            FS_STORAGE_BUCKET: attachments.bucketName,
            AWS_REGION: this.region,
          },
          environmentSecrets: {
            APP_ROLE_SECRET: apprunner.Secret.fromSecretsManager(appRoleSecret),
          },
        },
      }),
      vpcConnector,
      instanceRole,
      cpu: apprunner.Cpu.QUARTER_VCPU,
      memory: apprunner.Memory.HALF_GB,
      autoDeploymentsEnabled: false, // CI drives deploys explicitly
      healthCheck: apprunner.HealthCheck.http({
        path: '/health', // PREREQUISITE: api/ must expose this, unauthenticated
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      }),
    });

    // ---------------------------------------------------------------
    // Mail worker
    // ---------------------------------------------------------------
    /*
      Its own service, because it is its own process by design.

      `api/src/mail/index.ts` is explicit about why: the worker connects as
      `mail_role` to a table `app_role` cannot read at all, and folding it into
      the API would put those credentials in the same process as every request
      handler — which is what the outbox split exists to avoid. So the API
      queues, and this drains.

      In a PUBLIC subnet with a public IP, matching the migration task and for
      the same reason: a Fargate task in PRIVATE_ISOLATED cannot start without
      interface endpoints for ECR (two), CloudWatch Logs and Secrets Manager,
      and four more endpoints cost more than the NAT gateway this stack is
      built to avoid. The security group opens nothing inbound, so the address
      is an exit and not an entrance — and SES itself is still reached
      privately, through the endpoint above.
    */
    const mailSg = new ec2.SecurityGroup(this, 'MailSg', {
      vpc,
      description: 'FlightSquare mail worker',
    });
    dbSecurityGroup.addIngressRule(mailSg, ec2.Port.tcp(5432), 'mail worker');
    // The endpoint was created with `open: false`, so nothing can reach it
    // until something is named. Only this worker is.
    sesEndpoint.connections.allowFrom(mailSg, ec2.Port.tcp(443), 'mail worker to SES');

    const mailTask = new ecs.FargateTaskDefinition(this, 'MailTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });

    // Sending rights live on the task role, so no mail credential exists in
    // the environment at all. Scoped to this identity: the role can send as
    // flightsquareapp.com and cannot send as anything else.
    mailTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/flightsquareapp.com`,
        ],
      }),
    );

    mailTask.addContainer('mail', {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.imageTag ?? 'latest'),
      // The compiled entry point. `npm run mail -w api` is `tsx watch`, which
      // is a development command and is not in the runtime image.
      command: ['node', 'api/dist/mail/index.js'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mail',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        NODE_ENV: 'production',
        PGSSLMODE: 'require',
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: 'flightsquare',
        FS_MAIL_PROVIDER: 'ses',
        FS_MAIL_REGION: this.region,
        FS_MAIL_FROM: isProd
          ? 'FlightSquare <no-reply@flightsquareapp.com>'
          : 'FlightSquare <dev-noreply@flightsquareapp.com>',
        AWS_REGION: this.region,
        /*
          Dev only, and the asymmetry is the point.

          SES in sandbox delivers to verified addresses only, so an invited
          member's mail goes nowhere and the CloudWatch log is the only place
          their link exists. That makes this necessary here and indefensible in
          prod, where it would write live password-reset URLs and sign-in codes
          into a log with a month's retention.
        */
        ...(isProd ? {} : { FS_MAIL_LOG_BODIES: 'true' }),
      },
      secrets: {
        // Only its own role's credentials. Not app_role's, not the owner's.
        MAIL_ROLE_SECRET: ecs.Secret.fromSecretsManager(mailRoleSecret),
      },
    });

    /*
      How many workers to run, and why it is a knob.

      The worker asserts on startup that it really connected as `mail_role`
      and exits if it did not — a good check, and a chicken-and-egg on a fresh
      environment: the password is set by the migration task, whose revision
      carrying MAIL_ROLE_SECRET only exists once this stack has been deployed.
      Deploy with the worker running and it crash-loops, the service never
      reaches steady state, and CloudFormation waits on it.

      So a first deploy passes `-c mailDesiredCount=0`, then migrations run,
      then a second deploy brings it up:

        cdk deploy FlightSquareDev -c mailDesiredCount=0   # secret + taskdef
        aws ecs run-task ... MigrateTask                   # sets the password
        cdk deploy FlightSquareDev                         # worker comes up

      It stays useful afterwards as the way to stop the sender without
      destroying it — during an SES incident, or to stop a retry storm against
      a provider having a bad hour.
    */
    const mailDesiredCount = Number(this.node.tryGetContext('mailDesiredCount') ?? 1);

    const mailService = new ecs.FargateService(this, 'MailService', {
      cluster,
      serviceName: `${prefix}-mail`,
      taskDefinition: mailTask,
      desiredCount: mailDesiredCount,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [mailSg],
      // One at a time: two workers are safe (the claim is a write — see
      // `drainOnce`) but there is nothing here worth paying twice for.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Fail in minutes rather than hours. Without it a task that cannot
      // start leaves the deployment hanging for up to three, which is how a
      // bad image turns into an afternoon.
      circuitBreaker: { rollback: false },
    });

    // ---------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${service.serviceUrl}`,
      description: 'Point EXPO_PUBLIC_API_URL at this',
    });
    new cdk.CfnOutput(this, 'EcrRepoUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: database.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'OwnerSecretArn', { value: database.secret!.secretArn });
    new cdk.CfnOutput(this, 'AttachmentsBucket', { value: attachments.bucketName });
    new cdk.CfnOutput(this, 'MigrateTaskArn', { value: migrateTask.taskDefinitionArn });
    new cdk.CfnOutput(this, 'MigrateSubnets', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'MigrateSecurityGroup', {
      value: migrateSg.securityGroupId,
    });
    new cdk.CfnOutput(this, 'MailServiceName', { value: mailService.serviceName });
    new cdk.CfnOutput(this, 'MailRoleSecretArn', { value: mailRoleSecret.secretArn });
  }
}
