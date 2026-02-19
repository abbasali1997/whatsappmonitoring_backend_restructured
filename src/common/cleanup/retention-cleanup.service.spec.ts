import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { RetentionCleanupService } from "./retention-cleanup.service";
import { RegistrationStatus } from "../schemas/user.schema";

describe("RetentionCleanupService", () => {
  let service: RetentionCleanupService;

  const mockSessionModel = {
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  } as any;

  const mockUserModel = {
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  } as any;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case "cleanup.qrCodeCleanupDays":
          return 2;
        case "cleanup.failedInvitationCleanupDays":
          return 3;
        case "cleanup.intervalMs":
          return 1000;
        default:
          return undefined;
      }
    }),
  } as any;

  const mockScheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfigService.get = jest.fn((key: string) => {
      switch (key) {
        case "cleanup.qrCodeCleanupDays":
          return 2;
        case "cleanup.failedInvitationCleanupDays":
          return 3;
        case "cleanup.intervalMs":
          return 1000;
        default:
          return undefined;
      }
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetentionCleanupService,
        { provide: getModelToken("WhatsAppSession"), useValue: mockSessionModel },
        { provide: getModelToken("User"), useValue: mockUserModel },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SchedulerRegistry, useValue: mockScheduler },
      ],
    }).compile();

    service = module.get<RetentionCleanupService>(RetentionCleanupService);
  });

  it("should run cleanup and update sessions and users", async () => {
    await (service as any).runCleanup();

    expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
      { qrCodeExpiresAt: { $ne: null, $lte: expect.any(Date) } },
      {
        $set: {
          qrCode: null,
          qrCodeGeneratedAt: null,
          qrCodeExpiresAt: null,
        },
      },
    );

    expect(mockUserModel.updateMany).toHaveBeenCalledWith(
      { "qrInvitationHistory.sentAt": { $lt: expect.any(Date) } },
      {
        $pull: { qrInvitationHistory: { sentAt: { $lt: expect.any(Date) } } },
      },
    );

    expect(mockUserModel.updateMany).toHaveBeenCalledWith(
      {
        registrationStatus: RegistrationStatus.INVITED,
        createdAt: { $lt: expect.any(Date) },
      },
      {
        $set: {
          registrationStatus: RegistrationStatus.CANCELLED,
          isActive: false,
        },
      },
    );
  });

  it("should schedule and stop the cleanup interval", async () => {
    const intervalRef = { unref: jest.fn() } as any;
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue(intervalRef);

    service.onModuleInit();

    expect(mockScheduler.deleteInterval).toHaveBeenCalledWith("retention-cleanup");
    expect(mockScheduler.addInterval).toHaveBeenCalledWith(
      "retention-cleanup",
      intervalRef,
    );
    expect(intervalRef.unref).toHaveBeenCalled();

    service.onModuleDestroy();
    expect(mockScheduler.deleteInterval).toHaveBeenCalledWith("retention-cleanup");

    setIntervalSpy.mockRestore();
  });

  it("should skip scheduling when interval is invalid", async () => {
    mockConfigService.get = jest.fn((key: string) => {
      if (key === "cleanup.intervalMs") return 0;
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetentionCleanupService,
        { provide: getModelToken("WhatsAppSession"), useValue: mockSessionModel },
        { provide: getModelToken("User"), useValue: mockUserModel },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SchedulerRegistry, useValue: mockScheduler },
      ],
    }).compile();

    const localService = module.get<RetentionCleanupService>(
      RetentionCleanupService,
    );
    localService.onModuleInit();

    expect(mockScheduler.addInterval).not.toHaveBeenCalled();
  });

  it("should skip overlapping runs", async () => {
    const loggerSpy = jest.spyOn((service as any).logger, "debug");
    (service as any).running = true;

    await (service as any).runCleanup();

    expect(loggerSpy).toHaveBeenCalled();
    (service as any).running = false;
  });

  it("should handle cleanup errors", async () => {
    const loggerSpy = jest.spyOn((service as any).logger, "error");
    mockSessionModel.updateMany.mockRejectedValueOnce("boom");

    await (service as any).runCleanup();

    expect(loggerSpy).toHaveBeenCalled();
    expect((service as any).running).toBe(false);
  });

  it("should not require unref on interval", async () => {
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue(123 as any);

    service.onModuleInit();

    expect(mockScheduler.addInterval).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
  });
});
