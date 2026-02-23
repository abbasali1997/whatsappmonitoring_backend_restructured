import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WhatsAppHealthService } from "@/modules/whatsapp/whatsapp-health.service";
import { JobQueueWorker } from "@/job-queue/job-queue.worker";
import { WhatsAppService } from "@/modules/whatsapp/whatsapp.service";
// import { WhatsAppService } from "@/modules/whatsapp/whatsapp.service";

@Injectable()
export class WhatsappWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappWorker.name);
  private readonly FAILURE_THRESHOLD: number;
  private readonly ENABLED: boolean;

  private HEALTH_QUEUE = "whatsapp-health-check";
  private RECONNECT_QUEUE = "whatsapp-reconnect-sweep";

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly whatsappHealthService: WhatsAppHealthService,
    private readonly jobQueueService: JobQueueWorker,
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
    // HEALTH CHECK
    await this.healthCheckScheduler();

    // RECONNECT SWEEP
    await this.reconnectSweepScheduler();
  }

  private async healthCheckScheduler() {
    if (!this.ENABLED) {
      this.logger.log("[HealthCheckTick] Scheduler disabled by configuration");
      return;
    }

    const cronExpression = "0 */5 * * * *";

    const processFn = async () => {
      this.logger.log(
        "[HealthCheckTick] Starting CronJob for whatsapp health check",
      );

      await this.whatsappHealthService.runHealthChecks();
    };

    this.jobQueueService.registerWorker(this.HEALTH_QUEUE, processFn);

    await this.jobQueueService.registerCronJob(
      this.HEALTH_QUEUE,
      "run-health-check",
      cronExpression,
      {},
    );

    this.logger.log(
      `[HealthCheckTick] Scheduler started: interval = 5 minutes, failureThreshold=${this.FAILURE_THRESHOLD}`,
    );
  }

  /**
   * Periodically attempt to reconnect active sessions in case a pod terminated
   * while holding the session lock. This allows other pods to take over once
   * the lock expires.
   */
  private async reconnectSweepScheduler(): Promise<void> {
    const cronExpression = "0 */2 * * * *";

    const processFn = async () => {
      this.logger.log(
        "[ReconnectSweepTick] Starting CronJob for whatsapp sessions reconnect",
      );
      try {
        await this.whatsappService.reconnectActiveSessions();
      } catch (error) {
        this.logger.error(
          `Error during WhatsApp reconnect sweep: ${error.message}`,
          error,
        );
      }
    };

    this.jobQueueService.registerWorker(this.RECONNECT_QUEUE, processFn);

    await this.jobQueueService.registerCronJob(
      this.RECONNECT_QUEUE,
      "run-reconnect-sweep",
      cronExpression,
      {},
    );

    this.logger.log(
      `[ReconnectSweepTick] Scheduler started: interval = 5 minutes`,
    );
  }

  async onModuleDestroy() {
    if (!this.ENABLED) return;
    try {
      await this.jobQueueService.destroyWorker(this.RECONNECT_QUEUE);
      await this.jobQueueService.destroyWorker(this.HEALTH_QUEUE);
      this.logger.log("[HealthCheckTick] Scheduler stopped");
    } catch {
      // ignore
    }
  }
}
