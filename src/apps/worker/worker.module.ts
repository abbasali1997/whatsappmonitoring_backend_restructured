import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { WhatsAppModule } from "@/modules/whatsapp/whatsapp.module";
import { DatabaseModule } from "@/common/database/database.module";
import { WhatsappWorker } from "@/job-queue/whatsapp/whatsapp.worker";
import { JobQueueWorker } from "@/job-queue/job-queue.worker";
import { MongooseModule } from "@nestjs/mongoose";
import { configuration } from "@/config/configuration";
import { validationSchema } from "@/config/validation";
import { ScheduleModule } from "@nestjs/schedule";
import { CacheModule } from "@/common/cache/cache.module";

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
  ],
  providers: [WhatsappWorker, JobQueueWorker],
})
export class WorkerModule {}
