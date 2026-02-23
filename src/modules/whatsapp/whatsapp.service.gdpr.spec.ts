import { Test, TestingModule } from "@nestjs/testing";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { ConfigService } from "@nestjs/config";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppSession } from "../../common/schemas/whatsapp-session.schema";
import { Message } from "../../common/schemas/message.schema";
import { User } from "../../common/schemas/user.schema";
import { EntitiesService } from "../entities/entities.service";
import { StorageService } from "../storage/storage.service";
import { WhatsAppQueueService } from "../whatsapp-queue/whatsapp-queue.service";
import { QrGateway } from "./qr.gateway";

describe("WhatsAppService (LGPD/GDPR)", () => {
  let service: WhatsAppService;

  const mockSessionModel = {
    updateMany: jest.fn(),
  };

  const mockMessageModel = {
    updateMany: jest.fn(),
  };

  const mockUserModel = {};

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockEntitiesService = {};
  const mockStorageService = {};
  const mockQueueService = {};
  const mockQrGateway = {};

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

  describe("pseudonymizeMessagesForDeletedUser", () => {
    it("should scrub participant identity (from/to), remove PII metadata, and keep message content", async () => {
      const tenantId = new Types.ObjectId().toString();
      const phoneNumber = "+1234567890";
      const pseudonym = "Deleted User A1B2C3D4";
      const deletedBy = new Types.ObjectId().toString();

      mockMessageModel.updateMany
        .mockResolvedValueOnce({ matchedCount: 3, modifiedCount: 3 })
        .mockResolvedValueOnce({ matchedCount: 5, modifiedCount: 4 });

      const result = await service.pseudonymizeMessagesForDeletedUser({
        tenantId,
        phoneNumber,
        pseudonym,
        deletedBy,
      });

      expect(mockMessageModel.updateMany).toHaveBeenCalledTimes(2);

      const [fromQuery, fromUpdate] = mockMessageModel.updateMany.mock.calls[0];
      expect(fromQuery).toEqual(
        expect.objectContaining({
          tenantId: new Types.ObjectId(tenantId),
          $or: [
            { fromPhoneNumber: phoneNumber },
            { from: expect.stringMatching(/@c\.us$/) },
          ],
        }),
      );
      expect(fromUpdate).toEqual(
        expect.objectContaining({
          $set: expect.objectContaining({
            fromName: pseudonym,
            fromPhoneNumber: expect.stringMatching(/^deleted:/),
            from: expect.stringMatching(/^deleted:/),
            fromAvatarUrl: null,
            whatsappUsername: pseudonym,
            updatedBy: deletedBy,
          }),
          $unset: expect.objectContaining({
            "metadata.registeredUserInfo": "",
          }),
        }),
      );

      const [toQuery, toUpdate] = mockMessageModel.updateMany.mock.calls[1];
      expect(toQuery).toEqual(
        expect.objectContaining({
          tenantId: new Types.ObjectId(tenantId),
          $or: [
            { toPhoneNumber: phoneNumber },
            { to: expect.stringMatching(/@c\.us$/) },
          ],
        }),
      );
      expect(toUpdate).toEqual(
        expect.objectContaining({
          $set: expect.objectContaining({
            toName: pseudonym,
            toPhoneNumber: expect.stringMatching(/^deleted:/),
            to: expect.stringMatching(/^deleted:/),
            toAvatarUrl: null,
            updatedBy: deletedBy,
          }),
        }),
      );

      expect(result).toEqual({ matched: 8, modified: 7 });
    });

    it("should throw on invalid tenantId", async () => {
      await expect(
        service.pseudonymizeMessagesForDeletedUser({
          tenantId: "invalid",
          phoneNumber: "+123",
          pseudonym: "Deleted User TEST",
        }),
      ).rejects.toThrow("Invalid tenantId for pseudonymization");
    });
  });

  describe("deactivateSessionsForDeletedUser", () => {
    it("should scrub session identity and deactivate sessions for a user", async () => {
      const userId = new Types.ObjectId().toString();
      const deletedBy = new Types.ObjectId().toString();

      mockSessionModel.updateMany.mockResolvedValue({
        matchedCount: 2,
        modifiedCount: 2,
      });

      await service.deactivateSessionsForDeletedUser(userId, deletedBy);

      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        { userId: new Types.ObjectId(userId) },
        expect.objectContaining({
          $set: expect.objectContaining({
            isActive: false,
            userId: null,
            phoneNumber: null,
            whatsappName: null,
            whatsappId: null,
            sessionData: null,
            qrCode: null,
            qrCodeUrl: null,
            updatedBy: deletedBy,
          }),
        }),
      );
    });
  });
});
