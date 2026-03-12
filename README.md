# Flexischools Order Processing CDK

## What it deploys

- **Amazon RDS PostgreSQL** in private isolated subnets
- **Amazon ECS Fargate** service running a sample containerised microservice
- **Amazon SQS** queue and dead-letter queue for event-driven order processing
- **Application Load Balancer** in public subnets routing traffic to the Fargate service
- **Secrets Manager** secret for database credentials
- **CloudWatch Logs** for the container and PostgreSQL logs
- **Auto scaling** for ECS tasks based on CPU and queue depth

## Architecture summary

1. The ALB exposes the `/health`, `/orders` GET, and `/orders` POST endpoints.
2. The ECS Fargate microservice runs in private subnets behind the ALB.
3. The same container also polls the SQS queue for order events.
4. Processed events are written into PostgreSQL.
5. The database is only reachable from the ECS service security context and lives in isolated subnets.

## Security and best-practice choices

- RDS is **not publicly accessible**.
- Database credentials are stored in **AWS Secrets Manager**.
- RDS storage is **encrypted at rest**.
- SQS queues use **SQS-managed encryption**.
- ECS tasks run in **private subnets**.
- The service is configured with a **deployment circuit breaker**.
- CloudWatch logging is enabled for both the application and PostgreSQL.
- DLQ is configured to avoid poison-message loops.

## Project structure

```text
.
├── bin/
│   └── app.ts
├── lib/
│   └── order-processing-stack.ts
├── src/
│   ├── Dockerfile
│   ├── index.js
│   └── package.json
├── test/
│   └── order-processing-stack.test.ts
├── cdk.json
├── jest.config.js
├── package.json
├── tsconfig.json
└── README.md
```

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- AWS CDK bootstrap completed in the target account/region

Bootstrap if needed:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

## Install dependencies

```bash
npm install
```

## Run unit tests

```bash
npm test
```
## Synthesize the CloudFormation template

```bash
npm run synth
```

## Deploy

```bash
npm run deploy
```

By default the app deploys to `ap-southeast-2` when `CDK_DEFAULT_REGION` is not set.

## Key implementation notes

### RDS

The stack uses `DatabaseInstance` with PostgreSQL, a custom parameter group, backups, monitoring, log exports, encryption, and isolated subnets. AWS CDK supports PostgreSQL engine selection via `DatabaseInstanceEngine.postgres(...)`, and current CDK API references include modern PostgreSQL versions such as `VER_16_3`. 

### ECS + ALB

The stack uses `ApplicationLoadBalancedFargateService`, which is the standard higher-level CDK construct for placing a Fargate service behind an ALB. 
### SQS consumer design

The sample microservice exposes HTTP endpoints for the ALB and continuously polls SQS in-process to simulate an event-driven order worker. In a production design, you could split the web API and worker into separate ECS services for tighter scaling control.

## Suggested production improvements

- Add **RDS Proxy** for improved connection management.
- Use **AWS WAF** in front of the ALB.
- Add **HTTPS** with ACM and Route 53.
- Split API and queue worker into separate ECS services.
- Add **Amazon ElastiCache** or idempotency controls for high-volume workflows.
- Add **CloudWatch alarms** and dashboards.
- Add **CI/CD** with GitHub Actions or CodePipeline.

## Notes for submission

If the assessor asks for trade-offs, these are good talking points:

- I used a **single Fargate service** to satisfy the requirement quickly and clearly.
- I placed **RDS in isolated subnets** and **ECS in private subnets** for a stronger security baseline.
- I chose the **ALB Fargate pattern construct** to reduce boilerplate and improve readability.
- I added **DLQ, autoscaling, logging, and Secrets Manager** because these are expected production-friendly defaults.
