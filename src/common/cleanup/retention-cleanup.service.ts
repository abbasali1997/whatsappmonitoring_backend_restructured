import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { Model } from "mongoose";
import {
  WhatsAppSession,
  WhatsAppSessionDocument,
} from "../schemas/whatsapp-session.schema";
import { User, UserDocument, RegistrationStatus } from "../schemas/user.schema";

@Injectable()
export class RetentionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionCleanupService.name);
  private readonly intervalMs: number;
  private running = false;

  constructor(
    @InjectModel(WhatsAppSession.name)
    private readonly sessionModel: Model<WhatsAppSessionDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    const configInterval = this.configService.get<number>("cleanup.intervalMs");
    const envInterval = Number(process.env.CLEANUP_INTERVAL_MS);
    const interval = Number.isFinite(configInterval)
      ? Number(configInterval)
      : Number.isFinite(envInterval)
        ? envInterval
        : 21600000; // default: 6 hours
    this.intervalMs = interval;
  }

  onModuleInit() {
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      this.logger.warn(
        `[RetentionCleanup] Scheduler not started due to invalid intervalMs=${this.intervalMs}`,
      );
      return;
    }
    const name = "retention-cleanup";
    try {
      this.schedulerRegistry.deleteInterval(name);
    } catch {
      // ignore
    }

    const interval = setInterval(() => {
      void this.runCleanup();
    }, this.intervalMs);
    if (typeof (interval as any)?.unref === "function") {
      (interval as any).unref();
    }

    this.schedulerRegistry.addInterval(name, interval);
    this.logger.log(
      `[RetentionCleanup] Scheduler started: intervalMs=${this.intervalMs}`,
    );

    // Run once on startup (best-effort)
    void this.runCleanup();
  }

  onModuleDestroy() {
    const name = "retention-cleanup";
    try {
      this.schedulerRegistry.deleteInterval(name);
      this.logger.log("[RetentionCleanup] Scheduler stopped");
    } catch {
      // ignore
    }
  }

  private async runCleanup(): Promise<void> {
    if (this.running) {
      this.logger.debug(
        "[RetentionCleanup] Previous run still in progress; skipping",
      );
      return;
    }
    this.running = true;

    try {
      const now = new Date();
      const qrDays =
        Number(this.configService.get<string>("cleanup.qrCodeCleanupDays")) || 7;
      const inviteDays =
        Number(
          this.configService.get<string>("cleanup.failedInvitationCleanupDays"),
        ) || 14;

      const qrCutoff = new Date(now.getTime() - qrDays * 24 * 60 * 60 * 1000);
      const inviteCutoff = new Date(
        now.getTime() - inviteDays * 24 * 60 * 60 * 1000,
      );

      const expiredQrResult = await this.sessionModel.updateMany(
        { qrCodeExpiresAt: { $ne: null, $lte: now } },
        {
          $set: {
            qrCode: null,
            qrCodeGeneratedAt: null,
            qrCodeExpiresAt: null,
          },
        },
      );

      const qrHistoryResult = await this.userModel.updateMany(
        { "qrInvitationHistory.sentAt": { $lt: qrCutoff } },
        {
          $pull: { qrInvitationHistory: { sentAt: { $lt: qrCutoff } } },
        },
      );

      const staleInvitesResult = await this.userModel.updateMany(
        {
          registrationStatus: RegistrationStatus.INVITED,
          createdAt: { $lt: inviteCutoff },
        },
        {
          $set: {
            registrationStatus: RegistrationStatus.CANCELLED,
            isActive: false,
          },
        },
      );

      this.logger.log(
        `[RetentionCleanup] Completed: clearedQr=${expiredQrResult.modifiedCount || 0}, prunedQrHistory=${qrHistoryResult.modifiedCount || 0}, cancelledInvites=${staleInvitesResult.modifiedCount || 0}`,
      );
    } catch (error) {
      this.logger.error(
        `[RetentionCleanup] Failed to run cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
