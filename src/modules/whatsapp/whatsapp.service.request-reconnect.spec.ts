import { WhatsAppService } from "./whatsapp.service";

describe("WhatsAppService.requestReconnect", () => {
  it("should queue reconnect when service bus is configured", async () => {
    const mockQueueService = { queueReconnectSession: jest.fn() } as any;
    const mockConfigService = {
      get: jest.fn((key: string, def?: any) => {
        if (key === "azure.serviceBus.connectionString")
          return "Endpoint=sb://fake";
        if (key === "app.nodeEnv") return "production";
        if (key === "app.baseUrl") return "https://example.com";
        return def;
      }),
    } as any;

    const svc = new (WhatsAppService as any)(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mockConfigService,
      {} as any,
      {} as any,
      mockQueueService,
      {} as any,
    );

    await svc.requestReconnect("session-123");

    expect(mockQueueService.queueReconnectSession).toHaveBeenCalledWith(
      "session-123",
    );
  });

  it("should call initializeClient when service bus is not configured", async () => {
    const mockQueueService = { queueReconnectSession: jest.fn() } as any;
    const mockConfigService = {
      get: jest.fn((key: string, def?: any) => {
        // No service bus
        if (key === "azure.serviceBus.connectionString") return undefined;
        if (key === "app.nodeEnv") return "production";
        if (key === "app.baseUrl") return "https://example.com";
        return def;
      }),
    } as any;

    const svc = new (WhatsAppService as any)(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mockConfigService,
      {} as any,
      {} as any,
      mockQueueService,
      {} as any,
    );

    const spy = jest
      .spyOn(svc as any, "initializeClient")
      .mockResolvedValue(undefined);

    await svc.requestReconnect("session-456");

    expect(spy).toHaveBeenCalledWith("session-456");
  });
});
