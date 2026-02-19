import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { QueueService } from "./queue.service";

describe("QueueService", () => {
  let service: QueueService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockServiceBusClient = {
    createSender: jest.fn(),
    createReceiver: jest.fn(),
    close: jest.fn(),
  };

  const mockSender = {
    sendMessages: jest.fn(),
    createMessageBatch: jest.fn(),
    close: jest.fn(),
  };

  const mockReceiver = {
    subscribe: jest.fn(),
    close: jest.fn(),
    peekMessages: jest.fn(),
    completeMessage: jest.fn(),
    abandonMessage: jest.fn(),
    deadLetterMessage: jest.fn(),
    deferMessage: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockConfigService.get.mockImplementation((key: string) => {
      if (key === "azure.serviceBus.connectionString") {
        return "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=test;SharedAccessKey=test";
      }
      if (key === "azure.serviceBus.defaultQueue") {
        return "default-queue";
      }
      return undefined;
    });

    // Mock ServiceBusClient constructor
    const serviceBusModule = await import("@azure/service-bus");
    jest
      .spyOn(serviceBusModule, "ServiceBusClient")
      .mockImplementation(() => mockServiceBusClient as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("sendMessage", () => {
    it("should send message to queue", async () => {
      mockServiceBusClient.createSender.mockReturnValue(mockSender);
      mockSender.sendMessages.mockResolvedValue(undefined);

      await service.sendMessage(
        "test-queue",
        "test.event",
        { data: "test" },
        { correlationId: "test-correlation" },
      );

      expect(mockServiceBusClient.createSender).toHaveBeenCalledWith(
        "test-queue",
      );
      expect(mockSender.sendMessages).toHaveBeenCalled();
    });

    it("should use default queue if queue name not provided", async () => {
      mockServiceBusClient.createSender.mockReturnValue(mockSender);
      mockSender.sendMessages.mockResolvedValue(undefined);

      await service.sendMessage(undefined, "test.event", { data: "test" });

      expect(mockServiceBusClient.createSender).toHaveBeenCalledWith(
        "default-queue",
      );
    });

    it("should handle disabled queue service", async () => {
      // Mock service with no connection string
      mockConfigService.get.mockReturnValueOnce(undefined);

      const disabledService = new QueueService(configService);

      await disabledService.sendMessage("test-queue", "test.event", {
        data: "test",
      });

      // Should not throw, just log warning
      expect(mockServiceBusClient.createSender).not.toHaveBeenCalled();
    });

    it("should handle send errors", async () => {
      mockServiceBusClient.createSender.mockReturnValue(mockSender);
      mockSender.sendMessages.mockRejectedValue(new Error("Send failed"));

      await expect(
        service.sendMessage("test-queue", "test.event", { data: "test" }),
      ).rejects.toThrow("Send failed");
    });
  });

  describe("sendBatchMessages", () => {
    it("should send batch messages", async () => {
      const mockBatch = {
        tryAddMessage: jest.fn().mockReturnValue(true),
        count: 2,
      };

      mockServiceBusClient.createSender.mockReturnValue(mockSender);
      mockSender.createMessageBatch.mockResolvedValue(mockBatch);
      mockSender.sendMessages.mockResolvedValue(undefined);

      const messages = [
        {
          eventType: "event1",
          data: { test: "1" },
          options: { correlationId: "corr-1" },
        },
        {
          eventType: "event2",
          data: { test: "2" },
          options: { correlationId: "corr-2" },
        },
      ];

      await service.sendBatchMessages("test-queue", messages);

      expect(mockSender.createMessageBatch).toHaveBeenCalled();
      expect(mockSender.sendMessages).toHaveBeenCalled();
    });

    it("should handle batch size limits", async () => {
      const mockBatch1 = {
        tryAddMessage: jest
          .fn()
          .mockReturnValueOnce(true)
          .mockReturnValueOnce(false), // Second message doesn't fit
        count: 1,
      };

      const mockBatch2 = {
        tryAddMessage: jest.fn().mockReturnValue(true),
        count: 1,
      };

      mockServiceBusClient.createSender.mockReturnValue(mockSender);
      mockSender.createMessageBatch
        .mockResolvedValueOnce(mockBatch1)
        .mockResolvedValueOnce(mockBatch2);
      mockSender.sendMessages.mockResolvedValue(undefined);

      const messages = [
        { eventType: "event1", data: { test: "1" } },
        { eventType: "event2", data: { test: "2" } },
      ];

      await service.sendBatchMessages("test-queue", messages);

      expect(mockSender.sendMessages).toHaveBeenCalledTimes(2);
    });
  });

  describe("startReceiver", () => {
    it("should start receiver for queue", async () => {
      mockServiceBusClient.createReceiver.mockReturnValue(mockReceiver);
      mockReceiver.subscribe.mockImplementation((_options: any) => {
        // Simulate subscription (subscribe does not return a Promise in SDK)
        return undefined as any;
      });

      const handler = jest.fn();
      await service.startReceiver("test-queue", handler, {
        maxConcurrentCalls: 5,
        autoCompleteMessages: true,
      });

      expect(mockServiceBusClient.createReceiver).toHaveBeenCalledWith(
        "test-queue",
        {
          subQueueType: undefined,
        },
      );
      expect(mockReceiver.subscribe).toHaveBeenCalled();
    });

    it("should handle receiver errors", async () => {
      mockServiceBusClient.createReceiver.mockReturnValue(mockReceiver);
      mockReceiver.subscribe.mockImplementation(() => {
        throw new Error("Subscribe failed");
      });

      const handler = jest.fn();
      await expect(
        service.startReceiver("test-queue", handler),
      ).rejects.toThrow("Subscribe failed");
    });
  });

  describe("stopReceiver", () => {
    it("should stop receiver for queue", async () => {
      mockServiceBusClient.createReceiver.mockReturnValue(mockReceiver);
      mockReceiver.subscribe.mockResolvedValue(undefined);
      mockReceiver.close.mockResolvedValue(undefined);

      const handler = jest.fn();
      await service.startReceiver("test-queue", handler);
      await service.stopReceiver("test-queue");

      expect(mockReceiver.close).toHaveBeenCalled();
    });

    it("should handle stop errors gracefully", async () => {
      mockServiceBusClient.createReceiver.mockReturnValue(mockReceiver);
      mockReceiver.close.mockRejectedValue(new Error("Close failed"));

      const handler = jest.fn();
      await service.startReceiver("test-queue", handler);

      // Should not throw
      await expect(service.stopReceiver("test-queue")).resolves.not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should cleanup all senders and receivers", async () => {
      mockServiceBusClient.createSender.mockReturnValue(mockSender);
      mockServiceBusClient.createReceiver.mockReturnValue(mockReceiver);
      mockSender.close.mockResolvedValue(undefined);
      mockReceiver.close.mockResolvedValue(undefined);
      mockServiceBusClient.close.mockResolvedValue(undefined);

      await service.sendMessage("test-queue", "test.event", { data: "test" });
      const handler = jest.fn();
      await service.startReceiver("test-queue", handler);

      await (service as any).cleanup();

      expect(mockSender.close).toHaveBeenCalled();
      expect(mockReceiver.close).toHaveBeenCalled();
      expect(mockServiceBusClient.close).toHaveBeenCalled();
    });
  });
});
