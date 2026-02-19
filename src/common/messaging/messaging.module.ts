import { Module, Global } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MessagingService } from "./messaging.service";
import { QueueService } from "./queue.service";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MessagingService, QueueService],
  exports: [MessagingService, QueueService],
})
export class MessagingModule {}
