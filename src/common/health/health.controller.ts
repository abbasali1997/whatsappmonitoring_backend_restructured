import { Controller, Get, UseGuards, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { CacheService, CacheStatsResponse } from "../cache/cache.service";
import { JwtAuthGuard } from "../../modules/auth/jwt-auth.guard";
import { RolesGuard } from "../../modules/auth/roles.guard";
import { Roles } from "../../modules/auth/decorators";
import { UserRole } from "../schemas/user.schema";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly cacheService: CacheService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Health check endpoint" })
  @ApiResponse({
    status: 200,
    description: "Health status retrieved successfully",
  })
  @ApiResponse({ status: 503, description: "Service unhealthy" })
  async checkHealth() {
    return this.healthService.checkHealth();
  }

  @Get("live")
  @ApiOperation({
    summary: "Liveness probe endpoint (always 200 if process is running)",
  })
  @ApiResponse({ status: 200, description: "Service process is alive" })
  live() {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("metrics")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: "Get system metrics" })
  @ApiResponse({ status: 200, description: "Metrics retrieved successfully" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async getMetrics() {
    return this.healthService.getMetrics();
  }

  @Get("cache")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: "Get cache statistics" })
  @ApiResponse({
    status: 200,
    description: "Cache stats retrieved successfully",
  })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async getCacheStats(): Promise<{
    timestamp: string;
    stats: CacheStatsResponse;
  }> {
    return {
      timestamp: new Date().toISOString(),
      stats: this.cacheService.getStats(),
    };
  }

  @Get("keys")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM_ADMIN)
  @ApiOperation({ summary: "List cache keys by pattern (Redis only)" })
  @ApiResponse({ status: 200, description: "Cache keys retrieved" })
  async listCacheKeys(@Query("pattern") pattern = "refresh:token:*") {
    const keys = await this.cacheService.listKeys(pattern);
    return { pattern, keys };
  }
}
