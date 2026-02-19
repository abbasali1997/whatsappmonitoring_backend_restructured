import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../common/database/database.module";
import { EntitiesService } from "./entities.service";
import { EntitiesController } from "./entities.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [EntitiesController],
  providers: [EntitiesService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
