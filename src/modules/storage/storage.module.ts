import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StorageService } from "./storage.service";
import { StorageController, MediaController } from "./storage.controller";

@Module({
  imports: [ConfigModule],
  providers: [StorageService],
  controllers: [StorageController, MediaController],
  exports: [StorageService],
})
export class StorageModule {}
