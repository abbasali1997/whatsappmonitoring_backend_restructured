import { Controller, Get, UseGuards, Logger, Req } from "@nestjs/common";
import { Request } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { DashboardService } from "./dashboard.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { TenantGuard } from "../auth/tenant.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/decorators";
import { UserRole } from "../../common/schemas/user.schema";

@ApiTags("Dashboard")
@Controller("dashboard")
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@ApiBearerAuth()
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(private readonly dashboardService: DashboardService) {}

  @Get("stats")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN, UserRole.USER)
  @ApiOperation({ summary: "Get dashboard statistics" })
  @ApiResponse({
    status: 200,
    description: "Statistics retrieved successfully",
  })
  async getDashboardStats(@Req() req: Request) {
    try {
      const entityId = req.user["entityId"];
      const entityPath = req.user["entityPath"];
      const stats = await this.dashboardService.getDashboardStats(
        entityId,
        entityPath,
      );

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      this.logger.error("Failed to get dashboard stats:", error);
      throw error;
    }
  }

  @Get("system-health")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Get system health information" })
  @ApiResponse({
    status: 200,
    description: "System health retrieved successfully",
  })
  async getSystemHealth(@Req() req: Request) {
    try {
      const entityId = req.user["entityId"];
      const entityPath = req.user["entityPath"];
      const health = await this.dashboardService.getSystemHealth(
        entityId,
        entityPath,
      );

      return {
        success: true,
        data: health,
      };
    } catch (error) {
      this.logger.error("Failed to get system health:", error);
      throw error;
    }
  }
}
