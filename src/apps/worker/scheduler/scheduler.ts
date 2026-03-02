import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";

@Injectable()
export class Scheduler implements OnModuleDestroy {
  private readonly logger = new Logger(Scheduler.name);
  private connection: IORedis;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();

  constructor() {
    this.connection = new IORedis({
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT) || 6379,
      maxRetriesPerRequest: null,
    });
  }

  /**
   * Registers a new job queue and worker
   */
  registerWorker<T>(queueName: string, processFn: (data: T) => Promise<void>) {
    if (this.queues.has(queueName)) {
      return;
    }

    const queue = new Queue(queueName, {
      connection: this.connection,
    });

    const worker = new Worker(
      queueName,
      async (job: Job) => {
        await processFn(job.data);
      },
      {
        connection: this.connection,
      },
    );

    worker.on("completed", (job) => {
      this.logger.log(`Job ${job.name} completed`);
    });

    worker.on("failed", (job, err) => {
      this.logger.error(`Job ${job?.name} failed:`, err);
    });

    this.queues.set(queueName, queue);
    this.workers.set(queueName, worker);
  }

  async destroyWorker(): Promise<void> {
    const keys = this.queues.keys();
    for (const key of keys) {
      if (this.queues.has(key)) {
        this.queues.delete(key);
      }
    }
  }

  /**
   * Adds job to queue
   */
  async addJob<T>(queueName: string, data: T) {
    const queue = this.queues.get(queueName);

    if (!queue) {
      throw new Error(`Queue ${queueName} is not registered`);
    }

    await queue.add(queueName, data);
  }

  /**
   * Register CRON job
   */
  async registerCronJob<T>(
    queueName: string,
    jobName: string,
    cronExpression: string,
    data: T,
  ) {
    const queue = this.queues.get(queueName);
    if (!queue) throw new Error(`Queue ${queueName} not registered`);

    await queue.add(jobName, data, {
      repeat: {
        pattern: cronExpression,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async onModuleDestroy() {
    for (const worker of this.workers.values()) {
      await worker.close();
    }

    for (const queue of this.queues.values()) {
      await queue.close();
    }

    await this.connection.quit();
  }
}
