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
const cdk = __importStar(require("aws-cdk-lib"));
const assertions_1 = require("aws-cdk-lib/assertions");
const order_processing_stack_1 = require("../lib/order-processing-stack");
describe('OrderProcessingStack', () => {
    const app = new cdk.App();
    const stack = new order_processing_stack_1.OrderProcessingStack(app, 'TestOrderProcessingStack');
    const template = assertions_1.Template.fromStack(stack);
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
            ContainerDefinitions: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Name: 'OrderServiceContainer',
                    PortMappings: assertions_1.Match.arrayWith([
                        assertions_1.Match.objectLike({ ContainerPort: 8080 }),
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
            RedrivePolicy: assertions_1.Match.anyValue(),
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3JkZXItcHJvY2Vzc2luZy1zdGFjay50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsib3JkZXItcHJvY2Vzc2luZy1zdGFjay50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHVEQUF5RDtBQUN6RCwwRUFBcUU7QUFFckUsUUFBUSxDQUFDLHNCQUFzQixFQUFFLEdBQUcsRUFBRTtJQUNwQyxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLDZDQUFvQixDQUFDLEdBQUcsRUFBRSwwQkFBMEIsQ0FBQyxDQUFDO0lBQ3hFLE1BQU0sUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBRTNDLElBQUksQ0FBQyw4Q0FBOEMsRUFBRSxHQUFHLEVBQUU7UUFDeEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLHNCQUFzQixFQUFFO1lBQ3JELE1BQU0sRUFBRSxVQUFVO1lBQ2xCLGdCQUFnQixFQUFFLElBQUk7WUFDdEIsa0JBQWtCLEVBQUUsS0FBSztZQUN6QixNQUFNLEVBQUUsVUFBVTtTQUNuQixDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyxvREFBb0QsRUFBRSxHQUFHLEVBQUU7UUFDOUQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUNqRCxRQUFRLENBQUMsZUFBZSxDQUFDLDBCQUEwQixFQUFFLENBQUMsQ0FBQyxDQUFDO1FBRXhELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQkFBMEIsRUFBRTtZQUN6RCxvQkFBb0IsRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztnQkFDcEMsa0JBQUssQ0FBQyxVQUFVLENBQUM7b0JBQ2YsSUFBSSxFQUFFLHVCQUF1QjtvQkFDN0IsWUFBWSxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO3dCQUM1QixrQkFBSyxDQUFDLFVBQVUsQ0FBQyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsQ0FBQztxQkFDMUMsQ0FBQztpQkFDSCxDQUFDO2FBQ0gsQ0FBQztTQUNILENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsSUFBSSxDQUFDLDRDQUE0QyxFQUFFLEdBQUcsRUFBRTtRQUN0RCxRQUFRLENBQUMscUJBQXFCLENBQUMsMkNBQTJDLEVBQUU7WUFDMUUsTUFBTSxFQUFFLGlCQUFpQjtZQUN6QixJQUFJLEVBQUUsYUFBYTtTQUNwQixDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQywrQ0FBK0MsRUFBRSxHQUFHLEVBQUU7UUFDekQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUMvQyxRQUFRLENBQUMscUJBQXFCLENBQUMsaUJBQWlCLEVBQUU7WUFDaEQsYUFBYSxFQUFFLGtCQUFLLENBQUMsUUFBUSxFQUFFO1NBQ2hDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgTWF0Y2gsIFRlbXBsYXRlIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBPcmRlclByb2Nlc3NpbmdTdGFjayB9IGZyb20gJy4uL2xpYi9vcmRlci1wcm9jZXNzaW5nLXN0YWNrJztcblxuZGVzY3JpYmUoJ09yZGVyUHJvY2Vzc2luZ1N0YWNrJywgKCkgPT4ge1xuICBjb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICBjb25zdCBzdGFjayA9IG5ldyBPcmRlclByb2Nlc3NpbmdTdGFjayhhcHAsICdUZXN0T3JkZXJQcm9jZXNzaW5nU3RhY2snKTtcbiAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgYW4gZW5jcnlwdGVkIFBvc3RncmVTUUwgUkRTIGluc3RhbmNlJywgKCkgPT4ge1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpSRFM6OkRCSW5zdGFuY2UnLCB7XG4gICAgICBFbmdpbmU6ICdwb3N0Z3JlcycsXG4gICAgICBTdG9yYWdlRW5jcnlwdGVkOiB0cnVlLFxuICAgICAgUHVibGljbHlBY2Nlc3NpYmxlOiBmYWxzZSxcbiAgICAgIERCTmFtZTogJ29yZGVyc2RiJyxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBhbiBFQ1MgRmFyZ2F0ZSBzZXJ2aWNlIGFuZCB0YXNrIGRlZmluaXRpb24nLCAoKSA9PiB7XG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDUzo6U2VydmljZScsIDEpO1xuICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywgMSk7XG5cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBOYW1lOiAnT3JkZXJTZXJ2aWNlQ29udGFpbmVyJyxcbiAgICAgICAgICBQb3J0TWFwcGluZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHsgQ29udGFpbmVyUG9ydDogODA4MCB9KSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBhIHB1YmxpYyBhcHBsaWNhdGlvbiBsb2FkIGJhbGFuY2VyJywgKCkgPT4ge1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICBTY2hlbWU6ICdpbnRlcm5ldC1mYWNpbmcnLFxuICAgICAgVHlwZTogJ2FwcGxpY2F0aW9uJyxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBhbiBTUVMgcXVldWUgd2l0aCBhIGRlYWQtbGV0dGVyIHF1ZXVlJywgKCkgPT4ge1xuICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpTUVM6OlF1ZXVlJywgMik7XG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlNRUzo6UXVldWUnLCB7XG4gICAgICBSZWRyaXZlUG9saWN5OiBNYXRjaC5hbnlWYWx1ZSgpLFxuICAgIH0pO1xuICB9KTtcbn0pO1xuIl19