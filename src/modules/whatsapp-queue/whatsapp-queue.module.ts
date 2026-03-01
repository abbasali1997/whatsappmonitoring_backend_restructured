import { WhatsAppQueueProcessor } from "@/apps/worker/processors/whatsapp-queue/whatsapp-queue.processor";
import { WhatsAppQueueService } from "@/modules/whatsapp-queue/whatsapp-queue.service";
import { forwardRef, Module } from "@nestjs/common";
import { WhatsAppModule } from "@/modules/whatsapp/whatsapp.module";

@Module({
  imports: [forwardRef(() => WhatsAppModule)],
  providers: [WhatsAppQueueProcessor, WhatsAppQueueService],
  exports: [WhatsAppQueueService],
})
export class WhatsAppQueueModule {}
