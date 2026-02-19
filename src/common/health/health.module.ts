import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EmailModule } from "../../modules/email/email.module";
import { HealthService } from "./health.service";
import { HealthController } from "./health.controller";

@Module({
  imports: [ConfigModule, EmailModule],
  providers: [HealthService],
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule {}
