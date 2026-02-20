import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SessionStatus,
  WhatsAppSession,
  WhatsAppSessionDocument,
} from "../../src/common/schemas/whatsapp-session.schema";
import { WhatsAppHealthService } from "../../src/modules/whatsapp/whatsapp-health.service";
import { JobQueueService } from "../job-queue/job-queue.service";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { WhatsAppService } from "../../src/modules/whatsapp/whatsapp.service";

@Injectable()
export class WhatsAppHealthWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppHealthWorker.name);
  private readonly FAILURE_THRESHOLD: number;
  private readonly ENABLED: boolean;

  private NAME = "whatsapp-health-check";
  private running: boolean;

  constructor(
    @InjectModel(WhatsAppSession.name)
    private readonly sessionModel: Model<WhatsAppSessionDocument>,
    private readonly whatsappService: WhatsAppService,
    private readonly whatsappHealthService: WhatsAppHealthService,
    private readonly jobQueueService: JobQueueService,
    private readonly configService: ConfigService,
  ) {
    this.ENABLED =
      this.configService.get<boolean>(
        "whatsapp.healthCheckEnabled",
        process.env.WHATSAPP_HEALTHCHECK_ENABLED !== "false",
      ) ?? true;

    this.FAILURE_THRESHOLD =
      Number(
        this.configService.get<string>(
          "whatsapp.healthCheckFailureThreshold",
          process.env.WHATSAPP_HEALTHCHECK_FAILURE_THRESHOLD || "3",
        ),
      ) || 3;
  }

  async onModuleInit() {
    if (!this.ENABLED) {
      this.logger.log("[HealthCheckTick] Scheduler disabled by configuration");
      return;
    }

    const cronExpression = "0 */5 * * * *";

    const processFn = async () => {
      this.logger.log(
        "[HealthCheckTick] Starting CronJob for whatsapp health check",
      );

      await this.runHealthChecks();
    };

    this.jobQueueService.registerWorker(this.NAME, processFn);

    await this.jobQueueService.registerCronJob(
      this.NAME,
      "run-health-check",
      cronExpression,
      {},
    );

    this.logger.log(
      `[HealthCheckTick] Scheduler started: interval = 5 minutes, failureThreshold=${this.FAILURE_THRESHOLD}`,
    );
  }

  async runHealthChecks(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        "[HealthCheckTick] Previous run still in progress; skipping this tick",
      );
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    const activeClientSessionIds =
      this.whatsappService.listActiveClientSessionIds?.() || [];
    const sessionOr: any[] = [
      {
        status: {
          $in: [
            SessionStatus.READY,
            SessionStatus.AUTHENTICATED,
            SessionStatus.FAILED,
            SessionStatus.CONNECTING,
          ],
        },
      },
      // Previously connected sessions that got marked DISCONNECTED (e.g. during restarts)
      // should still be health-checked so we can trigger reconnect/alerts.
      {
        status: SessionStatus.DISCONNECTED,
        connectedAt: { $exists: true, $ne: null },
      },
    ];
    if (activeClientSessionIds.length) {
      // If a client exists in-memory, include it even if DB flags are stale.
      sessionOr.push({ sessionId: { $in: activeClientSessionIds } });
    }

    const sessions = await this.sessionModel
      .find({ $or: sessionOr })
      .select(
        "_id sessionId tenantId phoneNumber whatsappName status connectedAt lastHealthStatus consecutiveHealthFailures lastHealthAlertAt",
      )
      .lean();

    if (!sessions.length) {
      this.logger.debug(
        `[HealthCheckTick] No eligible sessions found (activeClients=${activeClientSessionIds.length})`,
      );
      this.running = false;
      return;
    }

    this.logger.log(
      `[HealthCheckTick] Running health checks: sessions=${sessions.length}`,
    );

    for (const session of sessions) {
      await this.whatsappHealthService.checkSession(session, {
        isPeriodic: true,
      });
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `[HealthCheckTick] Completed health checks: sessions=${sessions.length}, durationMs=${durationMs}`,
    );
    this.running = false;
  }

  async onModuleDestroy() {
    if (!this.ENABLED) return;
    try {
      await this.jobQueueService.destroyWorker(this.NAME);
      this.logger.log("[HealthCheckTick] Scheduler stopped");
    } catch {
      // ignore
    }
  }
}
