import { Controller, Post, Get, Body, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from "@nestjs/swagger";
import { EmailService } from "./email.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/decorators";
import { UserRole } from "../../common/schemas/user.schema";

class SendTestEmailDto {
  toEmail: string;
  subject?: string;
}

@ApiTags("Email")
@Controller("email")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Get("verify")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Verify email service connection" })
  @ApiResponse({ status: 200, description: "Connection status" })
  async verifyConnection() {
    const isConnected = await this.emailService.verifyConnection();
    return {
      status: isConnected ? "connected" : "disconnected",
      message: isConnected
        ? "Email service is working correctly"
        : "Email service connection failed",
      timestamp: new Date().toISOString(),
    };
  }

  @Post("test")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Send test email" })
  @ApiBody({ type: SendTestEmailDto })
  @ApiResponse({ status: 200, description: "Test email sent successfully" })
  @ApiResponse({ status: 400, description: "Failed to send test email" })
  async sendTestEmail(@Body() body: SendTestEmailDto) {
    try {
      await this.emailService.sendTestEmail(
        body.toEmail || "powerstar04123@gmail.com",
        body.subject || "2N5 - Test Email",
      );
      return {
        success: true,
        message: `Test email sent successfully to ${body.toEmail}`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to send test email: ${error.message}`,
        error: error.stack,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
