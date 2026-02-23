import { Test, TestingModule } from "@nestjs/testing";
import {
  WhatsAppQueueService,
  WhatsAppQueueEvent,
} from "./whatsapp-queue.service";
import { QueueService } from "@/common/messaging/queue.service";

describe("WhatsAppQueueService", () => {
  let service: WhatsAppQueueService;

  const mockQueueService = {
    sendMessage: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppQueueService,
        {
          provide: QueueService,
          useValue: mockQueueService,
        },
      ],
    }).compile();

    service = module.get<WhatsAppQueueService>(WhatsAppQueueService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("queueInitializeSession", () => {
    it("should queue session initialization", async () => {
      const sessionId = "test-session-123";
      const userId = "user-123";
      const tenantId = "tenant-123";

      mockQueueService.sendMessage.mockResolvedValue({
        messageId: "test-message-id",
      });

      await service.queueInitializeSession(sessionId, userId, tenantId);

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "whatsapp-queue",
        WhatsAppQueueEvent.SESSION_INIT,
        { sessionId },
        expect.objectContaining({
          correlationId: expect.stringContaining("wa-init-"),
          userId,
          tenantId,
        }),
      );
    });

    it("should handle errors when queueing fails", async () => {
      const sessionId = "test-session-123";
      mockQueueService.sendMessage.mockRejectedValue(new Error("Queue error"));

      await expect(service.queueInitializeSession(sessionId)).rejects.toThrow(
        "Queue error",
      );
    });
  });

  describe("queueReconnectSession", () => {
    it("should queue session reconnection", async () => {
      const sessionId = "test-session-123";
      const userId = "user-123";
      const tenantId = "tenant-123";

      mockQueueService.sendMessage.mockResolvedValue({
        messageId: "test-message-id",
      });

      await service.queueReconnectSession(sessionId, userId, tenantId);

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "whatsapp-queue",
        WhatsAppQueueEvent.SESSION_RECONNECT,
        { sessionId },
        expect.objectContaining({
          correlationId: expect.stringContaining("wa-reconnect-"),
          userId,
          tenantId,
        }),
      );
    });
  });

  describe("queueDisconnectSession", () => {
    it("should queue session disconnection", async () => {
      const sessionId = "test-session-123";
      const userId = "user-123";
      const tenantId = "tenant-123";

      mockQueueService.sendMessage.mockResolvedValue({
        messageId: "test-message-id",
      });

      await service.queueDisconnectSession(sessionId, userId, tenantId);

      expect(mockQueueService.sendMessage).toHaveBeenCalledWith(
        "whatsapp-queue",
        WhatsAppQueueEvent.SESSION_DISCONNECT,
        { sessionId },
        expect.objectContaining({
          correlationId: expect.stringContaining("wa-disconnect-"),
          userId,
          tenantId,
        }),
      );
    });
  });
});
