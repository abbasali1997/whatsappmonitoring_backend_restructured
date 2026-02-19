/**
 * Email Queue Service
 *
 * This service handles email sending through Azure Service Bus Queues.
 * Instead of sending emails synchronously, emails are queued and processed asynchronously
 * by the EmailQueueProcessor, providing better scalability and reliability.
 *
 * Features:
 * - Queue email jobs instead of sending immediately
 * - Support for all email types (invitation, password reset, verification, etc.)
 * - Automatic retry on failures
 * - Dead letter queue for failed emails
 * - Better performance and scalability
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { QueueService } from "../../common/messaging/queue.service";
import { EmailService } from "./email.service";

export enum EmailType {
  INVITATION = "email.invitation",
  INVITATION_WITH_QR = "email.invitation-with-qr",
  PASSWORD_RESET = "email.password-reset",
  EMAIL_VERIFICATION = "email.verification",
  TEST = "email.test",
  BULK = "email.bulk",
}

export interface InvitationEmailData {
  email: string;
  templateId: string;
  templateData: Record<string, any>;
}

export interface InvitationEmailWithQRData {
  email: string;
  firstName: string;
  lastName: string;
  qrCode: string;
  sessionId: string;
  expiresAt: Date;
}

export interface PasswordResetEmailData {
  email: string;
  firstName: string;
  resetLink: string;
  expiryHours: number;
  logoUrl?: string;
  companyName?: string;
  companyAddress?: string;
  supportEmail?: string;
  socialLinks?: {
    website?: string;
    linkedin?: string;
    twitter?: string;
  };
  language?: string;
}

export interface EmailVerificationData {
  email: string;
  firstName: string;
  lastName: string;
  verificationLink: string;
  expiryHours: number;
  logoUrl?: string;
  companyName?: string;
  companyAddress?: string;
  supportEmail?: string;
  socialLinks?: {
    website?: string;
    linkedin?: string;
    twitter?: string;
  };
  language?: string;
}

export interface TestEmailData {
  toEmail: string;
  subject?: string;
}

export interface BulkEmailData {
  emails: Array<{
    email: string;
    templateId: string;
    templateData: Record<string, any>;
  }>;
}

@Injectable()
export class EmailQueueService {
  private readonly logger = new Logger(EmailQueueService.name);
  private readonly queueName = "email-queue";

  constructor(
    private queueService: QueueService,
    private configService: ConfigService,
    private emailService: EmailService,
  ) {}

  /**
   * Check if running on localhost
   * @returns true if running on localhost, false otherwise
   */
  private isLocalhost(): boolean {
    const nodeEnv = this.configService.get<string>("app.nodeEnv", "development");
    const baseUrl = this.configService.get<string>("app.baseUrl", "http://localhost:3000");
    return (
      nodeEnv === "development" ||
      baseUrl.includes("localhost") ||
      baseUrl.includes("127.0.0.1")
    );
  }

  /**
   * Queue an invitation email
   */
  async queueInvitationEmail(
    email: string,
    templateId: string,
    templateData: Record<string, any>,
    options?: {
      correlationId?: string;
      userId?: string;
      tenantId?: string;
    },
  ): Promise<void> {
    this.logger.debug(
      `Queueing invitation email: to=${email}, templateId=${templateId}, correlationId=${options?.correlationId}, userId=${options?.userId}, tenantId=${options?.tenantId}`,
    );

    // On localhost, bypass queue and call email service directly
    if (this.isLocalhost()) {
      this.logger.debug(
        `[LOCALHOST] Bypassing queue, calling email service directly: to=${email}`,
      );
      await this.emailService.sendInvitationEmail(email, templateId, templateData);
      return;
    }

    const emailData: InvitationEmailData = {
      email,
      templateId,
      templateData,
    };

    await this.queueService.sendMessage(
      this.queueName,
      EmailType.INVITATION,
      emailData,
      {
        correlationId: options?.correlationId || `invitation-${email}`,
        userId: options?.userId,
        tenantId: options?.tenantId,
      },
    );

    this.logger.log(`Queued invitation email for ${email}`);
  }

  /**
   * Queue an invitation email with QR code
   */
  async queueInvitationEmailWithQR(
    email: string,
    data: {
      firstName: string;
      lastName: string;
      qrCode: string;
      sessionId: string;
      expiresAt: Date;
    },
    options?: {
      correlationId?: string;
      userId?: string;
      tenantId?: string;
    },
  ): Promise<void> {
    this.logger.debug(
      `Queueing invitation email with QR: to=${email}, sessionId=${data.sessionId}, expiresAt=${data.expiresAt?.toISOString?.()}, correlationId=${options?.correlationId}, userId=${options?.userId}, tenantId=${options?.tenantId}`,
    );

    // On localhost, bypass queue and call email service directly
    if (this.isLocalhost()) {
      this.logger.debug(
        `[LOCALHOST] Bypassing queue, calling email service directly: to=${email}`,
      );
      await this.emailService.sendInvitationEmailWithQR(email, data);
      return;
    }

    const emailData: InvitationEmailWithQRData = {
      email,
      ...data,
    };

    await this.queueService.sendMessage(
      this.queueName,
      EmailType.INVITATION_WITH_QR,
      emailData,
      {
        correlationId: options?.correlationId || `invitation-qr-${email}`,
        userId: options?.userId,
        tenantId: options?.tenantId,
      },
    );

    this.logger.log(`Queued invitation email with QR for ${email}`);
  }

  /**
   * Queue a password reset email
   */
  async queuePasswordResetEmail(
    email: string,
    data: {
      firstName: string;
      resetLink: string;
      expiryHours: number;
      logoUrl?: string;
      companyName?: string;
      companyAddress?: string;
      supportEmail?: string;
      socialLinks?: {
        website?: string;
        linkedin?: string;
        twitter?: string;
      };
    },
    options?: {
      correlationId?: string;
      userId?: string;
    },
  ): Promise<void> {
    this.logger.debug(
      `Queueing password reset email: to=${email}, expiryHours=${data.expiryHours}, correlationId=${options?.correlationId}, userId=${options?.userId}`,
    );

    // On localhost, bypass queue and call email service directly
    if (this.isLocalhost()) {
      this.logger.debug(
        `[LOCALHOST] Bypassing queue, calling email service directly: to=${email}`,
      );
      await this.emailService.sendPasswordResetEmail(email, data);
      return;
    }

    const emailData: PasswordResetEmailData = {
      email,
      ...data,
    };

    await this.queueService.sendMessage(
      this.queueName,
      EmailType.PASSWORD_RESET,
      emailData,
      {
        correlationId: options?.correlationId || `password-reset-${email}`,
        userId: options?.userId,
      },
    );

    this.logger.log(`Queued password reset email for ${email}`);
  }

  /**
   * Queue an email verification email
   */
  async queueEmailVerificationEmail(
    email: string,
    data: {
      firstName: string;
      lastName: string;
      verificationLink: string;
      expiryHours: number;
      logoUrl?: string;
      companyName?: string;
      companyAddress?: string;
      supportEmail?: string;
      socialLinks?: {
        website?: string;
        linkedin?: string;
        twitter?: string;
      };
    },
    options?: {
      correlationId?: string;
      userId?: string;
    },
  ): Promise<void> {
    this.logger.debug(
      `Queueing email verification: to=${email}, expiryHours=${data.expiryHours}, correlationId=${options?.correlationId}, userId=${options?.userId}`,
    );

    // On localhost, bypass queue and call email service directly
    if (this.isLocalhost()) {
      this.logger.debug(
        `[LOCALHOST] Bypassing queue, calling email service directly: to=${email}`,
      );
      await this.emailService.sendEmailVerificationEmail(email, data);
      return;
    }

    const emailData: EmailVerificationData = {
      email,
      ...data,
    };

    await this.queueService.sendMessage(
      this.queueName,
      EmailType.EMAIL_VERIFICATION,
      emailData,
      {
        correlationId: options?.correlationId || `email-verification-${email}`,
        userId: options?.userId,
      },
    );

    this.logger.log(`Queued email verification email for ${email}`);
  }

  /**
   * Queue a test email
   */
  async queueTestEmail(
    toEmail: string,
    subject?: string,
    options?: {
      correlationId?: string;
    },
  ): Promise<void> {
    this.logger.debug(
      `Queueing test email: to=${toEmail}, subject="${subject}", correlationId=${options?.correlationId}`,
    );

    // On localhost, bypass queue and call email service directly
    if (this.isLocalhost()) {
      this.logger.debug(
        `[LOCALHOST] Bypassing queue, calling email service directly: to=${toEmail}`,
      );
      await this.emailService.sendTestEmail(toEmail, subject);
      return;
    }

    const emailData: TestEmailData = {
      toEmail,
      subject,
    };

    await this.queueService.sendMessage(
      this.queueName,
      EmailType.TEST,
      emailData,
      {
        correlationId: options?.correlationId || `test-email-${toEmail}`,
      },
    );

    this.logger.log(`Queued test email for ${toEmail}`);
  }

  /**
   * Queue bulk emails
   * Each email in the bulk will be sent as a separate message for better reliability
   */
  async queueBulkEmails(
    emails: Array<{
      email: string;
      templateId: string;
      templateData: Record<string, any>;
    }>,
    options?: {
      correlationId?: string;
      tenantId?: string;
    },
  ): Promise<void> {
    this.logger.debug(
      `Queueing bulk invitation emails: count=${emails.length}, correlationId=${options?.correlationId}, tenantId=${options?.tenantId}`,
    );

    // On localhost, bypass queue and call email service directly
    if (this.isLocalhost()) {
      this.logger.debug(
        `[LOCALHOST] Bypassing queue, calling email service directly for bulk emails: count=${emails.length}`,
      );
      await this.emailService.sendBulkEmails(emails);
      return;
    }

    const messages = emails.map((emailData) => ({
      eventType: EmailType.INVITATION,
      data: {
        email: emailData.email,
        templateId: emailData.templateId,
        templateData: emailData.templateData,
      } as InvitationEmailData,
      options: {
        correlationId:
          options?.correlationId || `bulk-invitation-${emailData.email}`,
        tenantId: options?.tenantId,
      },
    }));

    await this.queueService.sendBatchMessages(this.queueName, messages);
    this.logger.log(`Queued ${emails.length} bulk invitation emails`);
  }
}
