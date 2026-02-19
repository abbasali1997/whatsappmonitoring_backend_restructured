import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Entity, EntitySchema } from "../schemas/entity.schema";
import { User, UserSchema } from "../schemas/user.schema";
import {
  WhatsAppSession,
  WhatsAppSessionSchema,
} from "../schemas/whatsapp-session.schema";
import { EntityType, EntityTypeSchema } from "../schemas/entity-type.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Entity.name, schema: EntitySchema },
      { name: User.name, schema: UserSchema },
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
      { name: EntityType.name, schema: EntityTypeSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
