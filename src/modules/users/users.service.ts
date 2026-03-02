import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  User,
  RegistrationStatus,
  UserRole,
  WhatsAppConnectionStatus,
} from "@/common/schemas/user.schema";
import {
  SessionStatus,
  WhatsAppSession,
} from "@/common/schemas/whatsapp-session.schema";
import { Entity } from "@/common/schemas/entity.schema";
import { Message } from "@/common/schemas/message.schema";
import { AuthService } from "../auth/auth.service";
import { EmailService } from "../email/email.service";
import { EmailQueueService } from "../email/email-queue.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { WhatsAppHealthService } from "../whatsapp-health/whatsapp-health.service";
import { MessagingService } from "@/common/messaging/messaging.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { InviteUserDto } from "./dto/invite-user.dto";
import {
  CreateSystemAdminDto,
  UpdateSystemAdminPasswordDto,
} from "./dto/create-user.dto";
import {
  SYSTEM_ENTITY_ID,
  SYSTEM_ENTITY_NAME,
  isSystemAdmin,
} from "../../common/constants/system-entity";
import { BulkInviteUserDto } from "./dto/bulk-invite-user.dto";
import { parsePhoneNumber, isValidPhoneNumber } from "libphonenumber-js";
import { randomUUID, randomBytes } from "crypto";
import { isEmpty } from "class-validator";
import { MESSAGES } from "../../common/constants/messages";
import { isPasswordStrong } from "../../common/security/password.utils";
import {
  BulkUploadGateway,
  BulkUploadProgressPayload,
  BulkUploadStatus,
} from "./bulk-upload.gateway";

const getFrontendUrl = (): string => {
  const raw = process.env.FRONTEND_URL?.trim();
  if (!raw) {
    return "https://system.2n5global.com";
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
};

const getCompanyName = (): string =>
  process.env.COMPANY_NAME?.trim() || "2N5 Global";

const getCompanyAddress = (): string =>
  process.env.COMPANY_ADDRESS?.trim() || "123 Business Street, Tech City";

const getSupportEmail = (): string =>
  process.env.SUPPORT_EMAIL?.trim() || "support@2n5global.com";

const getLogoUrl = (): string =>
  process.env.LOGO_URL?.trim() || "https://system.2n5global.com/favicon.svg";

const getPublicQrLink = (phoneNumber: string): string => {
  const frontendUrl = getFrontendUrl();
  return `${frontendUrl}/public/whatsapp/qr/${encodeURIComponent(phoneNumber)}`;
};

const sanitizeOptionalLink = (value?: string): string | undefined =>
  value?.trim() ? value.trim() : undefined;

type QRGenerationResponse = {
  qrCode: string | null;
  expiresAt: Date | null;
  sessionId: string;
  status?: "pending" | "ready" | "failed";
};

type BulkUploadJobState = {
  jobId: string;
  status: BulkUploadStatus;
  total: number;
  processed: number;
  success: number;
  failed: number;
  errors: any[];
  details: any[];
  startedAt: Date;
  finishedAt?: Date;
  message?: string;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private bulkUploadJobs: Map<string, BulkUploadJobState> = new Map();

  constructor(
    @InjectModel(User.name)
    private userModel: Model<User>,
    @InjectModel(Entity.name)
    private entityModel: Model<Entity>,
    @InjectModel(Message.name)
    private messageModel: Model<Message>,
    @InjectModel(WhatsAppSession.name)
    private whatsappSessionModel: Model<WhatsAppSession>,
    private authService: AuthService,
    private emailService: EmailService,
    private emailQueueService: EmailQueueService,
    private messagingService: MessagingService,
    @Inject(forwardRef(() => WhatsAppService))
    private whatsappService: WhatsAppService,
    private whatsappHealthService: WhatsAppHealthService,
    private bulkUploadGateway: BulkUploadGateway,
  ) {}

  private async queueUserInvitationEmail(params: {
    email?: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    tenantId?: Types.ObjectId;
    userId: Types.ObjectId;
    language?: string;
  }): Promise<void> {
    if (!params.email) {
      return;
    }

    try {
      const qrLink = getPublicQrLink(params.phoneNumber);

      await this.emailQueueService.queueInvitationEmail(
        params.email,
        "user-invitation",
        {
          firstName: params.firstName,
          lastName: params.lastName,
          subject: "Welcome to 2N5 - WhatsApp Connection",
          companyName: getCompanyName(),
          supportEmail: getSupportEmail(),
          loginUrl: `${getFrontendUrl()}/login`,
          qrCodeLink: qrLink,
          language: params.language || "en",
        },
        {
          correlationId: `user-invitation-${params.userId.toString()}`,
          userId: params.userId.toString(),
          tenantId: params.tenantId?.toString(),
        },
      );

      this.logger.log(`User invitation email queued for ${params.email}`);
    } catch (error) {
      this.logger.error(
        `Failed to queue user invitation email for ${params.email}: ${error.message}`,
        error,
      );
    }
  }

  async findAll(
    tenantId: string,
    filters?: any,
  ): Promise<{
    users: User[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const query: any = { isActive: true };

    // Only filter by tenantId if provided (SystemAdmin has no tenantId)
    if (tenantId && tenantId !== "") {
      query.tenantId = new Types.ObjectId(tenantId);
    }

    if (filters?.registrationStatus) {
      query.registrationStatus = filters.registrationStatus;
    }

    if (filters?.role) {
      query.role = filters.role;
    }

    if (filters?.entityId) {
      if (filters?.entityId !== SYSTEM_ENTITY_ID.toString())
        query.entityIdPath = new Types.ObjectId(filters.entityId);
    }

    if (filters?.whatsappConnectionStatus) {
      query.whatsappConnectionStatus = filters.whatsappConnectionStatus;
    }

    // Lifecycle WhatsApp status per client definition:
    // - new: created, no QR ever requested/sent, never connected
    // - requested: QR requested/sent, not yet connected
    // - connected: currently connected
    // - disconnected: was connected in the past, currently not connected
    if (filters?.whatsappStatus) {
      const desired = String(filters.whatsappStatus).toLowerCase();
      if (desired === "connected") {
        query.whatsappConnectionStatus = WhatsAppConnectionStatus.CONNECTED;
      } else if (desired === "disconnected") {
        query.whatsappConnectedAt = { $ne: null };
        query.whatsappConnectionStatus = {
          $ne: WhatsAppConnectionStatus.CONNECTED,
        };
      } else if (desired === "requested") {
        query.whatsappConnectedAt = null;
        query.$and = (query.$and || []).concat([
          {
            $or: [
              { "qrInvitationHistory.0": { $exists: true } },
              { whatsappConnectionStatus: WhatsAppConnectionStatus.CONNECTING },
              { whatsappConnectionStatus: WhatsAppConnectionStatus.FAILED },
            ],
          },
        ]);
      } else if (desired === "new") {
        query.whatsappConnectedAt = null;
        query.$and = (query.$and || []).concat([
          { "qrInvitationHistory.0": { $exists: false } },
          // Default state in DB is often DISCONNECTED; treat that as "new" only when no QR history exists.
          {
            $or: [
              {
                whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
              },
              { whatsappConnectionStatus: { $exists: false } },
              { whatsappConnectionStatus: null },
            ],
          },
        ]);
      }
    }

    // Optional: filter by WhatsApp session status (e.g. "qr_required")
    // This matches what the UI shows in the Users list.
    if (filters?.whatsappSessionStatus) {
      const sessionQuery: any = { isActive: true };
      if (tenantId && tenantId !== "") {
        sessionQuery.tenantId = new Types.ObjectId(tenantId);
      }

      if (
        String(filters.whatsappSessionStatus).toLowerCase() === "qr_required"
      ) {
        // Match true QR_REQUIRED sessions, plus FAILED sessions that still have a QR code
        // (the UI normalizes those as qr_required).
        sessionQuery.$or = [
          { status: SessionStatus.QR_REQUIRED },
          {
            status: SessionStatus.FAILED,
            $or: [
              { qrCode: { $exists: true, $nin: [null, ""] } },
              { qrCodeGeneratedAt: { $exists: true, $ne: null } },
            ],
          },
        ];
      } else {
        sessionQuery.status = String(
          filters.whatsappSessionStatus,
        ).toLowerCase();
      }

      const userIds = (await this.whatsappSessionModel.distinct(
        "userId",
        sessionQuery,
      )) as Types.ObjectId[];

      const filteredUserIds = (userIds || []).filter(Boolean);
      // If no sessions match, short-circuit to empty result set.
      if (filteredUserIds.length === 0) {
        const page = parseInt(filters?.page) || 1;
        const limit = parseInt(filters?.limit) || 10;
        return { users: [], total: 0, page, limit, totalPages: 0 };
      }

      query._id = { $in: filteredUserIds };
    }

    if (filters?.search) {
      query.$or = [
        { firstName: { $regex: filters.search, $options: "i" } },
        { lastName: { $regex: filters.search, $options: "i" } },
        { email: { $regex: filters.search, $options: "i" } },
        { phoneNumber: { $regex: filters.search, $options: "i" } },
      ];
    }

    // Pagination
    const page = parseInt(filters?.page) || 1;
    const limit = parseInt(filters?.limit) || 10;
    const skip = (page - 1) * limit;

    // Get total count for pagination
    const total = await this.userModel.countDocuments(query);
    const totalPages = Math.ceil(total / limit);

    // Get paginated users
    const users = await this.userModel
      .find(query)
      .populate("entityId", "name path type")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Attach WhatsApp session info in bulk (so UI can show accurate status without extra calls)
    // Safety: never let session lookup failures crash the Users list endpoint.
    const userIds = users.map((u) => u._id).filter(Boolean) as any[];
    const userPhoneDigits = new Map<string, string>(); // userId -> digits
    const desiredSessionIds: string[] = [];
    for (const u of users as any[]) {
      const id = u?._id?.toString?.() || String(u?._id || "");
      const phone = String(u?.phoneNumber || "");
      const digits = phone.replace(/[^0-9]/g, "");
      if (!id || !digits) continue;
      userPhoneDigits.set(id, digits);
      desiredSessionIds.push(`whatsapp-${digits}`);
    }

    let sessions: any[] = [];
    try {
      // IMPORTANT: do NOT filter by WhatsAppSession.isActive here; production data has READY sessions with isActive=false.
      const sessionQuery: any = {};
      if (tenantId && tenantId !== "") {
        sessionQuery.tenantId = new Types.ObjectId(tenantId);
      }
      const or: any[] = [];
      if (userIds.length) or.push({ userId: { $in: userIds } });
      if (desiredSessionIds.length)
        or.push({ sessionId: { $in: desiredSessionIds } });
      const desiredDigits = Array.from(
        new Set(desiredSessionIds.map((sid) => sid.replace(/^whatsapp-/, ""))),
      ).filter(Boolean);
      if (desiredDigits.length) {
        or.push({ phoneNumber: { $in: desiredDigits } });
        or.push({ phoneNumber: { $in: desiredDigits.map((d) => `+${d}`) } });
      }

      sessions =
        or.length === 0
          ? []
          : await this.whatsappSessionModel
              .find({
                ...(Object.keys(sessionQuery).length ? sessionQuery : {}),
                $or: or,
              })
              // IMPORTANT: don't include qrCode blobs in list responses (payload/memory risk)
              .select(
                "userId sessionId phoneNumber status qrCodeGeneratedAt qrCodeExpiresAt connectedAt disconnectedAt lastActivityAt whatsappName messagesSent messagesReceived messagesDelivered messagesFailed lastHealthStatus lastHealthCheckAt nextHealthCheckAt consecutiveHealthFailures lastHealthError updatedAt",
              )
              .lean();
    } catch (err) {
      this.logger.warn(
        `Failed to bulk-load WhatsApp sessions for users list (continuing without session data): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      sessions = [];
    }

    const pickNewest = (existing: any | undefined, next: any) => {
      if (!existing) return next;
      const existingUpdated = new Date(
        (existing as any)?.updatedAt || 0,
      ).getTime();
      const nextUpdated = new Date((next as any)?.updatedAt || 0).getTime();
      return nextUpdated >= existingUpdated ? next : existing;
    };

    const sessionByUserId = new Map<string, any>();
    const sessionBySessionId = new Map<string, any>();
    const sessionByPhoneDigits = new Map<string, any>();

    for (const s of sessions) {
      const sid = String((s as any)?.sessionId || "").trim();
      if (sid)
        sessionBySessionId.set(sid, pickNewest(sessionBySessionId.get(sid), s));

      const uid =
        (s as any)?.userId?.toString?.() || String((s as any)?.userId || "");
      if (uid)
        sessionByUserId.set(uid, pickNewest(sessionByUserId.get(uid), s));

      const phone = String((s as any)?.phoneNumber || "");
      const digits = phone.replace(/[^0-9]/g, "");
      if (digits)
        sessionByPhoneDigits.set(
          digits,
          pickNewest(sessionByPhoneDigits.get(digits), s),
        );
    }

    const computeWhatsAppStatus = (userObj: any, session: any | undefined) => {
      const connectedAt =
        userObj?.whatsappConnectedAt || session?.connectedAt || null;
      const currentConn = String(
        userObj?.whatsappConnectionStatus || "",
      ).toLowerCase();
      const currentSession = String(session?.status || "").toLowerCase();

      const isCurrentlyConnected =
        currentConn === WhatsAppConnectionStatus.CONNECTED ||
        currentSession === SessionStatus.READY ||
        currentSession === SessionStatus.AUTHENTICATED;

      if (isCurrentlyConnected) return "connected";

      // Ever connected at least once, but not currently connected.
      if (connectedAt) return "disconnected";

      // QR requested/sent at least once (or in-flight connection).
      const hasQrHistory =
        Array.isArray(userObj?.qrInvitationHistory) &&
        userObj.qrInvitationHistory.length > 0;
      const isInFlight =
        currentConn === WhatsAppConnectionStatus.CONNECTING ||
        currentConn === WhatsAppConnectionStatus.FAILED ||
        currentSession === SessionStatus.CONNECTING ||
        currentSession === SessionStatus.QR_REQUIRED ||
        currentSession === SessionStatus.FAILED ||
        currentSession === SessionStatus.DISCONNECTED;

      if (hasQrHistory || (session && isInFlight)) return "requested";

      return "new";
    };

    const usersWithWhatsApp = users.map((user) => {
      const userObj: any = user.toObject();
      const sid = userObj?._id?.toString?.() || String(userObj?._id || "");
      let session = sid ? sessionByUserId.get(sid) : undefined;
      if (!session && sid) {
        const digits = userPhoneDigits.get(sid);
        if (digits) {
          session =
            sessionBySessionId.get(`whatsapp-${digits}`) ||
            sessionByPhoneDigits.get(digits);
        }
      }

      const whatsappSession = session
        ? {
            sessionId: session.sessionId,
            status: session.status,
            qrCodeGeneratedAt: session.qrCodeGeneratedAt,
            qrCodeExpiresAt: session.qrCodeExpiresAt,
            connectedAt: session.connectedAt,
            disconnectedAt: session.disconnectedAt,
            lastActivityAt: session.lastActivityAt,
            whatsappName: session.whatsappName,
            messagesSent: session.messagesSent || 0,
            messagesReceived: session.messagesReceived || 0,
            messagesDelivered: session.messagesDelivered || 0,
            messagesFailed: session.messagesFailed || 0,
            healthStatus: {
              lastCheck: session.lastHealthCheckAt,
              nextCheck: session.nextHealthCheckAt,
              lastStatus: session.lastHealthStatus,
              consecutiveFailures: session.consecutiveHealthFailures || 0,
              successRate: 100,
              recentChecks: 1,
              alertTriggered: session.alertTriggered || false,
            },
          }
        : undefined;

      return {
        ...userObj,
        whatsappSession,
        whatsappStatus: computeWhatsAppStatus(userObj, session),
      };
    });

    return {
      users: usersWithWhatsApp,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async exportUsers(
    tenantId: string,
    filters?: {
      entityId?: string;
      registrationStatus?: RegistrationStatus;
      role?: UserRole | string;
    },
  ): Promise<
    Array<{
      tenantId: string;
      entityPath: string;
      userId: string;
      status: RegistrationStatus;
    }>
  > {
    const query: Record<string, unknown> = { isActive: true };

    if (tenantId && tenantId !== "") {
      if (!Types.ObjectId.isValid(tenantId)) {
        throw new BadRequestException(MESSAGES.USER.INVALID_ID_FORMAT);
      }
      query.tenantId = new Types.ObjectId(tenantId);
    }

    if (filters?.entityId && filters.entityId !== SYSTEM_ENTITY_ID.toString()) {
      if (!Types.ObjectId.isValid(filters.entityId)) {
        throw new BadRequestException(MESSAGES.USER.INVALID_ID_FORMAT);
      }
      query.entityIdPath = new Types.ObjectId(filters.entityId);
    }

    if (filters?.registrationStatus) {
      query.registrationStatus = filters.registrationStatus;
    }

    if (filters?.role) {
      query.role = filters.role;
    }

    const exportRows = await this.userModel
      .find(query, {
        tenantId: 1,
        entityPath: 1,
        registrationStatus: 1,
      })
      .sort({ createdAt: -1 })
      .lean();

    return exportRows.map((user) => ({
      tenantId: user.tenantId ? user.tenantId.toString() : "",
      entityPath: user.entityPath || "",
      userId: user._id.toString(),
      status: user.registrationStatus,
    }));
  }

  async findOne(id: string, tenantId: string): Promise<User> {
    // Validate id is provided
    if (!id) {
      throw new BadRequestException(MESSAGES.USER.ID_REQUIRED);
    }

    // Trim whitespace and convert to string
    const trimmedId = String(id).trim();

    // Validate id is a valid ObjectId format
    if (!Types.ObjectId.isValid(trimmedId)) {
      this.logger.error(
        `Invalid user ID format: "${trimmedId}" (original: "${id}", type: ${typeof id}, length: ${trimmedId.length})`,
      );
      throw new BadRequestException(MESSAGES.USER.INVALID_ID_FORMAT);
    }

    try {
      const query: any = {
        _id: new Types.ObjectId(trimmedId),
        isActive: true,
      };

      // Only filter by tenantId if provided and valid (SystemAdmin has no tenantId)
      const trimmedTenantId = tenantId ? String(tenantId).trim() : "";
      if (
        trimmedTenantId &&
        trimmedTenantId !== "" &&
        Types.ObjectId.isValid(trimmedTenantId)
      ) {
        query.tenantId = new Types.ObjectId(trimmedTenantId);
      }

      let user = await this.userModel
        .findOne(query)
        .populate("entity", "name path type");

      // If user not found and we filtered by tenantId, try without tenantId filter
      // This handles SystemAdmin users who might not have a tenantId
      if (!user && trimmedTenantId && trimmedTenantId !== "") {
        const fallbackQuery: any = {
          _id: new Types.ObjectId(trimmedId),
          isActive: true,
        };
        this.logger.debug(
          `User not found with tenantId filter, trying without tenantId: ${trimmedTenantId}`,
        );
        user = await this.userModel
          .findOne(fallbackQuery)
          .populate("entity", "name path type");
      }

      if (!user) {
        this.logger.error(
          `User not found with ID: ${trimmedId}, tenantId: ${trimmedTenantId || "none"}`,
        );
        throw new NotFoundException(MESSAGES.USER.NOT_FOUND);
      }

      return user;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Error finding user with ID ${trimmedId}:`, error);
      throw new BadRequestException(MESSAGES.USER.UPDATE_FAILED);
    }
  }

  async findByPhoneNumber(
    phoneNumber: string,
    tenantId: string,
  ): Promise<User> {
    const query: any = {
      phoneNumber,
      isActive: true,
    };

    // Only filter by tenantId if provided (SystemAdmin has no tenantId)
    if (tenantId && tenantId !== "") {
      query.tenantId = new Types.ObjectId(tenantId);
    }

    const user = await this.userModel.findOne(query);

    if (!user) {
      throw new NotFoundException(MESSAGES.USER.NOT_FOUND);
    }

    return user;
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    updatedBy: string,
    tenantId: string,
  ): Promise<User> {
    // Validate id is provided
    if (!id) {
      throw new BadRequestException(MESSAGES.USER.ID_REQUIRED);
    }

    // Trim whitespace and convert to string
    const trimmedId = String(id).trim();

    // Validate id is a valid ObjectId format
    if (!Types.ObjectId.isValid(trimmedId)) {
      this.logger.error(
        `Invalid user ID format in update: "${trimmedId}" (original: "${id}", type: ${typeof id})`,
      );
      throw new BadRequestException(MESSAGES.USER.INVALID_ID_FORMAT);
    }

    // Trim tenantId if provided
    const trimmedTenantId = tenantId ? String(tenantId).trim() : "";

    const user = await this.findOne(trimmedId, trimmedTenantId);

    const targetRole = (updateUserDto as any)?.role ?? user.role;

    const updateData: any = {
      ...updateUserDto,
      updatedBy,
    };

    // If language is being updated, persist to preferences
    if (updateUserDto.language) {
      updateData.preferences = {
        ...(user.preferences || {}),
        language: updateUserDto.language,
      };
      delete updateData.language;
    }

    // If phone number is being updated, validate E164 format
    if (updateUserDto.phoneNumber) {
      if (!isValidPhoneNumber(updateUserDto.phoneNumber)) {
        throw new BadRequestException(MESSAGES.USER.INVALID_PHONE_FORMAT);
      }
      const parsedPhone = parsePhoneNumber(updateUserDto.phoneNumber);
      updateData.phoneNumber = parsedPhone.format("E.164");
    }

    // If email is being updated, check if it's different
    if (updateUserDto.email && updateUserDto.email !== user.email) {
      // Normalize email to lowercase for comparison
      const normalizedNewEmail = updateUserDto.email.toLowerCase().trim();

      // Check if new email already exists
      const existingUser = await this.userModel.findOne({
        _id: { $ne: new Types.ObjectId(trimmedId) },
        isActive: true,
        email: normalizedNewEmail,
        role: targetRole,
      });

      if (existingUser) {
        throw new BadRequestException(MESSAGES.USER.EMAIL_ALREADY_EXISTS);
      }

      // Directly update the email (no verification required)
      updateData.email = normalizedNewEmail;
    }

    // If role is being updated (and email isn't changing), ensure (email, role) is still unique among active users
    if (
      (updateUserDto as any)?.role &&
      (updateUserDto as any)?.role !== user.role
    ) {
      const normalizedCurrentEmail = String(user.email || "")
        .toLowerCase()
        .trim();
      const existingForRole = await this.userModel.findOne({
        _id: { $ne: new Types.ObjectId(trimmedId) },
        isActive: true,
        email: normalizedCurrentEmail,
        role: targetRole,
      });

      if (existingForRole) {
        throw new BadRequestException(MESSAGES.USER.EMAIL_ALREADY_EXISTS);
      }
    }

    // If entity is being updated, validate and update path
    if (updateUserDto.entityId) {
      const entity = await this.entityModel.findOne({
        _id: new Types.ObjectId(updateUserDto.entityId),
        isActive: true,
      });

      if (!entity) {
        throw new NotFoundException(MESSAGES.ENTITY.NOT_FOUND);
      }

      // Move user to the new entity (not just the display path)
      updateData.entityId = entity._id;
      updateData.entityIdPath = Array.isArray((entity as any).entityIdPath)
        ? (entity as any).entityIdPath
        : [entity._id];
      updateData.entityPath = entity.path;
      updateData.tenantId = entity.tenantId;
    }

    // If password is being updated, hash it
    if (updateUserDto.password) {
      updateData.password = await this.authService.hashPassword(
        updateUserDto.password,
      );
    }

    const updatedUser = await this.userModel.findByIdAndUpdate(
      new Types.ObjectId(trimmedId),
      updateData,
      { new: true },
    );

    if (!updatedUser) {
      throw new NotFoundException(MESSAGES.USER.UPDATE_FAILED);
    }

    return updatedUser;
  }

  async inviteUser(
    inviteUserDto: InviteUserDto,
    invitedBy: string,
  ): Promise<User> {
    const {
      phoneNumber,
      email,
      firstName,
      lastName,
      entityId,
      role,
      language,
    } = inviteUserDto;

    const normalizedEmail = String(email || "")
      .toLowerCase()
      .trim();
    const desiredRole = role || UserRole.USER;

    // Phone number is required for regular users
    if (!phoneNumber) {
      throw new BadRequestException(MESSAGES.USER.PHONE_NUMBER_REQUIRED);
    }

    // Validate E164 phone number
    if (!isValidPhoneNumber(phoneNumber)) {
      throw new BadRequestException(MESSAGES.USER.INVALID_PHONE_FORMAT);
    }
    const parsedPhone = parsePhoneNumber(phoneNumber);
    const e164Phone = parsedPhone.format("E.164");

    // Check if user already exists
    const existingUser = await this.userModel.findOne({
      isActive: true,
      $or: [
        { phoneNumber: e164Phone },
        { email: normalizedEmail, role: desiredRole },
      ],
    });

    if (existingUser) {
      throw new BadRequestException(
        existingUser.phoneNumber === e164Phone
          ? MESSAGES.USER.PHONE_ALREADY_EXISTS
          : MESSAGES.USER.EMAIL_ALREADY_EXISTS,
      );
    }

    // Validate entity exists
    const entity = await this.entityModel.findOne({
      _id: new Types.ObjectId(entityId),
      isActive: true,
    });

    if (!entity) {
      throw new NotFoundException(MESSAGES.ENTITY.NOT_FOUND);
    }

    // Generate password hash for user
    const randomPassword = randomUUID();
    const hashedPassword = await this.authService.hashPassword(randomPassword);

    const newUserId: Types.ObjectId = new Types.ObjectId();

    // Build user data
    const userData: any = {
      _id: newUserId,
      email: normalizedEmail,
      firstName,
      lastName,
      password: hashedPassword,
      phoneNumber: e164Phone,
      entityId: new Types.ObjectId(entityId),
      entityIdPath: entity.entityIdPath,
      entityPath: entity.path,
      tenantId: entity.tenantId,
      role: desiredRole,
      registrationStatus: RegistrationStatus.REGISTERED,
      createdBy: invitedBy,
      preferences: {
        language: language || "en",
      },
    };

    const user = new this.userModel(userData);
    const savedUser = await user.save();

    await this.queueUserInvitationEmail({
      email,
      firstName,
      lastName,
      phoneNumber: e164Phone,
      tenantId: entity.tenantId,
      userId: savedUser._id as Types.ObjectId,
      language: language || "en",
    });

    return savedUser;
  }

  async inviteManager(
    inviteUserDto: InviteUserDto,
    invitedBy: string,
  ): Promise<User> {
    const { email, firstName, lastName, entityId, role, language } =
      inviteUserDto;

    const normalizedEmail = String(email || "")
      .toLowerCase()
      .trim();
    const desiredRole = role || UserRole.TENANT_ADMIN;

    // Check if user already exists
    const existingUser = await this.userModel.findOne({
      email: normalizedEmail,
      role: desiredRole,
      isActive: true,
    });

    if (existingUser) {
      throw new BadRequestException(MESSAGES.USER.EMAIL_ALREADY_EXISTS);
    }

    // Validate entity exists
    const entity = await this.entityModel.findOne({
      _id: new Types.ObjectId(entityId),
      isActive: true,
    });

    if (!entity) {
      throw new NotFoundException(MESSAGES.ENTITY.NOT_FOUND);
    }

    // Generate password hash for manager
    const randomPassword = randomUUID();
    const hashedPassword = await this.authService.hashPassword(randomPassword);

    const newUserId: Types.ObjectId = new Types.ObjectId();

    // Build manager data (no phone number)
    const userData: any = {
      _id: newUserId,
      email: normalizedEmail,
      firstName,
      lastName,
      password: hashedPassword,
      entityId: new Types.ObjectId(entityId),
      entityIdPath: entity.entityIdPath,
      entityPath: entity.path,
      tenantId: entity.tenantId,
      role: desiredRole,
      registrationStatus: RegistrationStatus.REGISTERED,
      createdBy: invitedBy,
      preferences: {
        language: language || "en",
      },
    };

    const user = new this.userModel(userData);
    const savedUser = await user.save();

    // Queue manager invitation email
    try {
      this.logger.debug(
        `Queueing manager invitation email: to=${email}, userId=${savedUser._id.toString()}, entityId=${entityId}`,
      );
      await this.emailQueueService.queueInvitationEmail(
        email,
        "manager-invitation",
        {
          firstName,
          lastName,
          role: "Manager",
          tempPassword: randomPassword,
          entity: {
            name: entity.name,
          },
          loginUrl: `${getFrontendUrl()}/login`,
          supportEmail: getSupportEmail(),
          companyName: getCompanyName(),
          companyAddress: getCompanyAddress(),
          socialLinks: {
            website:
              sanitizeOptionalLink(process.env.COMPANY_WEBSITE) ||
              "https://2n5global.com",
            linkedin: sanitizeOptionalLink(process.env.COMPANY_LINKEDIN),
            twitter: sanitizeOptionalLink(process.env.COMPANY_TWITTER),
          },
          language: language || "en",
        },
        {
          correlationId: `manager-invitation-${savedUser._id}`,
          userId: savedUser._id.toString(),
          tenantId: entity.tenantId.toString(),
        },
      );
      this.logger.log(`Manager invitation email queued for ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send manager invitation email: ${error.message}`,
        error,
      );
      // Don't fail user creation if email sending fails
    }

    return savedUser;
  }

  private serializeBulkJob(
    state: BulkUploadJobState,
  ): BulkUploadProgressPayload {
    return {
      ...state,
      startedAt: state.startedAt?.toISOString(),
      finishedAt: state.finishedAt?.toISOString(),
    };
  }

  private recordBulkUploadProgress(
    jobId: string,
    update: Partial<BulkUploadJobState>,
  ): BulkUploadProgressPayload {
    const existing =
      this.bulkUploadJobs.get(jobId) ||
      ({
        jobId,
        status: "queued",
        total: 0,
        processed: 0,
        success: 0,
        failed: 0,
        errors: [],
        details: [],
        startedAt: new Date(),
      } as BulkUploadJobState);

    const next: BulkUploadJobState = {
      ...existing,
      ...update,
      errors: update.errors ?? existing.errors,
      details: update.details ?? existing.details,
      processed:
        update.processed ??
        (update.success ?? existing.success) +
          (update.failed ?? existing.failed),
      total: update.total ?? existing.total,
    };

    this.bulkUploadJobs.set(jobId, next);
    const serialized = this.serializeBulkJob(next);
    this.bulkUploadGateway.emitProgress(jobId, serialized);
    return serialized;
  }

  getBulkUploadJob(jobId: string): BulkUploadProgressPayload {
    const job = this.bulkUploadJobs.get(jobId);
    if (!job) {
      throw new NotFoundException("Bulk upload job not found");
    }
    return this.serializeBulkJob(job);
  }

  async startBulkUploadUsersJob(
    bulkUploadDto: any,
    invitedBy: string,
  ): Promise<{ jobId: string }> {
    const jobId = randomUUID();
    const total = Array.isArray(bulkUploadDto?.users)
      ? bulkUploadDto.users.length
      : 0;

    this.recordBulkUploadProgress(jobId, {
      jobId,
      status: "queued",
      total,
      processed: 0,
      success: 0,
      failed: 0,
      errors: [],
      details: [],
      startedAt: new Date(),
    });

    setImmediate(async () => {
      try {
        this.recordBulkUploadProgress(jobId, {
          status: "running",
          startedAt: new Date(),
        });

        const result = await this.bulkUploadUsers(bulkUploadDto, invitedBy, {
          jobId,
          onProgress: (progress) =>
            this.recordBulkUploadProgress(jobId, {
              ...progress,
              errors: progress.errors ?? undefined,
              details: progress.details ?? undefined,
            }),
        });

        this.recordBulkUploadProgress(jobId, {
          status: "completed",
          success: result.success,
          failed: result.failed,
          processed: result.success + result.failed,
          errors: result.errors,
          details: result.details,
          finishedAt: new Date(),
        });
      } catch (error: any) {
        this.recordBulkUploadProgress(jobId, {
          status: "failed",
          message: error?.message || "Bulk upload failed",
          finishedAt: new Date(),
        });
        this.bulkUploadGateway.emitError(
          jobId,
          error?.message || "Bulk upload failed",
        );
      } finally {
        setTimeout(() => this.bulkUploadJobs.delete(jobId), 1000 * 60 * 30);
      }
    });

    return { jobId };
  }

  async startBulkUploadManagersJob(
    bulkUploadDto: any,
    invitedBy: string,
  ): Promise<{ jobId: string }> {
    const jobId = randomUUID();
    const total = Array.isArray(bulkUploadDto?.managers)
      ? bulkUploadDto.managers.length
      : 0;

    this.recordBulkUploadProgress(jobId, {
      jobId,
      status: "queued",
      total,
      processed: 0,
      success: 0,
      failed: 0,
      errors: [],
      details: [],
      startedAt: new Date(),
    });

    setImmediate(async () => {
      try {
        this.recordBulkUploadProgress(jobId, {
          status: "running",
          startedAt: new Date(),
        });

        const result = await this.bulkUploadManagers(bulkUploadDto, invitedBy, {
          jobId,
          onProgress: (progress) =>
            this.recordBulkUploadProgress(jobId, {
              ...progress,
              errors: progress.errors ?? undefined,
              details: progress.details ?? undefined,
            }),
        });

        this.recordBulkUploadProgress(jobId, {
          status: "completed",
          success: result.success,
          failed: result.failed,
          processed: result.success + result.failed,
          errors: result.errors,
          details: result.details,
          finishedAt: new Date(),
        });
      } catch (error: any) {
        this.recordBulkUploadProgress(jobId, {
          status: "failed",
          message: error?.message || "Bulk upload failed",
          finishedAt: new Date(),
        });
        this.bulkUploadGateway.emitError(
          jobId,
          error?.message || "Bulk upload failed",
        );
      } finally {
        setTimeout(() => this.bulkUploadJobs.delete(jobId), 1000 * 60 * 30);
      }
    });

    return { jobId };
  }

  async bulkInviteUsers(
    bulkInviteDto: BulkInviteUserDto,
    invitedBy: string,
  ): Promise<{ success: number; failed: number; errors: any[] }> {
    const { users, tenantId } = bulkInviteDto;
    let success = 0;
    let failed = 0;
    const errors: any[] = [];

    for (const userData of users) {
      try {
        await this.inviteUser({ ...userData, tenantId }, invitedBy);

        success++;
      } catch (error) {
        failed++;
        errors.push({
          user: userData,
          error: error.message,
        });
      }
    }

    return { success, failed, errors };
  }

  async bulkUploadUsers(
    bulkUploadDto: any,
    invitedBy: string,
    options?: {
      jobId?: string;
      onProgress?: (progress: Partial<BulkUploadJobState>) => void;
    },
  ): Promise<{
    success: number;
    failed: number;
    errors: any[];
    details: any[];
  }> {
    const { users, tenantId } = bulkUploadDto;
    const concurrency =
      Number(process.env.BULK_UPLOAD_CONCURRENCY || "10") || 10;
    let success = 0;
    let failed = 0;
    const errors: any[] = [];
    const details: any[] = [];
    const total = Array.isArray(users) ? users.length : 0;

    const notifyProgress = (status: BulkUploadStatus = "running") => {
      options?.onProgress?.({
        jobId: options?.jobId,
        status,
        total,
        processed: success + failed,
        success,
        failed,
      });
    };

    const query: any = {
      isActive: true,
    };

    if (!isEmpty(tenantId)) query.tenantId = new Types.ObjectId(tenantId);

    // Fetch all entities for this tenant to build a name-to-entity map
    const allEntities = await this.entityModel.find(query).lean();

    // Build a map of entity paths for quick lookup (case-insensitive)
    const entityPathMap = new Map<string, any>();
    allEntities.forEach((entity) => {
      // Store entities by their NORMALIZED name for case-insensitive lookup
      const normalizedName = entity.name.toLowerCase().trim();
      if (!entityPathMap.has(normalizedName)) {
        entityPathMap.set(normalizedName, []);
      }
      entityPathMap.get(normalizedName).push(entity);
    });

    notifyProgress();

    const processUser = async (userData: any) => {
      try {
        let { phoneNumber } = userData;
        const { email, firstName, lastName, entityPathNames } = userData;

        if (!phoneNumber) {
          throw new Error("Phone number is required");
        }

        if (String(phoneNumber)[0] !== "+") phoneNumber = "+" + phoneNumber;

        if (!isValidPhoneNumber(phoneNumber)) {
          throw new Error(`Invalid phone number format: ${phoneNumber}`);
        }

        const parsedPhone = parsePhoneNumber(phoneNumber);
        const e164Phone = parsedPhone.format("E.164");

        const existingUser = await this.userModel.findOne({
          phoneNumber: e164Phone,
          isActive: true,
        });

        if (existingUser) {
          throw new Error(`User with phone number ${e164Phone} already exists`);
        }

        let targetEntity = null;
        if (entityPathNames && entityPathNames.length > 0) {
          const cleanPathNames = entityPathNames.filter(
            (name) => name && name.trim() !== "",
          );
          const normalizedCleanPath = cleanPathNames.map((name) =>
            name.trim().toLowerCase(),
          );

          if (cleanPathNames.length > 0) {
            let currentParentId = null;

            for (let i = 0; i < cleanPathNames.length; i++) {
              const entityName = cleanPathNames[i].trim();
              const normalizedEntityName = entityName.toLowerCase().trim();
              const candidates = entityPathMap.get(normalizedEntityName) || [];

              const matchingEntity = candidates.find((e) => {
                const candidateParentId = e.parentId
                  ? e.parentId.toString()
                  : null;
                const currentParentIdStr =
                  currentParentId !== null ? currentParentId.toString() : null;

                if (currentParentId === null) {
                  return (
                    candidateParentId === null ||
                    candidateParentId === SYSTEM_ENTITY_ID.toString()
                  );
                }

                return (
                  candidateParentId !== null &&
                  candidateParentId === currentParentIdStr
                );
              });

              if (!matchingEntity) {
                const rootEntities = allEntities
                  .filter(
                    (e) =>
                      !e.parentId ||
                      (e.parentId &&
                        e.parentId.toString() === SYSTEM_ENTITY_ID.toString()),
                  )
                  .map((e) => e.name);
                throw new Error(
                  `Entity "${entityName}" not found in path: ${cleanPathNames.join(" > ")}. Available root entities: ${rootEntities.join(", ")}`,
                );
              }

              currentParentId = matchingEntity._id;

              if (i === cleanPathNames.length - 1) {
                targetEntity = matchingEntity;
              }
            }
            if (!targetEntity) {
              const fallbackTarget = allEntities.find((entity) => {
                if (!entity.path) return false;
                const normalizedEntityPath = entity.path
                  .split(">")
                  .map((segment) => segment.trim().toLowerCase())
                  .filter((segment) => segment.length > 0);
                if (normalizedEntityPath.length < normalizedCleanPath.length) {
                  return false;
                }
                const offset =
                  normalizedEntityPath.length - normalizedCleanPath.length;
                for (let idx = 0; idx < normalizedCleanPath.length; idx++) {
                  if (
                    normalizedEntityPath[offset + idx] !==
                    normalizedCleanPath[idx]
                  ) {
                    return false;
                  }
                }
                return true;
              });

              if (fallbackTarget) {
                targetEntity = fallbackTarget;
                currentParentId = fallbackTarget._id;
                console.log(
                  "[bulkUploadUsers] Target entity resolved via fallback path match:",
                  fallbackTarget.path,
                );
              }
            }
          }
        }

        if (!targetEntity) {
          throw new Error("Could not resolve entity from path names");
        }

        const tempPassword = randomUUID();
        const hashedPassword =
          await this.authService.hashPassword(tempPassword);

        const entityIdPath = targetEntity.entityIdPath || [targetEntity._id];

        const newUser = await this.userModel.create({
          _id: new Types.ObjectId(),
          phoneNumber: e164Phone,
          email: email || undefined,
          firstName,
          lastName,
          password: hashedPassword,
          entityId: targetEntity._id,
          entityIdPath,
          tenantId: entityIdPath[0],
          role: UserRole.USER,
          entityPath: targetEntity.path,
          registrationStatus: RegistrationStatus.INVITED,
          isActive: true,
          invitedBy: new Types.ObjectId(invitedBy),
          invitedAt: new Date(),
        });

        await this.queueUserInvitationEmail({
          email,
          firstName,
          lastName,
          phoneNumber: e164Phone,
          tenantId: entityIdPath[0],
          userId: newUser._id as Types.ObjectId,
        });

        success++;
        notifyProgress();
        details.push({
          phoneNumber: e164Phone,
          email,
          firstName,
          lastName,
          entityName: targetEntity.name,
          entityPath: targetEntity.path,
          status: "success",
        });
      } catch (error) {
        failed++;
        errors.push({
          user: userData,
          error: error.message,
        });
        details.push({
          ...userData,
          status: "failed",
          error: error.message,
        });
        notifyProgress();
      }
    };

    for (let i = 0; i < users.length; i += concurrency) {
      const batch = users.slice(i, i + concurrency);
      await Promise.all(batch.map((user) => processUser(user)));
    }

    options?.onProgress?.({
      jobId: options?.jobId,
      status: "completed",
      total,
      processed: success + failed,
      success,
      failed,
      errors,
      details,
    });

    return { success, failed, errors, details };
  }

  async bulkUploadManagers(
    bulkUploadDto: any,
    invitedBy: string,
    options?: {
      jobId?: string;
      onProgress?: (progress: Partial<BulkUploadJobState>) => void;
    },
  ): Promise<{
    success: number;
    failed: number;
    errors: any[];
    details: any[];
  }> {
    const { managers, tenantId } = bulkUploadDto;
    const concurrency =
      Number(process.env.BULK_UPLOAD_CONCURRENCY || "10") || 10;
    let success = 0;
    let failed = 0;
    const errors: any[] = [];
    const details: any[] = [];
    const total = Array.isArray(managers) ? managers.length : 0;

    const notifyProgress = (status: BulkUploadStatus = "running") => {
      options?.onProgress?.({
        jobId: options?.jobId,
        status,
        total,
        processed: success + failed,
        success,
        failed,
      });
    };

    const query: any = {
      isActive: true,
    };

    if (!isEmpty(tenantId)) query.tenantId = new Types.ObjectId(tenantId);

    // Fetch all entities for this tenant to build a name-to-entity map
    const allEntities = await this.entityModel.find(query).lean();

    // Build a map of entity paths for quick lookup (case-insensitive)
    const entityPathMap = new Map<string, any>();
    allEntities.forEach((entity) => {
      // Store entities by their NORMALIZED name for case-insensitive lookup
      const normalizedName = entity.name.toLowerCase().trim();
      if (!entityPathMap.has(normalizedName)) {
        entityPathMap.set(normalizedName, []);
      }
      entityPathMap.get(normalizedName).push(entity);
    });

    notifyProgress();

    const processManager = async (managerData: any) => {
      try {
        const { email, firstName, lastName, entityPathNames } = managerData;

        if (!email) {
          throw new Error("Email is required");
        }

        const normalizedEmail = email.toLowerCase().trim();

        const existingManager = await this.userModel.findOne({
          email: normalizedEmail,
          isActive: true,
        });

        if (existingManager) {
          throw new Error(
            `Manager with email ${normalizedEmail} already exists`,
          );
        }

        let targetEntity = null;
        if (entityPathNames && entityPathNames.length > 0) {
          const cleanPathNames = entityPathNames.filter(
            (name) => name && name.trim() !== "",
          );
          const normalizedCleanPath = cleanPathNames.map((name) =>
            name.trim().toLowerCase(),
          );

          if (cleanPathNames.length > 0) {
            let currentParentId: Types.ObjectId | null = null;

            for (let i = 0; i < cleanPathNames.length; i++) {
              const entityName = cleanPathNames[i].trim();
              const normalizedEntityName = entityName.toLowerCase().trim();
              const candidates = entityPathMap.get(normalizedEntityName) || [];

              const matchingEntity = candidates.find((e) => {
                const candidateParentId = e.parentId
                  ? e.parentId.toString()
                  : null;
                const currentParentIdStr =
                  currentParentId !== null ? currentParentId.toString() : null;

                if (currentParentId === null) {
                  return (
                    candidateParentId === null ||
                    candidateParentId === SYSTEM_ENTITY_ID.toString()
                  );
                }

                return (
                  candidateParentId !== null &&
                  candidateParentId === currentParentIdStr
                );
              });

              if (!matchingEntity) {
                const rootEntities = allEntities
                  .filter(
                    (e) =>
                      !e.parentId ||
                      (e.parentId &&
                        e.parentId.toString() === SYSTEM_ENTITY_ID.toString()),
                  )
                  .map((e) => e.name);
                throw new Error(
                  `Entity "${entityName}" not found in path: ${cleanPathNames.join(" > ")}. Available root entities: ${rootEntities.join(", ")}`,
                );
              }

              currentParentId = matchingEntity._id;

              if (i === cleanPathNames.length - 1) {
                targetEntity = matchingEntity;
              }
            }

            if (!targetEntity) {
              const fallbackTarget = allEntities.find((entity) => {
                if (!entity.path) return false;
                const normalizedEntityPath = entity.path
                  .split(">")
                  .map((segment) => segment.trim().toLowerCase())
                  .filter((segment) => segment.length > 0);
                if (normalizedEntityPath.length < normalizedCleanPath.length) {
                  return false;
                }
                const offset =
                  normalizedEntityPath.length - normalizedCleanPath.length;
                for (let idx = 0; idx < normalizedCleanPath.length; idx++) {
                  if (
                    normalizedEntityPath[offset + idx] !==
                    normalizedCleanPath[idx]
                  ) {
                    return false;
                  }
                }
                return true;
              });

              if (fallbackTarget) {
                targetEntity = fallbackTarget;
                currentParentId = fallbackTarget._id;
                this.logger.debug(
                  `[bulkUploadManagers] Target entity resolved via fallback path match: ${fallbackTarget.path}`,
                );
              }
            }
          }
        }

        if (!targetEntity) {
          throw new Error("Could not resolve entity from path names");
        }

        const tempPassword = randomUUID();
        const hashedPassword =
          await this.authService.hashPassword(tempPassword);

        const entityIdPath = targetEntity.entityIdPath || [targetEntity._id];

        await this.userModel.create({
          _id: new Types.ObjectId(),
          email: normalizedEmail,
          firstName,
          lastName,
          password: hashedPassword,
          entityId: targetEntity._id,
          entityIdPath,
          tenantId: entityIdPath[0],
          role: UserRole.TENANT_ADMIN,
          entityPath: targetEntity.path,
          registrationStatus: RegistrationStatus.REGISTERED,
          isActive: true,
          invitedBy: new Types.ObjectId(invitedBy),
          invitedAt: new Date(),
        });

        try {
          this.logger.log(`Manager ${normalizedEmail} created successfully.`);

          try {
            const templateData = {
              firstName,
              lastName,
              role: "Manager",
              tempPassword,
              entity: {
                name: targetEntity.name,
              },
              logoUrl:
                process.env.LOGO_URL ||
                "https://system.2n5global.com/favicon.svg",
              loginUrl: process.env.FRONTEND_URL + "/login",
              supportEmail:
                process.env.SUPPORT_EMAIL || "support@2n5global.com",
              companyName: process.env.COMPANY_NAME || "2N5 Global",
              companyAddress:
                process.env.COMPANY_ADDRESS || "123 Business Street, Tech City",
              socialLinks: {
                website: process.env.COMPANY_WEBSITE || "https://2n5global.com",
                linkedin: process.env.COMPANY_LINKEDIN,
                twitter: process.env.COMPANY_TWITTER,
              },
              // Keep language available for localized template copy
              language: (managerData as any)?.language || "en",
            };

            this.logger.debug(
              `Queueing bulk manager invitation email: to=${normalizedEmail}`,
            );
            await this.emailQueueService.queueInvitationEmail(
              normalizedEmail,
              "manager-invitation",
              templateData,
              {
                correlationId: `bulk-manager-invitation-${normalizedEmail}`,
                tenantId: tenantId,
              },
            );
            this.logger.log(
              `Bulk manager invitation email queued for ${normalizedEmail}`,
            );
          } catch (emailError) {
            this.logger.warn(
              `Failed to send bulk manager invitation email: ${emailError.message}`,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Failed to send invitation email to ${normalizedEmail}: ${error.message}`,
          );
        }

        success++;
        notifyProgress();
        details.push({
          email: normalizedEmail,
          firstName,
          lastName,
          entityName: targetEntity.name,
          entityPath: targetEntity.path,
          status: "success",
        });
      } catch (error) {
        failed++;
        errors.push({
          manager: managerData,
          error: error.message,
        });
        details.push({
          ...managerData,
          status: "failed",
          error: error.message,
        });
        notifyProgress();
      }
    };

    for (let i = 0; i < managers.length; i += concurrency) {
      const batch = managers.slice(i, i + concurrency);
      await Promise.all(batch.map((manager) => processManager(manager)));
    }

    options?.onProgress?.({
      jobId: options?.jobId,
      status: "completed",
      total,
      processed: success + failed,
      success,
      failed,
      errors,
      details,
    });

    return { success, failed, errors, details };
  }

  async listSystemAdmins(): Promise<any[]> {
    const admins = await this.userModel
      .find({ role: UserRole.SYSTEM_ADMIN, isActive: true })
      .sort({ createdAt: 1 })
      .lean();

    return admins.map((admin) => this.stripSensitiveFields(admin));
  }

  async createSystemAdmin(
    createDto: CreateSystemAdminDto,
    _createdBy: string,
  ): Promise<{ user: any; temporaryPassword: string }> {
    const normalizedEmail = createDto.email.toLowerCase().trim();
    const existing = await this.userModel.findOne({
      email: normalizedEmail,
      role: UserRole.SYSTEM_ADMIN,
      isActive: true,
    });

    if (existing) {
      throw new BadRequestException(MESSAGES.USER.EMAIL_ALREADY_EXISTS);
    }

    const temporaryPassword =
      createDto.temporaryPassword?.trim() || this.generateSecurePassword();

    if (!isPasswordStrong(temporaryPassword)) {
      throw new BadRequestException(MESSAGES.AUTH.PASSWORD_TOO_WEAK);
    }

    const hashedPassword =
      await this.authService.hashPassword(temporaryPassword);

    const systemAdmin = await this.userModel.create({
      _id: new Types.ObjectId(),
      email: normalizedEmail,
      firstName: createDto.firstName.trim(),
      lastName: createDto.lastName.trim(),
      password: hashedPassword,
      role: UserRole.SYSTEM_ADMIN,
      registrationStatus: RegistrationStatus.REGISTERED,
      entityId: SYSTEM_ENTITY_ID,
      entityIdPath: [SYSTEM_ENTITY_ID],
      entityPath: SYSTEM_ENTITY_NAME,
      tenantId: null,
      isActive: true,
      mustChangePassword: true,
    });

    return {
      user: this.sanitizeSystemAdmin(systemAdmin),
      temporaryPassword,
    };
  }

  async updateSystemAdminPassword(
    id: string,
    updateDto: UpdateSystemAdminPasswordDto,
    _updatedBy: string,
  ): Promise<{ message: string; user: any }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(MESSAGES.USER.INVALID_ID_FORMAT);
    }

    const adminUser = await this.userModel
      .findOne({
        _id: new Types.ObjectId(id),
        isActive: true,
      })
      .select("+password");

    if (!adminUser || adminUser.role !== UserRole.SYSTEM_ADMIN) {
      throw new NotFoundException(MESSAGES.USER.NOT_FOUND);
    }

    if (!isPasswordStrong(updateDto.newPassword)) {
      throw new BadRequestException(MESSAGES.AUTH.PASSWORD_TOO_WEAK);
    }

    const hashedPassword = await this.authService.hashPassword(
      updateDto.newPassword,
    );

    adminUser.password = hashedPassword;
    const mustChange =
      updateDto.requirePasswordChange === undefined
        ? true
        : !!updateDto.requirePasswordChange;
    adminUser.mustChangePassword = mustChange;
    adminUser.passwordChangedAt = mustChange ? undefined : new Date();
    await adminUser.save();

    return {
      message: MESSAGES.GENERAL.OPERATION_SUCCESS,
      user: this.sanitizeSystemAdmin(adminUser),
    };
  }

  async updateRegistrationStatus(
    id: string,
    status: RegistrationStatus,
    updatedBy: string,
    tenantId: string,
  ): Promise<User> {
    await this.findOne(id, tenantId);

    const updateData: any = {
      registrationStatus: status,
      updatedBy,
    };

    if (status === RegistrationStatus.REGISTERED) {
      updateData.registeredAt = new Date();
    }

    return this.userModel.findByIdAndUpdate(id, updateData, { new: true });
  }

  async updateWhatsAppConnectionStatus(
    id: string,
    status: WhatsAppConnectionStatus,
    tenantId: string,
  ): Promise<User> {
    await this.findOne(id, tenantId);

    const updateData: any = {
      whatsappConnectionStatus: status,
    };

    if (status === WhatsAppConnectionStatus.CONNECTED) {
      updateData.whatsappConnectedAt = new Date();
    }

    return this.userModel.findByIdAndUpdate(id, updateData, { new: true });
  }

  async remove(id: string, deletedBy: string, tenantId: string): Promise<void> {
    const user = await this.findOne(id, tenantId);

    // Prevent TenantAdmin from deleting their own account
    if (user.role === UserRole.TENANT_ADMIN && id === deletedBy) {
      throw new ForbiddenException(MESSAGES.GENERAL.FORBIDDEN);
    }

    const anonymizeToken = (() => {
      const existing = String((user as any)?.pseudonym || "").trim();
      if (existing) {
        // Reuse existing pseudonym to keep history stable if deletion is retried
        return existing;
      }
      return `Deleted User ${randomBytes(4).toString("hex").toUpperCase()}`;
    })();

    const emailToken = anonymizeToken
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

    // Disconnect WhatsApp session if user has a phone number
    if (user.phoneNumber) {
      try {
        const sessionId = `whatsapp-${user.phoneNumber.slice(1)}`;
        await this.whatsappService.disconnectSession(sessionId);
        this.logger.log(
          `WhatsApp session disconnected for user ${id} (${user.phoneNumber})`,
        );
      } catch (error) {
        // Log error but don't fail the deletion if session disconnect fails
        this.logger.warn(
          `Failed to disconnect WhatsApp session for user ${id}: ${error.message}`,
        );
      }

      // Pseudonymize any message history that would otherwise leak identity (phone/name)
      await this.whatsappService.pseudonymizeMessagesForDeletedUser({
        // Prefer tenantId from the user record to avoid malformed values coming from request context
        tenantId: (user as any)?.tenantId ?? tenantId,
        phoneNumber: user.phoneNumber,
        pseudonym: anonymizeToken,
        deletedBy,
      });
    }

    // Deactivate WhatsApp sessions tied to the user (scrub phone/session data)
    await this.whatsappService.deactivateSessionsForDeletedUser(id, deletedBy);

    // Soft delete + anonymize personal data (LGPD/GDPR "right to be forgotten")
    await this.userModel.findByIdAndUpdate(new Types.ObjectId(id), {
      isActive: false,
      deletedAt: new Date(),
      deletedBy,
      anonymizedAt: new Date(),
      pseudonym: anonymizeToken,
      updatedBy: deletedBy,

      // Personal fields
      firstName: "Deleted",
      lastName: "User",
      email: `deleted-${emailToken || "user"}@deleted.invalid`,
      phoneNumber: null,
      pendingEmail: null,
      emailVerified: false,
      avatar: null,
      initials: null,
      lastSeenAt: null,
      isOnline: false,

      // Security/session fields
      resetPasswordToken: null,
      resetPasswordExpires: null,
      emailVerificationToken: null,
      emailVerificationExpires: null,
      mustChangePassword: false,

      // WhatsApp fields
      whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
      whatsappConnectedAt: null,
      qrInvitationHistory: [],
    });
  }

  private jidFromE164(phoneNumber: string): string {
    const digits = String(phoneNumber || "").replace(/[^\d]/g, "");
    return `${digits}@c.us`;
  }

  /**
   * LGPD/GDPR: Data portability export for a specific user.
   * Returns personal data (sanitized) + message history associated with the user.
   */
  async exportUserData(params: {
    userId: string;
    tenantId:
      | string
      | Types.ObjectId
      | { _id?: string | Types.ObjectId }
      | null
      | undefined;
    requestedBy: string;
    includeMessages?: boolean;
    messageLimit?: number;
  }): Promise<{
    generatedAt: string;
    user: Record<string, any>;
    messages: any[];
    messagesTotal: number;
    messagesReturned: number;
    truncated: boolean;
    containsThirdPartyData: boolean;
  }> {
    const includeMessages = params.includeMessages !== false;
    const messageLimit =
      typeof params.messageLimit === "number" && params.messageLimit > 0
        ? Math.min(params.messageLimit, 50000)
        : 20000;

    const normalizeObjectId = (
      value: unknown,
      errorMessage: string,
    ): Types.ObjectId => {
      const raw: any = value;
      if (!raw) {
        throw new BadRequestException(errorMessage);
      }

      if (raw instanceof Types.ObjectId) {
        return raw;
      }

      // Some libs serialize ObjectId-ish values as { _id }, { id }, or { $oid }
      const nested =
        raw?._id ?? raw?.id ?? raw?.$oid ?? raw?.oid ?? raw?.value ?? undefined;
      if (nested !== undefined && nested !== raw) {
        return normalizeObjectId(nested, errorMessage);
      }

      if (typeof raw?.toHexString === "function") {
        const hex = String(raw.toHexString()).trim();
        if (Types.ObjectId.isValid(hex)) return new Types.ObjectId(hex);
      }

      const asString = String(raw).trim();
      if (!Types.ObjectId.isValid(asString)) {
        throw new BadRequestException(errorMessage);
      }
      return new Types.ObjectId(asString);
    };

    // Determine requester context (needed to support SystemAdmin tokens without tenantId)
    const requesterId = String(params.requestedBy || "").trim();
    const requester =
      requesterId && Types.ObjectId.isValid(requesterId)
        ? await this.userModel
            .findById(new Types.ObjectId(requesterId))
            .select({ tenantId: 1, role: 1 })
            .lean()
        : null;

    const requesterRole = (requester as any)?.role;
    const isSystemAdminRequester = requesterRole === UserRole.SYSTEM_ADMIN;

    // Load target user with tenant scoping for non-system-admins; system admins can load without tenant filter.
    let user: User;
    let tenantObjectIdForMessages: Types.ObjectId | null = null;

    if (isSystemAdminRequester) {
      user = await this.findOne(params.userId, "");
      // For system admins, derive tenant for message lookup from the target user
      const targetTenant = (user as any)?.tenantId;
      try {
        tenantObjectIdForMessages = targetTenant
          ? normalizeObjectId(targetTenant, "Invalid tenantId for export")
          : null;
      } catch {
        tenantObjectIdForMessages = null;
      }
    } else {
      const tenantObjectId = normalizeObjectId(
        params.tenantId ?? (requester as any)?.tenantId,
        "Invalid tenantId for export",
      );
      user = await this.findOne(params.userId, tenantObjectId.toString());
      tenantObjectIdForMessages = tenantObjectId;
    }

    const safeUser = {
      _id: user._id?.toString?.() || String((user as any)?._id || ""),
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: (user as any)?.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      role: user.role,
      registrationStatus: user.registrationStatus,
      entityId: user.entityId?.toString?.() || (user as any)?.entityId,
      entityPath: user.entityPath,
      tenantId: user.tenantId?.toString?.() || (user as any)?.tenantId,
      preferences: user.preferences || {},
      whatsappConnectionStatus: user.whatsappConnectionStatus,
      whatsappConnectedAt: user.whatsappConnectedAt,
      emailVerified: user.emailVerified,
      pendingEmail: user.pendingEmail,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deletedAt: (user as any)?.deletedAt,
      anonymizedAt: (user as any)?.anonymizedAt,
      pseudonym: (user as any)?.pseudonym,
      isActive: user.isActive,
    };

    if (!includeMessages || !user.phoneNumber || !tenantObjectIdForMessages) {
      return {
        generatedAt: new Date().toISOString(),
        user: safeUser,
        messages: [],
        messagesTotal: 0,
        messagesReturned: 0,
        truncated: false,
        containsThirdPartyData: true,
      };
    }

    const phoneNumber = String(user.phoneNumber);
    const jid = this.jidFromE164(phoneNumber);

    const baseQuery: any = {
      tenantId: tenantObjectIdForMessages,
      isActive: true,
      $or: [
        { fromPhoneNumber: phoneNumber },
        { toPhoneNumber: phoneNumber },
        { from: jid },
        { to: jid },
      ],
    };

    const messagesTotal = await this.messageModel.countDocuments(baseQuery);
    const messages = await this.messageModel
      .find(baseQuery)
      .sort({ sentAt: 1, createdAt: 1 })
      .limit(messageLimit)
      .lean();

    return {
      generatedAt: new Date().toISOString(),
      user: safeUser,
      messages,
      messagesTotal,
      messagesReturned: messages.length,
      truncated: messagesTotal > messages.length,
      // Message history usually includes other participants' phone numbers/names.
      containsThirdPartyData: true,
    };
  }

  /**
   * Check if a user is a Administrator
   * @param user - The user object to check
   * @returns true if the user is a Administrator
   */
  isSystemAdmin(user: User): boolean {
    return isSystemAdmin(user);
  }

  /**
   * Get the System entity ID constant
   * @returns The System entity ObjectId
   */
  getSystemEntityId(): Types.ObjectId {
    return SYSTEM_ENTITY_ID;
  }

  private sanitizeSystemAdmin(user: User | any): any {
    if (!user) return null;
    const doc = user as any;
    const plain =
      typeof doc?.toObject === "function" ? doc.toObject() : { ...doc };
    return this.stripSensitiveFields(plain);
  }

  private stripSensitiveFields(user: any): any {
    if (!user) {
      return user;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
      password,
      resetPasswordToken,
      resetPasswordExpires,
      emailVerificationToken,
      ...safe
    } = user;
    return safe;
  }

  private generateSecurePassword(): string {
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const upper = lower.toUpperCase();
    const numbers = "0123456789";
    const special = "!@#$%^&*()-_=+[]{}";
    const all = lower + upper + numbers + special;

    const pick = (charset: string) =>
      charset.charAt(Math.floor(Math.random() * charset.length));

    let password =
      pick(lower) + pick(upper) + pick(numbers) + pick(special) + pick(all);

    while (password.length < 16) {
      password += pick(all);
    }

    return password;
  }

  async searchUsers(query: string, tenantId: string): Promise<User[]> {
    const searchQuery: any = {
      isActive: true,
      $or: [
        { firstName: { $regex: query, $options: "i" } },
        { lastName: { $regex: query, $options: "i" } },
        { email: { $regex: query, $options: "i" } },
        { phoneNumber: { $regex: query, $options: "i" } },
      ],
    };

    // Only filter by tenantId if provided (SystemAdmin has no tenantId)
    if (tenantId && tenantId !== "") {
      searchQuery.tenantId = new Types.ObjectId(tenantId);
    }

    return this.userModel.find(searchQuery).limit(20);
  }

  /**
   * Regenerate WhatsApp QR code for a user
   * @param userId - The ID of the user
   * @param tenantId - The tenant ID
   * @returns Object containing the new QR code data
   */
  async verifyEmail(token: string, userId: string): Promise<User> {
    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      emailVerificationToken: token,
      isActive: true,
    });

    if (!user) {
      throw new BadRequestException(MESSAGES.USER.VERIFICATION_TOKEN_INVALID);
    }

    // Check if token is expired
    if (
      user.emailVerificationExpires &&
      user.emailVerificationExpires < new Date()
    ) {
      throw new BadRequestException(MESSAGES.USER.VERIFICATION_TOKEN_EXPIRED);
    }

    // Check if there's a pending email
    if (!user.pendingEmail) {
      throw new BadRequestException(MESSAGES.USER.NO_PENDING_VERIFICATION);
    }

    // Normalize pending email for comparison
    const normalizedPendingEmail = user.pendingEmail.toLowerCase().trim();

    // Check if pending email already exists for another user (in email or pendingEmail field)
    const existingUser = await this.userModel.findOne({
      _id: { $ne: new Types.ObjectId(userId) },
      isActive: true,
      role: user.role,
      $or: [
        { email: normalizedPendingEmail },
        { pendingEmail: normalizedPendingEmail },
      ],
    });

    if (existingUser) {
      throw new BadRequestException(MESSAGES.USER.EMAIL_ALREADY_EXISTS);
    }

    // Update email and clear verification fields
    const updatedUser = await this.userModel.findByIdAndUpdate(
      userId,
      {
        email: normalizedPendingEmail,
        emailVerified: true,
        pendingEmail: null,
        emailVerificationToken: null,
        emailVerificationExpires: null,
      },
      { new: true },
    );

    return updatedUser;
  }

  async resendEmailVerification(userId: string): Promise<void> {
    const user = await this.findOne(userId, "");

    if (!user.pendingEmail) {
      throw new BadRequestException(MESSAGES.USER.NO_PENDING_VERIFICATION);
    }

    // Check if token is expired, regenerate if needed
    let verificationToken = user.emailVerificationToken;
    let verificationExpires = user.emailVerificationExpires;

    if (
      !verificationToken ||
      !verificationExpires ||
      verificationExpires < new Date()
    ) {
      verificationToken = randomBytes(32).toString("hex");
      verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await this.userModel.findByIdAndUpdate(userId, {
        emailVerificationToken: verificationToken,
        emailVerificationExpires: verificationExpires,
      });
    }

    // Queue verification email
    const frontendUrl = process.env.FRONTEND_URL || "https://localhost:3000";
    const verificationLink = `${frontendUrl}/verify-email?token=${verificationToken}&userId=${userId}`;

    this.logger.debug(
      `Queueing email verification: to=${user.pendingEmail}, userId=${userId}`,
    );
    await this.emailQueueService.queueEmailVerificationEmail(
      user.pendingEmail,
      {
        firstName: user.firstName,
        lastName: user.lastName,
        verificationLink,
        expiryHours: 24,
        // language is handled inside email service; cast to any to avoid type drift here
      } as any,
      {
        correlationId: `email-verification-${userId}`,
        userId: userId,
      },
    );
  }

  async generateQrForPhoneNumber(
    phoneNumber: string,
  ): Promise<QRGenerationResponse> {
    if (!phoneNumber) {
      throw new BadRequestException(MESSAGES.USER.PHONE_NUMBER_REQUIRED);
    }

    const normalized = phoneNumber.startsWith("+")
      ? phoneNumber
      : `+${phoneNumber.replace(/^\+/, "")}`;

    const user = await this.userModel.findOne({
      phoneNumber: normalized,
      isActive: true,
    });

    if (!user) {
      throw new NotFoundException(MESSAGES.USER.NOT_FOUND);
    }

    // Check if session already exists and is connected
    const sessionId = `whatsapp-${normalized.slice(1)}`;
    try {
      const existingSession =
        await this.whatsappService.getSessionStatus(sessionId);

      // If session is already connected ('ready' or 'authenticated'), return that status without regenerating QR
      const isConnected =
        existingSession &&
        (existingSession.status === "ready" ||
          existingSession.status === "authenticated");

      if (isConnected) {
        this.logger.log(
          `Session ${sessionId} is already connected (status=${existingSession.status}), skipping QR generation`,
        );
        return {
          qrCode: null,
          expiresAt: null,
          sessionId,
          status: "ready",
        };
      }
    } catch (err) {
      // Session doesn't exist yet, which is fine - we'll create it
      this.logger.debug(`Session ${sessionId} not found, will create new one`);
    }

    const tenantId =
      user.tenantId && Types.ObjectId.isValid(user.tenantId)
        ? user.tenantId.toString()
        : "";

    return this.regenerateQRCode(user._id.toString(), tenantId, {
      waitForResult: false,
    });
  }

  async resendUserInvitation(userId: string, tenantId: string): Promise<void> {
    const user = await this.findOne(userId, tenantId);

    if (!user.email) {
      throw new BadRequestException(MESSAGES.USER.EMAIL_REQUIRED);
    }

    if (!user.phoneNumber) {
      throw new BadRequestException(MESSAGES.USER.PHONE_NUMBER_REQUIRED);
    }

    const tenantObjectId =
      user.tenantId && Types.ObjectId.isValid(user.tenantId)
        ? new Types.ObjectId(user.tenantId)
        : undefined;

    await this.queueUserInvitationEmail({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: user.phoneNumber,
      tenantId: tenantObjectId,
      userId: new Types.ObjectId(user._id),
      language: user.preferences?.language || "en",
    });
  }

  async regenerateQRCode(
    userId: string,
    tenantId: string,
    options?: { waitForResult?: boolean },
  ): Promise<QRGenerationResponse> {
    // Find the user and verify they have a phone number
    const user = await this.findOne(userId, tenantId);
    if (!user.phoneNumber) {
      throw new BadRequestException(
        "User does not have a phone number configured",
      );
    }

    const sessionId = `whatsapp-${user.phoneNumber.slice(1)}`;
    const waitForResult = options?.waitForResult !== false;

    // Check if session is already connected - don't regenerate QR if so
    try {
      const existingSession =
        await this.whatsappService.getSessionStatus(sessionId);

      const isConnected =
        existingSession &&
        (existingSession.status === "ready" ||
          existingSession.status === "authenticated");

      if (isConnected) {
        this.logger.log(
          `Session ${sessionId} is already connected (status=${existingSession.status}), skipping QR regeneration`,
        );
        return {
          qrCode: null,
          expiresAt: null,
          sessionId,
          status: "ready",
        };
      }
    } catch (err) {
      // Session doesn't exist yet, which is fine - we'll create it
      this.logger.debug(`Session ${sessionId} not found, will create/recreate`);
    }

    try {
      const hadClient = this.whatsappService.hasActiveClient(sessionId);

      // Ensure session exists and initialize client if needed
      const { initializedNewClient } =
        await this.whatsappService.recreateSession(
          sessionId,
          new Types.ObjectId(userId),
          userId, // Use the user's ID as the creator since we don't have updatedBy/createdBy
          user.entityId.toString(),
          user.tenantId ? user.tenantId.toString() : "",
        );

      if (!hadClient && initializedNewClient) {
        // Update user status to connecting only when a new client was started
        await this.updateWhatsAppConnectionStatus(
          userId,
          WhatsAppConnectionStatus.CONNECTING,
          tenantId,
        );
      }

      // Record QR "sent/requested" intent (used for client lifecycle status: Requested vs New)
      try {
        const qrCodeId = `qr_${Date.now()}_${randomBytes(4).toString("hex")}`;
        await this.userModel.updateOne(
          { _id: new Types.ObjectId(userId) },
          {
            $push: {
              qrInvitationHistory: {
                qrCodeId,
                sentAt: new Date(),
                attemptCount: 1,
                isExpired: false,
              },
            },
          },
        );
      } catch (historyErr) {
        this.logger.warn(
          `Failed to record QR invitation history for user ${userId}: ${
            historyErr instanceof Error
              ? historyErr.message
              : String(historyErr)
          }`,
        );
      }

      if (!waitForResult) {
        return {
          qrCode: null,
          expiresAt: null,
          sessionId,
          status: "pending",
        };
      }

      // Try to get QR code
      let qrCodeData = null;
      try {
        qrCodeData = await this.whatsappService.getQRCode(sessionId);
        if (qrCodeData) {
          this.logger.log(`QR code generated for session: ${sessionId}`);
        }
      } catch (error) {
        this.logger.warn(`Failed to get QR code: ${error.message}`);

        // Update status to failed
        await this.updateWhatsAppConnectionStatus(
          userId,
          WhatsAppConnectionStatus.FAILED,
          tenantId,
        );
        throw error;
      }

      if (!qrCodeData) {
        // Update status to failed if QR generation failed
        await this.updateWhatsAppConnectionStatus(
          userId,
          WhatsAppConnectionStatus.FAILED,
          tenantId,
        );
        throw new Error("Failed to generate QR code after multiple attempts");
      }

      // Update status to QR_REQUIRED since we successfully got a QR code
      await this.updateWhatsAppConnectionStatus(
        userId,
        WhatsAppConnectionStatus.CONNECTING,
        tenantId,
      );

      return {
        qrCode: qrCodeData.qrCode,
        expiresAt: qrCodeData.expiresAt,
        sessionId,
        status: "ready",
      };
    } catch (error) {
      // Update status to failed on error
      await this.updateWhatsAppConnectionStatus(
        userId,
        WhatsAppConnectionStatus.FAILED,
        tenantId,
      );
      throw new BadRequestException(MESSAGES.USER.QR_REGENERATION_FAILED);
    }
  }

  async getUserHealthStatus(userId: string, tenantId: string): Promise<any> {
    const user = await this.findOne(userId, tenantId);

    if (!user.phoneNumber) {
      throw new NotFoundException(
        "User does not have a phone number configured",
      );
    }

    const sessionId = `whatsapp-${user.phoneNumber.slice(1)}`;

    try {
      const sessionStatus =
        await this.whatsappService.getSessionStatus(sessionId);

      return {
        sessionId,
        phoneNumber: user.phoneNumber,
        healthStatus: {
          lastCheck:
            sessionStatus.lastHealthCheckAt || new Date().toISOString(),
          lastStatus: sessionStatus.lastHealthStatus || "unknown",
          consecutiveFailures: sessionStatus.consecutiveHealthFailures || 0,
          successRate: 100, // TODO: Calculate actual success rate
          recentChecks: 1, // TODO: Track recent checks
          alertTriggered: sessionStatus.alertTriggered || false,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to get health status for user ${userId}:`,
        error,
      );
      throw new NotFoundException("WhatsApp session not found for this user");
    }
  }

  async triggerUserHealthCheck(userId: string, tenantId: string): Promise<any> {
    const user = await this.findOne(userId, tenantId);

    if (!user.phoneNumber) {
      throw new NotFoundException(
        "User does not have a phone number configured",
      );
    }

    const sessionId = `whatsapp-${user.phoneNumber.slice(1)}`;

    try {
      // Trigger an immediate health check using the same flow as the periodic scheduler
      // (persist + alert + reconnect), then return the standard session status payload.
      const sessionStatus =
        await this.whatsappHealthService.runHealthCheckForSessionId(sessionId);

      this.logger.log(
        `Triggered health check for session ${sessionId} (manual)`,
      );

      return {
        sessionId,
        phoneNumber: user.phoneNumber,
        message: "Health check triggered successfully",
        healthStatus: {
          lastCheck:
            sessionStatus?.healthStatus?.lastCheck ||
            sessionStatus?.lastHealthCheckAt ||
            new Date().toISOString(),
          lastStatus:
            sessionStatus?.healthStatus?.lastStatus ||
            sessionStatus?.lastHealthStatus ||
            "unknown",
          consecutiveFailures:
            sessionStatus?.healthStatus?.consecutiveFailures ||
            sessionStatus?.consecutiveHealthFailures ||
            0,
          successRate: sessionStatus?.healthStatus?.successRate || 100,
          recentChecks: sessionStatus?.healthStatus?.recentChecks || 1,
          alertTriggered: (sessionStatus as any)?.alertTriggered || false,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to trigger health check for user ${userId}:`,
        error,
      );
      throw new BadRequestException("Failed to trigger health check");
    }
  }
}
