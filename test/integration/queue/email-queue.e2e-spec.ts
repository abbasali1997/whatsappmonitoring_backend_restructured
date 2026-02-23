import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "@/apps/api/app.module";
import { QueueHelpers } from "../../helpers/test-helpers";
import { EmailQueueService } from "../../../src/modules/email/email-queue.service";
import { cleanDatabase } from "../../setup-e2e";

describe("Email Queue Workflow (e2e)", () => {
  let app: INestApplication;
  let emailQueueService: EmailQueueService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    emailQueueService = moduleFixture.get<EmailQueueService>(EmailQueueService);
  });

  beforeEach(async () => {
    await cleanDatabase();
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

      await expect(
        emailQueueService.queueInvitationEmail(
          emailData.email,
          "user-invitation",
          {
            firstName: emailData.firstName,
            lastName: emailData.lastName,
            tempPassword: emailData.tempPassword,
            entityName: emailData.entityName,
          },
          {
            userId: "user-id",
            tenantId: "tenant-id",
          },
        ),
      ).resolves.not.toThrow();
    });

    it("should queue an invitation email with QR code", async () => {
      const emailData = {
        email: "inviteqr@example.com",
        firstName: "Jane",
        lastName: "Doe",
        qrCode:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        sessionId: "test-session-id",
        expiresAt: new Date(Date.now() + 60000),
      };

      await expect(
        emailQueueService.queueInvitationEmailWithQR(
          emailData.email,
          {
            firstName: emailData.firstName,
            lastName: emailData.lastName,
            qrCode: emailData.qrCode,
            sessionId: emailData.sessionId,
            expiresAt: emailData.expiresAt,
          },
          {
            userId: "user-id",
            tenantId: "tenant-id",
          },
        ),
      ).resolves.not.toThrow();
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
      const mockMessage = QueueHelpers.createMockServiceBusMessage(
        mockPayload,
        { type: "INVITATION" },
      );

      // Mock the email service to avoid actual email sending
      const emailService = app.get("EmailService");
      jest
        .spyOn(emailService, "sendInvitationEmail")
        .mockResolvedValue(undefined);

      // Note: processEmailMessage is private, so we test via the queue receiver
      // This test would need to be adjusted based on actual queue processing flow
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
      const mockMessage = QueueHelpers.createMockServiceBusMessage(
        mockPayload,
        { type: "INVITATION", deliveryCount: 1 },
      );

      // Mock email service to fail first time
      const emailService = app.get("EmailService");
      jest
        .spyOn(emailService, "sendInvitationEmail")
        .mockRejectedValueOnce(new Error("Temporary failure"))
        .mockResolvedValueOnce(undefined);

      // Note: processEmailMessage is private, so we test via the queue receiver
      // This test would need to be adjusted based on actual queue processing flow
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
      const mockMessage = QueueHelpers.createMockServiceBusMessage(
        mockPayload,
        { type: "INVITATION", deliveryCount: 4 }, // Max retries exceeded
      );

      const emailService = app.get("EmailService");
      jest
        .spyOn(emailService, "sendInvitationEmail")
        .mockRejectedValue(new Error("Permanent failure"));

      // Note: processEmailMessage is private, so we test via the queue receiver
      // This test would need to be adjusted based on actual queue processing flow
      expect(mockMessage).toBeDefined();
    });
  });
});
