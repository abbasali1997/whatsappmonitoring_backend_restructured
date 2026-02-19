import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { EmailService } from "./email.service";
import * as nodemailer from "nodemailer";
import * as fs from "fs";
import * as handlebars from "handlebars";

// Mock nodemailer
jest.mock("nodemailer");
jest.mock("fs");
jest.mock("handlebars");

describe("EmailService", () => {
  let service: EmailService;
  let mockConfigService: Partial<ConfigService>;
  let mockTransporter: any;

  beforeEach(async () => {
    // Mock transporter
    mockTransporter = {
      verify: jest.fn().mockResolvedValue(true),
      sendMail: jest.fn().mockResolvedValue({ messageId: "test-message-id" }),
    };

    // Mock nodemailer.createTransport
    (nodemailer.createTransport as jest.Mock) = jest
      .fn()
      .mockReturnValue(mockTransporter);

    // Mock ConfigService
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          "email.smtp.host": "smtp.example.com",
          "email.smtp.port": 587,
          "email.smtp.secure": false,
          "email.smtp.user": "test@example.com",
          "email.smtp.pass": "password123",
          "email.from.name": "2N5",
          "email.from.address": "noreply@2n5global.com",
          "email.company.name": "2N5",
          "email.company.address": "123 Business Street",
          "email.support.address": "support@2n5global.com",
          "email.social.website": "https://2n5global.com",
          "email.logo.url": "https://2n5global.com/logo.png",
        };
        return config[key];
      }),
    };

    // Mock fs module
    (fs.readFileSync as jest.Mock) = jest
      .fn()
      .mockReturnValue("<html><body>{{firstName}}</body></html>");

    // Mock handlebars
    (handlebars.compile as jest.Mock) = jest
      .fn()
      .mockReturnValue((data: any) => {
        return `<html><body>${data.firstName || ""}</body></html>`;
      });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("verifyConnection", () => {
    it("should return true when connection is verified", async () => {
      mockTransporter.verify = jest.fn().mockResolvedValue(true);

      const result = await service.verifyConnection();

      expect(result).toBe(true);
      expect(mockTransporter.verify).toHaveBeenCalled();
    });

    it("should return false when connection fails", async () => {
      mockTransporter.verify = jest
        .fn()
        .mockRejectedValue(new Error("Connection failed"));

      const result = await service.verifyConnection();

      expect(result).toBe(false);
    });
  });

  describe("sendTestEmail", () => {
    it("should send test email successfully", async () => {
      const toEmail = "test@example.com";
      const subject = "Test Email";

      await service.sendTestEmail(toEmail, subject);

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      const callArgs = mockTransporter.sendMail.mock.calls[0][0];
      expect(callArgs.to).toBe(toEmail);
      expect(callArgs.subject).toBe(subject);
      expect(callArgs.html).toContain("2N5 Email Service");
    });

    it("should throw error when sending fails", async () => {
      mockTransporter.sendMail = jest
        .fn()
        .mockRejectedValue(new Error("Send failed"));

      await expect(service.sendTestEmail("test@example.com")).rejects.toThrow();
    });
  });

  describe("sendInvitationEmail", () => {
    it("should send invitation email successfully", async () => {
      const email = "user@example.com";
      const templateId = "user-invitation";
      const templateData = {
        firstName: "John",
        lastName: "Doe",
        subject: "Welcome",
      };

      await service.sendInvitationEmail(email, templateId, templateData);

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      const callArgs = mockTransporter.sendMail.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toBe(templateData.subject);
    });

    it("should handle template loading errors gracefully", async () => {
      (fs.readFileSync as jest.Mock) = jest.fn().mockImplementation(() => {
        throw new Error("Template not found");
      });

      const email = "user@example.com";
      const templateId = "non-existent";
      const templateData = { firstName: "John" };

      // Should not throw, should use default template
      await expect(
        service.sendInvitationEmail(email, templateId, templateData),
      ).resolves.not.toThrow();
    });
  });

  describe("sendPasswordResetEmail", () => {
    it("should send password reset email successfully", async () => {
      const email = "user@example.com";
      const data = {
        firstName: "John",
        resetLink: "https://example.com/reset?token=abc123",
        expiryHours: 1,
      };

      await service.sendPasswordResetEmail(email, data);

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      const callArgs = mockTransporter.sendMail.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toContain("Reset Your Password");
    });
  });

  describe("sendBulkEmails", () => {
    it("should send multiple emails successfully", async () => {
      const emails = [
        {
          email: "user1@example.com",
          templateId: "user-invitation",
          templateData: { firstName: "User1" },
        },
        {
          email: "user2@example.com",
          templateId: "user-invitation",
          templateData: { firstName: "User2" },
        },
      ];

      const result = await service.sendBulkEmails(emails);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(2);
    });

    it("should handle partial failures in bulk email sending", async () => {
      mockTransporter.sendMail = jest
        .fn()
        .mockResolvedValueOnce({ messageId: "success" })
        .mockRejectedValueOnce(new Error("Send failed"));

      const emails = [
        {
          email: "user1@example.com",
          templateId: "user-invitation",
          templateData: { firstName: "User1" },
        },
        {
          email: "user2@example.com",
          templateId: "user-invitation",
          templateData: { firstName: "User2" },
        },
      ];

      const result = await service.sendBulkEmails(emails);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].email).toBe("user2@example.com");
    });
  });

  describe("sendEmailVerificationEmail", () => {
    it("should send email verification email successfully", async () => {
      const email = "user@example.com";
      const data = {
        firstName: "John",
        lastName: "Doe",
        verificationLink: "https://example.com/verify?token=abc123",
        expiryHours: 24,
      };

      await service.sendEmailVerificationEmail(email, data);

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      const callArgs = mockTransporter.sendMail.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toContain("Verify Your New Email Address");
    });
  });

  describe("sendInvitationEmailWithQR", () => {
    it("should send invitation email with QR code successfully", async () => {
      const email = "user@example.com";
      const data = {
        firstName: "John",
        lastName: "Doe",
        qrCode: "base64encodedqrcode",
        sessionId: "session123",
        expiresAt: new Date(Date.now() + 3600000),
      };

      await service.sendInvitationEmailWithQR(email, data);

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      const callArgs = mockTransporter.sendMail.mock.calls[0][0];
      expect(callArgs.to).toBe(email);
      expect(callArgs.subject).toContain("Connect Your WhatsApp");
    });
  });
});
