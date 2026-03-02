import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { QueueMessage, QueueService } from "@/common/messaging/queue.service";
import { WhatsAppService } from "@/modules/whatsapp/whatsapp.service";
import {
  WHATSAPP_QUEUE_NAME,
  WhatsAppQueueEvent,
} from "@/modules/whatsapp-queue/whatsapp-queue.service";

@Injectable()
export class WhatsAppQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppQueueProcessor.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
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
    // Skip starting receiver on localhost (WhatsApp sessions are initialized directly, not queued)
    if (this.isLocalhost()) {
      this.logger.log(
        `[LOCALHOST] WhatsApp queue processor skipped - sessions are initialized directly, not queued`,
      );
      return;
    }

    this.logger.log(
      `[PROCESSOR] Initializing WhatsApp queue processor for queue: ${WHATSAPP_QUEUE_NAME}`,
    );
    try {
      // Start receiver for WhatsApp events
      this.logger.debug(
        `[PROCESSOR] Starting receiver with options: maxConcurrentCalls=2, autoCompleteMessages=true`,
      );
      await this.queueService.startReceiver(
        WHATSAPP_QUEUE_NAME,
        async (message, payload: QueueMessage<{ sessionId: string }>) => {
          const messageId = message.messageId || "unknown";
          const correlationId =
            message.correlationId || payload.correlationId || "unknown";
          const receivedAt = new Date().toISOString();
          const startTime = Date.now();

          this.logger.debug(
            `[PROCESSOR] Message received: messageId=${messageId}, correlationId=${correlationId}, receivedAt=${receivedAt}, queue=${WHATSAPP_QUEUE_NAME}`,
          );
          this.logger.debug(
            `[PROCESSOR] Message payload: eventType=${payload.eventType}, timestamp=${payload.timestamp}, userId=${payload.userId}, tenantId=${payload.tenantId}`,
          );
          this.logger.debug(
            `[PROCESSOR] Message application properties: ${JSON.stringify(message.applicationProperties || {})}`,
          );

          try {
            const { eventType, data } = payload;
            this.logger.debug(
              `[PROCESSOR] Parsed payload: eventType=${eventType}, data=${JSON.stringify(data)}`,
            );

            const sessionId = data?.sessionId;
            if (!sessionId) {
              this.logger.warn(
                `[PROCESSOR] Received WhatsApp queue event without sessionId: messageId=${messageId}, correlationId=${correlationId}, payload=${JSON.stringify(payload)}`,
              );
              return;
            }

            this.logger.debug(
              `[PROCESSOR] Processing event: eventType=${eventType}, sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}`,
            );

            switch (eventType) {
              case WhatsAppQueueEvent.SESSION_INIT: {
                this.logger.log(
                  `[PROCESSOR] Processing SESSION_INIT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}`,
                );
                const initStartTime = Date.now();
                try {
                  await this.whatsappService.initializeClient(sessionId);
                  const initDuration = Date.now() - initStartTime;
                  this.logger.log(
                    `[PROCESSOR] Successfully processed SESSION_INIT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}, duration=${initDuration}ms`,
                  );
                } catch (initError) {
                  const initDuration = Date.now() - initStartTime;
                  this.logger.error(
                    `[PROCESSOR] Failed to process SESSION_INIT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}, duration=${initDuration}ms, error=${initError instanceof Error ? initError.message : String(initError)}`,
                    initError instanceof Error ? initError.stack : undefined,
                  );
                  throw initError;
                }
                break;
              }
              case WhatsAppQueueEvent.SESSION_RECONNECT: {
                this.logger.log(
                  `[PROCESSOR] Processing SESSION_RECONNECT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}`,
                );
                const reconnectStartTime = Date.now();
                try {
                  await this.whatsappService.initializeClient(sessionId);
                  const reconnectDuration = Date.now() - reconnectStartTime;
                  this.logger.log(
                    `[PROCESSOR] Successfully processed SESSION_RECONNECT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}, duration=${reconnectDuration}ms`,
                  );
                } catch (reconnectError) {
                  const reconnectDuration = Date.now() - reconnectStartTime;
                  this.logger.error(
                    `[PROCESSOR] Failed to process SESSION_RECONNECT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}, duration=${reconnectDuration}ms, error=${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`,
                    reconnectError instanceof Error
                      ? reconnectError.stack
                      : undefined,
                  );
                  throw reconnectError;
                }
                break;
              }
              case WhatsAppQueueEvent.SESSION_DISCONNECT: {
                this.logger.log(
                  `[PROCESSOR] Processing SESSION_DISCONNECT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}`,
                );
                const disconnectStartTime = Date.now();
                try {
                  await this.whatsappService.disconnectSession(sessionId);
                  const disconnectDuration = Date.now() - disconnectStartTime;
                  this.logger.log(
                    `[PROCESSOR] Successfully processed SESSION_DISCONNECT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}, duration=${disconnectDuration}ms`,
                  );
                } catch (disconnectError) {
                  const disconnectDuration = Date.now() - disconnectStartTime;
                  this.logger.error(
                    `[PROCESSOR] Failed to process SESSION_DISCONNECT: sessionId=${sessionId}, messageId=${messageId}, correlationId=${correlationId}, duration=${disconnectDuration}ms, error=${disconnectError instanceof Error ? disconnectError.message : String(disconnectError)}`,
                    disconnectError instanceof Error
                      ? disconnectError.stack
                      : undefined,
                  );
                  throw disconnectError;
                }
                break;
              }
              default:
                this.logger.warn(
                  `[PROCESSOR] Unknown WhatsApp queue event: eventType=${eventType}, messageId=${messageId}, correlationId=${correlationId}, sessionId=${sessionId}`,
                );
            }

            const totalDuration = Date.now() - startTime;
            this.logger.debug(
              `[PROCESSOR] Message processing completed: messageId=${messageId}, correlationId=${correlationId}, sessionId=${sessionId}, eventType=${eventType}, totalDuration=${totalDuration}ms`,
            );
          } catch (error) {
            const totalDuration = Date.now() - startTime;
            this.logger.error(
              `[PROCESSOR] Failed to process WhatsApp queue message: messageId=${messageId}, correlationId=${correlationId}, sessionId=${payload.data?.sessionId || "unknown"}, eventType=${payload.eventType}, totalDuration=${totalDuration}ms, error=${error instanceof Error ? error.message : String(error)}`,
              error instanceof Error ? error.stack : undefined,
            );
            throw error;
          }
        },
        {
          maxConcurrentCalls: 2,
          autoCompleteMessages: true,
        },
      );
      this.logger.log(
        `[PROCESSOR] Successfully started receiver for queue: ${WHATSAPP_QUEUE_NAME}`,
      );
    } catch (error) {
      this.logger.error(
        `[PROCESSOR] Failed to start receiver for queue ${WHATSAPP_QUEUE_NAME}: error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    // Skip stopping receiver on localhost (receiver was never started)
    if (this.isLocalhost()) {
      return;
    }

    this.logger.log(
      `[PROCESSOR] Stopping receiver for queue: ${WHATSAPP_QUEUE_NAME}`,
    );
    try {
      await this.queueService.stopReceiver(WHATSAPP_QUEUE_NAME);
      this.logger.log(
        `[PROCESSOR] Successfully stopped receiver for queue: ${WHATSAPP_QUEUE_NAME}`,
      );
    } catch (error) {
      this.logger.error(
        `[PROCESSOR] Failed to stop receiver for queue ${WHATSAPP_QUEUE_NAME}: error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
