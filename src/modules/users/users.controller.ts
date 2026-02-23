import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Request,
  BadRequestException,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import {
  InviteUserDto,
  BulkInviteUserDto,
  BulkUploadUsersDto,
  BulkUploadManagersDto,
  UpdateRegistrationStatusDto,
  CreateSystemAdminDto,
  UpdateSystemAdminPasswordDto,
} from "./dto/create-user.dto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles, RequireTenant } from "../auth/decorators";
import {
  UserRole,
  RegistrationStatus,
  WhatsAppConnectionStatus,
} from "../../common/schemas/user.schema";
import { SessionStatus } from "../../common/schemas/whatsapp-session.schema";

@ApiTags("Users")
@Controller("users")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post("invite")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({
    summary: "Invite a new user (with phone number - includes QR code)",
  })
  @ApiResponse({ status: 201, description: "User invited successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async invite(@Body() inviteUserDto: InviteUserDto, @Request() req) {
    return this.usersService.inviteUser(inviteUserDto, req.user.sub);
  }

  @Post("invite-manager")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Invite a new manager (without phone number)" })
  @ApiResponse({ status: 201, description: "Manager invited successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async inviteManager(@Body() inviteUserDto: InviteUserDto, @Request() req) {
    return this.usersService.inviteManager(inviteUserDto, req.user.sub);
  }

  @Post("bulk-invite")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Bulk invite users" })
  @ApiResponse({ status: 201, description: "Users invited successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async bulkInvite(@Body() bulkInviteDto: BulkInviteUserDto, @Request() req) {
    return this.usersService.bulkInviteUsers(bulkInviteDto, req.user.sub);
  }

  @Post("bulk-upload")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Bulk upload users with entity path resolution" })
  @ApiResponse({ status: 201, description: "Users uploaded successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async bulkUpload(@Body() bulkUploadDto: BulkUploadUsersDto, @Request() req) {
    return this.usersService.bulkUploadUsers(bulkUploadDto, req.user.sub);
  }

  @Post("bulk-upload/async")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Start async bulk upload users job" })
  @ApiResponse({ status: 201, description: "Bulk upload job started" })
  async startBulkUpload(
    @Body() bulkUploadDto: BulkUploadUsersDto,
    @Request() req,
  ) {
    return this.usersService.startBulkUploadUsersJob(
      bulkUploadDto,
      req.user.sub,
    );
  }

  @Get("bulk-upload/status/:jobId")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Get bulk upload job status" })
  @ApiResponse({ status: 200, description: "Bulk upload job status" })
  async getBulkUploadStatus(@Param("jobId") jobId: string) {
    return this.usersService.getBulkUploadJob(jobId);
  }

  @Post("bulk-upload-managers")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Bulk upload managers with entity path resolution" })
  @ApiResponse({ status: 201, description: "Managers uploaded successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async bulkUploadManagers(
    @Body() bulkUploadDto: BulkUploadManagersDto,
    @Request() req,
  ) {
    return this.usersService.bulkUploadManagers(bulkUploadDto, req.user.sub);
  }

  @Post("bulk-upload-managers/async")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Start async bulk upload managers job" })
  @ApiResponse({ status: 201, description: "Bulk upload managers job started" })
  async startBulkUploadManagers(
    @Body() bulkUploadDto: BulkUploadManagersDto,
    @Request() req,
  ) {
    return this.usersService.startBulkUploadManagersJob(
      bulkUploadDto,
      req.user.sub,
    );
  }

  @Get("bulk-upload-managers/status/:jobId")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Get bulk upload managers job status" })
  @ApiResponse({ status: 200, description: "Bulk upload managers job status" })
  async getBulkUploadManagersStatus(@Param("jobId") jobId: string) {
    return this.usersService.getBulkUploadJob(jobId);
  }

  @Get("system-admins")
  @Roles(UserRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: "List all system administrators" })
  @ApiResponse({ status: 200, description: "System admins retrieved" })
  async listSystemAdmins() {
    return this.usersService.listSystemAdmins();
  }

  @Post("system-admins")
  @Roles(UserRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: "Create a new system administrator" })
  @ApiResponse({ status: 201, description: "System admin created" })
  async createSystemAdmin(
    @Body() createSystemAdminDto: CreateSystemAdminDto,
    @Request() req,
  ) {
    return this.usersService.createSystemAdmin(
      createSystemAdminDto,
      req.user.sub,
    );
  }

  @Patch("system-admins/:id/password")
  @Roles(UserRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: "Reset a system admin password" })
  @ApiResponse({ status: 200, description: "Password updated successfully" })
  async resetSystemAdminPassword(
    @Param("id") id: string,
    @Body() updateDto: UpdateSystemAdminPasswordDto,
    @Request() req,
  ) {
    return this.usersService.updateSystemAdminPassword(
      id,
      updateDto,
      req.user.sub,
    );
  }

  @Get()
  @RequireTenant()
  @ApiOperation({ summary: "Get all users with pagination" })
  @ApiQuery({
    name: "registrationStatus",
    required: false,
    enum: RegistrationStatus,
  })
  @ApiQuery({ name: "role", required: false, enum: UserRole })
  @ApiQuery({ name: "entityId", required: false })
  @ApiQuery({
    name: "whatsappConnectionStatus",
    required: false,
    enum: WhatsAppConnectionStatus,
  })
  @ApiQuery({
    name: "whatsappStatus",
    required: false,
    enum: ["new", "requested", "connected", "disconnected"],
    description:
      "Lifecycle status per client definition: new/requested/connected/disconnected",
  })
  @ApiQuery({
    name: "whatsappSessionStatus",
    required: false,
    enum: SessionStatus,
    description: 'Filter by WhatsApp session status (e.g. "qr_required")',
  })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({
    name: "page",
    required: false,
    description: "Page number (default: 1)",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Items per page (default: 10)",
  })
  @ApiResponse({
    status: 200,
    description: "Users retrieved successfully with pagination",
  })
  async findAll(@Query() query: any, @Request() req) {
    return this.usersService.findAll(req.user.tenantId, query);
  }

  @Get("export")
  @RequireTenant()
  @ApiOperation({ summary: "Export users as CSV-ready dataset" })
  @ApiQuery({ name: "entityId", required: false })
  @ApiQuery({
    name: "registrationStatus",
    required: false,
    enum: RegistrationStatus,
  })
  @ApiQuery({ name: "role", required: false, enum: UserRole })
  @ApiResponse({
    status: 200,
    description: "Export dataset generated successfully",
  })
  async exportUsers(
    @Request() req,
    @Query("entityId") entityId?: string,
    @Query("registrationStatus") registrationStatus?: RegistrationStatus,
    @Query("role") role?: UserRole,
  ) {
    const rows = await this.usersService.exportUsers(req.user.tenantId, {
      entityId,
      registrationStatus,
      role,
    });

    return {
      generatedAt: new Date().toISOString(),
      total: rows.length,
      rows,
    };
  }

  @Get("search")
  @RequireTenant()
  @ApiOperation({ summary: "Search users" })
  @ApiQuery({ name: "q", required: true })
  @ApiResponse({ status: 200, description: "Users found successfully" })
  async search(@Query("q") query: string, @Request() req) {
    return this.usersService.searchUsers(query, req.user.tenantId);
  }

  @Get("me")
  @ApiOperation({ summary: "Get current user profile" })
  @ApiResponse({
    status: 200,
    description: "User profile retrieved successfully",
  })
  @ApiResponse({ status: 404, description: "User not found" })
  async getProfile(@Request() req) {
    if (!req.user || !req.user.sub) {
      throw new BadRequestException("User ID not found in token");
    }

    // Ensure we have a valid user ID
    const userId = String(req.user.sub).trim();
    const tenantId = req.user.tenantId ? String(req.user.tenantId).trim() : "";

    return this.usersService.findOne(userId, tenantId);
  }

  @Get(":id/data-export")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({
    summary:
      "Export a user's personal data and message history (LGPD/GDPR portability)",
  })
  @ApiQuery({
    name: "includeMessages",
    required: false,
    description: "true/false",
  })
  @ApiQuery({
    name: "format",
    required: false,
    description: 'Export format: "json" (default) or "csv"',
  })
  @ApiQuery({
    name: "messageLimit",
    required: false,
    description: "Max number of messages to include (default 20000, max 50000)",
  })
  @ApiResponse({
    status: 200,
    description: "User export generated successfully",
  })
  async exportUserData(
    @Param("id") id: string,
    @Request() req,
    @Query("includeMessages") includeMessages?: string,
    @Query("format") format?: string,
    @Query("messageLimit") messageLimit?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const include =
      includeMessages === undefined
        ? true
        : String(includeMessages).toLowerCase() !== "false";
    const limitNum = messageLimit ? Number(messageLimit) : undefined;

    const payload = await this.usersService.exportUserData({
      userId: id,
      tenantId: req.user.tenantId,
      requestedBy: req.user.sub,
      includeMessages: include,
      messageLimit: Number.isFinite(limitNum as any)
        ? (limitNum as number)
        : undefined,
    });

    const filenameSafeId = String(id || "user").replace(/[^a-zA-Z0-9_-]/g, "");

    const fmt = String(format || "json").toLowerCase();
    if (fmt === "csv") {
      const user = payload.user || {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];

      // Flatten into one CSV: user fields repeated per message row (works well in Excel).
      const headers = [
        "userId",
        "userFirstName",
        "userLastName",
        "userEmail",
        "userPhoneNumber",
        "userRole",
        "userRegistrationStatus",
        "userTenantId",
        "userEntityId",
        "userEntityPath",
        "generatedAt",
        "messageId",
        "whatsappMessageId",
        "direction",
        "type",
        "status",
        "sentAt",
        "deliveredAt",
        "readAt",
        "from",
        "fromName",
        "fromPhoneNumber",
        "to",
        "toName",
        "toPhoneNumber",
        "isExternalNumber",
        "isGroupMessage",
        "whatsappGroupName",
        "conversationId",
        "content",
        "mediaUrl",
        "caption",
        "fileName",
        "fileSize",
        "failureReason",
      ];

      const escapeCsvValue = (value: any) => {
        if (value === null || value === undefined) return "";
        const str = String(value);
        const escaped = str.replace(/"/g, '""');
        return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
      };

      const userCols = {
        userId: user._id || "",
        userFirstName: user.firstName || "",
        userLastName: user.lastName || "",
        userEmail: user.email || "",
        userPhoneNumber: user.phoneNumber || "",
        userRole: user.role || "",
        userRegistrationStatus: user.registrationStatus || "",
        userTenantId: user.tenantId || "",
        userEntityId: user.entityId || "",
        userEntityPath: user.entityPath || "",
        generatedAt: payload.generatedAt || new Date().toISOString(),
      };

      const rows = (messages.length ? messages : [null]).map((m: any) => {
        const row: Record<string, any> = {
          ...userCols,
          messageId: m?._id || "",
          whatsappMessageId: m?.whatsappMessageId || "",
          direction: m?.direction || "",
          type: m?.type || "",
          status: m?.status || "",
          sentAt: m?.sentAt || "",
          deliveredAt: m?.deliveredAt || "",
          readAt: m?.readAt || "",
          from: m?.from || "",
          fromName: m?.fromName || "",
          fromPhoneNumber: m?.fromPhoneNumber || "",
          to: m?.to || "",
          toName: m?.toName || "",
          toPhoneNumber: m?.toPhoneNumber || "",
          isExternalNumber: m?.isExternalNumber ?? "",
          isGroupMessage: m?.isGroupMessage ?? "",
          whatsappGroupName: m?.whatsappGroupName || "",
          conversationId: m?.conversationId || "",
          content: m?.content || "",
          mediaUrl: m?.mediaUrl || "",
          caption: m?.metadata?.caption || "",
          fileName: m?.metadata?.fileName || "",
          fileSize: m?.metadata?.fileSize ?? "",
          failureReason: m?.failureReason || "",
        };
        return headers.map((h) => escapeCsvValue(row[h])).join(",");
      });

      // Excel on Windows expects BOM for UTF-8 and prefers CRLF.
      const csv = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
      res?.setHeader("Content-Type", "text/csv; charset=utf-8");
      res?.setHeader(
        "Content-Disposition",
        `attachment; filename="user-data-export-${filenameSafeId}.csv"`,
      );
      return csv;
    }

    res?.setHeader("Content-Type", "application/json; charset=utf-8");
    res?.setHeader(
      "Content-Disposition",
      `attachment; filename="user-data-export-${filenameSafeId}.json"`,
    );

    return payload;
  }

  @Get(":id")
  @RequireTenant()
  @ApiOperation({ summary: "Get user by ID" })
  @ApiResponse({ status: 200, description: "User retrieved successfully" })
  @ApiResponse({ status: 404, description: "User not found" })
  async findOne(@Param("id") id: string, @Request() req) {
    return this.usersService.findOne(id, req.user.tenantId);
  }

  @Patch("me")
  @ApiOperation({ summary: "Update current user profile" })
  @ApiResponse({ status: 200, description: "Profile updated successfully" })
  @ApiResponse({ status: 404, description: "User not found" })
  async updateProfile(@Body() updateUserDto: UpdateUserDto, @Request() req) {
    return this.usersService.update(
      req.user.sub,
      updateUserDto,
      req.user.sub,
      req.user.tenantId || "",
    );
  }

  @Post("verify-email")
  @ApiOperation({ summary: "Verify email address with token" })
  @ApiResponse({ status: 200, description: "Email verified successfully" })
  @ApiResponse({ status: 400, description: "Invalid or expired token" })
  async verifyEmail(
    @Body("token") token: string,
    @Body("userId") userId: string,
  ) {
    return this.usersService.verifyEmail(token, userId);
  }

  @Post("resend-email-verification")
  @ApiOperation({ summary: "Resend email verification email" })
  @ApiResponse({
    status: 200,
    description: "Verification email sent successfully",
  })
  @ApiResponse({ status: 400, description: "No pending email verification" })
  async resendEmailVerification(@Request() req) {
    await this.usersService.resendEmailVerification(req.user.sub);
    return { message: "Verification email sent successfully" };
  }

  @Patch(":id")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Update user" })
  @ApiResponse({ status: 200, description: "User updated successfully" })
  @ApiResponse({ status: 404, description: "User not found" })
  async update(
    @Param("id") id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Request() req,
  ) {
    return this.usersService.update(
      id,
      updateUserDto,
      req.user.sub,
      req.user.tenantId,
    );
  }

  @Patch(":id/registration-status")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Update user registration status" })
  @ApiResponse({
    status: 200,
    description: "Registration status updated successfully",
  })
  @ApiResponse({ status: 404, description: "User not found" })
  async updateRegistrationStatus(
    @Param("id") id: string,
    @Body() updateStatusDto: UpdateRegistrationStatusDto,
    @Request() req,
  ) {
    return this.usersService.updateRegistrationStatus(
      id,
      updateStatusDto.status,
      req.user.sub,
      req.user.tenantId,
    );
  }

  @Patch(":id/whatsapp-status")
  @RequireTenant()
  @ApiOperation({ summary: "Update WhatsApp connection status" })
  @ApiResponse({
    status: 200,
    description: "WhatsApp status updated successfully",
  })
  @ApiResponse({ status: 404, description: "User not found" })
  async updateWhatsAppStatus(
    @Param("id") id: string,
    @Body("status") status: WhatsAppConnectionStatus,
    @Request() req,
  ) {
    return this.usersService.updateWhatsAppConnectionStatus(
      id,
      status,
      req.user.tenantId,
    );
  }

  @Delete(":id")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Delete user" })
  @ApiResponse({ status: 200, description: "User deleted successfully" })
  @ApiResponse({ status: 404, description: "User not found" })
  async remove(@Param("id") id: string, @Request() req) {
    await this.usersService.remove(id, req.user.sub, req.user.tenantId);
    return { message: "User deleted successfully" };
  }

  @Post(":id/resend-invite")
  @RequireTenant()
  @ApiOperation({ summary: "Resend user invitation email with QR link" })
  @ApiResponse({
    status: 200,
    description: "Invitation email queued successfully",
  })
  async resendInvitation(@Param("id") id: string, @Request() req) {
    await this.usersService.resendUserInvitation(id, req.user.tenantId);
    return { success: true };
  }

  @Post(":id/regenerate-qr")
  @RequireTenant()
  @ApiOperation({ summary: "Regenerate WhatsApp QR code for user" })
  @ApiResponse({ status: 200, description: "QR code regenerated successfully" })
  @ApiResponse({
    status: 400,
    description:
      "Bad request - User has no phone number or QR generation failed",
  })
  @ApiResponse({ status: 404, description: "User not found" })
  async regenerateQRCode(
    @Param("id") id: string,
    @Request() req,
    @Body("waitForResult") waitForResult?: boolean,
  ) {
    return this.usersService.regenerateQRCode(id, req.user.tenantId, {
      waitForResult,
    });
  }

  @Get(":id/health-status")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Get WhatsApp health status for user" })
  @ApiResponse({ status: 200, description: "Health status retrieved" })
  @ApiResponse({ status: 404, description: "User or session not found" })
  async getHealthStatus(@Param("id") id: string, @Request() req) {
    return this.usersService.getUserHealthStatus(id, req.user.tenantId);
  }

  @Post(":id/trigger-health-check")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Manually trigger WhatsApp health check for user" })
  @ApiResponse({ status: 200, description: "Health check triggered" })
  @ApiResponse({ status: 404, description: "User or session not found" })
  async triggerHealthCheck(@Param("id") id: string, @Request() req) {
    return this.usersService.triggerUserHealthCheck(id, req.user.tenantId);
  }
}
