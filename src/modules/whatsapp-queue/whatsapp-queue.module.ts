import { WhatsAppQueueService } from "@/modules/whatsapp-queue/whatsapp-queue.service";
import { forwardRef, Module } from "@nestjs/common";
import { WhatsAppModule } from "@/modules/whatsapp/whatsapp.module";
import { WhatsAppQueueProcessor } from "@/processors/whatsapp-processor/whatsapp-queue.processor";

@Module({
  imports: [forwardRef(() => WhatsAppModule)],
  providers: [WhatsAppQueueProcessor, WhatsAppQueueService],
  exports: [WhatsAppQueueService],
})
export class WhatsAppQueueModule {}
