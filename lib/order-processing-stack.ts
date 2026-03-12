import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as applicationautoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';


export class OrderProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'OrderProcessingVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-app',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'private-db',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Security group for PostgreSQL database',
    });

    const dbCredentialsSecret = new secretsmanager.Secret(this, 'DbCredentialsSecret', {
      description: 'Credentials for the order processing PostgreSQL database',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    const parameterGroup = new rds.ParameterGroup(this, 'PostgresParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      parameters: {
        log_connections: '1',
        log_disconnections: '1',
        log_statement: 'ddl',
        log_min_duration_statement: '500',
      },
    });

    const database = new rds.DatabaseInstance(this, 'OrderProcessingDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      databaseName: 'ordersdb',
      allocatedStorage: 50,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
      autoMinorVersionUpgrade: true,
      parameterGroup,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      monitoringInterval: cdk.Duration.seconds(60),
      publiclyAccessible: false,
    });

    const deadLetterQueue = new sqs.Queue(this, 'OrderEventsDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const orderQueue = new sqs.Queue(this, 'OrderEventsQueue', {
      visibilityTimeout: cdk.Duration.seconds(120),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: deadLetterQueue,
      },
    });

    const cluster = new ecs.Cluster(this, 'OrderProcessingCluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const imageAsset = new ecrAssets.DockerImageAsset(this, 'OrderServiceImage', {
      directory: path.resolve(__dirname, '../src'),
      file: 'Dockerfile',
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'OrderServiceTaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new logs.LogGroup(this, 'OrderServiceLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer('OrderServiceContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'order-service',
        logGroup,
      }),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        PORT: '8080',
        AWS_REGION: cdk.Stack.of(this).region,
        QUEUE_URL: orderQueue.queueUrl,
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: 'ordersdb',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'password'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    orderQueue.grantConsumeMessages(taskDefinition.taskRole);
    dbCredentialsSecret.grantRead(taskDefinition.taskRole);

    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'OrderService', {
      cluster,
      taskDefinition,
      publicLoadBalancer: true,
      assignPublicIp: false,
      desiredCount: 2,
      listenerPort: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
    });

    database.connections.allowDefaultPortFrom(fargateService.service, 'Allow ECS service to access PostgreSQL');

    const scalableTarget = fargateService.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 6,
    });

    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

scalableTarget.scaleOnMetric('QueueDepthScaling', {
  metric: orderQueue.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(1),
    statistic: 'Average',
  }),
  scalingSteps: [
    { upper: 0, change: -1 },
    { lower: 0, upper: 10, change: 1 },
    { lower: 10, upper: 50, change: 2 },
    { lower: 50, change: 3 },
  ],
  adjustmentType: applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
  cooldown: cdk.Duration.seconds(60),
});

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'Public DNS name for the application load balancer',
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: orderQueue.queueUrl,
      description: 'Primary SQS queue for order events',
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
      description: 'PostgreSQL endpoint',
    });

    new cdk.CfnOutput(this, 'DbSecretName', {
      value: dbCredentialsSecret.secretName,
      description: 'Secrets Manager secret containing database credentials',
    });
  }
}
