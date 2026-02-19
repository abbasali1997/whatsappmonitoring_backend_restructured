import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { RateLimitGuard } from "./rate-limit.guard";
import { ValidationPipe } from "../validation/validation.pipe";
import { EncryptionService } from "./encryption.service";

@Module({
  imports: [ConfigModule],
  providers: [RateLimitGuard, ValidationPipe, EncryptionService],
  exports: [RateLimitGuard, ValidationPipe, EncryptionService],
})
export class SecurityModule {}
