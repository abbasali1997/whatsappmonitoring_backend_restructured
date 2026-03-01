import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { WhatsAppModule } from "@/modules/whatsapp/whatsapp.module";
import { DatabaseModule } from "@/common/database/database.module";
import { WhatsappScheduler } from "@/apps/worker/scheduler/whatsapp/whatsapp.scheduler";
import { Scheduler } from "@/apps/worker/scheduler/scheduler";
import { MongooseModule } from "@nestjs/mongoose";
import { configuration } from "@/config/configuration";
import { validationSchema } from "@/config/validation";
import { ScheduleModule } from "@nestjs/schedule";
import { CacheModule } from "@/common/cache/cache.module";
import { MessagingModule } from "@/common/messaging/messaging.module";
import { EmailModule } from "@/modules/email/email.module";
import { WhatsAppQueueModule } from "@/modules/whatsapp-queue/whatsapp-queue.module";
import { EmailQueueProcessor } from "@/apps/worker/processors/email-queue/email-queue.processor";
import { WhatsAppQueueProcessor } from "@/apps/worker/processors/whatsapp-queue/whatsapp-queue.processor";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // Database
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        // useNewUrlParser and useUnifiedTopology are deprecated in the MongoDB driver 4.x
        // They have no effect and should be omitted to avoid deprecation warnings.
        return {
          uri: configService.get<string>("database.mongodbUri"),
        };
      },
      inject: [ConfigService],
    }),

    DatabaseModule,
    WhatsAppModule,
    CacheModule,
    MessagingModule,
    EmailModule,
    WhatsAppQueueModule,
  ],
  providers: [
    WhatsappScheduler,
    Scheduler,
    EmailQueueProcessor,
    WhatsAppQueueProcessor,
  ],
})
export class WorkerModule {}
