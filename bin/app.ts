#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OrderProcessingStack } from '../lib/order-processing-stack';

const app = new cdk.App();

new OrderProcessingStack(app, 'FlexischoolsOrderProcessingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-southeast-2',
  },
  description: 'Serverless order-processing platform with RDS PostgreSQL, ECS Fargate, SQS, and ALB',
});
