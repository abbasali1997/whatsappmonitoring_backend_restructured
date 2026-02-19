import { Test, TestingModule } from "@nestjs/testing";
import { WhatsAppQueueProcessor } from "./whatsapp-queue.processor";
import { QueueService } from "../../common/messaging/queue.service";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppQueueEvent } from "./whatsapp-queue.service";
import { ServiceBusReceivedMessage } from "@azure/service-bus";
import { ConfigService } from "@nestjs/config";

describe("WhatsAppQueueProcessor", () => {
  let processor: WhatsAppQueueProcessor;

  const mockQueueService = {
    startReceiver: jest.fn(),
    stopReceiver: jest.fn(),
  };

  const mockWhatsappService = {
    initializeClient: jest.fn(),
    disconnectSession: jest.fn(),
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
        WhatsAppQueueProcessor,
        {
          provide: QueueService,
          useValue: mockQueueService,
        },
        {
          provide: WhatsAppService,
          useValue: mockWhatsappService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    processor = module.get<WhatsAppQueueProcessor>(WhatsAppQueueProcessor);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(processor).toBeDefined();
  });

  describe("onModuleInit", () => {
    it("should start WhatsApp queue receiver", async () => {
      await processor.onModuleInit();

      expect(mockQueueService.startReceiver).toHaveBeenCalledWith(
        "whatsapp-queue",
        expect.any(Function),
        {
          maxConcurrentCalls: 2,
          autoCompleteMessages: true,
        },
      );
    });
  });

  describe("onModuleDestroy", () => {
    it("should stop WhatsApp queue receiver", async () => {
      await processor.onModuleDestroy();

      expect(mockQueueService.stopReceiver).toHaveBeenCalledWith(
        "whatsapp-queue",
      );
    });
  });

  describe("processMessage", () => {
    const createMockMessage = (
      eventType: string,
      sessionId: string,
    ): ServiceBusReceivedMessage =>
      ({
        messageId: "test-message-id",
        correlationId: "test-correlation-id",
        body: { eventType, data: { sessionId } },
        applicationProperties: { type: eventType },
      }) as any;

    it("should process SESSION_INIT event", async () => {
      await processor.onModuleInit();

      const message = createMockMessage(
        WhatsAppQueueEvent.SESSION_INIT,
        "session-123",
      );
      const payload = {
        eventType: WhatsAppQueueEvent.SESSION_INIT,
        data: { sessionId: "session-123" },
        timestamp: new Date(),
      };

      mockWhatsappService.initializeClient.mockResolvedValue(undefined);

      // Access the handler function passed to startReceiver
      const handler = mockQueueService.startReceiver.mock.calls[0]?.[1];
      if (handler) {
        await handler(message, payload);
      }

      expect(mockWhatsappService.initializeClient).toHaveBeenCalledWith(
        "session-123",
      );
    });

    it("should process SESSION_RECONNECT event", async () => {
      await processor.onModuleInit();

      const message = createMockMessage(
        WhatsAppQueueEvent.SESSION_RECONNECT,
        "session-456",
      );
      const payload = {
        eventType: WhatsAppQueueEvent.SESSION_RECONNECT,
        data: { sessionId: "session-456" },
        timestamp: new Date(),
      };

      mockWhatsappService.initializeClient.mockResolvedValue(undefined);

      const handler = mockQueueService.startReceiver.mock.calls[0]?.[1];
      if (handler) {
        await handler(message, payload);
      }

      expect(mockWhatsappService.initializeClient).toHaveBeenCalledWith(
        "session-456",
      );
    });

    it("should process SESSION_DISCONNECT event", async () => {
      await processor.onModuleInit();

      const message = createMockMessage(
        WhatsAppQueueEvent.SESSION_DISCONNECT,
        "session-789",
      );
      const payload = {
        eventType: WhatsAppQueueEvent.SESSION_DISCONNECT,
        data: { sessionId: "session-789" },
        timestamp: new Date(),
      };

      mockWhatsappService.disconnectSession.mockResolvedValue(undefined);

      const handler = mockQueueService.startReceiver.mock.calls[0]?.[1];
      if (handler) {
        await handler(message, payload);
      }

      expect(mockWhatsappService.disconnectSession).toHaveBeenCalledWith(
        "session-789",
      );
    });

    it("should handle missing sessionId", async () => {
      await processor.onModuleInit();

      const message = createMockMessage(WhatsAppQueueEvent.SESSION_INIT, "");
      const payload = {
        eventType: WhatsAppQueueEvent.SESSION_INIT,
        data: {},
        timestamp: new Date(),
      };

      const handler = mockQueueService.startReceiver.mock.calls[0]?.[1];
      if (handler) {
        await handler(message, payload);
      }

      expect(mockWhatsappService.initializeClient).not.toHaveBeenCalled();
    });

    it("should handle unknown event type", async () => {
      await processor.onModuleInit();

      const message = createMockMessage("unknown.event", "session-123");
      const payload = {
        eventType: "unknown.event",
        data: { sessionId: "session-123" },
        timestamp: new Date(),
      };

      const handler = mockQueueService.startReceiver.mock.calls[0]?.[1];
      if (handler) {
        await expect(handler(message, payload)).resolves.not.toThrow();
      }
    });

    it("should handle service errors", async () => {
      await processor.onModuleInit();

      const message = createMockMessage(
        WhatsAppQueueEvent.SESSION_INIT,
        "session-error",
      );
      const payload = {
        eventType: WhatsAppQueueEvent.SESSION_INIT,
        data: { sessionId: "session-error" },
        timestamp: new Date(),
      };

      mockWhatsappService.initializeClient.mockRejectedValue(
        new Error("Service error"),
      );

      const handler = mockQueueService.startReceiver.mock.calls[0]?.[1];
      if (handler) {
        await expect(handler(message, payload)).rejects.toThrow(
          "Service error",
        );
      }
    });
  });
});
