import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DashboardService } from "./dashboard.service";
import { DashboardController } from "./dashboard.controller";
import { UsersModule } from "../users/users.module";
import { EntitiesModule } from "../entities/entities.module";
import { WhatsAppModule } from "../whatsapp/whatsapp.module";
import { User, UserSchema } from "../../common/schemas/user.schema";
import { Entity, EntitySchema } from "../../common/schemas/entity.schema";
import { Message, MessageSchema } from "../../common/schemas/message.schema";
import {
  WhatsAppSession,
  WhatsAppSessionSchema,
} from "../../common/schemas/whatsapp-session.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Entity.name, schema: EntitySchema },
      { name: Message.name, schema: MessageSchema },
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
    ]),
    UsersModule,
    EntitiesModule,
    WhatsAppModule,
  ],
  providers: [DashboardService],
  controllers: [DashboardController],
  exports: [DashboardService],
})
export class DashboardModule {}
