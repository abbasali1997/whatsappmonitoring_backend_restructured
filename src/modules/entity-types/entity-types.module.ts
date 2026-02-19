import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../common/database/database.module";
import { EntityTypesService } from "./entity-types.service";
import { EntityTypesController } from "./entity-types.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [EntityTypesController],
  providers: [EntityTypesService],
  exports: [EntityTypesService],
})
export class EntityTypesModule {}
