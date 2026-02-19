import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { UsersService } from "../users/users.service";
import { EntitiesService } from "../entities/entities.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { User, UserRole } from "../../common/schemas/user.schema";
import { Entity } from "../../common/schemas/entity.schema";
import { Message } from "../../common/schemas/message.schema";
import {
  WhatsAppSession,
  SessionStatus,
} from "../../common/schemas/whatsapp-session.schema";
import { isSystemEntity } from "../../common/constants/system-entity";

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Entity.name) private entityModel: Model<Entity>,
    @InjectModel(Message.name) private messageModel: Model<Message>,
    @InjectModel(WhatsAppSession.name)
    private whatsappSessionModel: Model<WhatsAppSession>,
    private usersService: UsersService,
    private entitiesService: EntitiesService,
    private whatsappService: WhatsAppService,
  ) {}

  async getDashboardStats(entityId: string, _entityPath: string) {
    try {
      // Get entity statistics
      const entityStats = await this.getEntityStats(entityId);

      // Get message statistics
      const messageStats = await this.getMessageStats(entityId);

      // Get user statistics
      const userStats = await this.getUserStats(entityId);

      const stats = {
        entities: entityStats,
        messages: messageStats,
        users: userStats,
      };

      return stats;
    } catch (error) {
      this.logger.error("Failed to get dashboard stats:", error);
      throw error;
    }
  }

  private async getEntityStats(entityId: string) {
    // Convert entityId string to ObjectId
    const entityObjectId = new Types.ObjectId(entityId);
    const isSysAdmin = isSystemEntity(entityId);

    // Build query based on whether user is SystemAdmin or not
    const query: any = { isActive: true };

    if (!isSysAdmin) {
      // For non-SystemAdmin, filter by entityIdPath
      query.entityIdPath = entityObjectId;
    }
    // For SystemAdmin, no entityIdPath filter means they see all entities

    const totalEntities = await this.entityModel.countDocuments(query);

    const entities = await this.entityModel.countDocuments({
      ...query,
      type: "entity",
    });

    const companies = await this.entityModel.countDocuments({
      ...query,
      type: "company",
    });

    const departments = await this.entityModel.countDocuments({
      ...query,
      type: "department",
    });

    // Build user query based on entityIdPath
    const userQuery: any = { isActive: true, role: UserRole.USER };

    if (!isSysAdmin) {
      userQuery.entityIdPath = entityObjectId;
    }

    // Count users with phone numbers (E164 users)
    const e164Users = await this.userModel.countDocuments({
      ...userQuery,
      phoneNumber: { $exists: true, $ne: null },
    });

    // Calculate registration rate
    const totalUsers = await this.userModel.countDocuments(userQuery);
    const registeredUsers = await this.userModel.countDocuments({
      ...userQuery,
      registrationStatus: "registered",
    });
    const registrationRate =
      totalUsers > 0 ? Math.round((registeredUsers / totalUsers) * 100) : 0;

    // Calculate change from last week
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const entitiesLastWeek = await this.entityModel.countDocuments({
      ...query,
      createdAt: { $lte: lastWeek },
    });
    const entitiesNow = await this.entityModel.countDocuments({
      ...query,
      createdAt: { $lte: now },
    });
    const change = entitiesNow - entitiesLastWeek;

    return {
      total: totalEntities,
      entities,
      companies,
      departments,
      e164Users,
      registrationRate,
      change: {
        value: Math.abs(change),
        period: "vs last week",
        periodKey: "metrics.vsLastWeek",
        type: change >= 0 ? "increase" : "decrease",
      },
    };
  }

  private async getMessageStats(entityId: string) {
    // Convert entityId string to ObjectId
    const entityObjectId = new Types.ObjectId(entityId);
    const isSysAdmin = isSystemEntity(entityId);

    // Build base query
    const baseQuery: any = { isActive: true };

    if (!isSysAdmin) {
      baseQuery.entityIdPath = entityObjectId;
    }

    const now = new Date();
    const last24hStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last30dStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last365dStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const total = await this.messageModel.countDocuments({
      ...baseQuery,
    });

    // Total messages in last 24 hours (both inbound and outbound)
    const sent24h = await this.messageModel.countDocuments({
      ...baseQuery,
      createdAt: { $gte: last24hStart, $lte: now },
    });

    // Total messages in last 30 days
    const sent30d = await this.messageModel.countDocuments({
      ...baseQuery,
      createdAt: { $gte: last30dStart, $lte: now },
    });

    // Total messages in last 365 days
    const sent365d = await this.messageModel.countDocuments({
      ...baseQuery,
      createdAt: { $gte: last365dStart, $lte: now },
    });

    // Total monitored messages (messages from registered users)
    const outbound = await this.messageModel.countDocuments({
      ...baseQuery,
      isExternalNumber: false,
    });

    // External messages (from users without phone numbers in our system)
    const inbound = await this.messageModel.countDocuments({
      ...baseQuery,
      isExternalNumber: true,
    });

    // Active conversations (unique phone numbers that sent messages in last 24h)
    const activeConversations = await this.messageModel.distinct("from", {
      ...baseQuery,
      createdAt: { $gte: last24hStart, $lte: now },
    });

    // Calculate change from previous day
    const previousDayStart = new Date(
      last24hStart.getTime() - 24 * 60 * 60 * 1000,
    );
    const previousDayEnd = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sentPreviousDay = await this.messageModel.countDocuments({
      ...baseQuery,
      createdAt: { $gte: previousDayStart, $lte: previousDayEnd },
    });
    const change = sent24h - sentPreviousDay;

    return {
      total,
      sent24h,
      sent30d,
      sent365d,
      outbound,
      inbound,
      activeConversations: activeConversations.length,
      change: {
        value: Math.abs(change),
        period: "vs yesterday",
        periodKey: "metrics.vsYesterday",
        type: change >= 0 ? "increase" : "decrease",
      },
    };
  }

  private async getUserStats(entityId: string) {
    // Convert entityId string to ObjectId
    const entityObjectId = new Types.ObjectId(entityId);
    const isSysAdmin = isSystemEntity(entityId);

    // Build base query
    const baseQuery: any = { isActive: true, role: UserRole.USER };

    if (!isSysAdmin) {
      baseQuery.entityIdPath = entityObjectId;
    }

    const totalUsers = await this.userModel.countDocuments(baseQuery);

    const monitoredUsers = await this.userModel.countDocuments({
      ...baseQuery,
      phoneNumber: { $exists: true, $ne: null },
    });

    // Count connected users: users who have WhatsApp sessions with status READY/AUTHENTICATED.
    // IMPORTANT: do NOT filter by WhatsAppSession.isActive here; production data has READY sessions with isActive=false.
    const sessionQuery: any = {
      status: { $in: [SessionStatus.READY, SessionStatus.AUTHENTICATED] },
      userId: { $exists: true, $ne: null },
    };

    if (!isSysAdmin) {
      sessionQuery.entityIdPath = entityObjectId;
    }

    // Get distinct user IDs that have connected WhatsApp sessions
    const connectedUserIds = await this.whatsappSessionModel.distinct(
      "userId",
      sessionQuery,
    );
    const connectedUsers = (connectedUserIds || []).filter(Boolean).length;

    const unconnectedUsers = Math.max(totalUsers - connectedUsers, 0);

    // Calculate change from last week
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const usersLastWeek = await this.userModel.countDocuments({
      ...baseQuery,
      createdAt: { $lte: lastWeek },
    });
    const usersNow = await this.userModel.countDocuments({
      ...baseQuery,
      createdAt: { $lte: now },
    });
    const change = usersNow - usersLastWeek;

    return {
      total: totalUsers,
      monitored: monitoredUsers,
      connected: connectedUsers,
      unconnected: unconnectedUsers,
      change: {
        value: Math.abs(change),
        period: "vs last week",
        periodKey: "metrics.vsLastWeek",
        type: change >= 0 ? "increase" : "decrease",
      },
    };
  }

  async getSystemHealth(entityId: string, _entityPath: string) {
    try {
      // Convert entityId string to ObjectId
      const entityObjectId = new Types.ObjectId(entityId);
      const isSysAdmin = isSystemEntity(entityId);

      // Build base query
      const baseQuery: any = {};

      if (!isSysAdmin) {
        baseQuery.entityIdPath = entityObjectId;
      }

      // Check WhatsApp sessions health
      const totalSessions =
        await this.whatsappSessionModel.countDocuments(baseQuery);
      const activeSessions = await this.whatsappSessionModel.countDocuments({
        ...baseQuery,
      status: { $in: ["ready", "authenticated"] },
      });

      // Check recent message activity
      const lastHour = new Date(Date.now() - 60 * 60 * 1000);
      const recentMessages = await this.messageModel.countDocuments({
        ...baseQuery,
        createdAt: { $gte: lastHour },
      });

      // Check user registration activity
      const recentRegistrations = await this.userModel.countDocuments({
        ...baseQuery,
        registrationStatus: "registered",
        createdAt: { $gte: lastHour },
      });

      return {
        whatsappSessions: {
          total: totalSessions,
          active: activeSessions,
          health:
            totalSessions > 0 ? (activeSessions / totalSessions) * 100 : 0,
        },
        messageActivity: {
          recentMessages,
          status: recentMessages > 0 ? "active" : "idle",
        },
        userActivity: {
          recentRegistrations,
          status: recentRegistrations > 0 ? "active" : "idle",
        },
        overallHealth: "healthy", // This could be more sophisticated
      };
    } catch (error) {
      this.logger.error("Failed to get system health:", error);
      throw error;
    }
  }
}
