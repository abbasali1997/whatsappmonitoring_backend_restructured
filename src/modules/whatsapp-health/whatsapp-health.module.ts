import { forwardRef, Module } from "@nestjs/common";
import { WhatsAppModule } from "@/modules/whatsapp/whatsapp.module";
import { WhatsAppHealthService } from "@/modules/whatsapp-health/whatsapp-health.service";
import { MongooseModule } from "@nestjs/mongoose";
import {
  WhatsAppSession,
  WhatsAppSessionSchema,
} from "@/common/schemas/whatsapp-session.schema";
import { Message, MessageSchema } from "@/common/schemas/message.schema";
import { User, UserSchema } from "@/common/schemas/user.schema";
import { EmailModule } from "@/modules/email/email.module";
import { UsersModule } from "@/modules/users/users.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
      { name: Message.name, schema: MessageSchema },
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => UsersModule),
    forwardRef(() => WhatsAppModule),
    EmailModule,
  ],
  providers: [WhatsAppHealthService],
  exports: [WhatsAppHealthService],
})
export class WhatsAppHealthModule {}
