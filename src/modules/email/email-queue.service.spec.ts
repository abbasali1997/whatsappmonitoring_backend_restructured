import { Test, TestingModule } from "@nestjs/testing";
import { EmailQueueService, EmailType } from "./email-queue.service";
import { QueueService } from "../../common/messaging/queue.service";
import { ConfigService } from "@nestjs/config";
import { EmailService } from "./email.service";

describe("EmailQueueService", () => {
  let service: EmailQueueService;

  const mockQueueService = {
    sendMessage: jest.fn(),
    sendBatchMessages: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === "app.nodeEnv") return "test";
      if (key === "app.baseUrl") return "https://example.com";
      return defaultValue;
    }),
  };

  const mockEmailService = {
    sendInvitationEmail: jest.fn(),
    sendInvitationEmailWithQR: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
    sendEmailVerificationEmail: jest.fn(),
    sendTestEmail: jest.fn(),
    sendBulkEmails: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailQueueService,
        {
          provide: QueueService,
          useValue: mockQueueService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
      ],
    }).compile();

    service = module.get<EmailQueueService>(EmailQueueService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("queueInvitationEmail", () => {
    it("should queue an invitation email", async () => {
      const email = "test@example.com";
      const templateId = "invitation-template";
      const templateData = {
        firstName: "John",
        lastName: "Doe",
        tempPassword: "temp123",
        entityName: "Test Entity",
      };

      mockQueueService.sendMessage.mockResolvedValue(undefined);

      await service.queueInvitationEmail(email, templateId, templateData, {
        userId: "user-id",
        tenantId: "tenant-id",
      });

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "email-queue",
        EmailType.INVITATION,
        expect.objectContaining({
          email,
          templateId,
          templateData,
        }),
        expect.objectContaining({
          userId: "user-id",
          tenantId: "tenant-id",
        }),
      );
    });
  });

  describe("queueInvitationEmailWithQR", () => {
    it("should queue an invitation email with QR code", async () => {
      const email = "test@example.com";
      const qrData = {
        firstName: "Jane",
        lastName: "Doe",
        qrCode: "data:image/png;base64,test",
        sessionId: "session-123",
        expiresAt: new Date(),
      };

      mockQueueService.sendMessage.mockResolvedValue(undefined);

      await service.queueInvitationEmailWithQR(email, qrData, {
        userId: "user-id",
        tenantId: "tenant-id",
      });

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "email-queue",
        EmailType.INVITATION_WITH_QR,
        expect.objectContaining({
          email,
          ...qrData,
        }),
        expect.objectContaining({
          userId: "user-id",
          tenantId: "tenant-id",
        }),
      );
    });
  });

  describe("queuePasswordResetEmail", () => {
    it("should queue a password reset email", async () => {
      const email = "reset@example.com";
      const resetData = {
        firstName: "Reset",
        resetLink: "https://example.com/reset?token=abc123",
        expiryHours: 24,
      };

      mockQueueService.sendMessage.mockResolvedValue(undefined);

      await service.queuePasswordResetEmail(email, resetData, {
        userId: "user-id",
      });

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "email-queue",
        EmailType.PASSWORD_RESET,
        expect.objectContaining({
          email,
          ...resetData,
        }),
        expect.objectContaining({
          userId: "user-id",
        }),
      );
    });
  });

  describe("queueEmailVerificationEmail", () => {
    it("should queue an email verification email", async () => {
      const email = "verify@example.com";
      const verificationData = {
        firstName: "Verify",
        lastName: "User",
        verificationLink: "https://example.com/verify?token=abc123",
        expiryHours: 48,
      };

      mockQueueService.sendMessage.mockResolvedValue(undefined);

      await service.queueEmailVerificationEmail(email, verificationData, {
        userId: "user-id",
      });

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "email-queue",
        EmailType.EMAIL_VERIFICATION,
        expect.objectContaining({
          email,
          ...verificationData,
        }),
        expect.objectContaining({
          userId: "user-id",
        }),
      );
    });
  });

  describe("queueTestEmail", () => {
    it("should queue a test email", async () => {
      mockQueueService.sendMessage.mockResolvedValue(undefined);

      await service.queueTestEmail("test@example.com", "Test Subject", {
        correlationId: "test-correlation",
      });

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "email-queue",
        EmailType.TEST,
        expect.objectContaining({
          toEmail: "test@example.com",
          subject: "Test Subject",
        }),
        expect.objectContaining({
          correlationId: "test-correlation",
        }),
      );
    });
  });

  describe("queueBulkEmails", () => {
    it("should queue bulk emails", async () => {
      const emails = [
        {
          email: "user1@example.com",
          templateId: "invitation",
          templateData: {
            firstName: "User1",
            lastName: "Test",
            tempPassword: "temp1",
            entityName: "Entity1",
          },
        },
        {
          email: "user2@example.com",
          templateId: "invitation",
          templateData: {
            firstName: "User2",
            lastName: "Test",
            tempPassword: "temp2",
            entityName: "Entity2",
          },
        },
      ];

      mockQueueService.sendBatchMessages.mockResolvedValue(undefined);

      await service.queueBulkEmails(emails, {
        tenantId: "tenant-id",
        correlationId: "bulk-correlation",
      });

      expect(mockQueueService.sendBatchMessages).toHaveBeenCalledWith(
        "email-queue",
        expect.arrayContaining([
          expect.objectContaining({
            eventType: EmailType.INVITATION,
            data: expect.objectContaining({
              email: emails[0].email,
              templateId: emails[0].templateId,
            }),
          }),
          expect.objectContaining({
            eventType: EmailType.INVITATION,
            data: expect.objectContaining({
              email: emails[1].email,
              templateId: emails[1].templateId,
            }),
          }),
        ]),
      );
    });
  });

  describe("localhost bypass branches", () => {
    beforeEach(() => {
      // Force isLocalhost() to return true
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          if (key === "app.nodeEnv") return "development";
          if (key === "app.baseUrl") return "http://localhost:3000";
          return defaultValue;
        },
      );
    });

    it("should bypass queue for queueInvitationEmail on localhost", async () => {
      await service.queueInvitationEmail("test@example.com", "invitation", {
        firstName: "John",
      });

      expect(mockEmailService.sendInvitationEmail).toHaveBeenCalledWith(
        "test@example.com",
        "invitation",
        expect.objectContaining({ firstName: "John" }),
      );
      expect(mockQueueService.sendMessage).not.toHaveBeenCalled();
    });

    it("should bypass queue for queueInvitationEmailWithQR on localhost", async () => {
      await service.queueInvitationEmailWithQR("test@example.com", {
        firstName: "Jane",
        lastName: "Doe",
        qrCode: "data:image/png;base64,abc",
        sessionId: "session-123",
        expiresAt: new Date(),
      });

      expect(mockEmailService.sendInvitationEmailWithQR).toHaveBeenCalled();
      expect(mockQueueService.sendMessage).not.toHaveBeenCalled();
    });

    it("should bypass queue for queuePasswordResetEmail on localhost", async () => {
      await service.queuePasswordResetEmail("reset@example.com", {
        firstName: "Reset",
        resetLink: "https://example.com/reset",
        expiryHours: 24,
      });

      expect(mockEmailService.sendPasswordResetEmail).toHaveBeenCalled();
      expect(mockQueueService.sendMessage).not.toHaveBeenCalled();
    });

    it("should bypass queue for queueEmailVerificationEmail on localhost", async () => {
      await service.queueEmailVerificationEmail("verify@example.com", {
        firstName: "Verify",
        lastName: "User",
        verificationLink: "https://example.com/verify",
        expiryHours: 48,
      });

      expect(mockEmailService.sendEmailVerificationEmail).toHaveBeenCalled();
      expect(mockQueueService.sendMessage).not.toHaveBeenCalled();
    });

    it("should bypass queue for queueTestEmail on localhost", async () => {
      await service.queueTestEmail("test@example.com", "Hello");

      expect(mockEmailService.sendTestEmail).toHaveBeenCalledWith(
        "test@example.com",
        "Hello",
      );
      expect(mockQueueService.sendMessage).not.toHaveBeenCalled();
    });

    it("should bypass queue for queueBulkEmails on localhost", async () => {
      const emails = [
        {
          email: "user1@example.com",
          templateId: "invitation",
          templateData: { firstName: "User1" },
        },
        {
          email: "user2@example.com",
          templateId: "invitation",
          templateData: { firstName: "User2" },
        },
      ];

      await service.queueBulkEmails(emails, { correlationId: "bulk" });

      expect(mockEmailService.sendBulkEmails).toHaveBeenCalledWith(emails);
      expect(mockQueueService.sendBatchMessages).not.toHaveBeenCalled();
    });
  });
});
