#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CiStack } from '../lib/ci-stack';
import { FlightSquareStack } from '../lib/flightsquare-stack';

const app = new cdk.App();

/*
  Which images to run, by digest.

    cdk deploy FlightSquareDev -c apiImage=sha256:… -c webImage=sha256:…

  `scripts/deploy.sh` is the usual way in: it builds, pushes, reads the digest
  each push returned and passes it here, so the thing deployed is the thing
  just built with no tag in between.

  Two values because the API and the web app are separate ECR repositories.

  'latest' remains the fallback for a manual deploy and is worth understanding
  before relying on it: a tag is a name that can be moved, so re-pushing
  `latest` leaves the rendered template byte-identical, App Runner sees no
  change to its configuration, and the previous image keeps serving. The deploy
  reports success and nothing happens — which is exactly what it did twice
  before this, and why `start-deployment` had to be remembered afterwards. A
  digest makes the image part of the template, so a new image is a changed
  template and the deployment is the pull.
*/
const apiImage =
  app.node.tryGetContext('apiImage') ?? process.env.API_IMAGE ?? 'latest';
const webImage =
  app.node.tryGetContext('webImage') ?? process.env.WEB_IMAGE ?? 'latest';
// The migration task, which runs a deploy ahead of the services so the schema
// is in place before the code that needs it. Defaults to the API's image.
const migrateImage =
  app.node.tryGetContext('migrateImage') ?? process.env.MIGRATE_IMAGE ?? apiImage;

// Account IDs are pinned deliberately rather than resolved from the
// ambient profile. This is a guardrail: `cdk deploy FlightSquareProd
// --profile flightsquare-dev` fails outright instead of quietly
// deploying production infrastructure into the dev account.
new FlightSquareStack(app, 'FlightSquareDev', {
  envName: 'dev',
  apiImage,
  webImage,
  migrateImage,
  env: { account: '102378189980', region: 'us-east-1' },
  description: 'FlightSquare dev environment',
  tags: {
    Project: 'FlightSquare',
    Environment: 'dev',
    ManagedBy: 'cdk',
  },
});

new FlightSquareStack(app, 'FlightSquareProd', {
  envName: 'prod',
  apiImage,
  webImage,
  migrateImage,
  env: { account: '363434191112', region: 'us-east-1' },
  description: 'FlightSquare production environment',
  tags: {
    Project: 'FlightSquare',
    Environment: 'prod',
    ManagedBy: 'cdk',
  },
});

/*
  Who may deploy from CI, in the dev account only.

  Separate from the environment stacks because it is the role that deploys
  them, and deployed by hand the once:

    cdk deploy FlightSquareCiDev --profile flightsquare-dev

  There is deliberately no production equivalent. Prod gets one when somebody
  decides prod should deploy itself, which is a different decision from this
  one.
*/
new CiStack(app, 'FlightSquareCiDev', {
  repository: 'amos-dev1/flightsquare',
  /*
    The ids, not the names, because this repository has GitHub's immutable
    subject claims enabled — see CiStackProps.subjectPrefix. 331334617 is the
    owner, 1378642522 the repository; both are stable for the life of each and
    survive a rename, which is the point of them.

      gh api repos/amos-dev1/flightsquare/actions/oidc/customization/sub
  */
  subjectPrefix: 'repo:amos-dev1@331334617/flightsquare@1378642522',
  branch: 'main',
  qualifier: 'hnb659fds',
  env: { account: '102378189980', region: 'us-east-1' },
  description: 'GitHub Actions deploy role for the dev account',
  tags: { Project: 'FlightSquare', Environment: 'dev', ManagedBy: 'cdk' },
});

app.synth();
