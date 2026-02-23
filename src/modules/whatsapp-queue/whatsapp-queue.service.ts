import { Injectable, Logger } from "@nestjs/common";
import { QueueService } from "@/common/messaging/queue.service";

export const WHATSAPP_QUEUE_NAME = "whatsapp-queue";

export enum WhatsAppQueueEvent {
  SESSION_INIT = "whatsapp.session.init",
  SESSION_RECONNECT = "whatsapp.session.reconnect",
  SESSION_DISCONNECT = "whatsapp.session.disconnect",
}

@Injectable()
export class WhatsAppQueueService {
  private readonly logger = new Logger(WhatsAppQueueService.name);

  constructor(private readonly queueService: QueueService) {}

  async queueInitializeSession(
    sessionId: string,
    userId?: string,
    tenantId?: string,
  ): Promise<void> {
    const correlationId = `wa-init-${sessionId}`;
    const startTime = Date.now();
    this.logger.debug(
      `[QUEUE] Preparing to queue session init: sessionId=${sessionId}, userId=${userId}, tenantId=${tenantId}, correlationId=${correlationId}`,
    );
    try {
      this.logger.debug(
        `[QUEUE] Calling queueService.sendMessage: queue=${WHATSAPP_QUEUE_NAME}, eventType=${WhatsAppQueueEvent.SESSION_INIT}, sessionId=${sessionId}`,
      );
      await this.queueService.sendMessage(
        WHATSAPP_QUEUE_NAME,
        WhatsAppQueueEvent.SESSION_INIT,
        { sessionId },
        {
          correlationId,
          userId,
          tenantId,
        },
      );
      const duration = Date.now() - startTime;
      this.logger.log(
        `[QUEUE] Successfully queued session init: sessionId=${sessionId}, correlationId=${correlationId}, duration=${duration}ms`,
      );
      this.logger.debug(
        `[QUEUE] Session init message details: queue=${WHATSAPP_QUEUE_NAME}, eventType=${WhatsAppQueueEvent.SESSION_INIT}, sessionId=${sessionId}, userId=${userId}, tenantId=${tenantId}`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `[QUEUE] Failed to queue session init: sessionId=${sessionId}, correlationId=${correlationId}, duration=${duration}ms, error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async queueReconnectSession(
    sessionId: string,
    userId?: string,
    tenantId?: string,
  ): Promise<void> {
    const correlationId = `wa-reconnect-${sessionId}`;
    const startTime = Date.now();
    this.logger.debug(
      `[QUEUE] Preparing to queue session reconnect: sessionId=${sessionId}, userId=${userId}, tenantId=${tenantId}, correlationId=${correlationId}`,
    );
    try {
      this.logger.debug(
        `[QUEUE] Calling queueService.sendMessage: queue=${WHATSAPP_QUEUE_NAME}, eventType=${WhatsAppQueueEvent.SESSION_RECONNECT}, sessionId=${sessionId}`,
      );
      await this.queueService.sendMessage(
        WHATSAPP_QUEUE_NAME,
        WhatsAppQueueEvent.SESSION_RECONNECT,
        { sessionId },
        {
          correlationId,
          userId,
          tenantId,
        },
      );
      const duration = Date.now() - startTime;
      this.logger.log(
        `[QUEUE] Successfully queued session reconnect: sessionId=${sessionId}, correlationId=${correlationId}, duration=${duration}ms`,
      );
      this.logger.debug(
        `[QUEUE] Session reconnect message details: queue=${WHATSAPP_QUEUE_NAME}, eventType=${WhatsAppQueueEvent.SESSION_RECONNECT}, sessionId=${sessionId}, userId=${userId}, tenantId=${tenantId}`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `[QUEUE] Failed to queue session reconnect: sessionId=${sessionId}, correlationId=${correlationId}, duration=${duration}ms, error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async queueDisconnectSession(
    sessionId: string,
    userId?: string,
    tenantId?: string,
  ): Promise<void> {
    const correlationId = `wa-disconnect-${sessionId}`;
    const startTime = Date.now();
    this.logger.debug(
      `[QUEUE] Preparing to queue session disconnect: sessionId=${sessionId}, userId=${userId}, tenantId=${tenantId}, correlationId=${correlationId}`,
    );
    try {
      this.logger.debug(
        `[QUEUE] Calling queueService.sendMessage: queue=${WHATSAPP_QUEUE_NAME}, eventType=${WhatsAppQueueEvent.SESSION_DISCONNECT}, sessionId=${sessionId}`,
      );
      await this.queueService.sendMessage(
        WHATSAPP_QUEUE_NAME,
        WhatsAppQueueEvent.SESSION_DISCONNECT,
        { sessionId },
        {
          correlationId,
          userId,
          tenantId,
        },
      );
      const duration = Date.now() - startTime;
      this.logger.log(
        `[QUEUE] Successfully queued session disconnect: sessionId=${sessionId}, correlationId=${correlationId}, duration=${duration}ms`,
      );
      this.logger.debug(
        `[QUEUE] Session disconnect message details: queue=${WHATSAPP_QUEUE_NAME}, eventType=${WhatsAppQueueEvent.SESSION_DISCONNECT}, sessionId=${sessionId}, userId=${userId}, tenantId=${tenantId}`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `[QUEUE] Failed to queue session disconnect: sessionId=${sessionId}, correlationId=${correlationId}, duration=${duration}ms, error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
