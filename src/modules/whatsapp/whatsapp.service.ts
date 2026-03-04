import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  NotFoundException,
} from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { Connection, Model, Types } from "mongoose";
import { Client, RemoteAuth } from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import * as QRCode from "qrcode";
import { ConfigService } from "@nestjs/config";
import {
  WhatsAppSession,
  SessionStatus,
} from "../../common/schemas/whatsapp-session.schema";
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
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
import { StorageService } from "../storage/storage.service";
import { WhatsAppQueueService } from "../whatsapp-queue/whatsapp-queue.service";
import { QrGateway } from "./qr.gateway";
import { recordWhatsAppAlertEvent } from "../../telemetry";

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly execFileAsync = promisify(execFile);
  private clients: Map<string, Client> = new Map();
  private remoteAuthStore: any | null = null;
  // Prevent concurrent initialization of the same session (e.g., queue + direct)
  private initLocks: Map<string, Promise<void>> = new Map();
  private readonly readySessions: Set<string> = new Set();
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
  // Idle timeout for non-connected sessions (default: 5 minutes)
  private readonly idleSessionTimeoutMs =
    (Number(process.env.WHATSAPP_IDLE_SESSION_TIMEOUT_MS) || 5) * 60 * 1000;
  // How often to run idle cleanup (default: every 2 minutes)
  private readonly idleCleanupIntervalMs =
    (Number(process.env.WHATSAPP_IDLE_CLEANUP_INTERVAL_MS) || 2) * 60 * 1000;
  // Track cleanup state to avoid re-init while session files are locked
  private readonly cleanupInProgress: Set<string> = new Set();
  private readonly cleanupFailed: Set<string> = new Set();
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

  private async logRemoteAuthGridFsInfo(session: string): Promise<void> {
    try {
      const filesCollection = this.mongooseConnection.db.collection(
        `whatsapp-${session}.files`,
      );
      const count = await filesCollection.countDocuments();
      const latest = await filesCollection
        .find({})
        .sort({ uploadDate: -1 })
        .limit(1)
        .toArray();
      const latestDoc = latest?.[0];
      const uploadDate = latestDoc?.uploadDate;
      const length = latestDoc?.length;
      this.logger.debug(
        `[SERVICE] RemoteAuth GridFS info: session=${session}, filesCount=${count}, latestUploadDate=${
          uploadDate ? new Date(uploadDate).toISOString() : "none"
        }${typeof length === "number" ? `, latestSize=${length}` : ""}`,
      );
    } catch (e) {
      this.logger.warn(
        `[SERVICE] Failed to read RemoteAuth GridFS info for session=${session}: ${
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

  private normalizePhoneDigits(value?: string | null): string {
    return String(value || "").replace(/[^0-9]/g, "");
  }

  private maskPhoneDigits(value?: string | null): string {
    const digits = this.normalizePhoneDigits(value);
    if (!digits) return "";
    if (digits.length <= 4) return `****${digits}`;
    return `****${digits.slice(-4)}`;
  }

  private async failSessionWithPhoneMismatch(params: {
    sessionId: string;
    userId?: Types.ObjectId | string | null;
    expectedPhone?: string | null;
    connectedPhone?: string | null;
  }): Promise<void> {
    const now = new Date();
    const message =
      "Connected WhatsApp number does not match this user's phone number.";

    await this.sessionModel.findOneAndUpdate(
      { sessionId: params.sessionId },
      {
        status: SessionStatus.FAILED,
        lastError: "PHONE_MISMATCH",
        lastErrorAt: now,
        disconnectedAt: now,
        qrCode: null,
        qrCodeGeneratedAt: null,
        qrCodeExpiresAt: null,
      },
      { new: false },
    );

    if (params.userId) {
      try {
        await this.userModel.findByIdAndUpdate(params.userId, {
          whatsappConnectionStatus: WhatsAppConnectionStatus.FAILED,
          whatsappConnectedAt: null,
        });
      } catch (error) {
        this.logger.warn(
          `[SECURITY] Failed to mark user WhatsApp status FAILED on phone mismatch: sessionId=${params.sessionId}, userId=${String(
            params.userId,
          )}, error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.warn(
      `[SECURITY] WhatsApp phone mismatch: sessionId=${params.sessionId}, expected=${this.maskPhoneDigits(
        params.expectedPhone,
      )}, connected=${this.maskPhoneDigits(params.connectedPhone)}`,
    );

    // Best-effort: explicitly LOGOUT so WhatsApp mobile app removes it from "Linked devices".
    // `destroy()` alone may leave the device listed as linked for a while.
    const client = this.clients.get(params.sessionId);
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
        this.logger.log(
          `[SECURITY] Logged out WhatsApp session due to phone mismatch: sessionId=${params.sessionId}`,
        );
      } catch (error) {
        this.logger.warn(
          `[SECURITY] Failed to logout WhatsApp session on phone mismatch (will still destroy client): sessionId=${params.sessionId}, error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Preserve FAILED status while tearing down client resources
    await this.disconnectSession(params.sessionId, { preserveStatus: true });

    this.qrGateway.emitStatus(params.sessionId, {
      status: SessionStatus.FAILED,
      message,
    });
  }

  private generateAuthClientId(sessionId: string): string {
    return `${sessionId}-${Date.now()}`;
  }

  private async ensureAuthClientId(sessionId: string): Promise<string> {
    const doc = await this.sessionModel
      .findOne({ sessionId })
      .select("authClientId")
      .lean();
    return (doc as any)?.authClientId || sessionId;
  }

  private async rotateAuthClientId(sessionId: string): Promise<string> {
    const prev = await this.ensureAuthClientId(sessionId);
    const next = this.generateAuthClientId(sessionId);
    await this.sessionModel.updateOne(
      { sessionId },
      { $set: { authClientId: next } },
    );

    // Best-effort: delete old RemoteAuth backup to avoid orphaned sessions in Mongo.
    // RemoteAuth uses `RemoteAuth-${clientId}` as the session name.
    try {
      if (prev && prev !== next) {
        const store = this.ensureRemoteAuthStore();
        await store.delete({ session: `RemoteAuth-${prev}` });
      }
    } catch {
      // ignore
    }
    return next;
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
    private storageService: StorageService,
    private whatsappQueueService: WhatsAppQueueService,
    private qrGateway: QrGateway,
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

  private getSessionLockTtlMs(): number {
    return (
      Number(
        this.configService.get<string>(
          "whatsapp.sessionLockTtlMs",
          process.env.WHATSAPP_SESSION_LOCK_TTL_MS || "300000",
        ),
      ) || 300000
    );
  }

  private getSessionLockRefreshIntervalMs(): number {
    return (
      Number(
        this.configService.get<string>(
          "whatsapp.sessionLockRefreshIntervalMs",
          process.env.WHATSAPP_SESSION_LOCK_REFRESH_INTERVAL_MS || "60000",
        ),
      ) || 60000
    );
  }

  private async acquireSessionLock(sessionId: string): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.getSessionLockTtlMs());
    const owner = this.connectionOwnerId;
    const updated = await this.sessionModel.findOneAndUpdate(
      {
        sessionId,
        $or: [
          { connectionOwnerExpiresAt: { $exists: false } },
          { connectionOwnerExpiresAt: null },
          { connectionOwnerExpiresAt: { $lt: now } },
          { connectionOwner: owner },
        ],
      },
      {
        $set: {
          connectionOwner: owner,
          connectionOwnerExpiresAt: expiresAt,
          connectionOwnerHeartbeatAt: now,
        },
      },
      { new: true },
    );

    if (!updated) {
      this.logger.warn(
        `[SERVICE] Session lock already held by another pod; skipping init: sessionId=${sessionId}`,
      );
      return false;
    }
    return true;
  }

  private async refreshSessionLock(sessionId: string): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.getSessionLockTtlMs());
    await this.sessionModel.updateOne(
      { sessionId, connectionOwner: this.connectionOwnerId },
      {
        $set: {
          connectionOwnerExpiresAt: expiresAt,
          connectionOwnerHeartbeatAt: now,
        },
      },
    );
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

  private startSessionLockRefresh(sessionId: string): void {
    if (this.sessionLockRefreshTimers.has(sessionId)) {
      return;
    }
    const intervalMs = this.getSessionLockRefreshIntervalMs();
    const timer = setInterval(() => {
      if (!this.clients.has(sessionId)) {
        this.stopSessionLockRefresh(sessionId);
        return;
      }
      void this.refreshSessionLock(sessionId).catch((error) => {
        this.logger.warn(
          `[SERVICE] Failed to refresh session lock: sessionId=${sessionId}, error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, intervalMs);
    this.sessionLockRefreshTimers.set(sessionId, timer);
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
    // Reconnect active sessions on startup (isStartup=true uses a 24-hour
    // activity window so sessions that were live before a pod restart are
    // restored even if they haven't sent a message in the last 30 minutes).
    await this.reconnectActiveSessions(true);

    // Start periodic cleanup of idle (non-connected) clients to save memory
    this.startIdleClientCleanup();
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

  /**
   * Start periodic cleanup of idle WhatsApp clients.
   * Connected sessions (READY / AUTHENTICATED) are never closed here.
   */
  private startIdleClientCleanup(): void {
    if (this.idleCleanupTimer) {
      return;
    }

    this.logger.log(
      `Starting idle WhatsApp client cleanup: interval=${this.idleCleanupIntervalMs}ms, timeout=${this.idleSessionTimeoutMs}ms`,
    );

    this.idleCleanupTimer = setInterval(() => {
      this.cleanupIdleClients().catch((error) => {
        this.logger.error(
          `Error during idle WhatsApp client cleanup: ${error.message}`,
          error,
        );
      });
    }, this.idleCleanupIntervalMs);
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

  /**
   * Close idle Puppeteer/WhatsApp clients to free memory.
   * Only affects sessions that are NOT in READY or AUTHENTICATED state and
   * have been inactive for longer than idleSessionTimeoutMs.
   * Connected sessions remain open.
   */
  private async cleanupIdleClients(): Promise<void> {
    const now = Date.now();
    const idleSince = new Date(now - this.idleSessionTimeoutMs);

    // How long a READY/AUTHENTICATED session must be idle before its Chromium
    // process is destroyed (hibernation). The DB status stays READY so the
    // reconnect sweep re-activates it when fresh message activity resumes.
    // This bounds memory to O(concurrently active sessions), not O(all sessions),
    // making the system scale to hundreds of clients without proportional memory growth.
    const readyHibernateMs =
      Number(process.env.WHATSAPP_READY_HIBERNATE_TIMEOUT_MS) || 30 * 60 * 1000;
    const readyIdleSince = new Date(now - readyHibernateMs);

    // Only consider sessions for which this pod currently has a client instance
    const activeSessionIds = Array.from(this.clients.keys());
    if (!activeSessionIds.length) {
      return;
    }

    // 1. Non-connected sessions idle past the standard threshold (existing logic).
    const nonReadyIdleSessions = await this.sessionModel.find({
      sessionId: { $in: activeSessionIds },
      status: { $nin: [SessionStatus.READY, SessionStatus.AUTHENTICATED] },
      $or: [
        { lastActivityAt: { $lt: idleSince } },
        { lastActivityAt: { $exists: false } },
      ],
    });

    // 2. READY/AUTHENTICATED sessions idle past the hibernation threshold.
    //    Chromium is destroyed but DB status stays READY. The reconnect sweep
    //    will re-initialize Chromium once lastActivityAt is refreshed by new
    //    message activity or an explicit user action.
    const readyIdleSessions = await this.sessionModel.find({
      sessionId: { $in: activeSessionIds },
      status: { $in: [SessionStatus.READY, SessionStatus.AUTHENTICATED] },
      $or: [
        { lastActivityAt: { $lt: readyIdleSince } },
        { lastActivityAt: { $exists: false } },
      ],
    });

    const sessionsToProcess = [...nonReadyIdleSessions, ...readyIdleSessions];
    if (!sessionsToProcess.length) {
      return;
    }

    for (const session of sessionsToProcess) {
      if (this.initializingSessions.has(session.sessionId)) {
        this.logger.debug(
          `[SERVICE] Skipping idle cleanup for ${session.sessionId}; initialization in progress`,
        );
        continue;
      }
      if (this.cleanupInProgress.has(session.sessionId)) {
        this.logger.debug(
          `[SERVICE] Skipping idle cleanup for ${session.sessionId}; cleanup in progress`,
        );
        continue;
      }
      const sessionId = session.sessionId;
      const isHibernating = [
        SessionStatus.READY,
        SessionStatus.AUTHENTICATED,
      ].includes(session.status);

      this.logger.log(
        isHibernating
          ? `[SERVICE] Hibernating idle READY session ${sessionId} (lastActivityAt=${session.lastActivityAt}); destroying Chromium, DB status preserved as ${session.status}`
          : `[SERVICE] Closing idle WhatsApp client for session ${sessionId} (status=${session.status}, lastActivityAt=${session.lastActivityAt})`,
      );

      try {
        // preserveStatus=true: destroys Chromium without changing DB status.
        // For READY sessions this is hibernation — the session reconnects
        // automatically once new activity updates lastActivityAt.
        await this.disconnectSession(sessionId, { preserveStatus: true });
      } catch (error) {
        this.logger.warn(
          `[SERVICE] Failed to close idle client for session ${sessionId}: ${error.message}`,
        );
      }
    }
  }

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

  async initializeClient(sessionId: string): Promise<void> {
    const initStartTime = Date.now();
    this.logger.debug(
      `[SERVICE] initializeClient called: sessionId=${sessionId}`,
    );

    // Prevent concurrent initialization for the same session
    const existingLock = this.initLocks.get(sessionId);
    if (existingLock) {
      this.logger.debug(
        `[SERVICE] initializeClient already in progress for ${sessionId}, waiting for existing init`,
      );
      await existingLock;
      return;
    }

    const initPromise = (async () => {
      this.initializingSessions.add(sessionId);
      if (this.cleanupInProgress.has(sessionId)) {
        this.logger.warn(
          `[SERVICE] Cleanup in progress for ${sessionId}; delaying init`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (this.cleanupFailed.has(sessionId)) {
        this.logger.warn(
          `[SERVICE] Cleanup previously failed for ${sessionId}; skipping init to avoid launch errors (retry later)`,
        );
        return;
      }

      let lockAcquired = false;
      try {
        lockAcquired = await this.acquireSessionLock(sessionId);
        if (!lockAcquired) {
          return;
        }

        if (this.clients.has(sessionId)) {
          this.startSessionLockRefresh(sessionId);
          this.logger.warn(
            `[SERVICE] Client already exists for session: sessionId=${sessionId}. Skipping initialization.`,
          );
          return;
        }

        // Step 1: Detect Chrome path
        const platform = os.platform();
        this.logger.log(`Detecting Chrome path for platform: ${platform}`);

        const windowsPaths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          process.env.CHROME_PATH, // Allow override via env var
        ];

        const linuxPaths = [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium-browser",
          "/usr/bin/chromium",
          process.env.CHROME_PATH,
        ];

        const macPaths = [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          process.env.CHROME_PATH,
        ];

        const paths =
          platform === "win32"
            ? windowsPaths
            : platform === "linux"
              ? linuxPaths
              : platform === "darwin"
                ? macPaths
                : [];

        // Find first existing Chrome path
        let chromePath;
        for (const path of paths) {
          try {
            if (path && fsSync.existsSync(path)) {
              chromePath = path;
              this.logger.log(`Found Chrome at: ${path}`);
              break;
            }
          } catch (error) {
            this.logger.warn(
              `Error checking Chrome path ${path}: ${error.message}`,
            );
          }
        }

        if (!chromePath) {
          throw new Error(
            "Chrome not found. Please install Chrome or set CHROME_PATH environment variable.",
          );
        }

        const dataPath =
          process.env.WWEBJS_AUTH_PATH || `${process.cwd()}/.wwebjs_auth`;
        const authClientId = await this.ensureAuthClientId(sessionId);
        const remoteStore = this.ensureRemoteAuthStore();

        // Diagnostics: confirm whether a RemoteAuth backup exists in Mongo (GridFS) for this session/clientId.
        // If no backup exists, whatsapp-web.js will emit a fresh QR on restart.
        try {
          const candidateClientIds = Array.from(
            new Set([authClientId, sessionId]).values(),
          ).filter(Boolean);
          const candidateSessions = candidateClientIds.map(
            (id) => `RemoteAuth-${id}`,
          );
          for (const s of candidateSessions) {
            try {
              const exists = await remoteStore.sessionExists({ session: s });
              this.logger.debug(
                `[SERVICE] RemoteAuth Mongo backup exists? session=${s} -> ${exists}`,
              );
              if (exists) {
                await this.logRemoteAuthGridFsInfo(s);
              }
            } catch (e) {
              this.logger.warn(
                `[SERVICE] Failed checking RemoteAuth Mongo backup existence for session=${s}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        } catch {
          // ignore
        }
        const backupSyncIntervalMsRaw =
          this.configService.get<string>(
            "whatsapp.remoteAuthBackupSyncIntervalMs",
            process.env.WHATSAPP_REMOTE_AUTH_BACKUP_SYNC_INTERVAL_MS || "60000",
          ) || "60000";
        const parsedBackupSyncIntervalMs =
          Number.parseInt(String(backupSyncIntervalMsRaw), 10) || 60000;
        // whatsapp-web.js RemoteAuth enforces a minimum of 60000ms (1 minute).
        const backupSyncIntervalMs = Math.max(
          60000,
          parsedBackupSyncIntervalMs,
        );
        if (backupSyncIntervalMs !== parsedBackupSyncIntervalMs) {
          this.logger.warn(
            `[SERVICE] RemoteAuth backupSyncIntervalMs=${parsedBackupSyncIntervalMs} is below the minimum 60000ms; clamping to ${backupSyncIntervalMs}`,
          );
        }
        this.logger.debug(
          `[SERVICE] RemoteAuth backupSyncIntervalMs=${backupSyncIntervalMs} (sessionId=${sessionId})`,
        );

        // Step 3: Initialize WhatsApp client
        this.logger.log(
          `Initializing WhatsApp client for session: ${sessionId}`,
        );
        const puppeteerArgs = [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-crashpad",
          // Note: we intentionally do NOT use "--single-process" here.
          // It is unstable/unsupported on many Chrome builds and can cause
          // the browser to exit immediately, leading to "Target closed" errors.
        ];

        const buildClient = (clientId: string) =>
          new Client({
            authStrategy: new RemoteAuth({
              clientId,
              dataPath,
              store: remoteStore,
              backupSyncIntervalMs,
            } as any),
            puppeteer: {
              executablePath: chromePath,
              // Keep headless true in container environments to avoid Chrome launch failures
              headless: true,
              timeout: 300000,
              args: puppeteerArgs,
            },
          });

        const attachHandlers = (c: Client) => {
          c.on("qr", async (qr) => {
            try {
              this.logger.log(
                `QR Code received for session: ${sessionId} (length: ${qr.length})`,
              );
              this.logger.debug(`QR Data: ${qr.substring(0, 20)}...`);
              await this.handleQRCode(sessionId, qr);
            } catch (error) {
              this.logger.error(
                `Error handling QR code for session ${sessionId}:`,
                error,
              );
              await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
            }
          });

          // Useful when diagnosing sessions that show "authenticated" but never become truly CONNECTED/READY.
          c.on("change_state", (state) => {
            this.logger.debug(
              `[EVENT] change_state: sessionId=${sessionId}, state=${String(state)}`,
            );
          });

          c.on("remote_session_saved", async () => {
            // Emitted by RemoteAuth after it stores the compressed session into the remote store (Mongo GridFS here)
            this.logger.log(
              `[SERVICE] RemoteAuth session saved to MongoDB (GridFS): sessionId=${sessionId}, authClientId=${await this.ensureAuthClientId(
                sessionId,
              )}`,
            );
          });

          c.on("ready", async () => {
            try {
              this.readySessions.add(sessionId);
              this.logger.log(
                `WhatsApp client ready for session: ${sessionId}`,
              );
              await this.handleReady(sessionId, c);
            } catch (error) {
              this.logger.error(
                `Error handling ready event for session ${sessionId}:`,
                error,
              );
              await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
            }
          });

          c.on("authenticated", async () => {
            try {
              this.logger.log(
                `WhatsApp client authenticated for session: ${sessionId}`,
              );
              await this.updateSessionStatus(
                sessionId,
                SessionStatus.AUTHENTICATED,
              );
            } catch (error) {
              this.logger.error(
                `Error handling authentication for session ${sessionId}:`,
                error,
              );
              await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
            }
          });

          c.on("disconnected", async (reason) => {
            try {
              this.logger.warn(
                `WhatsApp client disconnected for session: ${sessionId}. Reason: ${reason}`,
              );
              await this.handleDisconnected(sessionId, reason);
            } catch (error) {
              this.logger.error(
                `Error handling disconnect for session ${sessionId}:`,
                error,
              );
              await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
            }
          });

          c.on("auth_failure", async (msg) => {
            try {
              this.logger.error(
                `Authentication failed for session ${sessionId}: ${msg}`,
              );
              await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
              await this.handleDisconnected(
                sessionId,
                `Authentication failed: ${msg}`,
              );
            } catch (error) {
              this.logger.error(
                `Error handling auth failure for session ${sessionId}:`,
                error,
              );
            }
          });

          c.on("message", async (message) => {
            try {
              await this.handleIncomingMessage(sessionId, message);
            } catch (error) {
              this.logger.error(
                `Error handling incoming message for session ${sessionId}:`,
                error,
              );
            }
          });

          c.on("message_create", async (message) => {
            try {
              if (message.fromMe) {
                await this.handleOutgoingMessage(sessionId, message);
              }
            } catch (error) {
              this.logger.error(
                `Error handling outgoing message for session ${sessionId}:`,
                error,
              );
            }
          });

          c.on("message_ack", async (message, ack) => {
            try {
              await this.handleMessageAck(sessionId, message, ack);
            } catch (error) {
              this.logger.error(
                `Error handling message ack for session ${sessionId}:`,
                error,
              );
            }
          });

          c.on("call", async (call) => {
            try {
              await this.handleCallEvent(sessionId, call);
            } catch (error) {
              this.logger.error(
                `Error handling call event for session ${sessionId}:`,
                error,
              );
            }
          });
        };

        let client = buildClient(authClientId);
        attachHandlers(client);

        // Step 5: Initialize the client with guarded retry if Chrome launch fails
        this.logger.log(
          `Starting WhatsApp client initialization for session: ${sessionId}`,
        );
        this.clients.set(sessionId, client);
        this.startSessionLockRefresh(sessionId);

        const initTimeoutMs =
          Number(process.env.WHATSAPP_CLIENT_INIT_TIMEOUT_MS) || 120000;
        const tryInit = async (label: string) => {
          await Promise.race([
            client.initialize(),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `WhatsApp init timeout after ${initTimeoutMs}ms (label=${label})`,
                    ),
                  ),
                initTimeoutMs,
              ),
            ),
          ]);
          this.logger.log(
            `WhatsApp client initialization completed (${label}) for session: ${sessionId}`,
          );
          const totalDuration = Date.now() - initStartTime;
          this.logger.debug(
            `[SERVICE] initializeClient success (${label}): sessionId=${sessionId}, duration=${totalDuration}ms`,
          );
        };

        try {
          await tryInit("first");

          // Post-init diagnostic: check whether we actually reach CONNECTED soon after init.
          // This helps differentiate "client never connected" from "connected but no messages".
          setTimeout(() => {
            const activeClient = this.clients.get(sessionId);
            if (!activeClient) return;
            void activeClient
              .getState()
              .then((state) => {
                this.logger.debug(
                  `[SERVICE] Post-init state probe: sessionId=${sessionId}, state=${String(
                    state,
                  )}`,
                );

                // If we are CONNECTED but never received a "ready" event, force the same initialization
                // that the ready handler would do (status=READY, phone mismatch enforcement, etc).
                // This makes session loading consistent across restarts even when wwebjs misses "ready".
                if (
                  String(state) === "CONNECTED" &&
                  !this.readySessions.has(sessionId)
                ) {
                  const info = (activeClient as any)?.info;
                  const wid =
                    info?.wid?._serialized || info?.wid?.user || "unknown";
                  const pushname = info?.pushname || "unknown";
                  this.logger.warn(
                    `[SERVICE] Session is CONNECTED but "ready" event was not observed; forcing handleReady: sessionId=${sessionId}, wid=${String(
                      wid,
                    )}, pushname=${String(pushname)}`,
                  );
                  void this.handleReady(sessionId, activeClient).catch((e) => {
                    this.logger.warn(
                      `[SERVICE] Forced handleReady failed: sessionId=${sessionId}, error=${
                        e instanceof Error ? e.message : String(e)
                      }`,
                    );
                  });
                }
              })
              .catch((e) => {
                this.logger.warn(
                  `[SERVICE] Post-init state probe failed: sessionId=${sessionId}, error=${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              });
          }, 15000);
        } catch (error) {
          const msg = (error && (error as any).message) || "";
          const isLaunchError =
            msg.includes("Failed to launch the browser process") ||
            msg.includes("WhatsApp init timeout");
          this.logger.error(
            `Failed to initialize WhatsApp client for session ${sessionId}:`,
            error,
          );
          this.clients.delete(sessionId);
          this.stopSessionLockRefresh(sessionId);
          await this.updateSessionStatus(sessionId, SessionStatus.FAILED);

          if (isLaunchError) {
            this.logger.warn(
              `[SERVICE] Launch failed; attempting to clean session files and retry: ${sessionId}`,
            );
            this.cleanupInProgress.add(sessionId);
            try {
              const pid = this.getClientBrowserPid(client);
              if (pid) {
                await this.killProcessTree(pid);
              }
              const cleaned =
                await this.cleanupSessionFilesForSession(sessionId);
              if (!cleaned) {
                this.cleanupFailed.add(sessionId);
              } else {
                this.cleanupFailed.delete(sessionId);
              }
            } catch (cleanupError) {
              this.logger.warn(
                `[SERVICE] Cleanup after launch failure failed for ${sessionId}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
              );
              this.cleanupFailed.add(sessionId);
            } finally {
              this.cleanupInProgress.delete(sessionId);
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));

            // If cleanup failed (common on Windows EBUSY), rotate auth profile to avoid locked dir.
            if (this.cleanupFailed.has(sessionId)) {
              const rotated = await this.rotateAuthClientId(sessionId);
              this.logger.warn(
                `[SERVICE] Cleanup did not fully complete; rotating RemoteAuth clientId and retrying: sessionId=${sessionId}, authClientId=${rotated}`,
              );
              try {
                client.removeAllListeners();
              } catch {
                // ignore
              }
              try {
                await client.destroy();
              } catch {
                // ignore
              }
              client = buildClient(rotated);
              attachHandlers(client);
            }

            // Re-add client to map before retry so event handlers remain active
            this.clients.set(sessionId, client);
            this.startSessionLockRefresh(sessionId);
            try {
              await tryInit("retry-after-cleanup");
              return;
            } catch (retryError) {
              this.logger.error(
                `[SERVICE] Retry after cleanup failed for session ${sessionId}:`,
                retryError,
              );
              this.clients.delete(sessionId);
              this.stopSessionLockRefresh(sessionId);
              await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
              throw retryError;
            }
          }

          throw error;
        }
      } catch (error) {
        const totalDuration = Date.now() - initStartTime;
        this.logger.error(
          `Critical error during client initialization for session ${sessionId}:`,
          error,
        );
        this.logger.debug(
          `[SERVICE] initializeClient errored: sessionId=${sessionId}, duration=${totalDuration}ms`,
        );
        await this.updateSessionStatus(sessionId, SessionStatus.FAILED);
        throw error;
      } finally {
        if (lockAcquired && !this.clients.has(sessionId)) {
          this.stopSessionLockRefresh(sessionId);
          await this.releaseSessionLock(sessionId);
        }
        this.initLocks.delete(sessionId);
        this.initializingSessions.delete(sessionId);
      }
    })();

    this.initLocks.set(sessionId, initPromise);
    await initPromise;
  }

  private async handleQRCode(
    sessionId: string,
    qrData: string,
    _shouldSendEmail: boolean = false,
  ): Promise<void> {
    try {
      this.logger.debug(
        `[QR_HANDLER] Processing QR code for session: ${sessionId}`,
      );

      // Read current session status first
      const existingSession = await this.sessionModel.findOne({ sessionId });

      if (!existingSession) {
        this.logger.error(
          `[QR_HANDLER] Session not found in database: ${sessionId}`,
        );
        return;
      }

      this.logger.debug(
        `[QR_HANDLER] Existing session status: ${existingSession.status}, userId: ${existingSession.userId}`,
      );

      // IMPORTANT: Only ignore QR code events if session is actually connected
      // Check if client exists and is actually connected before ignoring QR code
      // WhatsApp-web.js can emit QR events during reconnections even when authenticated,
      // but if the client is not actually connected, we should accept the QR code
      const client = this.clients.get(sessionId);
      let isActuallyConnected = false;
      let state: string | null = null;

      if (
        existingSession.status === SessionStatus.READY ||
        existingSession.status === SessionStatus.AUTHENTICATED
      ) {
        if (client) {
          try {
            state = await client.getState();
            isActuallyConnected = state === "CONNECTED";
            this.logger.debug(
              `[QR_HANDLER] Client exists for session ${sessionId}, state: ${state}, isActuallyConnected: ${isActuallyConnected}`,
            );
          } catch (error) {
            this.logger.warn(
              `[QR_HANDLER] Failed to get client state for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            isActuallyConnected = false;
            state = null;
          }
        } else {
          this.logger.debug(
            `[QR_HANDLER] Client not found in clients map for session ${sessionId}, accepting QR code`,
          );
          isActuallyConnected = false;
        }

        if (isActuallyConnected) {
          this.logger.warn(
            `[QR_HANDLER] Ignoring QR code for actually connected session: ${sessionId} (status: ${existingSession.status}, client state: CONNECTED). This is normal during reconnections.`,
          );
          return;
        } else {
          this.logger.warn(
            `[QR_HANDLER] Session status is ${existingSession.status} but client is not actually connected. Accepting QR code and updating status to QR_REQUIRED.`,
          );
          this.logger.warn(
            `[QR_HANDLER] This typically means RemoteAuth has no saved session to restore yet (or it was deleted). Note: whatsapp-web.js RemoteAuth only saves backups every backupSyncIntervalMs (min 60000ms). If the server restarts soon after linking, you'll need to scan QR again.`,
          );
          // Continue to process QR code and update status
        }
      }

      // Generate QR code as base64 image
      const qrCodeDataUrl = await QRCode.toDataURL(qrData);
      const qrCodeBase64 = qrCodeDataUrl.split(",")[1]; // Remove data:image/png;base64, prefix

      const expiresAt = new Date(Date.now() + 60000); // 1 minute expiry
      const session = await this.sessionModel.findOneAndUpdate(
        { sessionId },
        {
          status: SessionStatus.QR_REQUIRED,
          qrCode: qrCodeBase64,
          qrCodeGeneratedAt: new Date(),
          qrCodeExpiresAt: expiresAt,
        },
        { new: true },
      );

      if (!session) {
        this.logger.error(
          `[QR_HANDLER] Failed to update session with QR code: ${sessionId}`,
        );
        return;
      }

      // If a session requires QR, it is not connected anymore.
      // Keep user-level connection status in sync for UI/filters.
      if ((session as any).userId) {
        try {
          await this.userModel.findByIdAndUpdate((session as any).userId, {
            whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
          });
        } catch (error) {
          this.logger.warn(
            `[QR_HANDLER] Failed to mark user WhatsApp status DISCONNECTED on QR_REQUIRED: sessionId=${sessionId}, userId=${String(
              (session as any).userId,
            )}, error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      this.logger.log(
        `[QR_HANDLER] QR Code generated and saved for session: ${sessionId}`,
      );

      this.qrGateway.emitQrUpdate(sessionId, {
        qrCode: session.qrCode,
        expiresAt,
      });
      this.qrGateway.emitStatus(sessionId, {
        status: SessionStatus.QR_REQUIRED,
      });

      this.logger.debug(
        `[QR_HANDLER] QR ready for session ${sessionId}; awaiting user to scan.`,
      );
    } catch (error) {
      this.logger.error(
        `[QR_HANDLER] Failed to handle QR code for session: ${sessionId}`,
        error,
      );
      this.qrGateway.emitStatus(sessionId, {
        status: SessionStatus.FAILED,
        message:
          error instanceof Error ? error.message : "QR generation failed",
      });
    }
  }

  private async handleReady(sessionId: string, client: Client): Promise<void> {
    try {
      const info = client.info;

      // Enforce: connected WhatsApp phone must match the owning user's phone number
      const connectedDigits = this.normalizePhoneDigits(info?.wid?.user);
      const connectedE164 = connectedDigits ? `+${connectedDigits}` : null;

      const existingSession = await this.sessionModel
        .findOne({ sessionId })
        .select("userId")
        .lean();

      const sessionUserId = (existingSession as any)?.userId;
      if (sessionUserId) {
        const user = await this.userModel
          .findById(sessionUserId)
          .select("phoneNumber")
          .lean();

        const expectedE164 = (user as any)?.phoneNumber || null;
        const expectedDigits = this.normalizePhoneDigits(expectedE164);

        if (
          expectedDigits &&
          connectedDigits &&
          expectedDigits !== connectedDigits
        ) {
          await this.failSessionWithPhoneMismatch({
            sessionId,
            userId: sessionUserId,
            expectedPhone: expectedE164,
            connectedPhone: connectedE164,
          });
          return;
        }
      }

      const session = await this.sessionModel.findOneAndUpdate(
        { sessionId },
        {
          status: SessionStatus.READY,
          phoneNumber: connectedE164 || info?.wid?.user,
          whatsappName: info.pushname,
          whatsappId: info.wid._serialized,
          connectedAt: new Date(),
          lastActivityAt: new Date(),
          qrCode: null, // Clear QR code
        },
        { new: true },
      );

      if (session && session.userId) {
        // Update user's WhatsApp connection status to CONNECTED
        const now = new Date();
        await this.userModel.findByIdAndUpdate(
          session.userId,
          {
            whatsappConnectionStatus: WhatsAppConnectionStatus.CONNECTED,
            whatsappConnectedAt: now,
          },
          { new: true },
        );

        // Best-effort: mark last QR invitation as "scanned" when connection completes
        try {
          const user = await this.userModel
            .findById(session.userId)
            .select("qrInvitationHistory")
            .lean();
          const history = (user as any)?.qrInvitationHistory;
          if (Array.isArray(history) && history.length > 0) {
            const lastIndex = history.length - 1;
            const last = history[lastIndex];
            if (last && !last.scannedAt) {
              await this.userModel.updateOne(
                { _id: session.userId },
                {
                  $set: { [`qrInvitationHistory.${lastIndex}.scannedAt`]: now },
                },
              );
            }
          }
        } catch {
          // ignore
        }
        this.logger.log(
          `Updated user ${session.userId} WhatsApp connection status to CONNECTED`,
        );
      }

      this.logger.log(
        `Session ready: ${sessionId} - ${info.pushname} (${info.wid.user})`,
      );
      this.qrGateway.emitStatus(sessionId, { status: SessionStatus.READY });

      // Post-ready diagnostic: after RemoteAuth's 60s initial stability delay, the backup should be updated.
      // This lets us verify whether backups are actually being written (and if the uploadDate changes).
      try {
        const authClientId = await this.ensureAuthClientId(sessionId);
        const sessionName = `RemoteAuth-${authClientId}`;
        setTimeout(() => {
          void this.logRemoteAuthGridFsInfo(sessionName);
        }, 70000);
      } catch {
        // ignore
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle ready event for session: ${sessionId}`,
        error,
      );
    }
  }

  private async handleDisconnected(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    // If we initiated a disconnect with preserveStatus, ignore destroy-triggered events
    if (this.disconnectingWithPreserve.has(sessionId)) {
      this.logger.debug(
        `[SERVICE] Ignoring disconnected event for ${sessionId} (preserveStatus in effect)`,
      );
      this.disconnectingWithPreserve.delete(sessionId);
      this.clients.delete(sessionId);
      this.stopSessionLockRefresh(sessionId);
      await this.releaseSessionLock(sessionId);
      return;
    }

    const normalizedReason = String(reason || "").toUpperCase();
    const client = this.clients.get(sessionId);

    const session = await this.sessionModel.findOneAndUpdate(
      { sessionId },
      {
        status: SessionStatus.DISCONNECTED,
        disconnectedAt: new Date(),
        lastError: reason,
        lastErrorAt: new Date(),
      },
      { new: true },
    );

    const isBlocked =
      normalizedReason.includes("BLOCK") ||
      normalizedReason.includes("BANNED") ||
      normalizedReason.includes("BAN");
    recordWhatsAppAlertEvent({
      eventType: isBlocked ? "blocked" : "disconnected",
      sessionId,
      tenantId: session?.tenantId?.toString?.(),
      phoneNumber: session?.phoneNumber,
      reason,
      status: SessionStatus.DISCONNECTED,
    });

    if (session && session.userId) {
      // Update user's WhatsApp connection status to DISCONNECTED
      await this.userModel.findByIdAndUpdate(
        session.userId,
        {
          whatsappConnectionStatus: WhatsAppConnectionStatus.DISCONNECTED,
        },
        { new: true },
      );
      this.logger.log(
        `Updated user ${session.userId} WhatsApp connection status to DISCONNECTED`,
      );
    }

    // On LOGOUT or similar, attempt to clean up session files so next init won't fail on locks
    if (
      normalizedReason.includes("LOGOUT") ||
      normalizedReason.includes("UNPAIRED")
    ) {
      try {
        // Best-effort: force-kill browser process tree to release file locks (Windows EBUSY)
        const pid = this.getClientBrowserPid(client);
        try {
          if (client) {
            client.removeAllListeners();
            await client.destroy();
          }
        } catch {
          // ignore
        }
        if (pid) {
          await this.killProcessTree(pid);
        }

        const cleaned = await this.cleanupSessionFilesForSession(sessionId);
        if (!cleaned) {
          const rotated = await this.rotateAuthClientId(sessionId);
          this.logger.warn(
            `[SERVICE] Session files still locked after LOGOUT; rotating RemoteAuth clientId: sessionId=${sessionId}, authClientId=${rotated}`,
          );
        }
        this.logger.debug(
          `[SERVICE] Cleaned up session files after logout for ${sessionId}`,
        );
      } catch (cleanupError) {
        this.logger.warn(
          `[SERVICE] Failed to clean session files after logout for ${sessionId}: ${
            cleanupError instanceof Error ? cleanupError.message : cleanupError
          }`,
        );
      }
    }

    this.clients.delete(sessionId);
    this.stopSessionLockRefresh(sessionId);
    await this.releaseSessionLock(sessionId);
    this.qrGateway.emitStatus(sessionId, {
      status: SessionStatus.DISCONNECTED,
      message: reason,
    });
  }

  private async handleIncomingMessage(
    sessionId: string,
    message: any,
  ): Promise<void> {
    try {
      const session = await this.sessionModel.findOne({ sessionId });
      if (!session) return;

      const isCallLog = this.isCallLogMessage(message);
      const hasContent = message.body && message.body.trim() !== "";
      const hasMedia = message.hasMedia;

      if (!hasContent && !hasMedia && !isCallLog) {
        return;
      }

      // Check if message already exists by whatsappMessageId
      const existingMessage = await this.messageModel.findOne({
        whatsappMessageId: message.id._serialized,
      });

      if (existingMessage) {
        return;
      }

      // Check for duplicate by content (from + to + content + timestamp within 5 seconds)
      const messageTimestamp = new Date(message.timestamp * 1000);
      const timeWindow = 5000;
      const duplicateByContent = await this.messageModel.findOne({
        from: message.from,
        to: message.to,
        content: message.body || "",
        sentAt: {
          $gte: new Date(messageTimestamp.getTime() - timeWindow),
          $lte: new Date(messageTimestamp.getTime() + timeWindow),
        },
      });

      if (duplicateByContent) {
        return;
      }

      // Get entity with path
      const entity = await this.entityService.findOne(
        session.entityId.toString(),
        null,
      );
      if (!entity.entityIdPath || entity.entityIdPath.length === 0) {
        this.logger.warn(
          `Failed to get entity path for entity: ${session.entityId}`,
        );
      }

      // Check if message is a reply
      let quotedMessage = null;
      if (message.hasQuotedMsg) {
        try {
          // Get the quoted message
          quotedMessage = await message.getQuotedMessage();
          this.logger.log(
            `Reply detected - Original message: ${quotedMessage.id._serialized} from ${quotedMessage.from}`,
          );
        } catch (error) {
          this.logger.warn(`Failed to fetch quoted message: ${error.message}`);
        }
      }

      let mediaUrl = null;
      if (message.hasMedia) {
        mediaUrl = await this.handleMediaUpload(message);
      }

      // Check if sender is a registered user (external number detection)
      const cleanedPhoneNumber = this.cleanPhoneNumber(message.from);
      const registeredUser = await this.checkIfRegisteredUser(
        cleanedPhoneNumber,
        session.tenantId,
      );

      // Get contact info for sender (FROM)
      const fromContactInfo = await this.getContactInfo(message);

      // Get contact info for recipient (TO - session owner)
      const toPhoneNumber = this.getE164FromSession(sessionId);
      let toContactInfo = null;
      try {
        // Get the session owner's contact from WhatsApp
        const client = this.clients.get(sessionId);
        if (client) {
          const toContact = await client.getContactById(toPhoneNumber);
          if (toContact) {
            toContactInfo = {
              name:
                toContact.pushname ||
                toContact.name ||
                toContact.shortName ||
                toPhoneNumber,
              phone: toContact.number || toPhoneNumber,
              avatarUrl: null,
              username: toContact.pushname || toContact.name || undefined,
            };
            try {
              const profilePicUrl = await toContact.getProfilePicUrl();
              toContactInfo.avatarUrl = profilePicUrl || undefined;
            } catch (error) {
              // Profile picture not available
            }
          }
        }
      } catch (error) {
        this.logger.debug(
          `Failed to get recipient contact info: ${error.message}`,
        );
      }

      // Fallback to session user info if contact info not available
      if (!toContactInfo) {
        const sessionUser = await this.userModel.findOne({
          phoneNumber: toPhoneNumber,
        });
        toContactInfo = {
          name: sessionUser
            ? `${sessionUser.firstName} ${sessionUser.lastName}`
            : toPhoneNumber,
          phone: toPhoneNumber,
          avatarUrl: undefined,
          username: undefined,
        };
      }

      const isExternalNumber = !registeredUser;

      this.logger.log(
        `Message from ${cleanedPhoneNumber}: ${isExternalNumber ? "EXTERNAL" : "REGISTERED"} - ${fromContactInfo.name}`,
      );

      const contact = await message.getContact();

      const fromPhoneNumber = this.cleanPhoneNumber(contact.number);
      const toPhoneNumberFinal = this.getE164FromSession(sessionId);

      // Determine conversation ID - use group name if group, otherwise use phone number
      const conversationId =
        fromContactInfo.isGroup && fromContactInfo.groupName
          ? `group-${fromContactInfo.groupName}`
          : message.from;

      // Determine names: use group name if group, otherwise use contact name
      const fromName =
        fromContactInfo.isGroup && fromContactInfo.groupName
          ? fromContactInfo.groupName
          : fromContactInfo.name || fromPhoneNumber;

      const toName = toContactInfo.name || toPhoneNumberFinal;

      const messageData = {
        _id: new Types.ObjectId(),
        whatsappMessageId: message.id._serialized,
        from: message.from,
        to: message.to,
        fromPhoneNumber,
        toPhoneNumber: toPhoneNumberFinal,
        // New fields: names and avatars
        fromName,
        toName,
        fromAvatarUrl: fromContactInfo.avatarUrl,
        toAvatarUrl: toContactInfo.avatarUrl,
        type: this.getMessageType(message.type),
        direction: MessageDirection.INBOUND,
        content: message.body || (isCallLog ? "Call log" : ""),
        mediaUrl,
        status: MessageStatus.DELIVERED,
        sentAt: new Date(message.timestamp * 1000),
        deliveredAt: new Date(),
        conversationId: conversationId,
        entityId: session.entityId,
        entityIdPath: entity.entityIdPath,
        tenantId: session.tenantId,
        // External number detection fields
        isExternalNumber,
        whatsappUsername: fromContactInfo.username || fromContactInfo.name,
        whatsappGroupName: fromContactInfo.groupName,
        isGroupMessage: fromContactInfo.isGroup || false,
        metadata: {
          hasMedia: message.hasMedia,
          isForwarded: message.isForwarded,
          isStarred: message.isStarred,
          mediaType: message.type,
          caption: message.caption,
          callLog: isCallLog,
          callLogType: message.type,
          callLogBody: message.body,
          // Add reply metadata
          isReply: message.hasQuotedMsg,
          quotedMessageId: quotedMessage?.id?._serialized,
          quotedMessageFrom: quotedMessage?.from,
          quotedMessageBody: quotedMessage?.body,
          // External number metadata
          senderContactName: fromContactInfo.name,
          senderContactPhone: fromContactInfo.phone,
          isExternalSender: isExternalNumber,
          registeredUserInfo: registeredUser
            ? {
                firstName: registeredUser.firstName,
                lastName: registeredUser.lastName,
                email: registeredUser.email,
                role: registeredUser.role,
              }
            : null,
        },
      };

      await this.messageModel.create(messageData);

      // Update session statistics
      await this.sessionModel.findOneAndUpdate(
        { sessionId },
        {
          $inc: { messagesReceived: 1 },
          lastActivityAt: new Date(),
        },
      );

      this.logger.log(`Incoming message saved: ${message.id._serialized}`);
    } catch (error) {
      this.logger.error(
        `Failed to handle incoming message: ${error.message}`,
        error,
      );
    }
  }

  private async handleOutgoingMessage(
    sessionId: string,
    message: any,
  ): Promise<void> {
    try {
      const session = await this.sessionModel.findOne({ sessionId });
      if (!session) return;

      const isCallLog = this.isCallLogMessage(message);
      const hasContent = message.body && message.body.trim() !== "";
      const hasMedia = message.hasMedia;

      if (!hasContent && !hasMedia && !isCallLog) {
        return;
      }

      // Check if message already exists by whatsappMessageId
      const existingMessage = await this.messageModel.findOne({
        whatsappMessageId: message.id._serialized,
      });

      if (existingMessage) {
        return;
      }

      // Check for duplicate by content (from + to + content + timestamp within 5 seconds)
      const messageTimestamp = new Date(message.timestamp * 1000);
      const timeWindow = 5000;
      const duplicateByContent = await this.messageModel.findOne({
        from: message.from,
        to: message.to,
        content: message.body || "",
        sentAt: {
          $gte: new Date(messageTimestamp.getTime() - timeWindow),
          $lte: new Date(messageTimestamp.getTime() + timeWindow),
        },
      });

      if (duplicateByContent) {
        return;
      }

      // Get entity with path
      const entity = await this.entityService.findOne(
        session.entityId.toString(),
        null,
      );
      if (!entity.entityIdPath || entity.entityIdPath.length === 0) {
        this.logger.warn(
          `Failed to get entity path for entity: ${session.entityId}`,
        );
      }

      let mediaUrl = null;
      if (message.hasMedia) {
        mediaUrl = await this.handleMediaUpload(message);
      }

      // Get contact info for recipient (TO)
      const toContactInfo = await this.getContactInfo(message);
      // Get contact info for sender (FROM - session owner)
      const fromPhoneNumber = this.getE164FromSession(sessionId);
      let fromContactInfo = null;
      let toPhoneNumber = message.to;
      const isGroupDestination =
        String(message?.to || "").includes("@g.us") ||
        String(toContactInfo?.phone || "").includes("@g.us") ||
        !!toContactInfo?.isGroup;

      // Best-effort: resolve group name for outbound group messages
      let resolvedGroupName: string | undefined = toContactInfo?.groupName;
      if (isGroupDestination && !resolvedGroupName) {
        try {
          const chat = await message.getChat();
          resolvedGroupName = chat?.name || undefined;
        } catch {
          // ignore
        }
      }

      let toName = isGroupDestination
        ? resolvedGroupName || String(message?.to || "")
        : "Unknown";
      try {
        // Get the session owner's contact from WhatsApp
        const client = this.clients.get(sessionId);
        if (client) {
          const toContact = await client.getContactById(message.to);
          if (toContact) {
            // If this is a group destination, preserve the JID and prefer the group subject/name.
            if (isGroupDestination) {
              toPhoneNumber = message.to; // keep group JID (e.g., 123@g.us)
              toName =
                resolvedGroupName ||
                toContact.name ||
                toContact.pushname ||
                message.to;
            } else {
              toPhoneNumber = this.cleanPhoneNumber(toContact.number);
              toName = toContact.pushname || toContact.name || toPhoneNumber;
            }
          }
        }
        if (client) {
          const fromContact = await client.getContactById(fromPhoneNumber);
          if (fromContact) {
            fromContactInfo = {
              name:
                fromContact.pushname ||
                fromContact.name ||
                fromContact.shortName ||
                fromPhoneNumber,
              phone: fromContact.number || fromPhoneNumber,
              avatarUrl: null,
              username: fromContact.pushname || fromContact.name || undefined,
            };
            try {
              const profilePicUrl = await fromContact.getProfilePicUrl();
              fromContactInfo.avatarUrl = profilePicUrl || undefined;
            } catch (error) {
              // Profile picture not available
            }
          }
        }
      } catch (error) {
        this.logger.debug(
          `Failed to get sender contact info: ${error.message}`,
        );
      }

      // Fallback to session user info if contact info not available
      if (!fromContactInfo) {
        const sessionUser = await this.userModel.findOne({
          phoneNumber: fromPhoneNumber,
        });
        fromContactInfo = {
          name: sessionUser
            ? `${sessionUser.firstName} ${sessionUser.lastName}`
            : fromPhoneNumber,
          phone: fromPhoneNumber,
          avatarUrl: undefined,
          username: undefined,
        };
      }

      // Determine conversation ID
      const conversationId =
        isGroupDestination && resolvedGroupName
          ? `group-${resolvedGroupName}`
          : message.to;

      // Determine names: use group name if group, otherwise use contact name
      const fromName = fromContactInfo.name || fromPhoneNumber;

      const messageData = {
        _id: new Types.ObjectId(),
        whatsappMessageId: message.id._serialized,
        from: message.from,
        to: message.to,
        fromPhoneNumber,
        toPhoneNumber,
        // New fields: names and avatars
        fromName,
        toName,
        fromAvatarUrl: toContactInfo.avatarUrl,
        toAvatarUrl: fromContactInfo.avatarUrl,
        type: this.getMessageType(message.type),
        direction: MessageDirection.OUTBOUND,
        content: message.body || (isCallLog ? "Call log" : ""),
        mediaUrl,
        status: MessageStatus.SENT,
        sentAt: new Date(message.timestamp * 1000),
        conversationId: conversationId,
        entityId: session.entityId,
        entityIdPath: entity.entityIdPath,
        tenantId: session.tenantId,
        // WhatsApp contact information
        whatsappUsername: toContactInfo.username || toContactInfo.name,
        whatsappGroupName: resolvedGroupName,
        isGroupMessage: isGroupDestination,
        metadata: {
          hasMedia: message.hasMedia,
          isForwarded: message.isForwarded,
          isStarred: message.isStarred,
          mediaType: message.type,
          caption: message.caption,
          callLog: isCallLog,
          callLogType: message.type,
          callLogBody: message.body,
        },
      };

      await this.messageModel.create(messageData);

      // Update session statistics
      await this.sessionModel.findOneAndUpdate(
        { sessionId },
        {
          $inc: { messagesSent: 1 },
          lastActivityAt: new Date(),
        },
      );

      this.logger.log(`Outgoing message saved: ${message.id._serialized}`);
    } catch (error) {
      this.logger.error(
        `Failed to handle outgoing message: ${error.message}`,
        error,
      );
    }
  }

  private async handleCallEvent(sessionId: string, call: any): Promise<void> {
    try {
      const session = await this.sessionModel.findOne({ sessionId });
      if (!session) return;

      const callId =
        call?.id?._serialized || call?.id || `${sessionId}-call-${Date.now()}`;
      const callIdStr = callId.toString();

      const entity = await this.entityService.findOne(
        session.entityId.toString(),
        null,
      );
      if (!entity.entityIdPath || entity.entityIdPath.length === 0) {
        this.logger.warn(
          `Failed to get entity path for entity: ${session.entityId}`,
        );
      }

      const sessionE164 = this.getE164FromSession(sessionId);
      const sessionJid = sessionE164
        ? `${sessionE164.replace(/\+/g, "")}@c.us`
        : sessionId;

      const sessionDigits = sessionE164
        ? sessionE164.replace(/[^\d]/g, "")
        : null;
      const jidMatchesSession = (jid?: string) => {
        if (!jid || !sessionDigits) return false;
        const digits = jid.replace(/[^\d]/g, "");
        return digits.endsWith(sessionDigits);
      };

      const isFromSession =
        jidMatchesSession(call?.from) || jidMatchesSession(call?.id?.from);
      const isFromMe = call?.fromMe ?? call?.id?.fromMe ?? isFromSession;

      // Resolve counterparty JID (not the session owner)
      const pickRemoteJid = (): string | null => {
        const candidates = [
          // Outbound typically has `to`
          call?.to,
          // Common peer fields
          call?.peerJid,
          call?.peer,
          call?.id?.remote,
          call?.id?.to,
          call?.id?.user,
          call?.id?.from,
          call?.from,
        ].filter(Boolean) as string[];

        for (const jid of candidates) {
          if (!jidMatchesSession(jid)) {
            return jid;
          }
        }
        return null;
      };

      const remoteJidOriginal = pickRemoteJid() || "";
      const normalizedRemoteJid =
        this.normalizeJid(remoteJidOriginal) || remoteJidOriginal;
      let resolvedRemoteJid = normalizedRemoteJid || remoteJidOriginal;

      // Resolve LID to actual phone number
      const isLid = remoteJidOriginal.endsWith("@lid");
      let resolvedE164FromLid: string | null = null;
      if (isLid) {
        try {
          const client = this.clients.get(sessionId);
          if (client) {
            const contact = await client.getContactById(remoteJidOriginal);
            if (contact && contact.number) {
              resolvedE164FromLid = this.cleanPhoneNumber(contact.number);
              resolvedRemoteJid = `${contact.number}@c.us`;
              this.logger.debug(
                `Resolved LID ${remoteJidOriginal} → ${resolvedE164FromLid}`,
              );
            }
          }
        } catch (error) {
          this.logger.debug(
            `Failed to resolve LID ${remoteJidOriginal}: ${error.message}`,
          );
        }
      }

      const direction = isFromMe
        ? MessageDirection.OUTBOUND
        : MessageDirection.INBOUND;

      const from =
        direction === MessageDirection.OUTBOUND
          ? sessionJid
          : resolvedRemoteJid || sessionJid;
      const to =
        direction === MessageDirection.OUTBOUND
          ? resolvedRemoteJid || sessionJid
          : sessionJid;

      // Use resolved E.164 from LID if available, otherwise try to clean the JID
      const remotePhoneNumber = resolvedE164FromLid
        ? resolvedE164FromLid
        : resolvedRemoteJid
          ? this.cleanPhoneNumber(resolvedRemoteJid)
          : null;

      const fromPhoneNumber =
        direction === MessageDirection.OUTBOUND
          ? sessionE164
          : remotePhoneNumber || sessionE164;

      const toPhoneNumber =
        direction === MessageDirection.OUTBOUND
          ? remotePhoneNumber || resolvedRemoteJid || sessionE164
          : sessionE164;

      const callTimestamp = call?.timestamp
        ? new Date(call.timestamp * 1000)
        : new Date();

      let remoteName = remotePhoneNumber || resolvedRemoteJid || "Unknown";
      let remoteAvatarUrl = undefined;
      try {
        const client = this.clients.get(sessionId);
        if (client && resolvedRemoteJid) {
          const contact = await client.getContactById(resolvedRemoteJid);
          if (contact) {
            remoteName =
              contact.pushname ||
              contact.name ||
              contact.shortName ||
              remoteName;
            try {
              const profilePicUrl = await contact.getProfilePicUrl();
              remoteAvatarUrl = profilePicUrl || undefined;
            } catch {
              // Profile picture not available
            }
          }
        }
      } catch (error) {
        this.logger.debug(
          `Failed to get contact info for call ${callId}: ${error.message}`,
        );
      }

      let sessionOwnerName =
        session.phoneNumber || sessionE164 || sessionId || "Me";
      try {
        const sessionUser = await this.userModel.findOne({
          phoneNumber: sessionE164,
        });
        if (sessionUser) {
          sessionOwnerName =
            `${sessionUser.firstName} ${sessionUser.lastName}`.trim();
        }
      } catch (error) {
        this.logger.debug(
          `Failed to load session owner for call ${callId}: ${error.message}`,
        );
      }

      const registrationCheckNumber =
        direction === MessageDirection.OUTBOUND
          ? toPhoneNumber
          : remotePhoneNumber;
      const registeredRemote =
        registrationCheckNumber && session.tenantId
          ? await this.checkIfRegisteredUser(
              registrationCheckNumber,
              session.tenantId,
            )
          : null;
      const isExternalNumber = !registeredRemote;

      const translationKey =
        direction === MessageDirection.OUTBOUND
          ? call?.isVideo
            ? "call.outgoing.video"
            : "call.outgoing.voice"
          : call?.isVideo
            ? "call.incoming.video"
            : "call.incoming.voice";

      const content =
        direction === MessageDirection.OUTBOUND
          ? call?.isVideo
            ? "Outgoing video call"
            : "Outgoing voice call"
          : call?.isVideo
            ? "Incoming video call"
            : "Incoming voice call";

      const conversationId = normalizedRemoteJid || sessionJid;

      const messageData = {
        whatsappMessageId: callIdStr,
        from,
        to,
        fromPhoneNumber: fromPhoneNumber || from,
        toPhoneNumber: toPhoneNumber || to,
        fromName:
          direction === MessageDirection.OUTBOUND
            ? sessionOwnerName
            : remoteName,
        toName:
          direction === MessageDirection.OUTBOUND
            ? remoteName
            : sessionOwnerName,
        fromAvatarUrl:
          direction === MessageDirection.OUTBOUND ? undefined : remoteAvatarUrl,
        toAvatarUrl:
          direction === MessageDirection.OUTBOUND ? remoteAvatarUrl : undefined,
        type: MessageType.CALL,
        direction,
        content,
        mediaUrl: null,
        status:
          direction === MessageDirection.OUTBOUND
            ? MessageStatus.SENT
            : MessageStatus.DELIVERED,
        sentAt: callTimestamp,
        deliveredAt:
          direction === MessageDirection.INBOUND ? new Date() : undefined,
        conversationId,
        entityId: session.entityId,
        entityIdPath: entity.entityIdPath,
        tenantId: session.tenantId,
        isExternalNumber,
        metadata: {
          isGroup: !!call?.isGroup,
          isVideo: !!call?.isVideo,
          isOnline: call?.isOnline,
          canHandle: call?.canHandle,
          isOffer: !!call?.isOffer,
          remoteJid: normalizedRemoteJid,
          remoteJidOriginal,
          duration: call?.duration ?? call?.time ?? call?.t,
          translationKey,
          translationParams: {
            direction,
            isVideo: !!call?.isVideo,
          },
          callPayload: {
            id: call?.id?._serialized || call?.id,
            from: call?.from,
            to: call?.to,
            timestamp: call?.timestamp,
            rawType: call?.type,
          },
        },
      };

      const existingCall = await this.messageModel.findOne({
        whatsappMessageId: callIdStr,
      });

      if (existingCall) {
        await this.messageModel.findOneAndUpdate(
          { whatsappMessageId: callId },
          { $set: messageData },
        );
        this.logger.log(`Call event updated: ${callId} (${direction})`);
        return;
      }

      await this.messageModel.create({
        _id: new Types.ObjectId(),
        ...messageData,
      });

      await this.sessionModel.findOneAndUpdate(
        { sessionId },
        {
          $inc:
            direction === MessageDirection.OUTBOUND
              ? { messagesSent: 1 }
              : { messagesReceived: 1 },
          lastActivityAt: new Date(),
        },
      );

      this.logger.log(`Call event saved: ${callId} (${direction})`);
    } catch (error) {
      this.logger.error(`Failed to handle call event: ${error.message}`, error);
    }
  }

  private async handleMediaUpload(message: any): Promise<string | null> {
    try {
      const media = await message.downloadMedia();
      if (!media) return null;

      const { data, mimetype } = media;
      const extension = mimetype.split("/")[1];
      const fileName = `${message.id._serialized}.${extension}`;

      // Convert base64 to buffer
      const buffer = Buffer.from(data, "base64");

      // Upload to cloud storage using StorageService
      const uploadResult = await this.storageService.uploadFile(
        buffer,
        fileName,
        mimetype,
        "whatsapp-media",
      );

      this.logger.log(`Media uploaded to cloud storage: ${uploadResult.url}`);
      // Return proxy URL instead of direct cloud storage URL
      return uploadResult.proxyUrl;
    } catch (error) {
      this.logger.error(`Failed to upload media: ${error.message}`, error);
      return null;
    }
  }

  private async handleMessageAck(
    sessionId: string,
    message: any,
    ack: number,
  ): Promise<void> {
    try {
      const statusMap = new Map<number, MessageStatus>([
        [0, MessageStatus.PENDING],
        [1, MessageStatus.SENT],
        [2, MessageStatus.DELIVERED],
        [3, MessageStatus.READ],
        [-1, MessageStatus.FAILED],
      ]);

      const status = statusMap.get(ack) || MessageStatus.PENDING;
      const updateData: any = { status };

      if (status === MessageStatus.SENT) updateData.sentAt = new Date();
      if (status === MessageStatus.DELIVERED)
        updateData.deliveredAt = new Date();
      if (status === MessageStatus.READ) updateData.readAt = new Date();
      if (status === MessageStatus.FAILED) updateData.failedAt = new Date();

      await this.messageModel.findOneAndUpdate(
        { whatsappMessageId: message.id._serialized },
        updateData,
      );

      // Update session statistics
      if (status === MessageStatus.DELIVERED) {
        await this.sessionModel.findOneAndUpdate(
          { sessionId },
          { $inc: { messagesDelivered: 1 } },
        );
      } else if (status === MessageStatus.FAILED) {
        await this.sessionModel.findOneAndUpdate(
          { sessionId },
          { $inc: { messagesFailed: 1 } },
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle message ack: ${error.message}`,
        error,
      );
    }
  }

  private getMessageType(type: string): MessageType {
    const typeMap: Record<string, MessageType> = {
      chat: MessageType.TEXT,
      image: MessageType.IMAGE,
      video: MessageType.VIDEO,
      audio: MessageType.AUDIO,
      ptt: MessageType.AUDIO,
      document: MessageType.DOCUMENT,
      location: MessageType.LOCATION,
      vcard: MessageType.CONTACT,
      sticker: MessageType.STICKER,
      call: MessageType.CALL,
      call_log: MessageType.CALL,
    };
    return typeMap[type] || MessageType.TEXT;
  }

  private isCallLogMessage(message: any): boolean {
    return message?.type === "call_log";
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

  private async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    message?: string,
  ): Promise<void> {
    await this.sessionModel.findOneAndUpdate(
      { sessionId },
      { status, lastActivityAt: new Date() },
    );
    this.qrGateway.emitStatus(sessionId, { status, message });
  }

  async reconnectActiveSessions(isStartup = false): Promise<void> {
    this.logger.debug(
      `[SERVICE] Starting reconnect of active sessions (isStartup=${isStartup})`,
    );

    // On pod startup use a wide window (default 24 h) so all sessions that
    // were live before a crash/deploy are restored.  For the periodic scheduler
    // sweep (every 2 min) use a narrow window matching the hibernate threshold
    // so the sweep does NOT immediately undo deliberate hibernation.
    const reconnectMaxIdleMs = isStartup
      ? Number(process.env.WHATSAPP_STARTUP_RECONNECT_MAX_IDLE_MS) ||
        24 * 60 * 60 * 1000
      : Number(process.env.WHATSAPP_RECONNECT_MAX_IDLE_MS) ||
        30 * 60 * 1000;
    const reconnectCutoff = new Date(Date.now() - reconnectMaxIdleMs);

    const activeSessions = await this.sessionModel.find({
      // IMPORTANT: do NOT depend on WhatsAppSession.isActive for reconnection.
      // Production data contains READY sessions with isActive=false, which would otherwise
      // prevent RemoteAuth reconnection on pod restart.
      $or: [
        {
          status: { $in: [SessionStatus.READY, SessionStatus.AUTHENTICATED] },
          // Only wake sessions with recent activity. Sessions idle longer than
          // reconnectMaxIdleMs are intentionally hibernated by cleanupIdleClients
          // and will reconnect automatically once lastActivityAt is refreshed by
          // new message activity or an explicit user action.
          $or: [
            { lastActivityAt: { $gte: reconnectCutoff } },
            // Reconnect legacy sessions that pre-date the lastActivityAt field.
            { lastActivityAt: { $exists: false } },
          ],
        },
        { status: SessionStatus.CONNECTING },
        {
          // Previously connected sessions that got marked DISCONNECTED during restarts.
          // Some legacy docs may have missing connectedAt, but will still have whatsappId/phoneNumber.
          // Always try to reconnect DISCONNECTED sessions regardless of idle time —
          // they are visibly broken to users and should self-heal.
          status: SessionStatus.DISCONNECTED,
          $or: [
            { connectedAt: { $exists: true, $ne: null } },
            { whatsappId: { $exists: true, $ne: null } },
            { phoneNumber: { $exists: true, $ne: null } },
          ],
        },
      ],
    });
    this.logger.debug(
      `[SERVICE] Found ${activeSessions.length} active sessions to reconnect (READY, AUTHENTICATED, CONNECTING, or previously-connected DISCONNECTED)`,
    );

    const hasQueue = this.shouldUseQueue();
    const nodeEnv = this.configService.get<string>(
      "app.nodeEnv",
      "development",
    );
    this.logger.debug(
      `[SERVICE] Queue availability for reconnection: hasQueue=${hasQueue}, nodeEnv=${nodeEnv}`,
    );

    for (const session of activeSessions) {
      try {
        this.logger.log(
          `[SERVICE] Reconnecting/reinitializing session: sessionId=${session.sessionId}, status=${session.status}, userId=${session.userId?.toString?.()}, tenantId=${session.tenantId?.toString?.()}`,
        );
        if (hasQueue) {
          this.logger.debug(
            `[SERVICE] Using queue-based reconnection: sessionId=${session.sessionId}`,
          );
          try {
            await this.whatsappQueueService.queueReconnectSession(
              session.sessionId,
              session.userId?.toString?.(),
              session.tenantId?.toString?.(),
            );
            this.logger.debug(
              `[SERVICE] Successfully queued session reconnection: sessionId=${session.sessionId}`,
            );
          } catch (queueError) {
            this.logger.error(
              `[SERVICE] Failed to queue session reconnection, falling back to direct reconnect: sessionId=${session.sessionId}, error=${queueError instanceof Error ? queueError.message : String(queueError)}`,
              queueError instanceof Error ? queueError.stack : undefined,
            );
            this.logger.debug(
              `[SERVICE] Falling back to direct reconnection: sessionId=${session.sessionId}`,
            );
            await this.initializeClient(session.sessionId);
          }
        } else {
          this.logger.debug(
            `[SERVICE] Queue not available, using direct reconnection: sessionId=${session.sessionId}`,
          );
          await this.initializeClient(session.sessionId);
        }
      } catch (error) {
        this.logger.error(
          `[SERVICE] Failed to reconnect session: sessionId=${session.sessionId}, error=${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    this.logger.debug(`[SERVICE] Completed reconnect of active sessions`);
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
   * Check if a phone number belongs to a registered user
   * @param phoneNumber E164 formatted phone number
   * @param tenantId Tenant ID to check within
   * @returns User document if registered, null if external
   */
  private async checkIfRegisteredUser(
    phoneNumber: string,
    tenantId: Types.ObjectId,
  ): Promise<any> {
    try {
      // Find user by phone number within the tenant
      const user = await this.userModel
        .findOne({
          phoneNumber: phoneNumber,
          tenantId: tenantId,
          isActive: true,
          registrationStatus: { $in: ["registered", "invited"] },
        })
        .select("firstName lastName email phoneNumber role");

      return user;
    } catch (error) {
      this.logger.error(
        `Error checking registered user for ${phoneNumber}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Extract contact information from WhatsApp message
   * @param message WhatsApp message object
   * @returns Contact info object with avatar, username, and group info
   */
  private async getContactInfo(message: any): Promise<{
    name: string;
    phone: string;
    avatarUrl?: string;
    username?: string;
    groupName?: string;
    isGroup?: boolean;
  }> {
    try {
      const fromJid = String(message?.from || "");
      const toJid = String(message?.to || "");
      const groupJid = fromJid.includes("@g.us")
        ? fromJid
        : toJid.includes("@g.us")
          ? toJid
          : null;

      // Try to get contact info from WhatsApp
      const contact = await message.getContact();
      const name = contact.pushname || contact.name || contact.shortName || "";
      // For group chats, prefer the group JID as the "phone" identifier
      const phone = groupJid || contact.number || fromJid;

      // Get profile picture URL
      let avatarUrl = null;
      try {
        const profilePicUrl = await contact.getProfilePicUrl();
        avatarUrl = profilePicUrl || null;
      } catch (error) {
        // Profile picture not available
        this.logger.debug(`No profile picture for ${phone}`);
      }

      // Check if message is from a group
      let groupName = null;
      let isGroup = false;
      try {
        if (groupJid) {
          isGroup = true;
          const chat = await message.getChat();
          groupName = chat.name || null;
        }
      } catch (error) {
        this.logger.debug(
          `Not a group message or failed to get group info: ${error.message}`,
        );
      }

      return {
        name: (isGroup ? (groupName || "").trim() : name.trim()) || "Unknown",
        phone,
        avatarUrl: avatarUrl || undefined,
        username: isGroup ? undefined : name.trim() || undefined,
        groupName: groupName || undefined,
        isGroup: isGroup,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get contact info for ${message.from}:`,
        error,
      );
      return {
        name: "Unknown",
        phone: String(message?.to || message?.from || ""),
      };
    }
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

  /**
   * Normalize a WhatsApp JID to the standard user format (e.g., 123@c.us).
   * Groups and broadcast JIDs are returned unchanged.
   */
  private normalizeJid(jid?: string): string | null {
    if (!jid) return null;
    const lower = jid.toLowerCase();
    const isGroup = lower.endsWith("@g.us") || lower.includes("@broadcast");
    if (isGroup) return jid;

    const digitsOnly = jid.replace(/[^\d]/g, "");
    if (!digitsOnly) return jid;

    return `${digitsOnly}@c.us`;
  }

  /**
   * Convert sessionId to E164 phone number
   * @param sessionId WhatsApp session ID
   * @returns E164 formatted phone number or null if session not found
   */
  private getE164FromSession(sessionId: string): string {
    try {
      const e164 = sessionId.replace("whatsapp-", "+");
      return this.cleanPhoneNumber(e164);
    } catch (error) {
      this.logger.error(`Failed to get E164 from session ${sessionId}:`, error);
      return null;
    }
  }

  private cleanPhoneNumber(phoneNumber: string): string {
    // Remove any non-digit characters except +
    let cleaned = phoneNumber.replace(/[^\d+]/g, "");

    // If it doesn't start with +, assume it needs country code
    if (!cleaned.startsWith("+")) {
      // This is a simplified approach - in production you might want to use a library like libphonenumber
      // For now, we'll just return the original number
      cleaned = "+" + cleaned;
    }

    return cleaned;
  }

  /**
   * Process failed messages from DLQ
   */
  async processMessageDLQ(): Promise<void> {
    // This method is no longer needed as DLQService is removed.
    // If DLQ functionality is still required, it needs to be re-implemented or removed.
    // For now, we'll just log a message.
    this.logger.warn(
      "DLQ processing is no longer available as DLQService is removed.",
    );
  }
}
