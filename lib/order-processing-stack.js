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
const path = __importStar(require("path"));
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
                version: rds.PostgresEngineVersion.VER_16,
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
                version: rds.PostgresEngineVersion.VER_16,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [dbSecurityGroup],
            credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
            databaseName: 'ordersdb',
            allocatedStorage: 20,
            maxAllocatedStorage: 50,
            storageEncrypted: true,
            multiAz: false,
            backupRetention: cdk.Duration.days(0),
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
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3JkZXItcHJvY2Vzc2luZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9yZGVyLXByb2Nlc3Npbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBRW5DLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsMEVBQTREO0FBQzVELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLCtFQUFpRTtBQUNqRSxzRUFBd0Q7QUFDeEQsK0ZBQWlGO0FBQ2pGLDhFQUFnRTtBQUNoRSwyQ0FBNkI7QUFHN0IsTUFBYSxvQkFBcUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNqRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDbEQsV0FBVyxFQUFFLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQztZQUNqRCxNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxRQUFRO29CQUNkLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU07aUJBQ2xDO2dCQUNEO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxhQUFhO29CQUNuQixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7aUJBQy9DO2dCQUNEO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxZQUFZO29CQUNsQixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0I7aUJBQzVDO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCxNQUFNLGVBQWUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3JFLEdBQUc7WUFDSCxnQkFBZ0IsRUFBRSxLQUFLO1lBQ3ZCLFdBQVcsRUFBRSx3Q0FBd0M7U0FDdEQsQ0FBQyxDQUFDO1FBRUgsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLGNBQWMsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQ2pGLFdBQVcsRUFBRSwwREFBMEQ7WUFDdkUsb0JBQW9CLEVBQUU7Z0JBQ3BCLG9CQUFvQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxRQUFRLEVBQUUsVUFBVSxFQUFFLENBQUM7Z0JBQzlELGlCQUFpQixFQUFFLFVBQVU7Z0JBQzdCLGtCQUFrQixFQUFFLElBQUk7Z0JBQ3hCLFlBQVksRUFBRSxLQUFLO2FBQ3BCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSx3QkFBd0IsRUFBRTtZQUM1RSxNQUFNLEVBQUUsR0FBRyxDQUFDLHNCQUFzQixDQUFDLFFBQVEsQ0FBQztnQkFDMUMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxNQUFNO2FBQzFDLENBQUM7WUFDRixVQUFVLEVBQUU7Z0JBQ1YsZUFBZSxFQUFFLEdBQUc7Z0JBQ3BCLGtCQUFrQixFQUFFLEdBQUc7Z0JBQ3ZCLGFBQWEsRUFBRSxLQUFLO2dCQUNwQiwwQkFBMEIsRUFBRSxLQUFLO2FBQ2xDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ3pFLE1BQU0sRUFBRSxHQUFHLENBQUMsc0JBQXNCLENBQUMsUUFBUSxDQUFDO2dCQUMxQyxPQUFPLEVBQUUsR0FBRyxDQUFDLHFCQUFxQixDQUFDLE1BQU07YUFDMUMsQ0FBQztZQUNGLFlBQVksRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQztZQUNoRixHQUFHO1lBQ0gsVUFBVSxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLEVBQUU7WUFDM0QsY0FBYyxFQUFFLENBQUMsZUFBZSxDQUFDO1lBQ2pDLFdBQVcsRUFBRSxHQUFHLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUIsQ0FBQztZQUM1RCxZQUFZLEVBQUUsVUFBVTtZQUN4QixnQkFBZ0IsRUFBRSxFQUFFO1lBQ3BCLG1CQUFtQixFQUFFLEVBQUU7WUFDdkIsZ0JBQWdCLEVBQUUsSUFBSTtZQUN0QixPQUFPLEVBQUUsS0FBSztZQUNkLGVBQWUsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDckMsa0JBQWtCLEVBQUUsS0FBSztZQUN6QixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLHNCQUFzQixFQUFFLElBQUk7WUFDNUIsdUJBQXVCLEVBQUUsSUFBSTtZQUM3QixjQUFjO1lBQ2QscUJBQXFCLEVBQUUsQ0FBQyxZQUFZLENBQUM7WUFDckMsdUJBQXVCLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTO1lBQ3JELGtCQUFrQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUM1QyxrQkFBa0IsRUFBRSxLQUFLO1NBQzFCLENBQUMsQ0FBQztRQUVILE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDNUQsZUFBZSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUN0QyxVQUFVLEVBQUUsR0FBRyxDQUFDLGVBQWUsQ0FBQyxXQUFXO1NBQzVDLENBQUMsQ0FBQztRQUVILE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDekQsaUJBQWlCLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1lBQzVDLHNCQUFzQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNoRCxlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQ3JDLFVBQVUsRUFBRSxHQUFHLENBQUMsZUFBZSxDQUFDLFdBQVc7WUFDM0MsZUFBZSxFQUFFO2dCQUNmLGVBQWUsRUFBRSxDQUFDO2dCQUNsQixLQUFLLEVBQUUsZUFBZTthQUN2QjtTQUNGLENBQUMsQ0FBQztRQUVILE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7WUFDOUQsR0FBRztZQUNILG1CQUFtQixFQUFFLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPO1NBQ25ELENBQUMsQ0FBQztRQUVILE1BQU0sVUFBVSxHQUFHLElBQUksU0FBUyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUMzRSxTQUFTLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDO1lBQzVDLElBQUksRUFBRSxZQUFZO1lBQ2xCLFFBQVEsRUFBRSxTQUFTLENBQUMsUUFBUSxDQUFDLFdBQVc7U0FDekMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLENBQUMscUJBQXFCLENBQUMsSUFBSSxFQUFFLDRCQUE0QixFQUFFO1lBQ3ZGLEdBQUcsRUFBRSxHQUFHO1lBQ1IsY0FBYyxFQUFFLElBQUk7WUFDcEIsZUFBZSxFQUFFO2dCQUNmLGVBQWUsRUFBRSxHQUFHLENBQUMsZUFBZSxDQUFDLEtBQUs7Z0JBQzFDLHFCQUFxQixFQUFFLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxLQUFLO2FBQ3ZEO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxRQUFRLEdBQUcsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUMvRCxTQUFTLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTO1lBQ3ZDLGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87U0FDekMsQ0FBQyxDQUFDO1FBRUgsY0FBYyxDQUFDLFlBQVksQ0FBQyx1QkFBdUIsRUFBRTtZQUNuRCxLQUFLLEVBQUUsR0FBRyxDQUFDLGNBQWMsQ0FBQyxvQkFBb0IsQ0FBQyxVQUFVLENBQUM7WUFDMUQsT0FBTyxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDO2dCQUM5QixZQUFZLEVBQUUsZUFBZTtnQkFDN0IsUUFBUTthQUNULENBQUM7WUFDRixZQUFZLEVBQUUsQ0FBQyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsQ0FBQztZQUN2QyxXQUFXLEVBQUU7Z0JBQ1gsSUFBSSxFQUFFLE1BQU07Z0JBQ1osVUFBVSxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU07Z0JBQ3JDLFNBQVMsRUFBRSxVQUFVLENBQUMsUUFBUTtnQkFDOUIsT0FBTyxFQUFFLFFBQVEsQ0FBQyx5QkFBeUI7Z0JBQzNDLE9BQU8sRUFBRSxRQUFRLENBQUMsc0JBQXNCO2dCQUN4QyxPQUFPLEVBQUUsVUFBVTthQUNwQjtZQUNELE9BQU8sRUFBRTtnQkFDUCxPQUFPLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxtQkFBbUIsRUFBRSxVQUFVLENBQUM7Z0JBQ3ZFLFdBQVcsRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLGtCQUFrQixDQUFDLG1CQUFtQixFQUFFLFVBQVUsQ0FBQzthQUM1RTtZQUNELFdBQVcsRUFBRTtnQkFDWCxPQUFPLEVBQUUsQ0FBQyxXQUFXLEVBQUUsa0RBQWtELENBQUM7Z0JBQzFFLFFBQVEsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ2xDLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQ2hDLE9BQU8sRUFBRSxDQUFDO2dCQUNWLFdBQVcsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7YUFDdEM7U0FDRixDQUFDLENBQUM7UUFFSCxVQUFVLENBQUMsb0JBQW9CLENBQUMsY0FBYyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3pELG1CQUFtQixDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDLENBQUM7UUFFdkQsTUFBTSxjQUFjLEdBQUcsSUFBSSxXQUFXLENBQUMscUNBQXFDLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUNqRyxPQUFPO1lBQ1AsY0FBYztZQUNkLGtCQUFrQixFQUFFLElBQUk7WUFDeEIsY0FBYyxFQUFFLEtBQUs7WUFDckIsWUFBWSxFQUFFLENBQUM7WUFDZixZQUFZLEVBQUUsRUFBRTtZQUNoQixRQUFRLEVBQUUsS0FBSyxDQUFDLG1CQUFtQixDQUFDLElBQUk7WUFDeEMsV0FBVyxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CLEVBQUU7WUFDL0QsY0FBYyxFQUFFLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTtZQUNsQyxzQkFBc0IsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7U0FDakQsQ0FBQyxDQUFDO1FBRUgsY0FBYyxDQUFDLFdBQVcsQ0FBQyxvQkFBb0IsQ0FBQztZQUM5QyxJQUFJLEVBQUUsU0FBUztZQUNmLGdCQUFnQixFQUFFLEtBQUs7WUFDdkIsUUFBUSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNsQyxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1NBQ2pDLENBQUMsQ0FBQztRQUVILFFBQVEsQ0FBQyxXQUFXLENBQUMsb0JBQW9CLENBQUMsY0FBYyxDQUFDLE9BQU8sRUFBRSx3Q0FBd0MsQ0FBQyxDQUFDO1FBRTVHLE1BQU0sY0FBYyxHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUM7WUFDL0QsV0FBVyxFQUFFLENBQUM7WUFDZCxXQUFXLEVBQUUsQ0FBQztTQUNmLENBQUMsQ0FBQztRQUVILGNBQWMsQ0FBQyxxQkFBcUIsQ0FBQyxZQUFZLEVBQUU7WUFDakQsd0JBQXdCLEVBQUUsRUFBRTtZQUM1QixlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ3pDLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztTQUMzQyxDQUFDLENBQUM7UUFFUCxjQUFjLENBQUMsYUFBYSxDQUFDLG1CQUFtQixFQUFFO1lBQ2hELE1BQU0sRUFBRSxVQUFVLENBQUMsd0NBQXdDLENBQUM7Z0JBQzFELE1BQU0sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQy9CLFNBQVMsRUFBRSxTQUFTO2FBQ3JCLENBQUM7WUFDRixZQUFZLEVBQUU7Z0JBQ1osRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsRUFBRTtnQkFDeEIsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRTtnQkFDbEMsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRTtnQkFDbkMsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUU7YUFDekI7WUFDRCxjQUFjLEVBQUUsc0JBQXNCLENBQUMsY0FBYyxDQUFDLGtCQUFrQjtZQUN4RSxRQUFRLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1NBQ25DLENBQUMsQ0FBQztRQUVDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxjQUFjLENBQUMsWUFBWSxDQUFDLG1CQUFtQjtZQUN0RCxXQUFXLEVBQUUsbURBQW1EO1NBQ2pFLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2xDLEtBQUssRUFBRSxVQUFVLENBQUMsUUFBUTtZQUMxQixXQUFXLEVBQUUsb0NBQW9DO1NBQ2xELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDMUMsS0FBSyxFQUFFLFFBQVEsQ0FBQyx5QkFBeUI7WUFDekMsV0FBVyxFQUFFLHFCQUFxQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUN0QyxLQUFLLEVBQUUsbUJBQW1CLENBQUMsVUFBVTtZQUNyQyxXQUFXLEVBQUUsd0RBQXdEO1NBQ3RFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTdORCxvREE2TkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3NQYXR0ZXJucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzLXBhdHRlcm5zJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgcmRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yZHMnO1xuaW1wb3J0ICogYXMgc3FzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zcXMnO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIGVjckFzc2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyLWFzc2V0cyc7XG5pbXBvcnQgKiBhcyBhcHBsaWNhdGlvbmF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcHBsaWNhdGlvbmF1dG9zY2FsaW5nJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cblxuZXhwb3J0IGNsYXNzIE9yZGVyUHJvY2Vzc2luZ1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ09yZGVyUHJvY2Vzc2luZ1ZwYycsIHtcbiAgICAgIGlwQWRkcmVzc2VzOiBlYzIuSXBBZGRyZXNzZXMuY2lkcignMTAuMjAuMC4wLzE2JyksXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgICBuYW1lOiAncHVibGljJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgICAgbmFtZTogJ3ByaXZhdGUtYXBwJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI4LFxuICAgICAgICAgIG5hbWU6ICdwcml2YXRlLWRiJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRiU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnRGJTZWN1cml0eUdyb3VwJywge1xuICAgICAgdnBjLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBQb3N0Z3JlU1FMIGRhdGFiYXNlJyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRiQ3JlZGVudGlhbHNTZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdEYkNyZWRlbnRpYWxzU2VjcmV0Jywge1xuICAgICAgZGVzY3JpcHRpb246ICdDcmVkZW50aWFscyBmb3IgdGhlIG9yZGVyIHByb2Nlc3NpbmcgUG9zdGdyZVNRTCBkYXRhYmFzZScsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoeyB1c2VybmFtZTogJ3Bvc3RncmVzJyB9KSxcbiAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICdwYXNzd29yZCcsXG4gICAgICAgIGV4Y2x1ZGVQdW5jdHVhdGlvbjogdHJ1ZSxcbiAgICAgICAgaW5jbHVkZVNwYWNlOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBwYXJhbWV0ZXJHcm91cCA9IG5ldyByZHMuUGFyYW1ldGVyR3JvdXAodGhpcywgJ1Bvc3RncmVzUGFyYW1ldGVyR3JvdXAnLCB7XG4gICAgICBlbmdpbmU6IHJkcy5EYXRhYmFzZUluc3RhbmNlRW5naW5lLnBvc3RncmVzKHtcbiAgICAgICAgdmVyc2lvbjogcmRzLlBvc3RncmVzRW5naW5lVmVyc2lvbi5WRVJfMTYsXG4gICAgICB9KSxcbiAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgbG9nX2Nvbm5lY3Rpb25zOiAnMScsXG4gICAgICAgIGxvZ19kaXNjb25uZWN0aW9uczogJzEnLFxuICAgICAgICBsb2dfc3RhdGVtZW50OiAnZGRsJyxcbiAgICAgICAgbG9nX21pbl9kdXJhdGlvbl9zdGF0ZW1lbnQ6ICc1MDAnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRhdGFiYXNlID0gbmV3IHJkcy5EYXRhYmFzZUluc3RhbmNlKHRoaXMsICdPcmRlclByb2Nlc3NpbmdEYXRhYmFzZScsIHtcbiAgICAgIGVuZ2luZTogcmRzLkRhdGFiYXNlSW5zdGFuY2VFbmdpbmUucG9zdGdyZXMoe1xuICAgICAgICB2ZXJzaW9uOiByZHMuUG9zdGdyZXNFbmdpbmVWZXJzaW9uLlZFUl8xNixcbiAgICAgIH0pLFxuICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLlQ0RywgZWMyLkluc3RhbmNlU2l6ZS5NSUNSTyksXG4gICAgICB2cGMsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQgfSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbZGJTZWN1cml0eUdyb3VwXSxcbiAgICAgIGNyZWRlbnRpYWxzOiByZHMuQ3JlZGVudGlhbHMuZnJvbVNlY3JldChkYkNyZWRlbnRpYWxzU2VjcmV0KSxcbiAgICAgIGRhdGFiYXNlTmFtZTogJ29yZGVyc2RiJyxcbiAgICAgIGFsbG9jYXRlZFN0b3JhZ2U6IDIwLFxuICAgICAgbWF4QWxsb2NhdGVkU3RvcmFnZTogNTAsXG4gICAgICBzdG9yYWdlRW5jcnlwdGVkOiB0cnVlLFxuICAgICAgbXVsdGlBejogZmFsc2UsXG4gICAgICBiYWNrdXBSZXRlbnRpb246IGNkay5EdXJhdGlvbi5kYXlzKDApLFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBmYWxzZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBkZWxldGVBdXRvbWF0ZWRCYWNrdXBzOiB0cnVlLFxuICAgICAgYXV0b01pbm9yVmVyc2lvblVwZ3JhZGU6IHRydWUsXG4gICAgICBwYXJhbWV0ZXJHcm91cCxcbiAgICAgIGNsb3Vkd2F0Y2hMb2dzRXhwb3J0czogWydwb3N0Z3Jlc3FsJ10sXG4gICAgICBjbG91ZHdhdGNoTG9nc1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgIG1vbml0b3JpbmdJbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgcHVibGljbHlBY2Nlc3NpYmxlOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlYWRMZXR0ZXJRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ09yZGVyRXZlbnRzRGxxJywge1xuICAgICAgcmV0ZW50aW9uUGVyaW9kOiBjZGsuRHVyYXRpb24uZGF5cygxNCksXG4gICAgICBlbmNyeXB0aW9uOiBzcXMuUXVldWVFbmNyeXB0aW9uLlNRU19NQU5BR0VELFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb3JkZXJRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgJ09yZGVyRXZlbnRzUXVldWUnLCB7XG4gICAgICB2aXNpYmlsaXR5VGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwKSxcbiAgICAgIHJlY2VpdmVNZXNzYWdlV2FpdFRpbWU6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDIwKSxcbiAgICAgIHJldGVudGlvblBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoNCksXG4gICAgICBlbmNyeXB0aW9uOiBzcXMuUXVldWVFbmNyeXB0aW9uLlNRU19NQU5BR0VELFxuICAgICAgZGVhZExldHRlclF1ZXVlOiB7XG4gICAgICAgIG1heFJlY2VpdmVDb3VudDogNSxcbiAgICAgICAgcXVldWU6IGRlYWRMZXR0ZXJRdWV1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdPcmRlclByb2Nlc3NpbmdDbHVzdGVyJywge1xuICAgICAgdnBjLFxuICAgICAgY29udGFpbmVySW5zaWdodHNWMjogZWNzLkNvbnRhaW5lckluc2lnaHRzLkVOQUJMRUQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBpbWFnZUFzc2V0ID0gbmV3IGVjckFzc2V0cy5Eb2NrZXJJbWFnZUFzc2V0KHRoaXMsICdPcmRlclNlcnZpY2VJbWFnZScsIHtcbiAgICAgIGRpcmVjdG9yeTogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4uL3NyYycpLFxuICAgICAgZmlsZTogJ0RvY2tlcmZpbGUnLFxuICAgICAgcGxhdGZvcm06IGVjckFzc2V0cy5QbGF0Zm9ybS5MSU5VWF9BUk02NCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ09yZGVyU2VydmljZVRhc2tEZWZpbml0aW9uJywge1xuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICAgIHJ1bnRpbWVQbGF0Zm9ybToge1xuICAgICAgICBjcHVBcmNoaXRlY3R1cmU6IGVjcy5DcHVBcmNoaXRlY3R1cmUuQVJNNjQsXG4gICAgICAgIG9wZXJhdGluZ1N5c3RlbUZhbWlseTogZWNzLk9wZXJhdGluZ1N5c3RlbUZhbWlseS5MSU5VWCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdPcmRlclNlcnZpY2VMb2dHcm91cCcsIHtcbiAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICB0YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ09yZGVyU2VydmljZUNvbnRhaW5lcicsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbURvY2tlckltYWdlQXNzZXQoaW1hZ2VBc3NldCksXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAnb3JkZXItc2VydmljZScsXG4gICAgICAgIGxvZ0dyb3VwLFxuICAgICAgfSksXG4gICAgICBwb3J0TWFwcGluZ3M6IFt7IGNvbnRhaW5lclBvcnQ6IDgwODAgfV0sXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBQT1JUOiAnODA4MCcsXG4gICAgICAgIEFXU19SRUdJT046IGNkay5TdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAgIFFVRVVFX1VSTDogb3JkZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgICAgREJfSE9TVDogZGF0YWJhc2UuZGJJbnN0YW5jZUVuZHBvaW50QWRkcmVzcyxcbiAgICAgICAgREJfUE9SVDogZGF0YWJhc2UuZGJJbnN0YW5jZUVuZHBvaW50UG9ydCxcbiAgICAgICAgREJfTkFNRTogJ29yZGVyc2RiJyxcbiAgICAgIH0sXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIERCX1VTRVI6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKGRiQ3JlZGVudGlhbHNTZWNyZXQsICd1c2VybmFtZScpLFxuICAgICAgICBEQl9QQVNTV09SRDogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIoZGJDcmVkZW50aWFsc1NlY3JldCwgJ3Bhc3N3b3JkJyksXG4gICAgICB9LFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgY29tbWFuZDogWydDTUQtU0hFTEwnLCAnd2dldCAtcU8tIGh0dHA6Ly9sb2NhbGhvc3Q6ODA4MC9oZWFsdGggfHwgZXhpdCAxJ10sXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICByZXRyaWVzOiAzLFxuICAgICAgICBzdGFydFBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIG9yZGVyUXVldWUuZ3JhbnRDb25zdW1lTWVzc2FnZXModGFza0RlZmluaXRpb24udGFza1JvbGUpO1xuICAgIGRiQ3JlZGVudGlhbHNTZWNyZXQuZ3JhbnRSZWFkKHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlKTtcblxuICAgIGNvbnN0IGZhcmdhdGVTZXJ2aWNlID0gbmV3IGVjc1BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ09yZGVyU2VydmljZScsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbixcbiAgICAgIHB1YmxpY0xvYWRCYWxhbmNlcjogdHJ1ZSxcbiAgICAgIGFzc2lnblB1YmxpY0lwOiBmYWxzZSxcbiAgICAgIGRlc2lyZWRDb3VudDogMixcbiAgICAgIGxpc3RlbmVyUG9ydDogODAsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdGFza1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgICAgY2lyY3VpdEJyZWFrZXI6IHsgcm9sbGJhY2s6IHRydWUgfSxcbiAgICAgIGhlYWx0aENoZWNrR3JhY2VQZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICB9KTtcblxuICAgIGZhcmdhdGVTZXJ2aWNlLnRhcmdldEdyb3VwLmNvbmZpZ3VyZUhlYWx0aENoZWNrKHtcbiAgICAgIHBhdGg6ICcvaGVhbHRoJyxcbiAgICAgIGhlYWx0aHlIdHRwQ29kZXM6ICcyMDAnLFxuICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgIH0pO1xuXG4gICAgZGF0YWJhc2UuY29ubmVjdGlvbnMuYWxsb3dEZWZhdWx0UG9ydEZyb20oZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZSwgJ0FsbG93IEVDUyBzZXJ2aWNlIHRvIGFjY2VzcyBQb3N0Z3JlU1FMJyk7XG5cbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IGZhcmdhdGVTZXJ2aWNlLnNlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5OiAyLFxuICAgICAgbWF4Q2FwYWNpdHk6IDYsXG4gICAgfSk7XG5cbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oJ0NwdVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDYwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgfSk7XG5cbnNjYWxhYmxlVGFyZ2V0LnNjYWxlT25NZXRyaWMoJ1F1ZXVlRGVwdGhTY2FsaW5nJywge1xuICBtZXRyaWM6IG9yZGVyUXVldWUubWV0cmljQXBwcm94aW1hdGVOdW1iZXJPZk1lc3NhZ2VzVmlzaWJsZSh7XG4gICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgfSksXG4gIHNjYWxpbmdTdGVwczogW1xuICAgIHsgdXBwZXI6IDAsIGNoYW5nZTogLTEgfSxcbiAgICB7IGxvd2VyOiAwLCB1cHBlcjogMTAsIGNoYW5nZTogMSB9LFxuICAgIHsgbG93ZXI6IDEwLCB1cHBlcjogNTAsIGNoYW5nZTogMiB9LFxuICAgIHsgbG93ZXI6IDUwLCBjaGFuZ2U6IDMgfSxcbiAgXSxcbiAgYWRqdXN0bWVudFR5cGU6IGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcuQWRqdXN0bWVudFR5cGUuQ0hBTkdFX0lOX0NBUEFDSVRZLFxuICBjb29sZG93bjogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxufSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxiRG5zTmFtZScsIHtcbiAgICAgIHZhbHVlOiBmYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHVibGljIEROUyBuYW1lIGZvciB0aGUgYXBwbGljYXRpb24gbG9hZCBiYWxhbmNlcicsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUXVldWVVcmwnLCB7XG4gICAgICB2YWx1ZTogb3JkZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpbWFyeSBTUVMgcXVldWUgZm9yIG9yZGVyIGV2ZW50cycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGF0YWJhc2VFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBkYXRhYmFzZS5kYkluc3RhbmNlRW5kcG9pbnRBZGRyZXNzLFxuICAgICAgZGVzY3JpcHRpb246ICdQb3N0Z3JlU1FMIGVuZHBvaW50JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYlNlY3JldE5hbWUnLCB7XG4gICAgICB2YWx1ZTogZGJDcmVkZW50aWFsc1NlY3JldC5zZWNyZXROYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWNyZXRzIE1hbmFnZXIgc2VjcmV0IGNvbnRhaW5pbmcgZGF0YWJhc2UgY3JlZGVudGlhbHMnLFxuICAgIH0pO1xuICB9XG59XG4iXX0=