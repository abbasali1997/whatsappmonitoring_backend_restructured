import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { DashboardService } from "./dashboard.service";
import { User } from "../../common/schemas/user.schema";
import { Entity } from "../../common/schemas/entity.schema";
import { Message } from "../../common/schemas/message.schema";
import { WhatsAppSession } from "../../common/schemas/whatsapp-session.schema";
import { UsersService } from "../users/users.service";
import { EntitiesService } from "../entities/entities.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { SYSTEM_ENTITY_ID } from "../../common/constants/system-entity";

describe("DashboardService", () => {
  let service: DashboardService;
  let userModel: any;
  let entityModel: any;
  let messageModel: any;
  let whatsappSessionModel: any;

  const mockUserModel = {
    countDocuments: jest.fn(),
    find: jest.fn(),
  };

  const mockEntityModel = {
    countDocuments: jest.fn(),
  };

  const mockMessageModel = {
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
    distinct: jest.fn(),
  };

  const mockWhatsappSessionModel = {
    countDocuments: jest.fn(),
    find: jest.fn(),
    distinct: jest.fn(),
  };

  const mockUsersService = {
    findAll: jest.fn(),
  };

  const mockEntitiesService = {
    findAll: jest.fn(),
  };

  const mockWhatsappService = {
    getActiveSessions: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
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
          useValue: mockWhatsappSessionModel,
        },
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
        {
          provide: EntitiesService,
          useValue: mockEntitiesService,
        },
        {
          provide: WhatsAppService,
          useValue: mockWhatsappService,
        },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    userModel = module.get(getModelToken(User.name));
    entityModel = module.get(getModelToken(Entity.name));
    messageModel = module.get(getModelToken(Message.name));
    whatsappSessionModel = module.get(getModelToken(WhatsAppSession.name));

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("getDashboardStats", () => {
    const entityId = new Types.ObjectId().toString();
    const entityPath = [entityId];

    it("should return dashboard stats for regular user", async () => {
      // Mock entity stats (getEntityStats)
      entityModel.countDocuments
        .mockResolvedValueOnce(10) // totalEntities
        .mockResolvedValueOnce(5) // entities
        .mockResolvedValueOnce(3) // companies
        .mockResolvedValueOnce(2) // departments
        .mockResolvedValueOnce(8) // entitiesLastWeek
        .mockResolvedValueOnce(10); // entitiesNow

      // Mock user stats (getEntityStats - e164Users, totalUsers, registeredUsers)
      userModel.countDocuments
        .mockResolvedValueOnce(8) // e164Users
        .mockResolvedValueOnce(10) // totalUsers
        .mockResolvedValueOnce(7); // registeredUsers

      // Mock message stats (getMessageStats)
      messageModel.countDocuments
        .mockResolvedValueOnce(500) // total
        .mockResolvedValueOnce(100) // sent24h
        .mockResolvedValueOnce(200) // sent30d
        .mockResolvedValueOnce(1000) // sent365d
        .mockResolvedValueOnce(300) // outbound
        .mockResolvedValueOnce(200) // inbound
        .mockResolvedValueOnce(50); // sentPreviousDay

      messageModel.distinct.mockResolvedValueOnce([
        "+1234567890",
        "+0987654321",
      ]);

      // Mock user stats (getUserStats)
      userModel.countDocuments
        .mockResolvedValueOnce(10) // totalUsers
        .mockResolvedValueOnce(8) // monitoredUsers
        .mockResolvedValueOnce(5) // usersLastWeek
        .mockResolvedValueOnce(10); // usersNow

      // Mock WhatsApp session stats (getUserStats)
      whatsappSessionModel.distinct.mockResolvedValueOnce(
        new Array(5).fill(null).map(() => new Types.ObjectId()),
      ); // connected users (distinct userIds)

      const result = await service.getDashboardStats(
        entityId,
        entityPath.join(","),
      );

      expect(result).toHaveProperty("entities");
      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("users");
      expect(result.entities.total).toBe(10);
      expect(result.entities.entities).toBe(5);
      expect(result.entities.companies).toBe(3);
      expect(result.entities.departments).toBe(2);
    });

    it("should return dashboard stats for system admin", async () => {
      const systemEntityId = SYSTEM_ENTITY_ID.toString();

      // Mock entity stats (no entityIdPath filter for system admin)
      entityModel.countDocuments
        .mockResolvedValueOnce(50) // totalEntities
        .mockResolvedValueOnce(25) // entities
        .mockResolvedValueOnce(15) // companies
        .mockResolvedValueOnce(10) // departments
        .mockResolvedValueOnce(40) // entitiesLastWeek
        .mockResolvedValueOnce(50); // entitiesNow

      // Mock user stats (getEntityStats)
      userModel.countDocuments
        .mockResolvedValueOnce(40) // e164Users
        .mockResolvedValueOnce(50) // totalUsers
        .mockResolvedValueOnce(35); // registeredUsers

      // Mock message stats (getMessageStats)
      messageModel.countDocuments
        .mockResolvedValueOnce(5000) // total
        .mockResolvedValueOnce(100) // sent24h
        .mockResolvedValueOnce(2000) // sent30d
        .mockResolvedValueOnce(10000) // sent365d
        .mockResolvedValueOnce(3000) // outbound
        .mockResolvedValueOnce(2000) // inbound
        .mockResolvedValueOnce(400); // sentPreviousDay

      messageModel.distinct.mockResolvedValueOnce([
        "+1111111111",
        "+2222222222",
        "+3333333333",
      ]);

      // Mock user stats (getUserStats)
      userModel.countDocuments
        .mockResolvedValueOnce(50) // totalUsers
        .mockResolvedValueOnce(40) // monitoredUsers
        .mockResolvedValueOnce(45) // usersLastWeek
        .mockResolvedValueOnce(50); // usersNow

      // Mock WhatsApp session stats (getUserStats)
      whatsappSessionModel.distinct.mockResolvedValueOnce(
        new Array(20).fill(null).map(() => new Types.ObjectId()),
      ); // connected users (distinct userIds)

      const result = await service.getDashboardStats(systemEntityId, "");

      expect(result.entities.total).toBe(50);
      expect(result.users.total).toBe(50);
      expect(result.messages.sent24h).toBe(100);
    });

    it("should handle errors gracefully", async () => {
      entityModel.countDocuments.mockRejectedValue(new Error("Database error"));

      await expect(
        service.getDashboardStats(entityId, entityPath.join(",")),
      ).rejects.toThrow("Database error");
    });
  });

  describe("getSystemHealth", () => {
    const entityId = new Types.ObjectId().toString();

    it("should return system health information", async () => {
      whatsappSessionModel.countDocuments
        .mockResolvedValueOnce(10) // totalSessions
        .mockResolvedValueOnce(8); // activeSessions

      messageModel.countDocuments.mockResolvedValueOnce(50); // recentMessages

      userModel.countDocuments.mockResolvedValueOnce(5); // recentRegistrations

      const result = await service.getSystemHealth(entityId, "");

      expect(result).toHaveProperty("whatsappSessions");
      expect(result).toHaveProperty("messageActivity");
      expect(result).toHaveProperty("userActivity");
      expect(result).toHaveProperty("overallHealth");
      expect(result.whatsappSessions.total).toBe(10);
      expect(result.whatsappSessions.active).toBe(8);
      expect(result.messageActivity.recentMessages).toBe(50);
      expect(result.userActivity.recentRegistrations).toBe(5);
    });

    it("should handle empty sessions", async () => {
      whatsappSessionModel.countDocuments
        .mockResolvedValueOnce(0) // totalSessions
        .mockResolvedValueOnce(0); // activeSessions

      messageModel.countDocuments.mockResolvedValueOnce(0); // recentMessages

      userModel.countDocuments.mockResolvedValueOnce(0); // recentRegistrations

      const result = await service.getSystemHealth(entityId, "");

      expect(result.whatsappSessions.total).toBe(0);
      expect(result.whatsappSessions.active).toBe(0);
      expect(result.whatsappSessions.health).toBe(0);
    });
  });

  describe("internal stats methods", () => {
    it("should compute entity stats" , async () => {
      const entityId = new Types.ObjectId().toString();
      mockEntityModel.countDocuments
        .mockResolvedValueOnce(2) // totalEntities
        .mockResolvedValueOnce(1) // entities
        .mockResolvedValueOnce(1) // companies
        .mockResolvedValueOnce(0) // departments
        .mockResolvedValueOnce(0) // entitiesLastWeek
        .mockResolvedValueOnce(2); // entitiesNow

      mockUserModel.countDocuments
        .mockResolvedValueOnce(1) // e164Users
        .mockResolvedValueOnce(2) // totalUsers
        .mockResolvedValueOnce(1); // registeredUsers

      const result = await (service as any).getEntityStats(entityId);
      expect(result.total).toBe(2);
      expect(result.change.type).toBe("increase");
    });

    it("should compute message stats", async () => {
      const entityId = new Types.ObjectId().toString();
      mockMessageModel.countDocuments
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(5) // sent24h
        .mockResolvedValueOnce(8) // sent30d
        .mockResolvedValueOnce(30) // sent365d
        .mockResolvedValueOnce(6) // outbound
        .mockResolvedValueOnce(4) // inbound
        .mockResolvedValueOnce(1); // sentPreviousDay

      mockMessageModel.distinct.mockResolvedValueOnce(["+1234"]);

      const res = await (service as any).getMessageStats(entityId);
      expect(res.total).toBe(10);
      expect(res.activeConversations).toBe(1);
      expect(res.change.type).toBe("increase");
    });

    it("should compute user stats", async () => {
      const entityId = new Types.ObjectId().toString();
      mockUserModel.countDocuments
        .mockResolvedValueOnce(5) // totalUsers
        .mockResolvedValueOnce(3) // monitoredUsers
        .mockResolvedValueOnce(2) // usersLastWeek
        .mockResolvedValueOnce(5); // usersNow

      mockWhatsappSessionModel.distinct.mockResolvedValueOnce(
        new Array(3).fill(null).map(() => new Types.ObjectId()),
      ); // connected users (distinct userIds)
      const res = await (service as any).getUserStats(entityId);
      expect(res.total).toBe(5);
      expect(res.connected).toBe(3);
      expect(res.change.type).toBe("increase");
    });
  });
});
