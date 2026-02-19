/**
 * Azure Service Bus Queue Service
 *
 * This service provides functionality to send and receive messages using Azure Service Bus Queues.
 * Unlike Topics (pub/sub), Queues provide point-to-point messaging where each message is consumed by a single receiver.
 *
 * Features:
 * - Send messages to queues
 * - Receive and process messages from queues
 * - Dead letter queue (DLQ) support
 * - Message scheduling
 * - Batch operations
 * - Automatic retry and error handling
 *
 * Usage:
 * - Inject QueueService into your service/controller
 * - Use sendMessage() to send messages to a queue
 * - Use startReceiver() to start receiving messages from a queue
 * - Use stopReceiver() to stop receiving messages
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusSender,
  ServiceBusReceiver,
  ServiceBusReceivedMessage,
  ProcessErrorArgs,
} from "@azure/service-bus";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { recordQueueMessage, recordQueueBacklog } from "../../telemetry";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

export interface QueueMessage<T = any> {
  eventType: string;
  timestamp: Date;
  data: T;
  correlationId?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, any>;
}

export interface QueueReceiverOptions {
  /**
   * Maximum number of concurrent messages to process
   * Default: 1
   */
  maxConcurrentCalls?: number;
  /**
   * Maximum number of messages to receive in a batch
   * Default: 1
   */
  maxAutoLockRenewalDurationInMs?: number;
  /**
   * Auto-complete messages after processing
   * Default: false (manual completion required)
   */
  autoCompleteMessages?: boolean;
  /**
   * Sub-queue type (dead letter queue)
   * Default: undefined (main queue)
   */
  subQueueType?: "deadLetter";
}

export type QueueMessageHandler<T = any> = (
  message: ServiceBusReceivedMessage,
  payload: QueueMessage<T>,
) => Promise<void>;

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly serviceBusClient: ServiceBusClient | null = null;
  private readonly senders: Map<string, ServiceBusSender> = new Map();
  private readonly receivers: Map<string, ServiceBusReceiver> = new Map();
  private readonly messageHandlers: Map<string, QueueMessageHandler> =
    new Map();
  private readonly defaultQueueName: string;

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

  private extractTraceContext(carrier: Record<string, any>) {
    try {
      return propagation.extract(context.active(), carrier, {
        get: (c, key) => {
          const value = c[key];
          if (value === undefined || value === null) return undefined;
          if (Array.isArray(value)) return value.map(String);
          return String(value);
        },
        keys: (c) => Object.keys(c || {}),
      });
    } catch {
      return context.active();
    }
  }

  constructor(private configService: ConfigService) {
    const connectionString = this.configService.get<string>(
      "azure.serviceBus.connectionString",
    );
    this.defaultQueueName =
      this.configService.get<string>("azure.serviceBus.defaultQueue") ||
      "default-queue";

    if (!connectionString) {
      this.logger.warn(
        "Azure Service Bus connection string not configured. Queue service will be disabled.",
      );
      return;
    }

    try {
      this.serviceBusClient = new ServiceBusClient(connectionString);
      this.logger.log("Azure Service Bus Queue client initialized");
    } catch (error) {
      this.logger.error(
        `Failed to initialize Service Bus Queue client: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleInit() {
    // Module initialization if needed
  }

  async onModuleDestroy() {
    await this.cleanup();
  }

  /**
   * Get or create a sender for a queue
   */
  private async getSender(queueName: string): Promise<ServiceBusSender> {
    if (!this.serviceBusClient) {
      throw new Error("Service Bus client not initialized");
    }

    // Check if sender exists
    if (this.senders.has(queueName)) {
      return this.senders.get(queueName)!;
    }

    // Create new sender
    try {
      const sender = this.serviceBusClient.createSender(queueName);
      this.senders.set(queueName, sender);
      this.logger.debug(`Created sender for queue: ${queueName}`);
      return sender;
    } catch (error) {
      this.logger.error(
        `Failed to create sender for queue ${queueName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Remove sender from cache
   */
  private removeSender(queueName: string): void {
    if (this.senders.has(queueName)) {
      const sender = this.senders.get(queueName)!;
      this.senders.delete(queueName);
      try {
        const closeResult = sender.close();
        Promise.resolve(closeResult).catch((err) => {
          this.logger.debug(
            `Error closing sender for ${queueName}: ${err.message}`,
          );
        });
      } catch (err: any) {
        this.logger.debug(
          `Error closing sender for ${queueName}: ${err?.message}`,
        );
      }
      this.logger.debug(`Removed sender for queue: ${queueName}`);
    }
  }

  /**
   * Send a message to a queue
   *
   * @param queueName - Name of the queue (defaults to configured default queue)
   * @param eventType - Type of event/message
   * @param data - Message payload
   * @param options - Additional options (correlationId, userId, tenantId, scheduleEnqueueTime, etc.)
   */
  async sendMessage<T = any>(
    queueName: string | undefined,
    eventType: string,
    data: T,
    options?: {
      correlationId?: string;
      userId?: string;
      tenantId?: string;
      metadata?: Record<string, any>;
      scheduleEnqueueTime?: Date;
      messageId?: string;
      timeToLive?: number; // in milliseconds
    },
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      this.logger.warn(
        `Queue service disabled. Would have sent ${eventType} to queue ${targetQueue}`,
      );
      return;
    }

    try {
      const payload: QueueMessage<T> = {
        eventType,
        timestamp: new Date(),
        data,
        correlationId: options?.correlationId,
        userId: options?.userId,
        tenantId: options?.tenantId,
        metadata: options?.metadata,
      };

      // Generate message ID if not provided
      const messageId =
        options?.messageId ||
        `${eventType}-${payload.timestamp.getTime()}-${randomUUID()}`;

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
        ...(options?.timeToLive && {
          timeToLive: options.timeToLive,
        }),
      };

      const sender = await this.getSender(targetQueue);

      const tracer = trace.getTracer("unicx-integration-queue", "1.0.0");
      try {
        await tracer.startActiveSpan(
          "queue.send",
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              "messaging.system": "azure.servicebus",
              "messaging.destination": targetQueue,
              "messaging.destination_kind": "queue",
              "messaging.operation": "send",
              "messaging.message_id": messageId,
              "messaging.correlation_id": options?.correlationId || "unknown",
              "messaging.message_payload.event_type": eventType,
            },
          },
          async (span) => {
            try {
              await sender.sendMessages(message);
              this.logger.debug(
                `Message sent to queue ${targetQueue}: ${eventType} (ID: ${messageId})`,
              );

              // Track queue message sent
              recordQueueMessage(targetQueue, eventType, "sent");
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
        this.logger.error(
          `Failed to send message to queue ${targetQueue}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
        );
        // Remove sender from cache on error to force recreation
        this.removeSender(targetQueue);
        throw sendError;
      }
    } catch (error) {
      this.logger.error(
        `Error sending message to queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Send multiple messages in a batch to a queue
   * Automatically handles batch size limits by creating multiple batches if needed
   *
   * @param queueName - Name of the queue
   * @param messages - Array of messages to send
   */
  async sendBatchMessages<T = any>(
    queueName: string | undefined,
    messages: Array<{
      eventType: string;
      data: T;
      options?: {
        correlationId?: string;
        userId?: string;
        tenantId?: string;
        metadata?: Record<string, any>;
        messageId?: string;
        timeToLive?: number;
      };
    }>,
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      this.logger.warn(
        `Queue service disabled. Would have sent ${messages.length} messages to queue ${targetQueue}`,
      );
      return;
    }

    if (messages.length === 0) {
      return;
    }

    try {
      const sender = await this.getSender(targetQueue);
      let totalSent = 0;

      // Create first batch
      let batch = await sender.createMessageBatch();

      for (const msg of messages) {
        const payload: QueueMessage<T> = {
          eventType: msg.eventType,
          timestamp: new Date(),
          data: msg.data,
          correlationId: msg.options?.correlationId,
          userId: msg.options?.userId,
          tenantId: msg.options?.tenantId,
          metadata: msg.options?.metadata,
        };

        const messageId =
          msg.options?.messageId ||
          `${msg.eventType}-${payload.timestamp.getTime()}-${randomUUID()}`;

        const applicationProperties = this.injectTraceContext({
          eventType: msg.eventType,
          timestamp: payload.timestamp.toISOString(),
          ...(msg.options?.userId && { userId: msg.options.userId }),
          ...(msg.options?.tenantId && { tenantId: msg.options.tenantId }),
          ...(msg.options?.correlationId && {
            correlationId: msg.options.correlationId,
          }),
        });

        const serviceBusMessage: ServiceBusMessage = {
          body: payload,
          contentType: "application/json",
          subject: msg.eventType,
          messageId,
          correlationId: msg.options?.correlationId,
          applicationProperties,
          ...(msg.options?.timeToLive && {
            timeToLive: msg.options.timeToLive,
          }),
        };

        // Try to add message to current batch
        if (!batch.tryAddMessage(serviceBusMessage)) {
          // Current batch is full, send it
          await sender.sendMessages(batch);
          totalSent += batch.count;

          // Create a new batch
          batch = await sender.createMessageBatch();

          // Try to add the message to the new batch
          if (!batch.tryAddMessage(serviceBusMessage)) {
            // Message is too large to fit in any batch
            throw new Error(
              `Message too large to fit in a batch: ${msg.eventType} (ID: ${messageId})`,
            );
          }
        }
      }

      // Send the last batch if it has messages
      if (batch.count > 0) {
        await sender.sendMessages(batch);
        totalSent += batch.count;
      }

      this.logger.debug(
        `Sent ${totalSent} messages in batches to queue ${targetQueue}`,
      );
    } catch (error) {
      this.logger.error(
        `Error sending batch to queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Start receiving messages from a queue
   * Simplified API that automatically handles message completion
   *
   * @param queueName - Name of the queue to receive from
   * @param handler - Function to handle received messages
   * @param options - Receiver options (maxConcurrentCalls, autoCompleteMessages, etc.)
   */
  async startReceiver<T = any>(
    queueName: string | undefined,
    handler: QueueMessageHandler<T>,
    options?: QueueReceiverOptions,
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      this.logger.warn(
        `Queue service disabled. Cannot start receiver for queue ${targetQueue}`,
      );
      return;
    }

    // Check if receiver already exists
    if (this.receivers.has(targetQueue)) {
      this.logger.warn(
        `Receiver for queue ${targetQueue} already exists. Stop it first before starting a new one.`,
      );
      return;
    }

    try {
      // Create receiver
      const receiverOptions: any = {};
      if (options?.subQueueType === "deadLetter") {
        receiverOptions.subQueueType = "deadLetter";
      }

      const receiver = this.serviceBusClient.createReceiver(
        targetQueue,
        receiverOptions,
      );

      // Store receiver and handler
      this.receivers.set(targetQueue, receiver);
      this.messageHandlers.set(targetQueue, handler);

      // Configure message processing
      const processingOptions = {
        maxConcurrentCalls: options?.maxConcurrentCalls || 1,
        autoCompleteMessages: options?.autoCompleteMessages ?? true, // Default to true for easier use
      };

      // Start processing messages
      receiver.subscribe({
        processMessage: async (receivedMessage: ServiceBusReceivedMessage) => {
          try {
            const handler = this.messageHandlers.get(targetQueue);
            if (!handler) {
              this.logger.error(
                `No handler found for queue ${targetQueue}. Completing message.`,
              );
              if (!processingOptions.autoCompleteMessages) {
                await receiver.completeMessage(receivedMessage);
              }
              return;
            }

            // Parse message body
            let payload: QueueMessage<T>;
            try {
              payload = receivedMessage.body as QueueMessage<T>;
            } catch (parseError) {
              this.logger.error(
                `Failed to parse message body from queue ${targetQueue}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              );
              // Move to dead letter queue
              await receiver.deadLetterMessage(receivedMessage, {
                deadLetterReason: "Invalid message format",
                deadLetterErrorDescription:
                  parseError instanceof Error
                    ? parseError.message
                    : String(parseError),
              });
              return;
            }

            const ctx = this.extractTraceContext(
              (receivedMessage.applicationProperties as Record<string, any>) ||
                {},
            );

            await context.with(ctx, async () => {
              const tracer = trace.getTracer("unicx-integration-queue", "1.0.0");
              await tracer.startActiveSpan(
                "queue.process",
                {
                  kind: SpanKind.CONSUMER,
                  attributes: {
                    "messaging.system": "azure.servicebus",
                    "messaging.destination": targetQueue,
                    "messaging.destination_kind": "queue",
                    "messaging.operation": "process",
                    "messaging.message_id": String(
                      receivedMessage.messageId || "unknown",
                    ),
                    "messaging.correlation_id": String(
                      receivedMessage.correlationId ||
                        payload.correlationId ||
                        "unknown",
                    ),
                    "messaging.message_payload.event_type":
                      payload.eventType || "unknown",
                  },
                },
                async (span) => {
                  try {
                    // Call handler
                    await handler(receivedMessage, payload);

                    // Track queue message received
                    recordQueueMessage(
                      targetQueue,
                      payload.eventType || "unknown",
                      "received",
                    );

                    // Auto-complete message if enabled (default behavior)
                    if (processingOptions.autoCompleteMessages) {
                      await receiver.completeMessage(receivedMessage);
                    }
                    // If auto-complete is disabled, handler must manually complete/abandon/deadLetter
                    span.setStatus({ code: SpanStatusCode.OK });
                  } catch (handlerError) {
                    span.recordException(handlerError as Error);
                    span.setStatus({
                      code: SpanStatusCode.ERROR,
                      message:
                        handlerError instanceof Error
                          ? handlerError.message
                          : String(handlerError),
                    });
                    throw handlerError;
                  } finally {
                    span.end();
                  }
                },
              );
            });
          } catch (handlerError) {
            this.logger.error(
              `Error processing message from queue ${targetQueue}: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
            );

            // If auto-complete is enabled, message will be retried automatically
            // If disabled, handler should handle the error
            if (!processingOptions.autoCompleteMessages) {
              // Don't complete - let handler decide or let it retry based on max delivery count
            } else {
              // With auto-complete, errors will cause the message to be retried
              // After max delivery count, it will move to DLQ automatically
            }
          }
        },
        processError: async (args: ProcessErrorArgs) => {
          this.logger.error(
            `Error in message processing for queue ${targetQueue}: ${args.error.message}`,
          );
          if (args.error) {
            this.logger.error(
              `Error details: ${args.error.stack || args.error.message}`,
            );
          }
        },
      });

      this.logger.log(
        `Started receiver for queue: ${targetQueue} (maxConcurrentCalls: ${processingOptions.maxConcurrentCalls}, autoComplete: ${processingOptions.autoCompleteMessages})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to start receiver for queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Stop receiving messages from a queue
   *
   * @param queueName - Name of the queue to stop receiving from
   */
  async stopReceiver(queueName: string | undefined): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.receivers.has(targetQueue)) {
      this.logger.warn(`No receiver found for queue ${targetQueue}`);
      return;
    }

    try {
      const receiver = this.receivers.get(targetQueue)!;
      await receiver.close();
      this.receivers.delete(targetQueue);
      this.messageHandlers.delete(targetQueue);
      this.logger.log(`Stopped receiver for queue: ${targetQueue}`);
    } catch (error) {
      this.logger.error(
        `Error stopping receiver for queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Swallow error to avoid crashing callers; stopping receiver is best-effort
    }
  }

  /**
   * Peek messages from a queue without removing them
   * Useful for checking queue backlog without consuming messages
   *
   * @param queueName - Name of the queue
   * @param maxMessages - Maximum number of messages to peek (default: 10, max: 32)
   * @returns Array of peeked messages
   */
  async peekMessages(
    queueName: string | undefined,
    maxMessages: number = 10,
  ): Promise<ServiceBusReceivedMessage[]> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      this.logger.warn(
        `Queue service disabled. Cannot peek messages from queue ${targetQueue}`,
      );
      return [];
    }

    try {
      const receiver = this.serviceBusClient.createReceiver(targetQueue, {
        receiveMode: "peekLock",
      });
      const messages = await receiver.peekMessages(maxMessages);
      await receiver.close();
      return messages;
    } catch (error) {
      this.logger.error(
        `Error peeking messages from queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Estimate queue backlog by peeking messages
   * This provides an approximation of messages in the queue
   * For accurate counts, use Azure Service Bus Management API or Azure Monitor metrics
   *
   * @param queueName - Name of the queue
   * @returns Estimated message count (up to peek limit of 32)
   */
  async estimateQueueBacklog(queueName: string | undefined): Promise<number> {
    const targetQueue = queueName || this.defaultQueueName;

    try {
      // Peek up to 32 messages (Service Bus limit) to estimate backlog
      const messages = await this.peekMessages(targetQueue, 32);
      const estimatedCount = messages.length;

      // Record backlog metric
      recordQueueBacklog(targetQueue, estimatedCount);

      return estimatedCount;
    } catch (error) {
      this.logger.error(
        `Error estimating queue backlog for ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Receive messages manually (peek-lock pattern)
   * Useful for scenarios where you want to control when to receive messages
   *
   * @param queueName - Name of the queue
   * @param maxMessages - Maximum number of messages to receive (default: 1)
   * @param maxWaitTimeInMs - Maximum time to wait for messages (default: 5000ms)
   */
  async receiveMessages(
    queueName: string | undefined,
    maxMessages: number = 1,
    maxWaitTimeInMs: number = 5000,
  ): Promise<ServiceBusReceivedMessage[]> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      this.logger.warn(
        `Queue service disabled. Cannot receive messages from queue ${targetQueue}`,
      );
      return [];
    }

    try {
      const receiver = this.serviceBusClient.createReceiver(targetQueue);
      const messages = await receiver.receiveMessages(maxMessages, {
        maxWaitTimeInMs,
      });
      await receiver.close();
      return messages;
    } catch (error) {
      this.logger.error(
        `Error receiving messages from queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Complete a message (remove it from the queue)
   */
  async completeMessage(
    queueName: string | undefined,
    message: ServiceBusReceivedMessage,
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      return;
    }

    try {
      const receiver = this.serviceBusClient.createReceiver(targetQueue);
      await receiver.completeMessage(message);
      await receiver.close();
    } catch (error) {
      this.logger.error(
        `Error completing message from queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Abandon a message (return it to the queue for retry)
   */
  async abandonMessage(
    queueName: string | undefined,
    message: ServiceBusReceivedMessage,
    propertiesToModify?: Record<string, string | number | boolean | Date>,
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      return;
    }

    try {
      const receiver = this.serviceBusClient.createReceiver(targetQueue);
      await receiver.abandonMessage(message, propertiesToModify);
      await receiver.close();
    } catch (error) {
      this.logger.error(
        `Error abandoning message from queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Dead letter a message (move it to the dead letter queue)
   */
  async deadLetterMessage(
    queueName: string | undefined,
    message: ServiceBusReceivedMessage,
    reason?: string,
    errorDescription?: string,
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      return;
    }

    try {
      const receiver = this.serviceBusClient.createReceiver(targetQueue);
      await receiver.deadLetterMessage(message, {
        deadLetterReason: reason || "Manual dead letter",
        deadLetterErrorDescription: errorDescription || "Message moved to DLQ",
      });
      await receiver.close();
    } catch (error) {
      this.logger.error(
        `Error dead lettering message from queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Defer a message (postpone processing)
   */
  async deferMessage(
    queueName: string | undefined,
    message: ServiceBusReceivedMessage,
    propertiesToModify?: Record<string, string | number | boolean | Date>,
  ): Promise<void> {
    const targetQueue = queueName || this.defaultQueueName;

    if (!this.serviceBusClient) {
      return;
    }

    try {
      const receiver = this.serviceBusClient.createReceiver(targetQueue);
      await receiver.deferMessage(message, propertiesToModify);
      await receiver.close();
    } catch (error) {
      this.logger.error(
        `Error deferring message from queue ${targetQueue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Cleanup all senders and receivers
   */
  private async cleanup(): Promise<void> {
    this.logger.log("Cleaning up Queue Service...");

    // Close all receivers
    const receiverPromises = Array.from(this.receivers.entries()).map(
      async ([queueName, receiver]) => {
        try {
          await receiver.close();
          this.logger.debug(`Closed receiver for queue: ${queueName}`);
        } catch (error) {
          this.logger.error(
            `Error closing receiver for queue ${queueName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // Close all senders
    const senderPromises = Array.from(this.senders.entries()).map(
      async ([queueName, sender]) => {
        try {
          await sender.close();
          this.logger.debug(`Closed sender for queue: ${queueName}`);
        } catch (error) {
          this.logger.error(
            `Error closing sender for queue ${queueName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    await Promise.all([...receiverPromises, ...senderPromises]);

    // Close Service Bus client
    if (this.serviceBusClient) {
      try {
        await this.serviceBusClient.close();
        this.logger.log("Service Bus client closed");
      } catch (error) {
        this.logger.error(
          `Error closing Service Bus client: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Clear maps
    this.receivers.clear();
    this.senders.clear();
    this.messageHandlers.clear();

    this.logger.log("Queue Service cleanup complete");
  }
}
