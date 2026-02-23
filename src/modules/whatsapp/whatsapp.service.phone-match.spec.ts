import { Test, TestingModule } from "@nestjs/testing";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { Types } from "mongoose";
import { WhatsAppService } from "./whatsapp.service";
import {
  WhatsAppSession,
  SessionStatus,
} from "../../common/schemas/whatsapp-session.schema";
import { Message } from "../../common/schemas/message.schema";
import {
  User,
  WhatsAppConnectionStatus,
} from "../../common/schemas/user.schema";
import { EntitiesService } from "../entities/entities.service";
import { StorageService } from "../storage/storage.service";
import { WhatsAppQueueService } from "../whatsapp-queue/whatsapp-queue.service";
import { QrGateway } from "./qr.gateway";

describe("WhatsAppService (phone match enforcement)", () => {
  let service: WhatsAppService;

  const mockSessionModel = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };

  const mockMessageModel = {};

  const mockUserModel = {
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockEntitiesService = {};
  const mockStorageService = {};
  const mockQueueService = {};
  const mockQrGateway = {
    emitStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        { provide: getConnectionToken(), useValue: {} },
        {
          provide: getModelToken(WhatsAppSession.name),
          useValue: mockSessionModel,
        },
        { provide: getModelToken(Message.name), useValue: mockMessageModel },
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EntitiesService, useValue: mockEntitiesService },
        { provide: StorageService, useValue: mockStorageService },
        { provide: WhatsAppQueueService, useValue: mockQueueService },
        { provide: QrGateway, useValue: mockQrGateway },
      ],
    }).compile();

    service = module.get<WhatsAppService>(WhatsAppService);
    jest.clearAllMocks();
  });

  it("should fail + disconnect if connected WhatsApp phone differs from user's phoneNumber", async () => {
    const sessionId = "tenant_user_123";
    const userId = new Types.ObjectId();

    // sessionModel.findOne(...).select(...).lean()
    mockSessionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ userId }),
    });

    // userModel.findById(...).select(...).lean()
    mockUserModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ phoneNumber: "+15551234567" }),
    });

    mockSessionModel.findOneAndUpdate.mockResolvedValue(null);
    mockUserModel.findByIdAndUpdate.mockResolvedValue(null);

    const disconnectSpy = jest
      .spyOn(service, "disconnectSession")
      .mockResolvedValue(undefined);

    const mockClient: any = {
      logout: jest.fn().mockResolvedValue(undefined),
      info: {
        wid: { user: "447700900123", _serialized: "447700900123@c.us" },
        pushname: "Somebody Else",
      },
    };

    // Inject client into the service's clients map
    (service as any).clients.set(sessionId, mockClient);

    await (service as any).handleReady(sessionId, mockClient);

    expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { sessionId },
      expect.objectContaining({
        status: SessionStatus.FAILED,
        lastError: "PHONE_MISMATCH",
      }),
      expect.anything(),
    );

    expect(mockUserModel.findByIdAndUpdate).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        whatsappConnectionStatus: WhatsAppConnectionStatus.FAILED,
      }),
    );

    expect(disconnectSpy).toHaveBeenCalledWith(sessionId, {
      preserveStatus: true,
    });

    expect(mockClient.logout).toHaveBeenCalled();

    expect(mockQrGateway.emitStatus).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ status: SessionStatus.FAILED }),
    );
  });
});
