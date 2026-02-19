import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RetentionCleanupService } from "./retention-cleanup.service";
import {
  WhatsAppSession,
  WhatsAppSessionSchema,
} from "../schemas/whatsapp-session.schema";
import { User, UserSchema } from "../schemas/user.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [RetentionCleanupService],
})
export class RetentionCleanupModule {}
