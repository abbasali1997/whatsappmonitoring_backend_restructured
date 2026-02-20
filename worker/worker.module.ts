import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { WhatsAppModule } from "../src/modules/whatsapp/whatsapp.module";
import { DatabaseModule } from "../src/common/database/database.module";
import { WhatsAppHealthWorker } from "./whatsapp-health/whatsapp-health.worker";
import { JobQueueService } from "./job-queue/job-queue.service";
import { MongooseModule } from "@nestjs/mongoose";
import { configuration } from "../src/config/configuration";
import { validationSchema } from "../src/config/validation";
import { ScheduleModule } from "@nestjs/schedule";
import { CacheModule } from "../src/common/cache/cache.module";

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
  providers: [WhatsAppHealthWorker, JobQueueService],
})
export class WorkerModule {}
