import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EmailService } from "./email.service";
import { EmailController } from "./email.controller";
import { EmailQueueService } from "./email-queue.service";
import { EmailQueueProcessor } from "@/apps/worker/processors/email-queue/email-queue.processor";
import { MessagingModule } from "@/common/messaging/messaging.module";

@Module({
  imports: [ConfigModule, MessagingModule],
  controllers: [EmailController],
  providers: [EmailService, EmailQueueService, EmailQueueProcessor],
  exports: [EmailService, EmailQueueService],
})
export class EmailModule {}
