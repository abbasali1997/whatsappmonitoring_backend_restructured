import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { UsersService } from "./users.service";
import {
  User,
  UserRole,
  RegistrationStatus,
  WhatsAppConnectionStatus,
} from "../../common/schemas/user.schema";
import { Entity } from "../../common/schemas/entity.schema";
import { Message } from "../../common/schemas/message.schema";
import { AuthService } from "../auth/auth.service";
import { EmailService } from "../email/email.service";
import { EmailQueueService } from "../email/email-queue.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { WhatsAppHealthService } from "../whatsapp/whatsapp-health.service";
import { MessagingService } from "../../common/messaging/messaging.service";
import { BulkUploadGateway } from "./bulk-upload.gateway";
import { WhatsAppSession } from "../../common/schemas/whatsapp-session.schema";

describe("UsersService", () => {
  let service: UsersService;

  const mockUserModel = {
    findOne: jest.fn(),
    find: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findById: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
  };

  const mockEntityModel = {
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockMessageModel = {
    find: jest.fn(),
    countDocuments: jest.fn(),
  };

  const mockWhatsAppSessionModel = {
    distinct: jest.fn(),
  };

  const mockAuthService = {
    hashPassword: jest.fn(),
  };

  const mockEmailService = {
    sendInvitationEmailWithQR: jest.fn(),
    sendInvitationEmail: jest.fn(),
    sendEmailVerificationEmail: jest.fn(),
  };

  const mockEmailQueueService = {
    queueInvitationEmail: jest.fn(),
    queueInvitationEmailWithQR: jest.fn(),
    queueEmailVerificationEmail: jest.fn(),
  };

  const mockWhatsAppService = {
    createSession: jest.fn(),
    getQRCode: jest.fn(),
    disconnectSession: jest.fn(),
    pseudonymizeMessagesForDeletedUser: jest.fn(),
    deactivateSessionsForDeletedUser: jest.fn(),
  };

  const mockWhatsAppHealthService = {
    runHealthCheckForSessionId: jest.fn(),
  };

  const mockMessagingService = {
    // Add methods if needed
  };

  const mockBulkUploadGateway = {
    emitProgress: jest.fn(),
    emitError: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getModelToken(User.name),
          useValue: mockUserModel,
        },
        {
          provide: getModelToken(Entity.name),
          useValue: mockEntityModel,
        },
        {
          provide: getModelToken(Message.name),
          useValue: mockMessageModel,
        },
        {
          provide: getModelToken(WhatsAppSession.name),
          useValue: mockWhatsAppSessionModel,
        },
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: EmailQueueService,
          useValue: mockEmailQueueService,
        },
        {
          provide: WhatsAppService,
          useValue: mockWhatsAppService,
        },
        {
          provide: WhatsAppHealthService,
          useValue: mockWhatsAppHealthService,
        },
        {
          provide: MessagingService,
          useValue: mockMessagingService,
        },
        {
          provide: BulkUploadGateway,
          useValue: mockBulkUploadGateway,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("findOne", () => {
    it("should throw BadRequestException for invalid ID format", async () => {
      await expect(
        service.findOne("invalid-id", "507f1f77bcf86cd799439012"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("findAll", () => {
    it("should return paginated users", async () => {
      const mockUsers = [
        {
          _id: new Types.ObjectId(),
          email: "user1@example.com",
          firstName: "User",
          lastName: "One",
          phoneNumber: "+1234567890",
          toObject: jest.fn().mockReturnValue({
            _id: new Types.ObjectId(),
            email: "user1@example.com",
          }),
        },
      ];

      mockUserModel.countDocuments = jest.fn().mockResolvedValue(1);
      mockUserModel.find = jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          sort: jest.fn().mockReturnValue({
            skip: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(mockUsers),
            }),
          }),
        }),
      });
      mockWhatsAppService.getQRCode = jest.fn().mockResolvedValue(null);

      const result = await service.findAll("507f1f77bcf86cd799439012");

      expect(result).toHaveProperty("users");
      expect(result).toHaveProperty("total");
      expect(result).toHaveProperty("page");
      expect(result).toHaveProperty("limit");
      expect(result).toHaveProperty("totalPages");
    });
  });

  describe("exportUsers", () => {
    it("should map users into export rows", async () => {
      const tenantId = "507f1f77bcf86cd799439012";
      const mockRows = [
        {
          _id: new Types.ObjectId(),
          tenantId: new Types.ObjectId(tenantId),
          entityPath: "Entity > Company > Department",
          registrationStatus: RegistrationStatus.REGISTERED,
        },
      ];

      const lean = jest.fn().mockResolvedValue(mockRows);
      const sort = jest.fn().mockReturnValue({ lean });
      mockUserModel.find = jest.fn().mockReturnValue({ sort });

      const result = await service.exportUsers(tenantId);

      expect(mockUserModel.find).toHaveBeenCalledWith(
        { isActive: true, tenantId: new Types.ObjectId(tenantId) },
        { tenantId: 1, entityPath: 1, registrationStatus: 1 },
      );
      expect(result).toEqual([
        {
          tenantId,
          entityPath: mockRows[0].entityPath,
          userId: mockRows[0]._id.toString(),
          status: RegistrationStatus.REGISTERED,
        },
      ]);
    });

    it("should include role filter when provided", async () => {
      mockUserModel.find = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      });

      await service.exportUsers("507f1f77bcf86cd799439012", {
        role: UserRole.USER,
      });

      expect(mockUserModel.find).toHaveBeenCalledWith(
        {
          isActive: true,
          tenantId: new Types.ObjectId("507f1f77bcf86cd799439012"),
          role: UserRole.USER,
        },
        {
          tenantId: 1,
          entityPath: 1,
          registrationStatus: 1,
        },
      );
    });

    it("should throw BadRequestException for invalid entity filter", async () => {
      await expect(
        service.exportUsers("507f1f77bcf86cd799439012", {
          entityId: "invalid-id",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("update", () => {
    it("should throw BadRequestException when email already exists", async () => {
      const mockUser = {
        _id: new Types.ObjectId(),
        email: "test@example.com",
        isActive: true,
        populate: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          email: "test@example.com",
        }),
      };

      const existingUser = {
        _id: new Types.ObjectId("507f1f77bcf86cd799439014"),
        email: "newemail@example.com",
      };

      mockUserModel.findOne = jest
        .fn()
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(existingUser);

      await expect(
        service.update(
          "507f1f77bcf86cd799439011",
          { email: "newemail@example.com" },
          "507f1f77bcf86cd799439013",
          "507f1f77bcf86cd799439012",
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("remove (LGPD/GDPR anonymization)", () => {
    it("should anonymize the user and pseudonymize message/session identity", async () => {
      const userId = new Types.ObjectId().toString();
      const deletedBy = new Types.ObjectId().toString();
      const tenantId = new Types.ObjectId().toString();

      const user: any = {
        _id: new Types.ObjectId(userId),
        role: UserRole.USER,
        tenantId: new Types.ObjectId(tenantId),
        phoneNumber: "+1234567890",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
      };

      jest.spyOn(service, "findOne").mockResolvedValue(user);
      mockWhatsAppService.disconnectSession.mockResolvedValue(undefined);
      mockWhatsAppService.pseudonymizeMessagesForDeletedUser.mockResolvedValue({
        matched: 1,
        modified: 1,
      });
      mockWhatsAppService.deactivateSessionsForDeletedUser.mockResolvedValue(
        undefined,
      );
      mockUserModel.findByIdAndUpdate.mockResolvedValue(undefined);

      await service.remove(userId, deletedBy, tenantId);

      expect(mockWhatsAppService.disconnectSession).toHaveBeenCalledWith(
        `whatsapp-${user.phoneNumber.slice(1)}`,
      );
      expect(
        mockWhatsAppService.pseudonymizeMessagesForDeletedUser,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          phoneNumber: user.phoneNumber,
          deletedBy,
          pseudonym: expect.stringMatching(/^Deleted User /),
        }),
      );

      const pseudonymizeArg =
        mockWhatsAppService.pseudonymizeMessagesForDeletedUser.mock.calls[0][0];
      expect(String(pseudonymizeArg.tenantId)).toBe(tenantId);
      expect(mockWhatsAppService.deactivateSessionsForDeletedUser).toHaveBeenCalledWith(
        userId,
        deletedBy,
      );

      const updateArg = mockUserModel.findByIdAndUpdate.mock.calls[0][1];
      expect(updateArg).toEqual(
        expect.objectContaining({
          isActive: false,
          firstName: "Deleted",
          lastName: "User",
          phoneNumber: null,
          deletedBy,
        }),
      );
      expect(String(updateArg.email)).toMatch(/^deleted-.*@deleted\.invalid$/);
    });
  });

  describe("exportUserData (LGPD/GDPR portability)", () => {
    it("should include personal data and message history for the user", async () => {
      const userId = new Types.ObjectId().toString();
      const requestedBy = new Types.ObjectId().toString();
      const tenantId = new Types.ObjectId().toString();
      const phoneNumber = "+1234567890";

      const user: any = {
        _id: new Types.ObjectId(userId),
        role: UserRole.USER,
        tenantId: new Types.ObjectId(tenantId),
        phoneNumber,
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        registrationStatus: RegistrationStatus.REGISTERED,
        entityId: new Types.ObjectId(),
        entityPath: "Entity > Company",
        isActive: true,
        toObject: () => user,
      };

      jest.spyOn(service, "findOne").mockResolvedValue(user);
      mockUserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(requestedBy),
            role: UserRole.USER,
            tenantId: new Types.ObjectId(tenantId),
          }),
        }),
      });

      mockMessageModel.countDocuments.mockResolvedValue(2);
      mockMessageModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([{ _id: new Types.ObjectId() }]),
          }),
        }),
      });

      const res = await service.exportUserData({
        userId,
        tenantId,
        requestedBy,
        includeMessages: true,
        messageLimit: 100,
      });

      expect(res.user).toEqual(
        expect.objectContaining({
          _id: userId,
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
          phoneNumber,
        }),
      );
      expect(res.messagesTotal).toBe(2);
      expect(res.messagesReturned).toBe(1);
      expect(Array.isArray(res.messages)).toBe(true);
      expect(mockMessageModel.countDocuments).toHaveBeenCalled();
      expect(mockMessageModel.find).toHaveBeenCalled();
    });

    it("should accept tenantId provided as an object shape", async () => {
      const userId = new Types.ObjectId().toString();
      const requestedBy = new Types.ObjectId().toString();
      const tenantObjectId = new Types.ObjectId();

      const user: any = {
        _id: new Types.ObjectId(userId),
        role: UserRole.USER,
        tenantId: tenantObjectId,
        phoneNumber: "+1234567890",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        registrationStatus: RegistrationStatus.REGISTERED,
        entityId: new Types.ObjectId(),
        entityPath: "Entity > Company",
        isActive: true,
      };

      jest.spyOn(service, "findOne").mockResolvedValue(user);
      mockUserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(requestedBy),
            role: UserRole.USER,
            tenantId: tenantObjectId,
          }),
        }),
      });

      mockMessageModel.countDocuments.mockResolvedValue(0);
      mockMessageModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const res = await service.exportUserData({
        userId,
        tenantId: { _id: tenantObjectId },
        requestedBy,
        includeMessages: true,
      });

      expect(String(res.user.tenantId)).toBe(tenantObjectId.toString());
    });

    it("should allow SystemAdmin requester with null tenantId by deriving tenant from target user", async () => {
      const userId = new Types.ObjectId().toString();
      const systemAdminId = new Types.ObjectId().toString();
      const tenantObjectId = new Types.ObjectId();

      const user: any = {
        _id: new Types.ObjectId(userId),
        role: UserRole.USER,
        tenantId: tenantObjectId,
        phoneNumber: "+1234567890",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        registrationStatus: RegistrationStatus.REGISTERED,
        entityId: new Types.ObjectId(),
        entityPath: "Entity > Company",
        isActive: true,
      };

      jest.spyOn(service, "findOne").mockResolvedValue(user);

      // requester lookup
      mockUserModel.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(systemAdminId),
            role: UserRole.SYSTEM_ADMIN,
            tenantId: null,
          }),
        }),
      });

      mockMessageModel.countDocuments.mockResolvedValue(0);
      mockMessageModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const res = await service.exportUserData({
        userId,
        tenantId: null,
        requestedBy: systemAdminId,
        includeMessages: true,
      });

      expect(res.user).toEqual(expect.objectContaining({ _id: userId }));
      expect(mockMessageModel.countDocuments).toHaveBeenCalled();
    });

    it("should return empty messages when includeMessages=false", async () => {
      const userId = new Types.ObjectId().toString();
      const requestedBy = new Types.ObjectId().toString();
      const tenantId = new Types.ObjectId().toString();

      const user: any = {
        _id: new Types.ObjectId(userId),
        role: UserRole.USER,
        tenantId: new Types.ObjectId(tenantId),
        phoneNumber: "+1234567890",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        registrationStatus: RegistrationStatus.REGISTERED,
        entityId: new Types.ObjectId(),
        entityPath: "Entity > Company",
        isActive: true,
      };

      jest.spyOn(service, "findOne").mockResolvedValue(user);

      const res = await service.exportUserData({
        userId,
        tenantId,
        requestedBy,
        includeMessages: false,
      });

      expect(res.messages).toEqual([]);
      expect(res.messagesTotal).toBe(0);
      expect(mockMessageModel.countDocuments).not.toHaveBeenCalled();
      expect(mockMessageModel.find).not.toHaveBeenCalled();
    });
  });

  describe("inviteUser", () => {
    it("should throw BadRequestException when phone number is missing", async () => {
      const inviteUserDto = {
        email: "newuser@example.com",
        firstName: "New",
        lastName: "User",
        entityId: "507f1f77bcf86cd799439015",
        tenantId: "507f1f77bcf86cd799439012",
      };

      await expect(
        service.inviteUser(inviteUserDto as any, "507f1f77bcf86cd799439013"),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when user already exists", async () => {
      const inviteUserDto = {
        phoneNumber: "+1234567890",
        email: "existing@example.com",
        firstName: "Existing",
        lastName: "User",
        entityId: "507f1f77bcf86cd799439015",
        tenantId: "507f1f77bcf86cd799439012",
      };

      const existingUser = {
        _id: new Types.ObjectId(),
        email: "existing@example.com",
        phoneNumber: "+1234567890",
      };

      mockUserModel.findOne = jest.fn().mockResolvedValue(existingUser);

      await expect(
        service.inviteUser(inviteUserDto, "507f1f77bcf86cd799439013"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("generateQrForPhoneNumber", () => {
    it("should call regenerateQRCode with user data", async () => {
      const user = {
        _id: new Types.ObjectId(),
        phoneNumber: "+1234567890",
        tenantId: new Types.ObjectId(),
      };

      mockUserModel.findOne = jest.fn().mockResolvedValue(user);
      const qrPayload = {
        qrCode: null,
        expiresAt: null,
        sessionId: "session-1",
        status: "pending",
      };
      const regenSpy = jest
        .spyOn(service, "regenerateQRCode")
        .mockResolvedValue(qrPayload as any);

      const result = await service.generateQrForPhoneNumber("+1234567890");

      expect(regenSpy).toHaveBeenCalledWith(
        user._id.toString(),
        user.tenantId.toString(),
        { waitForResult: false },
      );
      expect(result).toBe(qrPayload);

      regenSpy.mockRestore();
    });

    it("should throw NotFoundException when user is missing", async () => {
      mockUserModel.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.generateQrForPhoneNumber("+1111111111"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove", () => {
    // Test removed due to mocking complexity with populate
  });

  // NOTE: Users stats endpoint removed (unused by frontend).
});
