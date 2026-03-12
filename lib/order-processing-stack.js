"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderProcessingStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ecsPatterns = __importStar(require("aws-cdk-lib/aws-ecs-patterns"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const rds = __importStar(require("aws-cdk-lib/aws-rds"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const ecrAssets = __importStar(require("aws-cdk-lib/aws-ecr-assets"));
const applicationautoscaling = __importStar(require("aws-cdk-lib/aws-applicationautoscaling"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
class OrderProcessingStack extends cdk.Stack {
    constructor(scope, id, props) {
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
            directory: './src',
            platform: ecrAssets.Platform.LINUX_AMD64,
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
exports.OrderProcessingStack = OrderProcessingStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3JkZXItcHJvY2Vzc2luZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9yZGVyLXByb2Nlc3Npbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBRW5DLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsMEVBQTREO0FBQzVELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLCtFQUFpRTtBQUNqRSxzRUFBd0Q7QUFDeEQsK0ZBQWlGO0FBQ2pGLDhFQUFnRTtBQUdoRSxNQUFhLG9CQUFxQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ2pELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUNsRCxXQUFXLEVBQUUsR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDO1lBQ2pELE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxtQkFBbUIsRUFBRTtnQkFDbkI7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLFFBQVE7b0JBQ2QsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTTtpQkFDbEM7Z0JBQ0Q7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLGFBQWE7b0JBQ25CLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLG1CQUFtQjtpQkFDL0M7Z0JBQ0Q7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLFlBQVk7b0JBQ2xCLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLGdCQUFn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R0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxjQUFjLENBQUMsWUFBWSxDQUFDLG1CQUFtQjtZQUN0RCxXQUFXLEVBQUUsbURBQW1EO1NBQ2pFLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2xDLEtBQUssRUFBRSxVQUFVLENBQUMsUUFBUTtZQUMxQixXQUFXLEVBQUUsb0NBQW9DO1NBQ2xELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDMUMsS0FBSyxFQUFFLFFBQVEsQ0FBQyx5QkFBeUI7WUFDekMsV0FBVyxFQUFFLHFCQUFxQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUN0QyxLQUFLLEVBQUUsbUJBQW1CLENBQUMsVUFBVTtZQUNyQyxXQUFXLEVBQUUsd0RBQXdEO1NBQ3RFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTVORCxvREE0TkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3NQYXR0ZXJucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzLXBhdHRlcm5zJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgcmRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yZHMnO1xuaW1wb3J0ICogYXMgc3FzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zcXMnO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIGVjckFzc2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyLWFzc2V0cyc7XG5pbXBvcnQgKiBhcyBhcHBsaWNhdGlvbmF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcHBsaWNhdGlvbmF1dG9zY2FsaW5nJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcblxuXG5leHBvcnQgY2xhc3MgT3JkZXJQcm9jZXNzaW5nU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnT3JkZXJQcm9jZXNzaW5nVnBjJywge1xuICAgICAgaXBBZGRyZXNzZXM6IGVjMi5JcEFkZHJlc3Nlcy5jaWRyKCcxMC4yMC4wLjAvMTYnKSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdwdWJsaWMnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgICBuYW1lOiAncHJpdmF0ZS1hcHAnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjgsXG4gICAgICAgICAgbmFtZTogJ3ByaXZhdGUtZGInLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGJTZWN1cml0eUdyb3VwID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdEYlNlY3VyaXR5R3JvdXAnLCB7XG4gICAgICB2cGMsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIFBvc3RncmVTUUwgZGF0YWJhc2UnLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGJDcmVkZW50aWFsc1NlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0RiQ3JlZGVudGlhbHNTZWNyZXQnLCB7XG4gICAgICBkZXNjcmlwdGlvbjogJ0NyZWRlbnRpYWxzIGZvciB0aGUgb3JkZXIgcHJvY2Vzc2luZyBQb3N0Z3JlU1FMIGRhdGFiYXNlJyxcbiAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgIHNlY3JldFN0cmluZ1RlbXBsYXRlOiBKU09OLnN0cmluZ2lmeSh7IHVzZXJuYW1lOiAncG9zdGdyZXMnIH0pLFxuICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ3Bhc3N3b3JkJyxcbiAgICAgICAgZXhjbHVkZVB1bmN0dWF0aW9uOiB0cnVlLFxuICAgICAgICBpbmNsdWRlU3BhY2U6IGZhbHNlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHBhcmFtZXRlckdyb3VwID0gbmV3IHJkcy5QYXJhbWV0ZXJHcm91cCh0aGlzLCAnUG9zdGdyZXNQYXJhbWV0ZXJHcm91cCcsIHtcbiAgICAgIGVuZ2luZTogcmRzLkRhdGFiYXNlSW5zdGFuY2VFbmdpbmUucG9zdGdyZXMoe1xuICAgICAgICB2ZXJzaW9uOiByZHMuUG9zdGdyZXNFbmdpbmVWZXJzaW9uLlZFUl8xNl8zLFxuICAgICAgfSksXG4gICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgIGxvZ19jb25uZWN0aW9uczogJzEnLFxuICAgICAgICBsb2dfZGlzY29ubmVjdGlvbnM6ICcxJyxcbiAgICAgICAgbG9nX3N0YXRlbWVudDogJ2RkbCcsXG4gICAgICAgIGxvZ19taW5fZHVyYXRpb25fc3RhdGVtZW50OiAnNTAwJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBkYXRhYmFzZSA9IG5ldyByZHMuRGF0YWJhc2VJbnN0YW5jZSh0aGlzLCAnT3JkZXJQcm9jZXNzaW5nRGF0YWJhc2UnLCB7XG4gICAgICBlbmdpbmU6IHJkcy5EYXRhYmFzZUluc3RhbmNlRW5naW5lLnBvc3RncmVzKHtcbiAgICAgICAgdmVyc2lvbjogcmRzLlBvc3RncmVzRW5naW5lVmVyc2lvbi5WRVJfMTZfMyxcbiAgICAgIH0pLFxuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLkJVUlNUQUJMRTMsIGVjMi5JbnN0YW5jZVNpemUuTUVESVVNKSxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCB9LFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtkYlNlY3VyaXR5R3JvdXBdLFxuICAgICAgY3JlZGVudGlhbHM6IHJkcy5DcmVkZW50aWFscy5mcm9tU2VjcmV0KGRiQ3JlZGVudGlhbHNTZWNyZXQpLFxuICAgICAgZGF0YWJhc2VOYW1lOiAnb3JkZXJzZGInLFxuICAgICAgYWxsb2NhdGVkU3RvcmFnZTogNTAsXG4gICAgICBtYXhBbGxvY2F0ZWRTdG9yYWdlOiAxMDAsXG4gICAgICBzdG9yYWdlRW5jcnlwdGVkOiB0cnVlLFxuICAgICAgbXVsdGlBejogZmFsc2UsXG4gICAgICBiYWNrdXBSZXRlbnRpb246IGNkay5EdXJhdGlvbi5kYXlzKDcpLFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBmYWxzZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBkZWxldGVBdXRvbWF0ZWRCYWNrdXBzOiB0cnVlLFxuICAgICAgYXV0b01pbm9yVmVyc2lvblVwZ3JhZGU6IHRydWUsXG4gICAgICBwYXJhbWV0ZXJHcm91cCxcbiAgICAgIGNsb3Vkd2F0Y2hMb2dzRXhwb3J0czogWydwb3N0Z3Jlc3FsJ10sXG4gICAgICBjbG91ZHdhdGNoTG9nc1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgIG1vbml0b3JpbmdJbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgcHVibGljbHlBY2Nlc3NpYmxlOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlYWRMZXR0ZXJRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ09yZGVyRXZlbnRzRGxxJywge1xuICAgICAgcmV0ZW50aW9uUGVyaW9kOiBjZGsuRHVyYXRpb24uZGF5cygxNCksXG4gICAgICBlbmNyeXB0aW9uOiBzcXMuUXVldWVFbmNyeXB0aW9uLlNRU19NQU5BR0VELFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb3JkZXJRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ09yZGVyRXZlbnRzUXVldWUnLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwKSxcbiAgICAgIHJlY2VpdmVNZXNzYWdlV2FpdFRpbWU6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDIwKSxcbiAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoNCksXG4gICAgICBlbmNyeXB0aW9uOiBzcXMuUXVldWVFbmNyeXB0aW9uLlNRU19NQU5BR0VELFxuICAgICAgZGVhZExldHRlclF1ZXVlOiB7XG4gICAgICAgIG1heFJlY2VpdmVDb3VudDogNSxcbiAgICAgICAgcXVldWU6IGRlYWRMZXR0ZXJRdWV1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdPcmRlclByb2Nlc3NpbmdDbHVzdGVyJywge1xuICAgICAgdnBjLFxuICAgICAgY29udGFpbmVySW5zaWdodHNWMjogZWNzLkNvbnRhaW5lckluc2lnaHRzLkVOQUJMRUQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBpbWFnZUFzc2V0ID0gbmV3IGVjckFzc2V0cy5Eb2NrZXJJbWFnZUFzc2V0KHRoaXMsICdPcmRlclNlcnZpY2VJbWFnZScsIHtcbiAgICAgIGRpcmVjdG9yeTogJy4vc3JjJyxcbiAgICAgIHBsYXRmb3JtOiBlY3JBc3NldHMuUGxhdGZvcm0uTElOVVhfQU1ENjQsXG4gICAgfSk7XG5cbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdPcmRlclNlcnZpY2VUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIGNwdTogNTEyLFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDEwMjQsXG4gICAgICBydW50aW1lUGxhdGZvcm06IHtcbiAgICAgICAgY3B1QXJjaGl0ZWN0dXJlOiBlY3MuQ3B1QXJjaGl0ZWN0dXJlLlg4Nl82NCxcbiAgICAgICAgb3BlcmF0aW5nU3lzdGVtRmFtaWx5OiBlY3MuT3BlcmF0aW5nU3lzdGVtRmFtaWx5LkxJTlVYLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ09yZGVyU2VydmljZUxvZ0dyb3VwJywge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignT3JkZXJTZXJ2aWNlQ29udGFpbmVyJywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRG9ja2VySW1hZ2VBc3NldChpbWFnZUFzc2V0KSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6ICdvcmRlci1zZXJ2aWNlJyxcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIHBvcnRNYXBwaW5nczogW3sgY29udGFpbmVyUG9ydDogODA4MCB9XSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFBPUlQ6ICc4MDgwJyxcbiAgICAgICAgQVdTX1JFR0lPTjogY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgICAgUVVFVUVfVVJMOiBvcmRlclF1ZXVlLnF1ZXVlVXJsLFxuICAgICAgICBEQl9IT1NUOiBkYXRhYmFzZS5kYkluc3RhbmNlRW5kcG9pbnRBZGRyZXNzLFxuICAgICAgICBEQl9QT1JUOiBkYXRhYmFzZS5kYkluc3RhbmNlRW5kcG9pbnRQb3J0LFxuICAgICAgICBEQl9OQU1FOiAnb3JkZXJzZGInLFxuICAgICAgfSxcbiAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgREJfVVNFUjogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIoZGJDcmVkZW50aWFsc1NlY3JldCwgJ3VzZXJuYW1lJyksXG4gICAgICAgIERCX1BBU1NXT1JEOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihkYkNyZWRlbnRpYWxzU2VjcmV0LCAncGFzc3dvcmQnKSxcbiAgICAgIH0sXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICBjb21tYW5kOiBbJ0NNRC1TSEVMTCcsICd3Z2V0IC1xTy0gaHR0cDovL2xvY2FsaG9zdDo4MDgwL2hlYWx0aCB8fCBleGl0IDEnXSxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIHJldHJpZXM6IDMsXG4gICAgICAgIHN0YXJ0UGVyaW9kOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgb3JkZXJRdWV1ZS5ncmFudENvbnN1bWVNZXNzYWdlcyh0YXNrRGVmaW5pdGlvbi50YXNrUm9sZSk7XG4gICAgZGJDcmVkZW50aWFsc1NlY3JldC5ncmFudFJlYWQodGFza0RlZmluaXRpb24udGFza1JvbGUpO1xuXG4gICAgY29uc3QgZmFyZ2F0ZVNlcnZpY2UgPSBuZXcgZWNzUGF0dGVybnMuQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSh0aGlzLCAnT3JkZXJTZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uLFxuICAgICAgcHVibGljTG9hZEJhbGFuY2VyOiB0cnVlLFxuICAgICAgYXNzaWduUHVibGljSXA6IGZhbHNlLFxuICAgICAgZGVzaXJlZENvdW50OiAyLFxuICAgICAgbGlzdGVuZXJQb3J0OiA4MCxcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICB0YXNrU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgICBjaXJjdWl0QnJlYWtlcjogeyByb2xsYmFjazogdHJ1ZSB9LFxuICAgICAgaGVhbHRoQ2hlY2tHcmFjZVBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgIH0pO1xuXG4gICAgZmFyZ2F0ZVNlcnZpY2UudGFyZ2V0R3JvdXAuY29uZmlndXJlSGVhbHRoQ2hlY2soe1xuICAgICAgcGF0aDogJy9oZWFsdGgnLFxuICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgfSk7XG5cbiAgICBkYXRhYmFzZS5jb25uZWN0aW9ucy5hbGxvd0RlZmF1bHRQb3J0RnJvbShmYXJnYXRlU2VydmljZS5zZXJ2aWNlLCAnQWxsb3cgRUNTIHNlcnZpY2UgdG8gYWNjZXNzIFBvc3RncmVTUUwnKTtcblxuICAgIGNvbnN0IHNjYWxhYmxlVGFyZ2V0ID0gZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHk6IDIsXG4gICAgICBtYXhDYXBhY2l0eTogNixcbiAgICB9KTtcblxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25DcHVVdGlsaXphdGlvbignQ3B1U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogNjAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICB9KTtcblxuc2NhbGFibGVUYXJnZXQuc2NhbGVPbk1ldHJpYygnUXVldWVEZXB0aFNjYWxpbmcnLCB7XG4gIG1ldHJpYzogb3JkZXJRdWV1ZS5tZXRyaWNBcHByb3hpbWF0ZU51bWJlck9mTWVzc2FnZXNWaXNpYmxlKHtcbiAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIHN0YXRpc3RpYzogJ0F2ZXJhZ2UnLFxuICB9KSxcbiAgc2NhbGluZ1N0ZXBzOiBbXG4gICAgeyB1cHBlcjogMCwgY2hhbmdlOiAtMSB9LFxuICAgIHsgbG93ZXI6IDAsIHVwcGVyOiAxMCwgY2hhbmdlOiAxIH0sXG4gICAgeyBsb3dlcjogMTAsIHVwcGVyOiA1MCwgY2hhbmdlOiAyIH0sXG4gICAgeyBsb3dlcjogNTAsIGNoYW5nZTogMyB9LFxuICBdLFxuICBhZGp1c3RtZW50VHlwZTogYXBwbGljYXRpb25hdXRvc2NhbGluZy5BZGp1c3RtZW50VHlwZS5DSEFOR0VfSU5fQ0FQQUNJVFksXG4gIGNvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG59KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGJEbnNOYW1lJywge1xuICAgICAgdmFsdWU6IGZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdQdWJsaWMgRE5TIG5hbWUgZm9yIHRoZSBhcHBsaWNhdGlvbiBsb2FkIGJhbGFuY2VyJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdRdWV1ZVVybCcsIHtcbiAgICAgIHZhbHVlOiBvcmRlclF1ZXVlLnF1ZXVlVXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdQcmltYXJ5IFNRUyBxdWV1ZSBmb3Igb3JkZXIgZXZlbnRzJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXRhYmFzZUVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IGRhdGFiYXNlLmRiSW5zdGFuY2VFbmRwb2ludEFkZHJlc3MsXG4gICAgICBkZXNjcmlwdGlvbjogJ1Bvc3RncmVTUUwgZW5kcG9pbnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RiU2VjcmV0TmFtZScsIHtcbiAgICAgIHZhbHVlOiBkYkNyZWRlbnRpYWxzU2VjcmV0LnNlY3JldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3JldHMgTWFuYWdlciBzZWNyZXQgY29udGFpbmluZyBkYXRhYmFzZSBjcmVkZW50aWFscycsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==