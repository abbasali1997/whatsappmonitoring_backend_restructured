import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusSender,
} from "@azure/service-bus";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

export enum MessageTopic {
  WHATSAPP_EVENTS = "whatsapp-events",
  USER_EVENTS = "user-events",
  ENTITY_EVENTS = "entity-events",
  MESSAGE_EVENTS = "message-events",
  SESSION_EVENTS = "session-events",
}

export interface MessagePayload<T = any> {
  eventType: string;
  timestamp: Date;
  data: T;
  correlationId?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class MessagingService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingService.name);
  private readonly serviceBusClient: ServiceBusClient;
  private readonly senders: Map<string, ServiceBusSender> = new Map();

  private injectTraceContext(
    carrier: Record<string, any>,
  ): Record<string, any> {
    try {
      propagation.inject(context.active(), carrier, {
        set: (c, key, value) => {
          c[key] = value;
        },
      });
    } catch {
      // ignore
    }
    return carrier;
  }

  constructor(private configService: ConfigService) {
    const connectionString = this.configService.get<string>(
      "azure.serviceBus.connectionString",
    );

    if (!connectionString) {
      this.logger.warn(
        "Azure Service Bus connection string not configured. Messaging will be disabled.",
      );
      return;
    }

    try {
      this.serviceBusClient = new ServiceBusClient(connectionString);
      this.logger.log("Azure Service Bus client initialized");
    } catch (error) {
      this.logger.error(
        `Failed to initialize Service Bus client: ${error.message}`,
      );
    }
  }

  /**
   * Get or create sender for a topic
   */
  private async getSender(topic: string): Promise<ServiceBusSender> {
    if (!this.serviceBusClient) {
      throw new Error("Service Bus client not initialized");
    }

    // Check if sender exists and is still valid
    if (this.senders.has(topic)) {
      const sender = this.senders.get(topic);
      // Return existing sender
      return sender;
    }

    // Create new sender
    try {
      const sender = this.serviceBusClient.createSender(topic);
      this.senders.set(topic, sender);
      this.logger.debug(`Created sender for topic: ${topic}`);
      return sender;
    } catch (error) {
      this.logger.error(
        `Failed to create sender for topic ${topic}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Remove sender from cache (used when sender fails)
   */
  private removeSender(topic: string): void {
    if (this.senders.has(topic)) {
      const sender = this.senders.get(topic);
      this.senders.delete(topic);
      // Try to close the sender gracefully
      sender.close().catch((err) => {
        this.logger.debug(
          `Error closing failed sender for ${topic}: ${err.message}`,
        );
      });
      this.logger.debug(`Removed sender for topic: ${topic}`);
    }
  }

  /**
   * Extract error details from AggregateError or regular error
   */
  private extractErrorDetails(error: any): {
    message: string;
    details: string[];
    stack?: string;
  } {
    const details: string[] = [];
    let message = error.message || "Unknown error";
    let stack = error.stack;

    // Handle AggregateError (contains multiple errors)
    if (
      error.name === "AggregateError" &&
      error.errors &&
      Array.isArray(error.errors)
    ) {
      message = `AggregateError: ${error.errors.length} error(s) occurred`;
      error.errors.forEach((err: any, index: number) => {
        details.push(`Error ${index + 1}: ${err.message || err.toString()}`);
        if (err.stack && !stack) {
          stack = err.stack;
        }
      });
    } else if (error.errors && Array.isArray(error.errors)) {
      // Handle other error types with nested errors
      error.errors.forEach((err: any, index: number) => {
        details.push(`Error ${index + 1}: ${err.message || err.toString()}`);
      });
    }

    // Add connection-related error hints
    const errorMessage = error.message?.toLowerCase() || "";
    if (
      errorMessage.includes("timeout") ||
      errorMessage.includes("connection")
    ) {
      details.push(
        "Hint: This may be a network connectivity issue. Check firewall rules and Azure Service Bus configuration.",
      );
    }

    return { message, details, stack };
  }

  /**
   * Publish a message to a topic
   */
  async publish<T = any>(
    topic: MessageTopic | string,
    eventType: string,
    data: T,
    options?: {
      correlationId?: string;
      userId?: string;
      tenantId?: string;
      metadata?: Record<string, any>;
      scheduleEnqueueTime?: Date;
    },
  ): Promise<void> {
    if (!this.serviceBusClient) {
      this.logger.warn(
        `Messaging disabled. Would have published ${eventType} to ${topic}`,
      );
      return;
    }

    try {
      const payload: MessagePayload<T> = {
        eventType,
        timestamp: new Date(),
        data,
        correlationId: options?.correlationId,
        userId: options?.userId,
        tenantId: options?.tenantId,
        metadata: options?.metadata,
      };

      // Generate a unique message ID for duplicate detection
      // Use eventType + timestamp + UUID to ensure uniqueness
      const messageId = `${eventType}-${payload.timestamp.getTime()}-${randomUUID()}`;

      const applicationProperties = this.injectTraceContext({
        eventType,
        timestamp: payload.timestamp.toISOString(),
        ...(options?.userId && { userId: options.userId }),
        ...(options?.tenantId && { tenantId: options.tenantId }),
        ...(options?.correlationId && {
          correlationId: options.correlationId,
        }),
      });

      const message: ServiceBusMessage = {
        body: payload,
        contentType: "application/json",
        subject: eventType,
        messageId,
        correlationId: options?.correlationId,
        applicationProperties,
        ...(options?.scheduleEnqueueTime && {
          scheduledEnqueueTimeUtc: options.scheduleEnqueueTime,
        }),
      };

      const sender = await this.getSender(topic);

      const tracer = trace.getTracer("unicx-integration-messaging", "1.0.0");
      try {
        await tracer.startActiveSpan(
          "topic.publish",
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              "messaging.system": "azure.servicebus",
              "messaging.destination": String(topic),
              "messaging.destination_kind": "topic",
              "messaging.operation": "send",
              "messaging.message_id": messageId,
              "messaging.correlation_id": options?.correlationId || "unknown",
              "messaging.message_payload.event_type": eventType,
            },
          },
          async (span) => {
            try {
              await sender.sendMessages(message);
              this.logger.log(`Message published to ${topic}: ${eventType}`);
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (sendError) {
              span.recordException(sendError as Error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                  sendError instanceof Error
                    ? sendError.message
                    : String(sendError),
              });
              throw sendError;
            } finally {
              span.end();
            }
          },
        );
      } catch (sendError) {
        // If send fails, it might be a connection issue - remove sender to force recreation
        const errorDetails = this.extractErrorDetails(sendError);
        this.logger.error(
          `Failed to send message to ${topic}: ${errorDetails.message}`,
          errorDetails.stack,
        );

        if (errorDetails.details.length > 0) {
          this.logger.error(
            `Error details: ${errorDetails.details.join("; ")}`,
          );
        }

        // Check if it's a connection error - if so, remove sender to force recreation on next attempt
        const errorMessage = sendError.message?.toLowerCase() || "";
        if (
          errorMessage.includes("connection") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("amqp") ||
          sendError.name === "AggregateError"
        ) {
          this.logger.warn(
            `Removing sender for ${topic} due to connection error. Will recreate on next attempt.`,
          );
          this.removeSender(topic);
        }

        throw sendError;
      }
    } catch (error) {
      const errorDetails = this.extractErrorDetails(error);
      this.logger.error(
        `Failed to publish message to ${topic}: ${errorDetails.message}`,
        errorDetails.stack,
      );

      if (errorDetails.details.length > 0) {
        this.logger.error(`Error details: ${errorDetails.details.join("; ")}`);
      }

      throw error;
    }
  }

  /**
   * Publish batch messages
   */
  async publishBatch<T = any>(
    topic: MessageTopic | string,
    messages: Array<{
      eventType: string;
      data: T;
      correlationId?: string;
      userId?: string;
      tenantId?: string;
    }>,
  ): Promise<void> {
    if (!this.serviceBusClient) {
      this.logger.warn(
        `Messaging disabled. Would have published batch to ${topic}`,
      );
      return;
    }

    try {
      const serviceBusMessages: ServiceBusMessage[] = messages.map((msg) => {
        const payload: MessagePayload<T> = {
          eventType: msg.eventType,
          timestamp: new Date(),
          data: msg.data,
          correlationId: msg.correlationId,
          userId: msg.userId,
          tenantId: msg.tenantId,
        };

        // Generate a unique message ID for duplicate detection
        const messageId = `${msg.eventType}-${payload.timestamp.getTime()}-${randomUUID()}`;

        const applicationProperties = this.injectTraceContext({
          eventType: msg.eventType,
          timestamp: payload.timestamp.toISOString(),
          ...(msg.userId && { userId: msg.userId }),
          ...(msg.tenantId && { tenantId: msg.tenantId }),
          ...(msg.correlationId && { correlationId: msg.correlationId }),
        });

        return {
          body: payload,
          contentType: "application/json",
          subject: msg.eventType,
          messageId,
          correlationId: msg.correlationId,
          applicationProperties,
        };
      });

      const sender = await this.getSender(topic);

      const tracer = trace.getTracer("unicx-integration-messaging", "1.0.0");
      try {
        await tracer.startActiveSpan(
          "topic.publish_batch",
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              "messaging.system": "azure.servicebus",
              "messaging.destination": String(topic),
              "messaging.destination_kind": "topic",
              "messaging.operation": "send",
              "messaging.batch.count": messages.length,
            },
          },
          async (span) => {
            try {
              await sender.sendMessages(serviceBusMessages);
              this.logger.log(
                `Batch of ${messages.length} messages published to ${topic}`,
              );
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (sendError) {
              span.recordException(sendError as Error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                  sendError instanceof Error
                    ? sendError.message
                    : String(sendError),
              });
              throw sendError;
            } finally {
              span.end();
            }
          },
        );
      } catch (sendError) {
        // If send fails, it might be a connection issue - remove sender to force recreation
        const errorDetails = this.extractErrorDetails(sendError);
        this.logger.error(
          `Failed to send batch to ${topic}: ${errorDetails.message}`,
          errorDetails.stack,
        );

        if (errorDetails.details.length > 0) {
          this.logger.error(
            `Error details: ${errorDetails.details.join("; ")}`,
          );
        }

        // Check if it's a connection error - if so, remove sender to force recreation on next attempt
        const errorMessage = sendError.message?.toLowerCase() || "";
        if (
          errorMessage.includes("connection") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("amqp") ||
          sendError.name === "AggregateError"
        ) {
          this.logger.warn(
            `Removing sender for ${topic} due to connection error. Will recreate on next attempt.`,
          );
          this.removeSender(topic);
        }

        throw sendError;
      }
    } catch (error) {
      const errorDetails = this.extractErrorDetails(error);
      this.logger.error(
        `Failed to publish batch to ${topic}: ${errorDetails.message}`,
        errorDetails.stack,
      );

      if (errorDetails.details.length > 0) {
        this.logger.error(`Error details: ${errorDetails.details.join("; ")}`);
      }

      throw error;
    }
  }

  /**
   * Publish WhatsApp event
   */
  async publishWhatsAppEvent(
    eventType: string,
    data: any,
    sessionId: string,
    tenantId: string,
  ): Promise<void> {
    await this.publish(MessageTopic.WHATSAPP_EVENTS, eventType, data, {
      correlationId: sessionId,
      tenantId,
      metadata: { sessionId },
    });
  }

  /**
   * Publish message event
   */
  async publishMessageEvent(
    eventType: string,
    messageData: any,
    tenantId: string,
    userId?: string,
  ): Promise<void> {
    await this.publish(MessageTopic.MESSAGE_EVENTS, eventType, messageData, {
      tenantId,
      userId,
    });
  }

  /**
   * Publish user event
   */
  async publishUserEvent(
    eventType: string,
    userData: any,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    await this.publish(MessageTopic.USER_EVENTS, eventType, userData, {
      userId,
      tenantId,
    });
  }

  /**
   * Close all senders and client
   */
  async onModuleDestroy() {
    this.logger.log("Closing Service Bus connections");

    for (const [topic, sender] of this.senders.entries()) {
      try {
        await sender.close();
        this.logger.debug(`Closed sender for topic: ${topic}`);
      } catch (error) {
        this.logger.error(
          `Error closing sender for ${topic}: ${error.message}`,
        );
      }
    }

    if (this.serviceBusClient) {
      try {
        await this.serviceBusClient.close();
        this.logger.log("Service Bus client closed");
      } catch (error) {
        this.logger.error(`Error closing Service Bus client: ${error.message}`);
      }
    }
  }
}
