/**
 * Email Queue Processor
 *
 * This service processes email messages from the Azure Service Bus Queue
 * and actually sends them using the EmailService.
 *
 * It should be started when the application initializes (OnModuleInit)
 * and stopped when the application shuts down (OnModuleDestroy).
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { QueueService, QueueMessage } from "@/common/messaging/queue.service";
import { EmailService } from "@/modules/email/email.service";
import {
  EmailType,
  InvitationEmailData,
  InvitationEmailWithQRData,
  PasswordResetEmailData,
  EmailVerificationData,
  TestEmailData,
} from "@/modules/email/email-queue.service";
import { ServiceBusReceivedMessage } from "@azure/service-bus";

@Injectable()
export class EmailQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueProcessor.name);
  private readonly queueName = "email-queue";

  constructor(
    private queueService: QueueService,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  /**
   * Check if running on localhost
   * @returns true if running on localhost, false otherwise
   */
  private isLocalhost(): boolean {
    const nodeEnv = this.configService.get<string>(
      "app.nodeEnv",
      "development",
    );
    const baseUrl = this.configService.get<string>(
      "app.baseUrl",
      "http://localhost:3000",
    );
    return (
      nodeEnv === "development" ||
      baseUrl.includes("localhost") ||
      baseUrl.includes("127.0.0.1")
    );
  }

  async onModuleInit() {
    // Skip starting receiver on localhost (emails are sent directly, not queued)
    if (this.isLocalhost()) {
      this.logger.log(
        "[LOCALHOST] Email queue processor skipped - emails are sent directly, not queued",
      );
      return;
    }

    // Start processing email messages from the queue
    await this.queueService.startReceiver(
      this.queueName,
      this.processEmailMessage.bind(this),
      {
        maxConcurrentCalls: 5, // Process up to 5 emails concurrently
        autoCompleteMessages: true, // Auto-complete on success
      },
    );
    this.logger.log("Email queue processor started");
  }

  async onModuleDestroy() {
    // Skip stopping receiver on localhost (receiver was never started)
    if (this.isLocalhost()) {
      return;
    }

    // Stop processing messages
    await this.queueService.stopReceiver(this.queueName);
    this.logger.log("Email queue processor stopped");
  }

  /**
   * Process email messages from the queue
   */
  private async processEmailMessage(
    message: ServiceBusReceivedMessage,
    payload: QueueMessage<any>,
  ): Promise<void> {
    const { eventType, data } = payload;

    try {
      this.logger.debug(
        `Processing email message: type=${eventType}, messageId=${message.messageId}, correlationId=${message.correlationId || message.applicationProperties?.correlationId}, to=${data.email || data.toEmail}`,
      );
      if (message.applicationProperties) {
        this.logger.debug(
          `Message applicationProperties: ${JSON.stringify(message.applicationProperties)}`,
        );
      }

      switch (eventType) {
        case EmailType.INVITATION:
          this.logger.debug(
            `Dispatching InvitationEmail: to=${(data as InvitationEmailData).email}, templateId=${(data as InvitationEmailData).templateId}`,
          );
          await this.handleInvitationEmail(data as InvitationEmailData);
          break;

        case EmailType.INVITATION_WITH_QR:
          this.logger.debug(
            `Dispatching InvitationEmailWithQR: to=${(data as InvitationEmailWithQRData).email}, sessionId=${(data as InvitationEmailWithQRData).sessionId}`,
          );
          await this.handleInvitationEmailWithQR(
            data as InvitationEmailWithQRData,
          );
          break;

        case EmailType.PASSWORD_RESET:
          this.logger.debug(
            `Dispatching PasswordResetEmail: to=${(data as PasswordResetEmailData).email}`,
          );
          await this.handlePasswordResetEmail(data as PasswordResetEmailData);
          break;

        case EmailType.EMAIL_VERIFICATION:
          this.logger.debug(
            `Dispatching EmailVerification: to=${(data as EmailVerificationData).email}`,
          );
          await this.handleEmailVerificationEmail(
            data as EmailVerificationData,
          );
          break;

        case EmailType.TEST:
          this.logger.debug(
            `Dispatching TestEmail: to=${(data as TestEmailData).toEmail}`,
          );
          await this.handleTestEmail(data as TestEmailData);
          break;

        default:
          this.logger.warn(`Unknown email type: ${eventType}`);
          throw new Error(`Unknown email type: ${eventType}`);
      }

      this.logger.log(
        `Successfully processed email: ${eventType} for ${data.email || data.toEmail}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process email message ${eventType}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger.debug(
        `Email processing error details: messageId=${message.messageId}, correlationId=${message.correlationId || message.applicationProperties?.correlationId}, errorStack=${error?.stack}`,
      );

      // Check delivery count to determine if we should dead letter
      const deliveryCount = message.deliveryCount || 0;
      const maxRetries = 3;

      if (deliveryCount >= maxRetries) {
        // Move to dead letter queue after max retries
        await this.queueService.deadLetterMessage(
          this.queueName,
          message,
          "Max retries exceeded",
          error instanceof Error ? error.message : String(error),
        );
        this.logger.error(
          `Email message moved to DLQ after ${maxRetries} retries: ${eventType}`,
        );
      } else {
        // Message will be retried automatically (abandoned)
        throw error; // Re-throw to trigger retry
      }
    }
  }

  /**
   * Handle invitation email
   */
  private async handleInvitationEmail(
    data: InvitationEmailData,
  ): Promise<void> {
    await this.emailService.sendInvitationEmail(
      data.email,
      data.templateId,
      data.templateData,
    );
  }

  /**
   * Handle invitation email with QR code
   */
  private async handleInvitationEmailWithQR(
    data: InvitationEmailWithQRData,
  ): Promise<void> {
    this.logger.debug(
      `[EMAIL_PROCESSOR] Processing INVITATION_WITH_QR: to=${data.email}, sessionId=${data.sessionId}, firstName=${data.firstName}, lastName=${data.lastName}, qrCodeLength=${data.qrCode?.length || 0}, expiresAt=${data.expiresAt}`,
    );

    if (!data.email) {
      throw new Error("[EMAIL_PROCESSOR] Email address is required");
    }

    if (!data.qrCode) {
      throw new Error("[EMAIL_PROCESSOR] QR code is required");
    }

    await this.emailService.sendInvitationEmailWithQR(data.email, {
      firstName: data.firstName,
      lastName: data.lastName,
      qrCode: data.qrCode,
      sessionId: data.sessionId,
      expiresAt: data.expiresAt,
    });

    this.logger.log(
      `[EMAIL_PROCESSOR] ✓ INVITATION_WITH_QR email sent successfully to ${data.email}`,
    );
  }

  /**
   * Handle password reset email
   */
  private async handlePasswordResetEmail(
    data: PasswordResetEmailData,
  ): Promise<void> {
    await this.emailService.sendPasswordResetEmail(data.email, {
      firstName: data.firstName,
      resetLink: data.resetLink,
      expiryHours: data.expiryHours,
      logoUrl: data.logoUrl,
      companyName: data.companyName,
      companyAddress: data.companyAddress,
      supportEmail: data.supportEmail,
      socialLinks: data.socialLinks,
    });
  }

  /**
   * Handle email verification email
   */
  private async handleEmailVerificationEmail(
    data: EmailVerificationData,
  ): Promise<void> {
    await this.emailService.sendEmailVerificationEmail(data.email, {
      firstName: data.firstName,
      lastName: data.lastName,
      verificationLink: data.verificationLink,
      expiryHours: data.expiryHours,
      logoUrl: data.logoUrl,
      companyName: data.companyName,
      companyAddress: data.companyAddress,
      supportEmail: data.supportEmail,
      socialLinks: data.socialLinks,
    });
  }

  /**
   * Handle test email
   */
  private async handleTestEmail(data: TestEmailData): Promise<void> {
    await this.emailService.sendTestEmail(data.toEmail, data.subject);
  }
}
