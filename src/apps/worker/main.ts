import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { Logger } from "@nestjs/common";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger("WorkerBootstrap");
  logger.log("Worker is running");

  // Keep the process alive (createApplicationContext does not start an HTTP server)
  await new Promise(() => {});
}

bootstrap().catch((err) => {
  console.error("[WORKER] Fatal startup error:", err);
  process.exit(1);
});
