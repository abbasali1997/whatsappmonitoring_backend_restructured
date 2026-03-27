import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { Connection, Model, Types } from "mongoose";
import { Client } from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import { ConfigService } from "@nestjs/config";
import {
  WhatsAppSession,
  SessionStatus,
} from "../../common/schemas/whatsapp-session.schema";
import {
  Message,
  MessageDirection,
  MessageStatus,
} from "../../common/schemas/message.schema";
import {
  User,
  WhatsAppConnectionStatus,
} from "../../common/schemas/user.schema";
import * as mongoose from "mongoose";
import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { EntitiesService } from "../entities/entities.service";
import { WhatsAppQueueService } from "../whatsapp-queue/whatsapp-queue.service";
import { firstValueFrom } from "rxjs";
import { AxiosError } from "axios";
import { HttpService } from "@nestjs/axios";

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly execFileAsync = promisify(execFile);
  private clients: Map<string, Client> = new Map();
  private remoteAuthStore: any | null = null;
  private healthChecks: Map<
    string,
    {
      lastCheck: Date;
      lastStatus: "success" | "failed" | "warning";
      consecutiveFailures: number;
      successRate: number;
      recentChecks: number;
    }
  > = new Map();
  // Timer for periodic idle client cleanup
  private idleCleanupTimer: NodeJS.Timeout | null = null;
  // Timer for periodic reconnect sweeps in multi-pod setups
  // private reconnectSweepTimer: NodeJS.Timeout | null = null;
  // private reconnectSweepInProgress = false;
  // Track cleanup state to avoid re-init while session files are locked
  private readonly cleanupInProgress: Set<string> = new Set();
  // Track sessions currently initializing to avoid idle cleanup during long startups
  private readonly initializingSessions: Set<string> = new Set();
  // Track sessions being intentionally disconnected with preserveStatus to ignore
  // spurious 'disconnected' events fired by destroy()
  private readonly disconnectingWithPreserve: Set<string> = new Set();
  // Cross-pod ownership (avoid multiple pods initializing same session)
  private readonly connectionOwnerId =
    process.env.POD_NAME || process.env.HOSTNAME || os.hostname();
  private readonly sessionLockRefreshTimers: Map<string, NodeJS.Timeout> =
    new Map();

  // Expose state for gateway guards (read-only)
  public isInitializing = (sessionId: string): boolean =>
    this.initializingSessions.has(sessionId);
  public isCleanupInProgress = (sessionId: string): boolean =>
    this.cleanupInProgress.has(sessionId);

  private ensureRemoteAuthStore(): any {
    if (this.remoteAuthStore) return this.remoteAuthStore;

    // IMPORTANT: In NestJS, `MongooseModule.forRoot*` uses `mongoose.createConnection()`,
    // so the active DB is NOT necessarily available at `mongoose.connection`.
    // `wwebjs-mongo` expects an object with `.connection.db` and `.mongo.GridFSBucket`.
    const mongooseLike = {
      connection: this.mongooseConnection as any,
      mongo: (mongoose as any).mongo,
    };

    this.remoteAuthStore = new MongoStore({ mongoose: mongooseLike as any });
    this.instrumentRemoteAuthStore(this.remoteAuthStore);
    this.logger.log("[SERVICE] RemoteAuth store initialized (MongoStore)");
    return this.remoteAuthStore;
  }

  private remoteAuthStoreInstrumented = false;

  /**
   * Instrument wwebjs-mongo store methods to help debug RemoteAuth persistence issues.
   * This is especially useful when backups exist but sessions still require QR after restart.
   */
  private instrumentRemoteAuthStore(store: any): void {
    if (this.remoteAuthStoreInstrumented) return;
    if (!store) return;
    this.remoteAuthStoreInstrumented = true;

    try {
      const originalSave =
        typeof store.save === "function" ? store.save.bind(store) : null;
      if (originalSave) {
        store.save = async (options: any) => {
          const sessionName = options?.session;
          const zipPath = `${sessionName}.zip`;
          const startedAt = Date.now();
          try {
            const exists = fsSync.existsSync(zipPath);
            const size = exists ? fsSync.statSync(zipPath).size : undefined;
            this.logger.log(
              `[REMOTE_AUTH_STORE] save(start) session=${sessionName}, zipExists=${exists}${
                typeof size === "number" ? `, zipSize=${size}` : ""
              }`,
            );
          } catch {
            this.logger.log(
              `[REMOTE_AUTH_STORE] save(start) session=${sessionName}`,
            );
          }

          try {
            const res = await originalSave(options);
            const durationMs = Date.now() - startedAt;
            this.logger.log(
              `[REMOTE_AUTH_STORE] save(done) session=${sessionName}, durationMs=${durationMs}`,
            );
            return res;
          } catch (e) {
            const durationMs = Date.now() - startedAt;
            this.logger.error(
              `[REMOTE_AUTH_STORE] save(failed) session=${sessionName}, durationMs=${durationMs}, error=${
                e instanceof Error ? e.message : String(e)
              }`,
              e instanceof Error ? e.stack : undefined,
            );
            throw e;
          }
        };
      }

      const originalExtract =
        typeof store.extract === "function" ? store.extract.bind(store) : null;
      if (originalExtract) {
        store.extract = async (options: any) => {
          const sessionName = options?.session;
          const destPath = options?.path;
          const startedAt = Date.now();
          this.logger.log(
            `[REMOTE_AUTH_STORE] extract(start) session=${sessionName}, dest=${destPath}`,
          );
          try {
            const res = await originalExtract(options);
            const durationMs = Date.now() - startedAt;
            this.logger.log(
              `[REMOTE_AUTH_STORE] extract(done) session=${sessionName}, durationMs=${durationMs}`,
            );
            return res;
          } catch (e) {
            const durationMs = Date.now() - startedAt;
            this.logger.error(
              `[REMOTE_AUTH_STORE] extract(failed) session=${sessionName}, durationMs=${durationMs}, error=${
                e instanceof Error ? e.message : String(e)
              }`,
              e instanceof Error ? e.stack : undefined,
            );
            throw e;
          }
        };
      }
    } catch (e) {
      this.logger.warn(
        `[REMOTE_AUTH_STORE] Failed to instrument MongoStore: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private getClientBrowserPid(client: Client | undefined): number | undefined {
    try {
      const pid = (client as any)?.pupBrowser?.process?.()?.pid;
      return typeof pid === "number" ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private async killProcessTree(pid: number): Promise<void> {
    if (!pid || pid <= 0) return;
    try {
      if (os.platform() === "win32") {
        // /T kills the process tree; /F forces termination.
        await this.execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
      } else {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    } catch (error) {
      // Best-effort. If this fails, cleanup may still work after retries.
      this.logger.debug(
        `[SERVICE] Failed to kill process tree for pid=${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async ensureAuthClientId(sessionId: string): Promise<string> {
    const doc = await this.sessionModel
      .findOne({ sessionId })
      .select("authClientId")
      .lean();
    return (doc as any)?.authClientId || sessionId;
  }

  private async cleanupSessionFilesByClientId(
    clientId: string,
    maxRetries = os.platform() === "win32" ? 12 : 5,
    retryDelay = os.platform() === "win32" ? 2000 : 2000,
  ): Promise<boolean> {
    const authPath =
      process.env.WWEBJS_AUTH_PATH || `${process.cwd()}/.wwebjs_auth`;
    const sessionPaths = [
      // RemoteAuth naming (current)
      `${authPath}/RemoteAuth-${clientId}`,
      // Legacy LocalAuth naming (pre-migration) - keep cleaning it to avoid stale locks/files
      `${authPath}/session-${clientId}`,
    ];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const existing = sessionPaths.filter((p) => fsSync.existsSync(p));
        if (!existing.length) {
          this.logger.debug(
            `Session directory does not exist, nothing to clean: ${sessionPaths.join(
              ", ",
            )}`,
          );
          return true;
        }

        for (const sessionPath of existing) {
          await fs.rm(sessionPath, {
            recursive: true,
            force: true,
            maxRetries: 3,
          });
        }
        this.logger.log(
          `Successfully cleaned up session files for clientId=${clientId} on attempt ${attempt}`,
        );
        return true;
      } catch (error: any) {
        const isRetryable =
          error?.code === "EBUSY" ||
          error?.code === "EPERM" ||
          error?.code === "ENOTEMPTY";

        if (isRetryable && attempt < maxRetries) {
          this.logger.warn(
            `Cleanup attempt ${attempt} failed (${error.code}) for clientId=${clientId}, retrying in ${retryDelay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          this.logger.warn(
            `Could not fully clean up session files for clientId=${clientId} after ${attempt} attempts: ${error?.message || error}. ` +
              `Files may need manual cleanup under: ${authPath}`,
          );
          return false;
        }
      }
    }
    return false;
  }

  private async cleanupSessionFilesForSession(
    sessionId: string,
  ): Promise<boolean> {
    const currentClientId = await this.ensureAuthClientId(sessionId);
    const candidates = Array.from(new Set([currentClientId, sessionId])).filter(
      Boolean,
    );

    let allClean = true;
    for (const clientId of candidates) {
      const ok = await this.cleanupSessionFilesByClientId(clientId);
      if (!ok) allClean = false;
    }
    return allClean;
  }

  constructor(
    @InjectConnection()
    private readonly mongooseConnection: Connection,
    @InjectModel(WhatsAppSession.name)
    private sessionModel: Model<WhatsAppSession>,
    @InjectModel(Message.name)
    private messageModel: Model<Message>,
    @InjectModel(User.name)
    private userModel: Model<User>,
    private configService: ConfigService,
    private entityService: EntitiesService,
    private whatsappQueueService: WhatsAppQueueService,
    private readonly httpService: HttpService,
  ) {}

  private buildRedactedParticipantId(pseudonym: string): string {
    const token = String(pseudonym || "deleted")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return `deleted:${token || "deleted"}`;
  }

  private jidFromE164(phoneNumber: string): string {
    const digits = String(phoneNumber || "").replace(/[^\d]/g, "");
    return `${digits}@c.us`;
  }

  /**
   * LGPD/GDPR: Pseudonymize message participant identity for a deleted user while keeping
   * message content and conversation history intact.
   */
  async pseudonymizeMessagesForDeletedUser(params: {
    tenantId:
      | string
      | Types.ObjectId
      | { _id?: string | Types.ObjectId }
      | null
      | undefined;
    phoneNumber: string;
    pseudonym: string;
    deletedBy?: string;
  }): Promise<{ matched: number; modified: number }> {
    const { tenantId, phoneNumber, pseudonym, deletedBy } = params;

    const normalizeTenantObjectId = (): Types.ObjectId => {
      const raw: any =
        (tenantId as any)?._id !== undefined ? (tenantId as any)._id : tenantId;

      if (raw instanceof Types.ObjectId) {
        return raw;
      }

      const asString = String(raw || "").trim();
      if (!asString || !Types.ObjectId.isValid(asString)) {
        throw new Error("Invalid tenantId for pseudonymization");
      }
      return new Types.ObjectId(asString);
    };

    let tenantObjectId: Types.ObjectId;
    try {
      tenantObjectId = normalizeTenantObjectId();
    } catch {
      throw new Error("Invalid tenantId for pseudonymization");
    }
    if (!phoneNumber) {
      return { matched: 0, modified: 0 };
    }

    const jid = this.jidFromE164(phoneNumber);
    const redacted = this.buildRedactedParticipantId(pseudonym);
    const now = new Date();

    const fromRes = await this.messageModel.updateMany(
      {
        tenantId: tenantObjectId,
        $or: [{ fromPhoneNumber: phoneNumber }, { from: jid }],
      },
      {
        $set: {
          fromName: pseudonym,
          fromPhoneNumber: redacted,
          from: redacted,
          fromAvatarUrl: null,
          whatsappUsername: pseudonym,
          updatedBy: deletedBy,
          updatedAt: now,
          "metadata.senderContactName": pseudonym,
          "metadata.senderContactPhone": null,
        },
        $unset: {
          "metadata.registeredUserInfo": "",
        },
      },
    );

    const toRes = await this.messageModel.updateMany(
      {
        tenantId: tenantObjectId,
        $or: [{ toPhoneNumber: phoneNumber }, { to: jid }],
      },
      {
        $set: {
          toName: pseudonym,
          toPhoneNumber: redacted,
          to: redacted,
          toAvatarUrl: null,
          updatedBy: deletedBy,
          updatedAt: now,
        },
      },
    );

    const matched =
      Number((fromRes as any)?.matchedCount ?? (fromRes as any)?.n ?? 0) +
      Number((toRes as any)?.matchedCount ?? (toRes as any)?.n ?? 0);
    const modified =
      Number(
        (fromRes as any)?.modifiedCount ?? (fromRes as any)?.nModified ?? 0,
      ) +
      Number((toRes as any)?.modifiedCount ?? (toRes as any)?.nModified ?? 0);

    return { matched, modified };
  }

  /**
   * LGPD/GDPR: deactivate WhatsApp sessions tied to a deleted user (scrub phone/session data)
   */
  async deactivateSessionsForDeletedUser(
    userId: string,
    deletedBy?: string,
  ): Promise<void> {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      return;
    }

    await this.sessionModel.updateMany(
      { userId: new Types.ObjectId(userId) },
      {
        $set: {
          isActive: false,
          status: SessionStatus.DISCONNECTED,
          userId: null,
          phoneNumber: null,
          whatsappName: null,
          whatsappId: null,
          sessionData: null,
          qrCode: null,
          qrCodeUrl: null,
          updatedBy: deletedBy,
          disconnectedAt: new Date(),
        },
      },
    );
  }

  /**
   * Check if queue should be used (not on localhost)
   * @returns true if queue should be used, false if running on localhost
   */
  private shouldUseQueue(): boolean {
    const serviceBusConnectionString = this.configService.get<string>(
      "azure.serviceBus.connectionString",
    );
    if (!serviceBusConnectionString) {
      return false;
    }

    const nodeEnv = this.configService.get<string>(
      "app.nodeEnv",
      "development",
    );
    const baseUrl = this.configService.get<string>(
      "app.baseUrl",
      "http://localhost:3000",
    );
    const isLocalhost =
      nodeEnv === "development" ||
      baseUrl.includes("localhost") ||
      baseUrl.includes("127.0.0.1");

    // Don't use queue on localhost
    return !isLocalhost;
  }

  private async releaseSessionLock(sessionId: string): Promise<void> {
    await this.sessionModel.updateOne(
      { sessionId, connectionOwner: this.connectionOwnerId },
      {
        $unset: {
          connectionOwner: "",
          connectionOwnerExpiresAt: "",
          connectionOwnerHeartbeatAt: "",
        },
      },
    );
  }

  private stopSessionLockRefresh(sessionId: string): void {
    const timer = this.sessionLockRefreshTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.sessionLockRefreshTimers.delete(sessionId);
    }
  }

  async onModuleInit() {
    this.logger.log("WhatsApp Service initialized");
  }

  async onModuleDestroy() {
    this.logger.log("Destroying all WhatsApp clients");

    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }

    for (const [sessionId] of this.clients.entries()) {
      await this.disconnectSession(sessionId);
    }
  }

  // private getReconnectSweepIntervalMs(): number {
  //   return (
  //     Number(
  //       this.configService.get<string>(
  //         "whatsapp.reconnectSweepIntervalMs",
  //         process.env.WHATSAPP_RECONNECT_SWEEP_INTERVAL_MS || "120000",
  //       ),
  //     ) || 120000
  //   );
  // }

  async createSession(
    sessionId: string,
    userId: Types.ObjectId,
    invitedBy: string,
    entityId: string,
    tenantId: string,
  ): Promise<WhatsAppSession> {
    this.logger.log(`Creating new WhatsApp session: ${sessionId}`);
    // Get entity path before creating session
    const entityObjectId = new Types.ObjectId(entityId);
    this.logger.log(`Creating WhatsApp session for entity: ${entityId}`);

    let entityIdPath: Types.ObjectId[] = [];

    // Check if this is a System Admin (special entity ID)
    const isSystemAdmin = entityId === "000000000000000000000001";

    if (isSystemAdmin) {
      this.logger.log("Creating session for Administrator");
      entityIdPath = [entityObjectId]; // System Admin's own entity ID only
    } else {
      // For regular users, get the full entity path
      const entity = await this.entityService.findOne(entityId, null);

      if (!entity) {
        throw new Error(`Entity not found: ${entityId}`);
      }

      if (!entity.entityIdPath || !entity.entityIdPath.length) {
        this.logger.warn(
          `No entity path found for entity: ${entityId}, using entity ID only`,
        );
        entityIdPath = [entityObjectId];
      } else {
        entityIdPath = entity.entityIdPath;
      }
    }

    // Check if session already exists
    let session = await this.sessionModel.findOne({ sessionId });

    if (!session) {
      session = await this.sessionModel.create({
        _id: new Types.ObjectId(),
        sessionId,
        userId,
        entityId: entityObjectId,
        entityIdPath: entityIdPath,
        tenantId: isSystemAdmin ? entityObjectId : new Types.ObjectId(tenantId),
        status: SessionStatus.CONNECTING,
        createdBy: invitedBy,
      });
    } else {
      // Update existing session with entity path
      session = await this.sessionModel.findOneAndUpdate(
        { sessionId },
        {
          entityIdPath: entityIdPath,
          tenantId: isSystemAdmin
            ? entityObjectId
            : new Types.ObjectId(tenantId),
          lastActivityAt: new Date(),
        },
        { new: true },
      );
    }

    // Initialize WhatsApp client (queue-based if available and not on localhost)
    const hasQueue = this.shouldUseQueue();
    const nodeEnv = this.configService.get<string>(
      "app.nodeEnv",
      "development",
    );
    this.logger.debug(
      `[SERVICE] Checking queue availability for session init: sessionId=${sessionId}, hasQueue=${hasQueue}, nodeEnv=${nodeEnv}`,
    );
    if (hasQueue) {
      this.logger.debug(
        `[SERVICE] Using queue-based initialization: sessionId=${sessionId}, userId=${userId?.toString?.()}, tenantId=${tenantId}`,
      );
      try {
        await this.whatsappQueueService.queueInitializeSession(
          sessionId,
          userId?.toString?.(),
          tenantId,
        );
        this.logger.debug(
          `[SERVICE] Successfully queued session initialization: sessionId=${sessionId}`,
        );
      } catch (queueError) {
        this.logger.error(
          `[SERVICE] Failed to queue session initialization, falling back to direct init: sessionId=${sessionId}, error=${queueError instanceof Error ? queueError.message : String(queueError)}`,
          queueError instanceof Error ? queueError.stack : undefined,
        );
        this.logger.debug(
          `[SERVICE] Falling back to direct initialization: sessionId=${sessionId}`,
        );
        await this.initializeClient(sessionId);
      }
    } else {
      this.logger.debug(
        `[SERVICE] Queue not available, using direct initialization: sessionId=${sessionId}`,
      );
      await this.initializeClient(sessionId);
    }

    return session;
  }

  async recreateSession(
    sessionId: string,
    userId: Types.ObjectId,
    invitedBy: string,
    entityId: string,
    tenantId: string,
  ): Promise<{ session: WhatsAppSession; initializedNewClient: boolean }> {
    this.logger.log(
      `[SERVICE] Recreating WhatsApp session: sessionId=${sessionId}, userId=${userId.toString()}, invitedBy=${invitedBy}, entityId=${entityId}, tenantId=${tenantId}`,
    );

    // Get entity path before recreating session (same as createSession)
    const entityObjectId = new Types.ObjectId(entityId);

    let entityIdPath: Types.ObjectId[] = [];

    // Check if this is a System Admin (special entity ID)
    const isSystemAdmin = entityId === "000000000000000000000001";

    if (isSystemAdmin) {
      this.logger.log(
        `[SERVICE] Recreating session for Administrator: sessionId=${sessionId}`,
      );
      entityIdPath = [entityObjectId]; // System Admin's own entity ID only
    } else {
      // For regular users, get the full entity path
      const entity = await this.entityService.findOne(entityId, null);

      if (!entity) {
        throw new Error(`Entity not found: ${entityId}`);
      }

      if (!entity.entityIdPath || !entity.entityIdPath.length) {
        this.logger.warn(
          `No entity path found for entity: ${entityId}, using entity ID only`,
        );
        entityIdPath = [entityObjectId];
      } else {
        entityIdPath = entity.entityIdPath;
      }
    }

    // Check if session already exists
    let session = await this.sessionModel.findOne({ sessionId });

    if (!session) {
      session = await this.sessionModel.create({
        _id: new Types.ObjectId(),
        sessionId,
        userId,
        entityId: entityObjectId,
        entityIdPath: entityIdPath,
        tenantId: isSystemAdmin ? entityObjectId : new Types.ObjectId(tenantId),
        status: SessionStatus.CONNECTING,
        createdBy: invitedBy,
      });
    } else {
      // IMPORTANT: Don't reset status if session is already connected (READY or AUTHENTICATED)
      // This prevents disconnecting an active session when opening the QR modal
      const isConnected =
        session.status === SessionStatus.READY ||
        session.status === SessionStatus.AUTHENTICATED;

      if (isConnected) {
        this.logger.log(
          `[SERVICE] Session ${sessionId} is already connected (status=${session.status}), preserving status`,
        );
        // Only update non-status fields for connected sessions
        session = await this.sessionModel.findOneAndUpdate(
          { sessionId },
          {
            userId,
            entityId: entityObjectId,
            entityIdPath: entityIdPath,
            tenantId: isSystemAdmin
              ? entityObjectId
              : new Types.ObjectId(tenantId),
            lastActivityAt: new Date(),
          },
          { new: true },
        );
      } else {
        session = await this.sessionModel.findOneAndUpdate(
          { sessionId },
          {
            userId,
            entityId: entityObjectId,
            entityIdPath: entityIdPath,
            tenantId: isSystemAdmin
              ? entityObjectId
              : new Types.ObjectId(tenantId),
            status: SessionStatus.CONNECTING,
            lastActivityAt: new Date(),
          },
          { new: true },
        );
      }
    }

    this.logger.debug(
      `[SERVICE] Recreate session document prepared: sessionId=${sessionId}`,
    );

    // Always ensure the client is initialized (without tearing down existing ones)
    let initializedNewClient = false;
    try {
      if (this.clients.has(sessionId)) {
        try {
          const client = this.clients.get(sessionId);
          const state = client
            ? await client.getState().catch(() => null)
            : null;
          if (state === "CONNECTED") {
            this.logger.debug(
              `[SERVICE] Existing client for ${sessionId} is CONNECTED; skipping re-init.`,
            );
            return { session, initializedNewClient: false };
          }
        } catch (stateErr) {
          this.logger.warn(
            `[SERVICE] Could not read client state for ${sessionId}: ${stateErr instanceof Error ? stateErr.message : stateErr}`,
          );
        }
        this.logger.debug(
          `[SERVICE] Existing client detected for session ${sessionId}; skipping initialization.`,
        );
      } else {
        this.logger.debug(
          `[SERVICE] Recreate session triggering initialization: sessionId=${sessionId}`,
        );
        await this.initializeClient(sessionId);
        initializedNewClient = true;
        this.logger.debug(
          `[SERVICE] Initialization completed for recreated session: sessionId=${sessionId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[SERVICE] Failed to initialize recreated session: sessionId=${sessionId}, error=${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }

    return { session, initializedNewClient };
  }

  async initializeClient(sessionId: string): Promise<{
    success: boolean;
    message: string;
    sessionId: string;
  }> {
    const baseUrl = this.configService.get<string>(
      "whatsappManager.baseUrl",
      "http://localhost:3002",
    );
    const apiKey = this.configService.get<string>("whatsappManager.apiKey", "");
    const timeout = this.configService.get<number>(
      "whatsappManager.timeoutMs",
      15000,
    );

    const url = `${baseUrl}/clients/init`;

    try {
      const { data } = await firstValueFrom(
        this.httpService.post(
          url,
          { sessionId },
          {
            timeout,
            headers: {
              "x-internal-api-key": apiKey,
              "Content-Type": "application/json",
            },
          },
        ),
      );

      this.logger.log(
        `WhatsApp manager init request sent successfully for sessionId=${sessionId}`,
      );

      return data as {
        success: boolean;
        message: string;
        sessionId: string;
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ message?: string }>;
      const status = axiosError.response?.status;
      const responseData = axiosError.response?.data;

      this.logger.error(
        `Failed to call WhatsApp manager init API for sessionId=${sessionId}. status=${String(
          status,
        )} error=${axiosError.message} response=${JSON.stringify(responseData)}`,
        axiosError.stack,
      );

      throw new InternalServerErrorException(
        responseData?.message ||
          "Failed to start WhatsApp client on manager service",
      );
    }
  }

  // async sendMediaMessage(
  //   sessionId: string,
  //   to: string,
  //   message: string,
  //   mediaBuffer: Buffer,
  //   contentType: string,
  //   mediaType: 'image' | 'video' | 'audio' | 'document',
  //   userId: string,
  // ): Promise<Message> {
  //   const client = this.clients.get(sessionId);
  //   if (!client) {
  //     throw new Error(`No active client for session: ${sessionId}`);
  //   }

  //   const session = await this.sessionModel.findOne({ sessionId });
  //   if (!session) {
  //     throw new Error(`Session not found: ${sessionId}`);
  //   }

  //   try {
  //     // Create MessageMedia from buffer
  //     const media = new MessageMedia(contentType, mediaBuffer.toString('base64'));

  //     // Send message with media
  //     const sentMessage = await client.sendMessage(to, media, { caption: message });

  //     // Get entity with path
  //     const entity = await this.entityService.findOne(session.entityId.toString(), null);
  //     if (!entity.entityIdPath || entity.entityIdPath.length === 0) {
  //       this.logger.warn(`Failed to get entity path for entity: ${session.entityId}`);
  //     }

  //     // Create message record
  //     const fromPhoneNumber = await this.getE164FromSession(sessionId);
  //     const toPhoneNumber = this.cleanPhoneNumber(to);

  //     const messageData = await this.messageModel.create({
  //       whatsappMessageId: sentMessage.id._serialized,
  //       sessionId: session._id,
  //       entityId: session.entityId,
  //       entityIdPath: entity.entityIdPath || [],
  //       direction: MessageDirection.OUTBOUND,
  //       from: session.phoneNumber,
  //       to: to,
  //       fromPhoneNumber,
  //       toPhoneNumber,
  //       content: message,
  //       messageType: this.getMessageType(mediaType),
  //       status: MessageStatus.SENT,
  //       mediaUrl: null, // Will be set by storage service
  //       metadata: {
  //         mediaType,
  //         contentType,
  //         size: mediaBuffer.length,
  //       },
  //       timestamp: new Date(),
  //       userId: new Types.ObjectId(userId),
  //       tenantId: session.tenantId,
  //     });

  //     this.logger.log(`Media message sent successfully: ${sentMessage.id._serialized}`);
  //     return messageData;
  //   } catch (error) {
  //     this.logger.error(`Failed to send media message: ${error.message}`);
  //     throw error;
  //   }
  // }

  // async sendMessage(
  //   sessionId: string,
  //   to: string,
  //   content: string | MessageMedia,
  //   userId: string,
  //   options: { caption?: string } = {},
  //   retryCount: number = 0
  // ): Promise<Message> {
  //   const client = this.clients.get(sessionId);
  //   if (!client) {
  //     throw new Error(`No active client for session: ${sessionId}`);
  //   }

  //   const session = await this.sessionModel.findOne({ sessionId });
  //   if (!session) {
  //     throw new Error(`Session not found: ${sessionId}`);
  //   }

  //   try {
  //     let sentMessage;
  //     let messageType = MessageType.TEXT;
  //     let mediaUrl = null;

  //     if (typeof content === 'string') {
  //       // Text message
  //       sentMessage = await client.sendMessage(to, content);
  //     } else {
  //       // Media message
  //       sentMessage = await client.sendMessage(to, content, { caption: options.caption });
  //       messageType = this.getMessageType(content.mimetype.split('/')[0]);

  //       // Upload media to cloud storage using StorageService
  //       const extension = content.mimetype.split('/')[1];
  //       const fileName = `${sentMessage.id._serialized}.${extension}`;

  //       const buffer = Buffer.from(content.data, 'base64');
  //       const uploadResult = await this.storageService.uploadFile(
  //         buffer,
  //         fileName,
  //         content.mimetype,
  //         'whatsapp-media',
  //       );

  //       mediaUrl = uploadResult.proxyUrl;
  //     }

  //     // Get entity with path
  //     const entity = await this.entityService.findOne(session.entityId.toString(), null);
  //     if (!entity.entityIdPath || entity.entityIdPath.length === 0) {
  //       this.logger.warn(`Failed to get entity path for entity: ${session.entityId}`);
  //     }

  //     const fromPhoneNumber = await this.getE164FromSession(sessionId);
  //     const toPhoneNumber = this.cleanPhoneNumber(to);

  //     const messageData = await this.messageModel.create({
  //       whatsappMessageId: sentMessage.id._serialized,
  //       from: session.phoneNumber,
  //       to,
  //       fromPhoneNumber,
  //       toPhoneNumber,
  //       type: messageType,
  //       direction: MessageDirection.OUTBOUND,
  //       content: typeof content === 'string' ? content : options.caption || '',
  //       mediaUrl,
  //       status: MessageStatus.SENT,
  //       sentAt: new Date(),
  //       conversationId: to,
  //       entityId: session.entityId,
  //       entityIdPath: entity.entityIdPath,
  //       tenantId: session.tenantId,
  //       createdBy: userId,
  //       metadata: {
  //         hasMedia: mediaUrl !== null,
  //         mediaType: typeof content === 'string' ? null : content.mimetype,
  //         caption: options.caption,
  //       },
  //     });

  //     // Update session statistics
  //     await this.sessionModel.findOneAndUpdate(
  //       { sessionId },
  //       {
  //         $inc: { messagesSent: 1 },
  //         lastActivityAt: new Date(),
  //       },
  //     );

  //     this.logger.log(`Message sent successfully: ${sentMessage.id._serialized}`);
  //     return messageData;
  //   } catch (error) {
  //     this.logger.error(`Failed to send message: ${error.message}`, error);

  //     // Send to DLQ for retry if not already from DLQ
  //     if (retryCount === 0) {
  //       await this.dlqService.sendToDLQ(
  //         {
  //           sessionId,
  //           to,
  //           content,
  //           userId,
  //           options,
  //         },
  //         error,
  //         {
  //           topic: 'whatsapp-messages',
  //           subscription: 'message-retry',
  //           maxRetries: 5,
  //           retryDelay: 300000, // 5 minutes
  //         }
  //       );
  //     }

  //     throw error;
  //   }
  // }

  async getQRCode(
    sessionId: string,
  ): Promise<{ qrCode: string; expiresAt: Date } | null> {
    const session = await this.sessionModel.findOne({ sessionId });
    if (!session || !session.qrCode) {
      return null;
    }

    // Return the raw base64 string - frontend will add data:image/png;base64, prefix
    return {
      qrCode: session.qrCode,
      expiresAt: session.qrCodeExpiresAt,
    };
  }

  async getSessionStatus(sessionId: string): Promise<any> {
    const session = await this.sessionModel.findOne({ sessionId });
    if (!session) {
      throw new NotFoundException("Session not found");
    }

    // Get health check status
    let healthStatus = this.healthChecks.get(sessionId);
    if (!healthStatus) {
      healthStatus = {
        lastCheck: new Date(),
        lastStatus: "success",
        consecutiveFailures: 0,
        successRate: 100,
        recentChecks: 0,
      };
      this.healthChecks.set(sessionId, healthStatus);
    }

    // Check current status
    const client = this.clients.get(sessionId);
    if (client) {
      const failureThreshold =
        Number(
          this.configService.get<string>(
            "whatsapp.healthCheckFailureThreshold",
            process.env.WHATSAPP_HEALTHCHECK_FAILURE_THRESHOLD || "3",
          ),
        ) || 3;
      const activityGraceMs =
        Number(
          this.configService.get<string>(
            "whatsapp.healthActivityGraceMs",
            process.env.WHATSAPP_HEALTH_ACTIVITY_GRACE_MS || "120000",
          ),
        ) || 120000; // default: 2 minutes
      const lastActivityAtMs = session.lastActivityAt
        ? new Date(session.lastActivityAt as any).getTime()
        : 0;
      const isRecentlyActive =
        lastActivityAtMs > 0 &&
        Date.now() - lastActivityAtMs <= activityGraceMs;
      try {
        const state = await client.getState();
        // whatsapp-web.js states can be transient (e.g., OPENING) even while messages still flow.
        // Treat only persistent failures as "failed"; treat transient states as "warning".
        const normalizedState = String(state || "").toUpperCase();
        const transientProblemStates = new Set([
          "DISCONNECTED",
          "CONFLICT",
          "PAIRING",
        ]);
        const hardFailStates = new Set(["UNLAUNCHED", "TIMEOUT", "UNPAIRED"]);

        if (normalizedState === "CONNECTED") {
          healthStatus.lastStatus = "success";
          healthStatus.consecutiveFailures = 0;
        } else if (isRecentlyActive) {
          // If messages are still flowing recently, avoid false "unstable" caused by transient states.
          healthStatus.lastStatus = "success";
          healthStatus.consecutiveFailures = 0;
        } else if (hardFailStates.has(normalizedState)) {
          // Hard failures should count towards the threshold.
          healthStatus.consecutiveFailures++;
          healthStatus.lastStatus =
            healthStatus.consecutiveFailures >= failureThreshold
              ? "failed"
              : "warning";
        } else if (transientProblemStates.has(normalizedState)) {
          // Transient states can happen without impacting message flow; do not increment failures.
          healthStatus.lastStatus = "warning";
        } else {
          // OPENING / RESUMING / etc
          healthStatus.lastStatus = "warning";
        }
        healthStatus.lastCheck = new Date();
        healthStatus.recentChecks++;
        healthStatus.successRate =
          ((healthStatus.recentChecks - healthStatus.consecutiveFailures) /
            healthStatus.recentChecks) *
          100;
        this.healthChecks.set(sessionId, healthStatus);
      } catch (error) {
        this.logger.error(`Failed to get client state: ${error.message}`);
        if (isRecentlyActive) {
          // If the client is still active, don't mark it unstable just because getState failed.
          healthStatus.lastStatus = "warning";
        } else {
          healthStatus.consecutiveFailures++;
          healthStatus.lastStatus =
            healthStatus.consecutiveFailures >= failureThreshold
              ? "failed"
              : "warning";
        }
        healthStatus.lastCheck = new Date();
        healthStatus.recentChecks++;
        healthStatus.successRate =
          ((healthStatus.recentChecks - healthStatus.consecutiveFailures) /
            healthStatus.recentChecks) *
          100;
        this.healthChecks.set(sessionId, healthStatus);
      }
    }

    return {
      ...session.toObject(),
      healthStatus: {
        ...healthStatus,
        // IMPORTANT: this is persisted and updated only by the periodic scheduler.
        // Manual/dedicated checks may run, but must not change this value.
        nextCheck: (session as any).nextHealthCheckAt,
      },
    };
  }

  hasActiveClient(sessionId: string): boolean {
    return this.clients.has(sessionId);
  }

  /**
   * Returns sessionIds for WhatsApp clients currently active in this process.
   * Useful for health-check selection when DB state is stale/lagging in multi-pod deployments.
   */
  listActiveClientSessionIds(): string[] {
    return Array.from(this.clients.keys());
  }

  // NOTE: cleanupSessionFiles(...) was replaced by:
  // - cleanupSessionFilesByClientId(clientId)
  // - cleanupSessionFilesForSession(sessionId)

  async disconnectSession(
    sessionId: string,
    options?: {
      preserveStatus?: boolean;
      /**
       * When true, deletes local auth/session folders under `.wwebjs_auth`.
       * WARNING: this will effectively unlink the WhatsApp session and will require a new QR.
       *
       * Default: false (disconnect should NOT wipe auth; this avoids losing sessions on restart).
       */
      cleanupSessionFiles?: boolean;
    },
  ): Promise<void> {
    try {
      if (options?.preserveStatus) {
        this.disconnectingWithPreserve.add(sessionId);
      }

      const client = this.clients.get(sessionId);
      if (client) {
        const pid = this.getClientBrowserPid(client);
        // Remove from active clients map first to prevent event handlers from interfering
        this.clients.delete(sessionId);
        this.stopSessionLockRefresh(sessionId);

        // Remove all listeners to prevent 'disconnected' event from triggering handleDisconnected
        // which would incorrectly update the session status in DB when we want to preserve it
        client.removeAllListeners();

        // Destroy browser safely; do not crash on puppeteer “session closed” errors
        try {
          await client.destroy();
          this.logger.log(
            `Successfully destroyed WhatsApp client for session ${sessionId}`,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to destroy client for session ${sessionId}: ${error instanceof Error ? error.message : error}`,
          );
        }

        // Best-effort: ensure underlying Chrome process tree is dead (Windows can keep locks briefly)
        try {
          if (pid) {
            await this.killProcessTree(pid);
          }
        } catch {
          // ignore
        }

        // IMPORTANT:
        // Do NOT delete RemoteAuth/session folders on a normal disconnect.
        // Doing so would wipe stored auth and makes sessions disappear on server restart.
        if (options?.cleanupSessionFiles) {
          try {
            const cleaned = await this.cleanupSessionFilesForSession(sessionId);
            if (!cleaned) {
              this.logger.warn(
                `[SERVICE] Requested cleanupSessionFiles but could not fully clean auth dir for sessionId=${sessionId}`,
              );
            }
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean session files for ${sessionId}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
            );
          }
        }
      }

      if (!options?.preserveStatus) {
        try {
          const session = await this.sessionModel
            .findOneAndUpdate(
              { sessionId },
              {
                status: SessionStatus.DISCONNECTED,
                disconnectedAt: new Date(),
                qrCode: null,
                qrCodeGeneratedAt: null,
                qrCodeExpiresAt: null,
              },
              { new: true },
            )
            .select("userId")
            .lean();

          if ((session as any)?.userId) {
            await this.userModel.findByIdAndUpdate((session as any).userId, {
              whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
            });
          }

          this.logger.log(`Session disconnected successfully: ${sessionId}`);
        } catch (dbError) {
          this.logger.error(
            `Failed to update session status: ${dbError.message}`,
          );
        }
      } else {
        this.logger.debug(
          `Session ${sessionId} disconnected with preserveStatus=true; skipping status update.`,
        );
      }
    } catch (error) {
      // Even if cleanup fails, ensure session is marked as disconnected
      if (!options?.preserveStatus) {
        try {
          const session = await this.sessionModel
            .findOneAndUpdate(
              { sessionId },
              {
                status: SessionStatus.DISCONNECTED,
                disconnectedAt: new Date(),
                lastError: error.message,
                lastErrorAt: new Date(),
              },
              { new: true },
            )
            .select("userId")
            .lean();

          if ((session as any)?.userId) {
            await this.userModel.findByIdAndUpdate((session as any).userId, {
              whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
            });
          }
        } catch (dbError) {
          this.logger.error(
            `Failed to update session status: ${dbError.message}`,
          );
        }
      }

      // Remove from clients map even if cleanup failed
      this.clients.delete(sessionId);

      this.logger.error(
        `Error during session disconnect for ${sessionId}:`,
        error,
      );
      // Do not rethrow to avoid crashing the process on disconnect paths
    } finally {
      // Always clear the marker to avoid leaks
      if (options?.preserveStatus) {
        this.disconnectingWithPreserve.delete(sessionId);
      }
      if (!this.clients.has(sessionId)) {
        this.stopSessionLockRefresh(sessionId);
        await this.releaseSessionLock(sessionId);
      }
    }
  }

  /**
   * Explicit "unlink" behavior: destroy client + remove persisted auth data so next init requires a new QR.
   * This is intentionally separate from `disconnectSession` to avoid wiping sessions on shutdown/restart.
   */
  async removeSession(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);

    // Best-effort: WhatsApp logout so the mobile app removes it from "Linked devices".
    if (client) {
      try {
        const logoutTimeoutMs =
          Number(process.env.WHATSAPP_LOGOUT_TIMEOUT_MS) || 15000;
        await Promise.race([
          client.logout(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("WhatsApp logout timeout")),
              logoutTimeoutMs,
            ),
          ),
        ]);
      } catch (error) {
        this.logger.warn(
          `[SERVICE] removeSession: logout failed for sessionId=${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Disconnect client resources but DO NOT rely on disconnectSession to wipe auth.
    await this.disconnectSession(sessionId, { cleanupSessionFiles: false });

    // Remove persisted RemoteAuth backup(s) from MongoStore + local `.wwebjs_auth` folders.
    try {
      const store = this.ensureRemoteAuthStore();
      const clientId = await this.ensureAuthClientId(sessionId);
      const candidates = Array.from(new Set([clientId, sessionId])).filter(
        Boolean,
      );
      for (const id of candidates) {
        try {
          await store.delete({ session: `RemoteAuth-${id}` });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    // Remove local session folders (RemoteAuth-*/session-*) and clear authClientId so future inits start clean.
    await this.cleanupSessionFilesForSession(sessionId);
    await this.sessionModel.updateOne(
      { sessionId },
      {
        $unset: { authClientId: "" },
        $set: {
          status: SessionStatus.DISCONNECTED,
          disconnectedAt: new Date(),
          qrCode: null,
          qrCodeGeneratedAt: null,
          qrCodeExpiresAt: null,
        },
      },
    );
  }

  async requestReconnect(sessionId: string): Promise<void> {
    try {
      const hasQueue = this.shouldUseQueue();
      this.logger.log(
        `[SERVICE] Requesting reconnect for session=${sessionId}, useQueue=${hasQueue}`,
      );
      if (hasQueue) {
        await this.whatsappQueueService.queueReconnectSession(sessionId);
        this.logger.log(`[SERVICE] Queued reconnect for session=${sessionId}`);
      } else {
        await this.initializeClient(sessionId);
        this.logger.log(
          `[SERVICE] Directly reinitialized session=${sessionId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[SERVICE] Request reconnect failed for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async getMessages(filters: any): Promise<{
    messages: Message[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const query: any = { $and: [{ isActive: true }] };

    if (filters?.tenantId)
      query.$and.push({ tenantId: new Types.ObjectId(filters.tenantId) });

    // Entity filter with hierarchy support
    if (filters?.entityId) {
      const entityId = new Types.ObjectId(filters.entityId);

      // If userEntityIdPath is provided, filter by hierarchy
      if (
        filters?.userEntityIdPath &&
        Array.isArray(filters.userEntityIdPath) &&
        filters.userEntityIdPath.length > 0
      ) {
        // Include messages where entityId is in the user's path OR where message's entityIdPath includes user's entityId
        query.$and.push({
          entityId: {
            $in: [
              ...filters.userEntityIdPath.map(
                (id: string) => new Types.ObjectId(id),
              ),
              entityId,
            ],
          },
        });
      } else {
        // Fallback: Check if the entity ID is in the entityIdPath array
        query.$and.push({
          entityIdPath: entityId,
        });
      }
    } else if (
      filters?.userEntityId &&
      filters?.userEntityIdPath &&
      Array.isArray(filters.userEntityIdPath) &&
      filters.userEntityIdPath.length > 0
    ) {
      // If no specific entityId filter but user has entity hierarchy, filter by hierarchy
      const userEntityId = new Types.ObjectId(filters.userEntityId);
      query.$and.push({
        $or: [
          {
            entityId: {
              $in: [
                ...filters.userEntityIdPath.map(
                  (id: string) => new Types.ObjectId(id),
                ),
                userEntityId,
              ],
            },
          },
          { entityIdPath: { $in: [userEntityId] } },
        ],
      });
    }
    if (filters?.direction) query.$and.push({ direction: filters.direction });
    if (filters?.status) query.$and.push({ status: filters.status });
    if (filters?.type) query.$and.push({ type: filters.type });
    // Phone number search (E164 format)
    if (filters?.phoneNumber) {
      const searchNumber = filters.phoneNumber.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      query.$and.push({
        $or: [
          { fromPhoneNumber: { $regex: searchNumber, $options: "i" } },
          { toPhoneNumber: { $regex: searchNumber, $options: "i" } },
        ],
      });
    }

    if (filters?.to) {
      // Destination (to) substring search (Excel-style "contains")
      // Users often paste partial digits; match against stored toPhoneNumber.
      const raw = String(filters.to || "");
      if (raw.length > 0) {
        const safe = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        query.$and.push({
          $or: [
            { toPhoneNumber: { $regex: safe, $options: "i" } },
            { toName: { $regex: safe, $options: "i" } },
            { whatsappGroupName: { $regex: safe, $options: "i" } },
          ],
        });
      }
    }
    if (filters?.conversationId)
      query.$and.push({ conversationId: filters.conversationId });
    if (filters?.isExternal !== undefined) {
      query.$and.push({
        isExternalNumber:
          filters.isExternal === true || filters.isExternal === "true",
      });
    }

    // Message content search
    if (filters?.messageContent) {
      query.$and.push({
        $or: [
          {
            content: {
              $regex: this.escapeRegExp(filters.messageContent),
              $options: "i",
            },
          },
          {
            whatsappGroupName: {
              $regex: this.escapeRegExp(filters.messageContent),
              $options: "i",
            },
          },
          {
            fromName: {
              $regex: this.escapeRegExp(filters.messageContent),
              $options: "i",
            },
          },
          {
            toName: {
              $regex: this.escapeRegExp(filters.messageContent),
              $options: "i",
            },
          },
          {
            fromPhoneNumber: {
              $regex: this.escapeRegExp(filters.messageContent),
              $options: "i",
            },
          },
          {
            toPhoneNumber: {
              $regex: this.escapeRegExp(filters.messageContent),
              $options: "i",
            },
          },
        ],
      });
    }

    if (filters?.startDate || filters?.endDate) {
      const sentAtRange: any = {};

      if (filters.startDate) {
        const start = new Date(filters.startDate);
        if (!Number.isNaN(start.getTime())) {
          sentAtRange.$gte = start;
        }
      }

      if (filters.endDate) {
        const end = new Date(filters.endDate);
        if (!Number.isNaN(end.getTime())) {
          sentAtRange.$lte = end;
        }
      }

      // Only apply date filter if at least one bound is valid.
      if (Object.keys(sentAtRange).length > 0) {
        query.$and.push({ sentAt: sentAtRange });
      }
    }

    // Pagination
    const page = parseInt(filters?.page) || 1;
    const limit = parseInt(filters?.limit) || 20;
    const skip = (page - 1) * limit;
    const total = await this.messageModel.countDocuments(query);
    const totalPages = Math.ceil(total / limit);

    const messages = await this.messageModel
      .find(query)
      .populate("entityId", "name path type")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Fetch reply messages for messages that have replyToMessageId
    const messagesWithReplies = await Promise.all(
      messages.map(async (msg) => {
        const msgObj = msg.toObject();
        if (msgObj.metadata?.quotedMessageId) {
          const replyToMessage = await this.messageModel.findOne({
            whatsappMessageId: msgObj.metadata.quotedMessageId,
          });
          if (replyToMessage) {
            msgObj.replyToMessage = {
              id: replyToMessage._id,
              content: replyToMessage.content,
              type: replyToMessage.type,
              mediaUrl: replyToMessage.mediaUrl,
              from: replyToMessage.from,
              senderName:
                replyToMessage.fromName ||
                replyToMessage.toName ||
                replyToMessage.metadata?.senderContactName ||
                replyToMessage.from,
            };
            msgObj.replyToMessageId = replyToMessage._id;
          }
        }
        return msgObj;
      }),
    );

    // Enhance messages with external tag information
    const enhancedMessages = messagesWithReplies.map((msg) => ({
      ...msg,
      // Ensure entityPath is available for frontend filtering/export
      entityPath:
        (msg as any)?.entityPath || (msg as any)?.entityId?.path || "",
      // Add external tag for frontend
      tags: msg.isExternalNumber ? ["External"] : [],
      // Add display information
      displayName: msg.fromName || msg.metadata?.senderContactName || "Unknown",
      displayPhone: msg.fromPhoneNumber || msg.from,
    }));

    return {
      messages: enhancedMessages as any,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async getConversations(
    tenantId: string,
    userEntityId?: Types.ObjectId,
    userEntityIdPath?: Types.ObjectId[],
  ): Promise<any[]> {
    // Build match query - only include tenantId if provided (SystemAdmin has no tenantId)
    const matchQuery: any = { isActive: true };
    if (tenantId && tenantId !== "") {
      matchQuery.tenantId = new Types.ObjectId(tenantId);
    }

    // Filter by entity hierarchy: managers can see messages from their entities and below
    if (userEntityId && userEntityIdPath && userEntityIdPath.length > 0) {
      // Include messages where the entityId is in the user's entity hierarchy path
      // OR where the message's entityIdPath includes the user's entityId
      matchQuery.$or = [
        { entityId: { $in: [...userEntityIdPath, userEntityId] } },
        { entityIdPath: { $in: [userEntityId] } },
      ];
    } else if (userEntityId) {
      // Fallback: if no path, just filter by entityId
      matchQuery.entityId = userEntityId;
    }

    const conversations = await this.messageModel.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: "$conversationId",
          lastMessage: { $last: "$content" },
          lastMessageAt: { $last: "$sentAt" },
          lastMessageType: { $last: "$type" },
          totalMessages: { $sum: 1 },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$direction", MessageDirection.INBOUND] },
                    { $ne: ["$status", MessageStatus.READ] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          // Add external number detection
          isExternalNumber: { $last: "$isExternalNumber" },
          // Get WhatsApp contact info from the most recent message
          fromName: { $last: "$fromName" },
          toName: { $last: "$toName" },
          fromAvatarUrl: { $last: "$fromAvatarUrl" },
          toAvatarUrl: { $last: "$toAvatarUrl" },
          whatsappUsername: { $last: "$whatsappUsername" },
          whatsappGroupName: { $last: "$whatsappGroupName" },
          isGroupMessage: { $last: "$isGroupMessage" },
          contactName: { $last: "$metadata.senderContactName" },
          contactPhone: { $last: "$metadata.senderContactPhone" },
          fromPhoneNumber: { $last: "$fromPhoneNumber" },
          toPhoneNumber: { $last: "$toPhoneNumber" },
          direction: { $last: "$direction" },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]);

    // Enhance conversation data with display information
    const enhancedConversations = conversations.map((conv) => {
      // Determine display name - prefer group name, then fromName/toName, then WhatsApp username, then contact name
      let displayName =
        conv.whatsappGroupName ||
        conv.fromName ||
        conv.toName ||
        conv.whatsappUsername ||
        conv.contactName ||
        "Unknown";

      // For groups, show group name
      if (conv.isGroupMessage && conv.whatsappGroupName) {
        displayName = conv.whatsappGroupName;
      }

      // Determine display phone
      const displayPhone = conv.isGroupMessage
        ? null
        : conv.fromPhoneNumber ||
          conv.toPhoneNumber ||
          conv.contactPhone ||
          conv._id;

      // Determine avatar URL
      const avatarUrl = conv.fromAvatarUrl || conv.toAvatarUrl || null;

      return {
        ...conv,
        conversationId: conv._id,
        // Determine if this conversation is with an external number
        isExternal: conv.isExternalNumber || false,
        // Display information
        displayName,
        displayPhone,
        avatarUrl,
        // Add external tag for frontend
        tags: conv.isExternalNumber ? ["External"] : [],
      };
    });

    return enhancedConversations;
  }

  /**
   * Clean and format phone number to E164 format
   * @param phoneNumber Raw phone number
   * @returns Cleaned E164 phone number
   */
  /**
   * Escape special characters in a string for use in a regular expression
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
