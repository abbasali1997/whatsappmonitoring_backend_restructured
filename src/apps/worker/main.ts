import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { Logger } from "@nestjs/common";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger("WorkerBootstrap");

  logger.log("App worker is running");
}

bootstrap();
