import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { Model, Types } from "mongoose";
import {
  WhatsAppSession,
  WhatsAppSessionDocument,
  SessionStatus,
} from "../../common/schemas/whatsapp-session.schema";
import { WhatsAppService } from "./whatsapp.service";
import { EmailService } from "../email/email.service";
import { InjectModel } from "@nestjs/mongoose";
import { User, UserDocument } from "../../common/schemas/user.schema";
import {
  recordWhatsAppAlertEvent,
  recordWhatsAppHealthCheck,
} from "../../telemetry";

@Injectable()
export class WhatsAppHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppHealthService.name);
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly alertCooldownMs: number;
  private readonly enabled: boolean;

  constructor(
    @InjectModel(WhatsAppSession.name)
    private readonly sessionModel: Model<WhatsAppSessionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.enabled =
      this.configService.get<boolean>(
        "whatsapp.healthCheckEnabled",
        process.env.WHATSAPP_HEALTHCHECK_ENABLED !== "false",
      ) ?? true;
    this.intervalMs =
      Number(
        this.configService.get<string>(
          "whatsapp.healthCheckIntervalMs",
          process.env.WHATSAPP_HEALTHCHECK_INTERVAL_MS || "300000",
        ),
      ) || 300000; // default 5 minutes
    this.failureThreshold =
      Number(
        this.configService.get<string>(
          "whatsapp.healthCheckFailureThreshold",
          process.env.WHATSAPP_HEALTHCHECK_FAILURE_THRESHOLD || "3",
        ),
      ) || 3;

    // Throttle alert emails so we don't spam users every tick while a session is down.
    this.alertCooldownMs =
      Number(
        this.configService.get<string>(
          "whatsapp.healthAlertCooldownMs",
          process.env.WHATSAPP_HEALTH_ALERT_COOLDOWN_MS || "3600000",
        ),
      ) || 3600000; // default: 1 hour
  }

  onModuleInit() {}

  onModuleDestroy() {
    if (!this.enabled) return;
    const name = "whatsapp-health-check";
    try {
      this.schedulerRegistry.deleteInterval(name);
      this.logger.log("[HealthCheckTick] Scheduler stopped");
    } catch {
      // ignore
    }
  }

  /**
   * Manual health check for a single session that reuses the exact same logic
   * as the periodic scheduler: update persisted fields, alert, and reconnect.
   */
  async runHealthCheckForSessionId(sessionId: string): Promise<any> {
    const session = await this.sessionModel
      .findOne({ sessionId })
      .select(
        "_id sessionId tenantId phoneNumber whatsappName lastHealthStatus consecutiveHealthFailures lastHealthAlertAt status isActive",
      )
      .lean();

    if (!session) {
      throw new NotFoundException("Session not found");
    }

    // Match periodic scheduler eligibility so manual checks behave the same.
    const st = (session as any).status;
    const eligibleByStatus =
      [
        SessionStatus.READY,
        SessionStatus.AUTHENTICATED,
        SessionStatus.FAILED,
        SessionStatus.CONNECTING,
      ].includes(st) ||
      (st === SessionStatus.DISCONNECTED && !!(session as any).connectedAt);
    const eligible =
      eligibleByStatus || this.whatsappService.hasActiveClient(sessionId);

    if (eligible) {
      // IMPORTANT: manual/dedicated checks must NOT update nextHealthCheckAt
      await this.checkSession(session as any, { isPeriodic: false });
    }

    // Return the same payload shape the UI already understands.
    return this.whatsappService.getSessionStatus(sessionId);
  }

  async checkSession(
    session: {
      _id: Types.ObjectId;
      sessionId: string;
      tenantId: Types.ObjectId;
      phoneNumber?: string;
      whatsappName?: string;
      lastHealthStatus?: string;
      consecutiveHealthFailures?: number;
      lastHealthAlertAt?: Date;
    },
    options?: { isPeriodic?: boolean },
  ) {
    try {
      const status = await this.whatsappService.getSessionStatus(
        session.sessionId,
      );
      const health = status.healthStatus;
      const consecutiveFailures = health?.consecutiveFailures || 0;
      const now = Date.now();
      const nextHealthCheckAt =
        options?.isPeriodic === true
          ? new Date(now + this.intervalMs)
          : undefined;

      await this.sessionModel.updateOne(
        { _id: session._id },
        {
          $set: {
            lastHealthStatus: health?.lastStatus || "unknown",
            lastHealthCheckAt: new Date(),
            ...(options?.isPeriodic === true ? { nextHealthCheckAt } : {}),
            consecutiveHealthFailures: consecutiveFailures,
            lastHealthError: undefined,
          },
        },
      );

      if (
        health?.lastStatus === "failed" ||
        consecutiveFailures >= this.failureThreshold
      ) {
        // Requirement: if health checks keep failing more than the threshold,
        // disconnect the session and alert the user.
        if (consecutiveFailures > this.failureThreshold) {
          await this.handleFailureThresholdExceeded(
            session,
            `Health check failed (${consecutiveFailures} consecutive)`,
            consecutiveFailures,
          );
        } else {
          this.raiseAlert(
            session,
            `Health check failed (${consecutiveFailures} consecutive)`,
            consecutiveFailures,
          );
          try {
            await this.whatsappService.requestReconnect(session.sessionId);
            this.logger.log(
              `[HealthCheck] Requested reconnect for session=${session.sessionId}`,
            );
          } catch (err) {
            this.logger.error(
              `[HealthCheck] Failed to request reconnect for session=${session.sessionId}: ${err?.message || err}`,
            );
          }
        }
      }

      const normalizedStatus =
        health?.lastStatus === "success" ||
        health?.lastStatus === "failed" ||
        health?.lastStatus === "warning"
          ? health?.lastStatus
          : "warning";
      recordWhatsAppHealthCheck({
        sessionId: session.sessionId,
        tenantId: session.tenantId?.toString?.(),
        phoneNumber: session.phoneNumber,
        status: normalizedStatus,
        consecutiveFailures,
        reason: health?.lastStatus,
      });
    } catch (error: any) {
      const consecutive = (session.consecutiveHealthFailures || 0) + 1;
      const now = Date.now();
      const nextHealthCheckAt =
        options?.isPeriodic === true
          ? new Date(now + this.intervalMs)
          : undefined;

      await this.sessionModel.updateOne(
        { _id: session._id },
        {
          $set: {
            lastHealthStatus: "failed",
            lastHealthCheckAt: new Date(),
            ...(options?.isPeriodic === true ? { nextHealthCheckAt } : {}),
            consecutiveHealthFailures: consecutive,
            lastHealthError: error?.message || "Health check failed",
          },
        },
      );

      if (consecutive >= this.failureThreshold) {
        if (consecutive > this.failureThreshold) {
          await this.handleFailureThresholdExceeded(
            session,
            `Health check error: ${error?.message || "unknown"}`,
            consecutive,
          );
        } else {
          this.raiseAlert(
            session,
            `Health check error: ${error?.message || "unknown"}`,
            consecutive,
          );
          try {
            await this.whatsappService.requestReconnect(session.sessionId);
            this.logger.log(
              `[HealthCheck] Requested reconnect for session=${session.sessionId} (error path)`,
            );
          } catch (err) {
            this.logger.error(
              `[HealthCheck] Failed to request reconnect for session=${session.sessionId} (error path): ${err?.message || err}`,
            );
          }
        }
      }

      recordWhatsAppHealthCheck({
        sessionId: session.sessionId,
        tenantId: session.tenantId?.toString?.(),
        phoneNumber: session.phoneNumber,
        status: "failed",
        consecutiveFailures: consecutive,
        errorMessage: error?.message || "Health check failed",
        reason: "error",
      });
    }
  }

  private async handleFailureThresholdExceeded(
    session: {
      _id: Types.ObjectId;
      sessionId: string;
      tenantId: Types.ObjectId;
      phoneNumber?: string;
      whatsappName?: string;
      lastHealthAlertAt?: Date;
    },
    reason: string,
    consecutiveFailures: number,
  ): Promise<void> {
    this.raiseAlert(session, `${reason} (disconnecting)`, consecutiveFailures);
    try {
      // "Wipe" the session so next init requires a fresh QR (removes RemoteAuth backups + local auth).
      await this.whatsappService.removeSession(session.sessionId);
      this.logger.warn(
        `[HealthCheck] Wiped/unlinked session=${session.sessionId} after ${consecutiveFailures} consecutive failures`,
      );
    } catch (err) {
      this.logger.error(
        `[HealthCheck] Failed to wipe/unlink session=${session.sessionId} after ${consecutiveFailures} failures: ${err?.message || err}`,
      );
    }
  }

  private raiseAlert(
    session: {
      sessionId: string;
      tenantId: Types.ObjectId;
      phoneNumber?: string;
      whatsappName?: string;
    },
    reason: string,
    consecutiveFailures: number,
  ) {
    this.logger.warn(
      `[HealthCheck] Session=${session.sessionId}, tenant=${session.tenantId?.toString()}, phone=${session.phoneNumber || "n/a"} failed: ${reason}`,
    );
    recordWhatsAppAlertEvent({
      eventType: "health_check_failed",
      sessionId: session.sessionId,
      tenantId: session.tenantId?.toString?.(),
      phoneNumber: session.phoneNumber,
      reason,
      status: "failed",
    });
    // Notify user via email (best-effort)
    this.notifyUser(session, reason, consecutiveFailures).catch((err) =>
      this.logger.error(
        `[HealthCheck] Failed to send alert email for session=${session.sessionId}: ${err?.message || err}`,
      ),
    );
  }

  private async notifyUser(
    session: {
      sessionId: string;
      tenantId: Types.ObjectId;
      phoneNumber?: string;
      whatsappName?: string;
      lastHealthAlertAt?: Date;
    },
    reason: string,
    consecutiveFailures: number,
  ) {
    // Basic throttle to avoid spamming the same user repeatedly
    const now = Date.now();
    const lastAlertAt = session.lastHealthAlertAt
      ? new Date(session.lastHealthAlertAt).getTime()
      : 0;
    if (lastAlertAt && now - lastAlertAt < this.alertCooldownMs) {
      this.logger.debug(
        `[HealthCheck] Skipping alert email due to cooldown: session=${session.sessionId}, cooldownMs=${this.alertCooldownMs}`,
      );
      return;
    }

    const owner = await this.userModel
      .findOne({ whatsappSessionId: session.sessionId })
      .lean();

    // Fallback: try to find by phoneNumber if not found by session
    const userRecord =
      owner ||
      (session.phoneNumber
        ? await this.userModel
            .findOne({ phoneNumber: session.phoneNumber })
            .lean()
        : null);

    const toEmail = userRecord?.email;
    if (!toEmail) {
      this.logger.debug(
        `[HealthCheck] No email found to alert for session=${session.sessionId}`,
      );
      return;
    }

    await this.emailService.sendWhatsAppHealthAlert(toEmail, {
      sessionId: session.sessionId,
      phoneNumber: session.phoneNumber,
      whatsappName: session.whatsappName,
      lastHealthStatus: "failed",
      consecutiveFailures,
      reason,
      language: (userRecord as any)?.language || "en",
    });

    // Record alert time for throttling (best-effort)
    try {
      await this.sessionModel.updateOne(
        { sessionId: session.sessionId },
        { $set: { lastHealthAlertAt: new Date() } },
      );
    } catch (err) {
      this.logger.debug(
        `[HealthCheck] Failed to update lastHealthAlertAt for session=${session.sessionId}: ${err?.message || err}`,
      );
    }
  }
}
