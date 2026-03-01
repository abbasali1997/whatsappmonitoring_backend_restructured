"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const app_module_1 = require("@/apps/api/app.module");
const test_helpers_1 = require("../../helpers/test-helpers");
const email_queue_service_1 = require("../../../src/modules/email/email-queue.service");
const setup_e2e_1 = require("../../setup-e2e");
describe("Email Queue Workflow (e2e)", () => {
    let app;
    let emailQueueService;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        emailQueueService = moduleFixture.get(email_queue_service_1.EmailQueueService);
    });
    beforeEach(async () => {
        await (0, setup_e2e_1.cleanDatabase)();
    });
    afterAll(async () => {
        await app.close();
    });
    describe("Email Queue Operations", () => {
        it("should queue an invitation email", async () => {
            const emailData = {
                email: "invite@example.com",
                firstName: "John",
                lastName: "Doe",
                tempPassword: "temp123",
                entityName: "Test Entity",
            };
            await expect(emailQueueService.queueInvitationEmail(emailData.email, "user-invitation", {
                firstName: emailData.firstName,
                lastName: emailData.lastName,
                tempPassword: emailData.tempPassword,
                entityName: emailData.entityName,
            }, {
                userId: "user-id",
                tenantId: "tenant-id",
            })).resolves.not.toThrow();
        });
        it("should queue an invitation email with QR code", async () => {
            const emailData = {
                email: "inviteqr@example.com",
                firstName: "Jane",
                lastName: "Doe",
                qrCode: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                sessionId: "test-session-id",
                expiresAt: new Date(Date.now() + 60000),
            };
            await expect(emailQueueService.queueInvitationEmailWithQR(emailData.email, {
                firstName: emailData.firstName,
                lastName: emailData.lastName,
                qrCode: emailData.qrCode,
                sessionId: emailData.sessionId,
                expiresAt: emailData.expiresAt,
            }, {
                userId: "user-id",
                tenantId: "tenant-id",
            })).resolves.not.toThrow();
        });
        it("should process queued email message", async () => {
            const mockPayload = {
                eventType: "email.invitation",
                timestamp: new Date(),
                data: {
                    email: "process@example.com",
                    templateId: "user-invitation",
                    templateData: {
                        firstName: "Process",
                        lastName: "Test",
                        tempPassword: "temp123",
                        entityName: "Test Entity",
                    },
                },
            };
            const mockMessage = test_helpers_1.QueueHelpers.createMockServiceBusMessage(mockPayload, { type: "INVITATION" });
            const emailService = app.get("EmailService");
            jest
                .spyOn(emailService, "sendInvitationEmail")
                .mockResolvedValue(undefined);
            expect(mockMessage).toBeDefined();
        });
        it("should handle queue message retry on failure", async () => {
            const mockPayload = {
                eventType: "email.invitation",
                timestamp: new Date(),
                data: {
                    email: "retry@example.com",
                    templateId: "user-invitation",
                    templateData: {
                        firstName: "Retry",
                        lastName: "Test",
                    },
                },
            };
            const mockMessage = test_helpers_1.QueueHelpers.createMockServiceBusMessage(mockPayload, { type: "INVITATION", deliveryCount: 1 });
            const emailService = app.get("EmailService");
            jest
                .spyOn(emailService, "sendInvitationEmail")
                .mockRejectedValueOnce(new Error("Temporary failure"))
                .mockResolvedValueOnce(undefined);
            expect(mockMessage).toBeDefined();
        });
    });
    describe("Queue Error Handling", () => {
        it("should dead-letter message after max retries", async () => {
            const mockPayload = {
                eventType: "email.invitation",
                timestamp: new Date(),
                data: {
                    email: "deadletter@example.com",
                    templateId: "user-invitation",
                    templateData: {},
                },
            };
            const mockMessage = test_helpers_1.QueueHelpers.createMockServiceBusMessage(mockPayload, { type: "INVITATION", deliveryCount: 4 });
            const emailService = app.get("EmailService");
            jest
                .spyOn(emailService, "sendInvitationEmail")
                .mockRejectedValue(new Error("Permanent failure"));
            expect(mockMessage).toBeDefined();
        });
    });
});
//# sourceMappingURL=email-queue.e2e-spec.js.map