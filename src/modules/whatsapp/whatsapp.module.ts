import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppController } from "./whatsapp.controller";
import { PublicWhatsAppController } from "./public-whatsapp.controller";
import {
  WhatsAppSession,
  WhatsAppSessionSchema,
} from "../../common/schemas/whatsapp-session.schema";
import { Message, MessageSchema } from "../../common/schemas/message.schema";
import { User, UserSchema } from "../../common/schemas/user.schema";
import { UsersModule } from "../users/users.module";
import { EntitiesModule } from "../entities/entities.module";
import { StorageModule } from "../storage/storage.module";
import { EmailModule } from "../email/email.module";
import { QrGateway } from "./qr.gateway";
import { WhatsAppQueueModule } from "@/modules/whatsapp-queue/whatsapp-queue.module";
import { WhatsAppHealthModule } from "@/modules/whatsapp-health/whatsapp-health.module";
import { HttpModule } from "@nestjs/axios";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
      { name: Message.name, schema: MessageSchema },
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => UsersModule),
    forwardRef(() => EntitiesModule),
    forwardRef(() => WhatsAppQueueModule),
    forwardRef(() => WhatsAppHealthModule),
    StorageModule,
    EmailModule,
    HttpModule,
  ],
  controllers: [WhatsAppController, PublicWhatsAppController],
  providers: [WhatsAppService, QrGateway],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
