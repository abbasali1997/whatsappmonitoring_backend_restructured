import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { UsersService } from "../users/users.service";

@Controller("public/whatsapp")
export class PublicWhatsAppController {
  constructor(
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
  ) {}

  @Get("qr/:phone")
  async getQrPayload(@Param("phone") phone: string) {
    const normalized = (phone || "").trim();
    if (!normalized) {
      throw new BadRequestException("Phone number is required");
    }

    const digits = normalized.replace(/[^0-9]/g, "");
    if (!digits) {
      throw new BadRequestException("Phone number must include digits");
    }

    const e164Phone = digits.startsWith("+") ? digits : `+${digits}`;
    const qrData = await this.usersService.generateQrForPhoneNumber(e164Phone);

    return {
      success: true,
      phone: e164Phone,
      sessionId: qrData.sessionId,
      qrCode: qrData.qrCode,
      expiresAt: qrData.expiresAt ?? null,
      status: qrData.status || "pending",
    };
  }
}
