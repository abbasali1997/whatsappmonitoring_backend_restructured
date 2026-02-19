import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppController } from "./whatsapp.controller";
import { PublicWhatsAppController } from "./public-whatsapp.controller";
import { WhatsAppQueueService } from "./whatsapp-queue.service";
import { WhatsAppQueueProcessor } from "./whatsapp-queue.processor";
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
import { WhatsAppHealthService } from "./whatsapp-health.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
      { name: Message.name, schema: MessageSchema },
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => UsersModule),
    forwardRef(() => EntitiesModule),
    StorageModule,
    EmailModule,
  ],
  controllers: [WhatsAppController, PublicWhatsAppController],
  providers: [
    WhatsAppService,
    WhatsAppQueueService,
    WhatsAppQueueProcessor,
    QrGateway,
    WhatsAppHealthService,
  ],
  exports: [WhatsAppService, WhatsAppQueueService, WhatsAppHealthService],
})
export class WhatsAppModule {}
