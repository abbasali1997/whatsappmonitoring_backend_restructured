import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DatabaseModule } from "../../common/database/database.module";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { WhatsAppModule } from "../whatsapp/whatsapp.module";
import { MessagingModule } from "../../common/messaging/messaging.module";
import { Message, MessageSchema } from "../../common/schemas/message.schema";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { BulkUploadGateway } from "./bulk-upload.gateway";

@Module({
  imports: [
    DatabaseModule,
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
    AuthModule,
    EmailModule,
    MessagingModule,
    forwardRef(() => WhatsAppModule),
  ],
  controllers: [UsersController],
  providers: [UsersService, BulkUploadGateway],
  exports: [UsersService],
})
export class UsersModule {}
