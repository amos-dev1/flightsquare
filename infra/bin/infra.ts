#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FlightSquareStack } from '../lib/flightsquare-stack';

const app = new cdk.App();

// Which image tag to deploy. Override with:
//   cdk deploy FlightSquareDev -c imageTag=sha-abc1234
// CI should always pass an explicit tag; 'latest' is a convenience for
// manual deploys only, and makes rollbacks ambiguous.
const imageTag =
  app.node.tryGetContext('imageTag') ?? process.env.IMAGE_TAG ?? 'latest';

// Account IDs are pinned deliberately rather than resolved from the
// ambient profile. This is a guardrail: `cdk deploy FlightSquareProd
// --profile flightsquare-dev` fails outright instead of quietly
// deploying production infrastructure into the dev account.
new FlightSquareStack(app, 'FlightSquareDev', {
  envName: 'dev',
  imageTag,
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
  imageTag,
  env: { account: '363434191112', region: 'us-east-1' },
  description: 'FlightSquare production environment',
  tags: {
    Project: 'FlightSquare',
    Environment: 'prod',
    ManagedBy: 'cdk',
  },
});

app.synth();
