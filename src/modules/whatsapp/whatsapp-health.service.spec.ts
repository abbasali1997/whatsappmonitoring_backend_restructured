import { Test, TestingModule } from "@nestjs/testing";
import { WhatsAppHealthService } from "./whatsapp-health.service";
import { WhatsAppService } from "./whatsapp.service";
import { getModelToken } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { EmailService } from "../email/email.service";

describe("WhatsAppHealthService", () => {
  let service: WhatsAppHealthService;

  let sessions: any[] = [];

  const mockSessionModel = {
    find: jest.fn(() => ({
      select: jest.fn(() => ({
        lean: jest.fn(async () => sessions),
      })),
    })),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  } as any;

  const mockWhatsAppService = {
    getSessionStatus: jest.fn(),
    requestReconnect: jest.fn(),
    removeSession: jest.fn(),
  } as any;

  const mockEmailService = {
    sendWhatsAppHealthAlert: jest.fn().mockResolvedValue(undefined),
  } as any;
  const mockScheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  } as any;
  const mockUserModel = {
    findOne: jest.fn(() => ({
      lean: jest.fn().mockResolvedValue(null),
    })),
  } as any;
  const mockConfigService = {
    get: jest.fn((_key: string, defaultValue: any) => defaultValue),
  } as any;

  beforeEach(async () => {
    sessions = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppHealthService,
        {
          provide: getModelToken("WhatsAppSession"),
          useValue: mockSessionModel,
        },
        { provide: getModelToken("User"), useValue: mockUserModel },
        { provide: WhatsAppService, useValue: mockWhatsAppService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: SchedulerRegistry, useValue: mockScheduler },
      ],
    }).compile();

    service = module.get<WhatsAppHealthService>(WhatsAppHealthService);
  });

  it("should request reconnect when health check fails threshold", async () => {
    const session = {
      _id: "id",
      sessionId: "session-1",
      tenantId: "tenant-1",
      phoneNumber: "+123",
      whatsappName: "Test",
      lastHealthStatus: "unknown",
      consecutiveHealthFailures: 2,
    } as any;

    sessions = [session];

    mockWhatsAppService.getSessionStatus.mockResolvedValue({
      healthStatus: { lastStatus: "failed", consecutiveFailures: 3 },
    });

    await service.runHealthChecks();

    expect(mockWhatsAppService.requestReconnect).toHaveBeenCalledWith(
      "session-1",
    );
  });

  it("should disconnect session and send alert email when failures exceed threshold (>3)", async () => {
    const session = {
      _id: "id",
      sessionId: "session-1",
      tenantId: "tenant-1",
      phoneNumber: "+123",
      whatsappName: "Test",
      lastHealthStatus: "unknown",
      consecutiveHealthFailures: 3,
      lastHealthAlertAt: null,
    } as any;

    sessions = [session];

    // Exceeds threshold (default failureThreshold=3) => disconnect
    mockWhatsAppService.getSessionStatus.mockResolvedValue({
      healthStatus: { lastStatus: "failed", consecutiveFailures: 4 },
    });

    // Ensure notifyUser finds an email
    (mockUserModel.findOne as any) = jest.fn(() => ({
      lean: jest
        .fn()
        .mockResolvedValue({ email: "user@example.com", language: "en" }),
    }));

    await service.runHealthChecks();

    expect(mockWhatsAppService.removeSession).toHaveBeenCalledWith("session-1");
    expect(mockEmailService.sendWhatsAppHealthAlert).toHaveBeenCalledWith(
      "user@example.com",
      expect.objectContaining({
        sessionId: "session-1",
        consecutiveFailures: 4,
      }),
    );
  });
});
