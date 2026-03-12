import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { OrderProcessingStack } from '../lib/order-processing-stack';

describe('OrderProcessingStack', () => {
  const app = new cdk.App();
  const stack = new OrderProcessingStack(app, 'TestOrderProcessingStack');
  const template = Template.fromStack(stack);

  test('creates an encrypted PostgreSQL RDS instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      DBName: 'ordersdb',
    });
  });

  test('creates an ECS Fargate service and task definition', () => {
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'OrderServiceContainer',
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 8080 }),
          ]),
        }),
      ]),
    });
  });

  test('creates a public application load balancer', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('creates an SQS queue with a dead-letter queue', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.anyValue(),
    });
  });
});
