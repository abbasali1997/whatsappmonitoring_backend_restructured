# Azure Service Bus Queue Service Usage Guide

This guide explains how to use the `QueueService` to send and receive messages using Azure Service Bus Queues.

## Overview

The `QueueService` provides point-to-point messaging using Azure Service Bus Queues. Unlike Topics (pub/sub), each message in a queue is consumed by a single receiver, making it ideal for:
- Task/job processing
- Load distribution
- Work queues
- Sequential processing

## Configuration

Add to your `.env` file:
```bash
AZURE_SERVICE_BUS_CONNECTION_STRING=Endpoint=sb://...
AZURE_SERVICE_BUS_DEFAULT_QUEUE=default-queue  # Optional, defaults to "default-queue"
```

## Basic Usage

### 1. Sending Messages

```typescript
import { Injectable } from '@nestjs/common';
import { QueueService } from '../common/messaging/queue.service';

@Injectable()
export class MyService {
  constructor(private queueService: QueueService) {}

  async sendNotification(userId: string, message: string) {
    await this.queueService.sendMessage(
      'notifications-queue',  // Queue name (optional, uses default if not provided)
      'user-notification',     // Event type
      {                        // Data payload
        userId,
        message,
        priority: 'high',
      },
      {
        correlationId: `notification-${userId}`,
        userId,
        tenantId: 'tenant-123',
        metadata: {
          source: 'api',
          timestamp: new Date().toISOString(),
        },
      },
    );
  }
}
```

### 2. Receiving Messages (Automatic Processing)

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { QueueService, QueueMessageHandler } from '../common/messaging/queue.service';
import { ServiceBusReceivedMessage } from '@azure/service-bus';

@Injectable()
export class NotificationProcessor implements OnModuleInit, OnModuleDestroy {
  constructor(private queueService: QueueService) {}

  async onModuleInit() {
    // Start receiving messages from the queue
    await this.queueService.startReceiver(
      'notifications-queue',
      this.handleNotification.bind(this),
      {
        maxConcurrentCalls: 5,        // Process up to 5 messages concurrently
        autoCompleteMessages: false,  // Manual completion (recommended)
      },
    );
  }

  async onModuleDestroy() {
    // Stop receiving messages
    await this.queueService.stopReceiver('notifications-queue');
  }

  private async handleNotification(
    message: ServiceBusReceivedMessage,
    payload: QueueMessage<any>,
  ): Promise<void> {
    try {
      console.log(`Processing notification: ${payload.eventType}`);
      console.log(`Data:`, payload.data);
      console.log(`Correlation ID: ${payload.correlationId}`);

      // Process the notification
      await this.processNotification(payload.data);

      // Complete the message (remove from queue)
      await this.queueService.completeMessage('notifications-queue', message);
    } catch (error) {
      console.error('Error processing notification:', error);
      
      // Option 1: Abandon message (return to queue for retry)
      await this.queueService.abandonMessage('notifications-queue', message);
      
      // Option 2: Dead letter message (move to DLQ)
      // await this.queueService.deadLetterMessage(
      //   'notifications-queue',
      //   message,
      //   'Processing failed',
      //   error.message,
      // );
    }
  }

  private async processNotification(data: any): Promise<void> {
    // Your processing logic here
  }
}
```

### 3. Manual Message Receiving (Peek-Lock Pattern)

```typescript
import { Injectable } from '@nestjs/common';
import { QueueService } from '../common/messaging/queue.service';

@Injectable()
export class ManualQueueProcessor {
  constructor(private queueService: QueueService) {}

  async processNextMessage() {
    // Receive one message
    const messages = await this.queueService.receiveMessages(
      'notifications-queue',
      1,      // Max messages
      5000,   // Max wait time (5 seconds)
    );

    if (messages.length === 0) {
      console.log('No messages available');
      return;
    }

    const message = messages[0];
    const payload = message.body;

    try {
      // Process message
      await this.processMessage(payload);

      // Complete message
      await this.queueService.completeMessage('notifications-queue', message);
    } catch (error) {
      // Abandon for retry
      await this.queueService.abandonMessage('notifications-queue', message);
    }
  }
}
```

### 4. Batch Sending

```typescript
import { Injectable } from '@nestjs/common';
import { QueueService } from '../common/messaging/queue.service';

@Injectable()
export class BatchSender {
  constructor(private queueService: QueueService) {}

  async sendBulkNotifications(notifications: Array<{ userId: string; message: string }>) {
    await this.queueService.sendBatchMessages(
      'notifications-queue',
      notifications.map((notif) => ({
        eventType: 'user-notification',
        data: {
          userId: notif.userId,
          message: notif.message,
        },
        options: {
          userId: notif.userId,
          correlationId: `notification-${notif.userId}`,
        },
      })),
    );
  }
}
```

### 5. Scheduled Messages

```typescript
import { Injectable } from '@nestjs/common';
import { QueueService } from '../common/messaging/queue.service';

@Injectable()
export class ScheduledSender {
  constructor(private queueService: QueueService) {}

  async scheduleReminder(userId: string, reminderTime: Date) {
    await this.queueService.sendMessage(
      'reminders-queue',
      'user-reminder',
      { userId, message: 'Your reminder' },
      {
        scheduleEnqueueTime: reminderTime,  // Message will be available at this time
        userId,
      },
    );
  }
}
```

### 6. Dead Letter Queue Processing

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../common/messaging/queue.service';

@Injectable()
export class DLQProcessor implements OnModuleInit {
  constructor(private queueService: QueueService) {}

  async onModuleInit() {
    // Process messages from dead letter queue
    await this.queueService.startReceiver(
      'notifications-queue',
      this.handleDLQMessage.bind(this),
      {
        subQueueType: 'deadLetter',  // Receive from DLQ
        maxConcurrentCalls: 1,
        autoCompleteMessages: false,
      },
    );
  }

  private async handleDLQMessage(
    message: ServiceBusReceivedMessage,
    payload: QueueMessage<any>,
  ): Promise<void> {
    console.error('DLQ Message:', {
      messageId: message.messageId,
      deadLetterReason: message.deadLetterReason,
      deadLetterErrorDescription: message.deadLetterErrorDescription,
      payload,
    });

    // Log to monitoring system, send alert, etc.
    await this.handleFailedMessage(payload);

    // Complete the DLQ message
    await this.queueService.completeMessage('notifications-queue', message);
  }
}
```

## Message Lifecycle

1. **Send**: Message is sent to the queue
2. **Receive**: Message is received by a receiver (becomes locked)
3. **Process**: Your handler processes the message
4. **Complete**: Message is removed from queue (success)
5. **Abandon**: Message is returned to queue for retry (failure)
6. **Dead Letter**: Message is moved to DLQ after max retries (permanent failure)

## Best Practices

1. **Always handle errors**: Use try-catch in your message handlers
2. **Manual completion**: Set `autoCompleteMessages: false` for better control
3. **Idempotency**: Make your handlers idempotent (safe to retry)
4. **Dead letter handling**: Monitor and process DLQ messages
5. **Concurrency**: Adjust `maxConcurrentCalls` based on your processing capacity
6. **Message TTL**: Set `timeToLive` for messages that expire
7. **Correlation IDs**: Use correlation IDs to track related messages

## Error Handling

```typescript
private async handleMessage(
  message: ServiceBusReceivedMessage,
  payload: QueueMessage<any>,
): Promise<void> {
  try {
    await this.process(payload);
    await this.queueService.completeMessage('my-queue', message);
  } catch (error) {
    // Check retry count
    const deliveryCount = message.deliveryCount || 0;
    const maxRetries = 3;

    if (deliveryCount >= maxRetries) {
      // Move to DLQ after max retries
      await this.queueService.deadLetterMessage(
        'my-queue',
        message,
        'Max retries exceeded',
        error.message,
      );
    } else {
      // Retry
      await this.queueService.abandonMessage('my-queue', message);
    }
  }
}
```

## Queue vs Topic

| Feature | Queue | Topic |
|---------|-------|-------|
| Pattern | Point-to-point | Pub/Sub |
| Consumers | Single | Multiple |
| Use Case | Task processing | Event broadcasting |
| Load Balancing | Yes | No (all subscribers get all messages) |

## Environment Variables

```bash
# Required
AZURE_SERVICE_BUS_CONNECTION_STRING=Endpoint=sb://...

# Optional
AZURE_SERVICE_BUS_DEFAULT_QUEUE=default-queue
```

## Example: Complete Worker Service

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { QueueService, QueueMessageHandler } from '../common/messaging/queue.service';
import { ServiceBusReceivedMessage } from '@azure/service-bus';

interface TaskPayload {
  taskId: string;
  taskType: string;
  data: any;
}

@Injectable()
export class TaskWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskWorkerService.name);

  constructor(private queueService: QueueService) {}

  async onModuleInit() {
    await this.queueService.startReceiver(
      'tasks-queue',
      this.processTask.bind(this),
      {
        maxConcurrentCalls: 10,
        autoCompleteMessages: false,
      },
    );
    this.logger.log('Task worker started');
  }

  async onModuleDestroy() {
    await this.queueService.stopReceiver('tasks-queue');
    this.logger.log('Task worker stopped');
  }

  private async processTask(
    message: ServiceBusReceivedMessage,
    payload: QueueMessage<TaskPayload>,
  ): Promise<void> {
    const { taskId, taskType, data } = payload.data;

    try {
      this.logger.log(`Processing task ${taskId} of type ${taskType}`);

      // Process based on task type
      switch (taskType) {
        case 'email':
          await this.sendEmail(data);
          break;
        case 'notification':
          await this.sendNotification(data);
          break;
        default:
          throw new Error(`Unknown task type: ${taskType}`);
      }

      // Complete message on success
      await this.queueService.completeMessage('tasks-queue', message);
      this.logger.log(`Task ${taskId} completed successfully`);
    } catch (error) {
      this.logger.error(`Task ${taskId} failed: ${error.message}`);

      // Dead letter after 3 retries
      if ((message.deliveryCount || 0) >= 3) {
        await this.queueService.deadLetterMessage(
          'tasks-queue',
          message,
          'Max retries exceeded',
          error.message,
        );
      } else {
        await this.queueService.abandonMessage('tasks-queue', message);
      }
    }
  }

  private async sendEmail(data: any): Promise<void> {
    // Email sending logic
  }

  private async sendNotification(data: any): Promise<void> {
    // Notification sending logic
  }
}
```

