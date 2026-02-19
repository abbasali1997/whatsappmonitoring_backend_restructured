import { Test, TestingModule } from "@nestjs/testing";
import { EmailQueueProcessor } from "./email-queue.processor";
import { QueueService } from "../../common/messaging/queue.service";
import { EmailService } from "./email.service";
import { EmailType } from "./email-queue.service";
import { ServiceBusReceivedMessage } from "@azure/service-bus";
import { ConfigService } from "@nestjs/config";

describe("EmailQueueProcessor", () => {
  let processor: EmailQueueProcessor;

  const mockQueueService = {
    startReceiver: jest.fn(),
    stopReceiver: jest.fn(),
  };

  const mockEmailService = {
    sendInvitationEmail: jest.fn(),
    sendInvitationEmailWithQR: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
    sendEmailVerificationEmail: jest.fn(),
    sendTestEmail: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === "app.nodeEnv") return "test";
      if (key === "app.baseUrl") return "https://example.com";
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailQueueProcessor,
        {
          provide: QueueService,
          useValue: mockQueueService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    processor = module.get<EmailQueueProcessor>(EmailQueueProcessor);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(processor).toBeDefined();
  });

  describe("onModuleInit", () => {
    it("should start email queue receiver", async () => {
      await processor.onModuleInit();

      expect(mockQueueService.startReceiver).toHaveBeenCalledWith(
        "email-queue",
        expect.any(Function),
        {
          maxConcurrentCalls: 5,
          autoCompleteMessages: true,
        },
      );
    });
  });

  describe("onModuleDestroy", () => {
    it("should stop email queue receiver", async () => {
      await processor.onModuleDestroy();

      expect(mockQueueService.stopReceiver).toHaveBeenCalledWith("email-queue");
    });
  });

  describe("processEmailMessage", () => {
    const createMockMessage = (
      eventType: string,
      data: any,
    ): ServiceBusReceivedMessage =>
      ({
        messageId: "test-message-id",
        correlationId: "test-correlation-id",
        body: { eventType, data },
        applicationProperties: { type: eventType },
      }) as any;

    it("should process invitation email", async () => {
      const message = createMockMessage(EmailType.INVITATION, {
        email: "test@example.com",
        templateId: "invitation",
        templateData: { firstName: "John" },
      });

      mockEmailService.sendInvitationEmail.mockResolvedValue(undefined);

      // Access private method via reflection or make it public for testing
      await (processor as any).processEmailMessage(message, {
        eventType: EmailType.INVITATION,
        data: message.body.data,
      });

      expect(mockEmailService.sendInvitationEmail).toHaveBeenCalledWith(
        "test@example.com",
        "invitation",
        expect.objectContaining({
          firstName: "John",
        }),
      );
    });

    it("should process invitation email with QR", async () => {
      const message = createMockMessage(EmailType.INVITATION_WITH_QR, {
        email: "test@example.com",
        firstName: "Jane",
        lastName: "Doe",
        qrCode: "data:image/png;base64,test",
        sessionId: "session-123",
        expiresAt: new Date(),
      });

      mockEmailService.sendInvitationEmailWithQR.mockResolvedValue(undefined);

      await (processor as any).processEmailMessage(message, {
        eventType: EmailType.INVITATION_WITH_QR,
        data: message.body.data,
      });

      expect(mockEmailService.sendInvitationEmailWithQR).toHaveBeenCalledWith(
        "test@example.com",
        expect.objectContaining({
          firstName: "Jane",
          qrCode: "data:image/png;base64,test",
        }),
      );
    });

    it("should process password reset email", async () => {
      const message = createMockMessage(EmailType.PASSWORD_RESET, {
        email: "reset@example.com",
        firstName: "Reset",
        resetLink: "https://example.com/reset",
        expiryHours: 24,
      });

      mockEmailService.sendPasswordResetEmail.mockResolvedValue(undefined);

      await (processor as any).processEmailMessage(message, {
        eventType: EmailType.PASSWORD_RESET,
        data: message.body.data,
      });

      expect(mockEmailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        "reset@example.com",
        expect.objectContaining({
          resetLink: "https://example.com/reset",
        }),
      );
    });

    it("should process email verification email", async () => {
      const message = createMockMessage(EmailType.EMAIL_VERIFICATION, {
        email: "verify@example.com",
        firstName: "Verify",
        lastName: "User",
        verificationLink: "https://example.com/verify",
        expiryHours: 48,
      });

      mockEmailService.sendEmailVerificationEmail.mockResolvedValue(undefined);

      await (processor as any).processEmailMessage(message, {
        eventType: EmailType.EMAIL_VERIFICATION,
        data: message.body.data,
      });

      expect(mockEmailService.sendEmailVerificationEmail).toHaveBeenCalledWith(
        "verify@example.com",
        expect.objectContaining({
          verificationLink: "https://example.com/verify",
        }),
      );
    });

    it("should process test email", async () => {
      const message = createMockMessage(EmailType.TEST, {
        toEmail: "test@example.com",
        subject: "Test Subject",
      });

      mockEmailService.sendTestEmail.mockResolvedValue(undefined);

      await (processor as any).processEmailMessage(message, {
        eventType: EmailType.TEST,
        data: message.body.data,
      });

      expect(mockEmailService.sendTestEmail).toHaveBeenCalledWith(
        "test@example.com",
        "Test Subject",
      );
    });

    it("should handle unknown email type", async () => {
      const message = createMockMessage("unknown.type", {
        email: "test@example.com",
      });

      await expect(
        (processor as any).processEmailMessage(message, {
          eventType: "unknown.type",
          data: message.body.data,
        }),
      ).rejects.toThrow("Unknown email type: unknown.type");
    });

    it("should handle email service errors", async () => {
      const message = createMockMessage(EmailType.INVITATION, {
        email: "error@example.com",
        templateId: "invitation",
        templateData: {},
      });

      mockEmailService.sendInvitationEmail.mockRejectedValue(
        new Error("Email service error"),
      );

      await expect(
        (processor as any).processEmailMessage(message, {
          eventType: EmailType.INVITATION,
          data: message.body.data,
        }),
      ).rejects.toThrow("Email service error");
    });
  });
});
