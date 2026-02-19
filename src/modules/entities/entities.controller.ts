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
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { EntitiesService } from "./entities.service";
import { CreateEntityDto } from "./dto/create-entity.dto";
import { UpdateEntityDto } from "./dto/update-entity.dto";
import { MoveEntityDto } from "./dto/move-entity.dto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles, RequireTenant } from "../auth/decorators";
import { UserRole } from "../../common/schemas/user.schema";

@ApiTags("Entities")
@Controller("entities")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class EntitiesController {
  constructor(private readonly entitiesService: EntitiesService) {}

  @Post()
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Create a new entity" })
  @ApiResponse({ status: 201, description: "Entity created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async create(@Body() createEntityDto: CreateEntityDto, @Request() req) {
    return this.entitiesService.create(
      createEntityDto,
      req.user.sub,
      req.user.role,
      req.user.entityId,
    );
  }

  @Get()
  @RequireTenant()
  @ApiOperation({ summary: "Get all entities" })
  @ApiQuery({
    name: "type",
    required: false,
    enum: ["entity", "company", "department"],
  })
  @ApiQuery({ name: "parentId", required: false })
  @ApiQuery({ name: "level", required: false })
  @ApiQuery({ name: "search", required: false })
  @ApiResponse({ status: 200, description: "Entities retrieved successfully" })
  async findAll(@Query() query: any, @Request() req) {
    return this.entitiesService.findAll(req.user.tenantId, query);
  }

  @Get("export")
  @RequireTenant()
  @ApiOperation({ summary: "Export entities as CSV-ready dataset" })
  @ApiQuery({ name: "type", required: false })
  @ApiQuery({ name: "parentId", required: false })
  @ApiQuery({
    name: "level",
    required: false,
    description: "Max level depth to include",
  })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "ancestorId", required: false })
  @ApiResponse({
    status: 200,
    description: "Export dataset generated successfully",
  })
  async exportEntities(
    @Request() req,
    @Query("type") type?: string,
    @Query("parentId") parentId?: string,
    @Query("level") level?: string,
    @Query("search") search?: string,
    @Query("ancestorId") ancestorId?: string,
  ) {
    const rows = await this.entitiesService.exportEntities(req.user.tenantId, {
      type,
      parentId,
      level: level !== undefined ? Number(level) : undefined,
      search,
      ancestorId,
    });

    return {
      generatedAt: new Date().toISOString(),
      total: rows.length,
      rows,
    };
  }

  @Get("hierarchy")
  @RequireTenant()
  @ApiOperation({ summary: "Get entity hierarchy" })
  @ApiQuery({ name: "maxDepth", required: false })
  @ApiResponse({
    status: 200,
    description: "Entity hierarchy retrieved successfully",
  })
  async findHierarchy(@Query("maxDepth") maxDepth: number, @Request() req) {
    return this.entitiesService.findHierarchy(req.user.tenantId, maxDepth);
  }

  @Get("stats")
  @RequireTenant()
  @ApiOperation({ summary: "Get entity statistics" })
  @ApiResponse({
    status: 200,
    description: "Entity statistics retrieved successfully",
  })
  async getStats(@Request() req) {
    return this.entitiesService.getEntityStats(req.user.tenantId);
  }

  @Get(":id")
  @RequireTenant()
  @ApiOperation({ summary: "Get entity by ID" })
  @ApiResponse({ status: 200, description: "Entity retrieved successfully" })
  @ApiResponse({ status: 404, description: "Entity not found" })
  async findOne(@Param("id") id: string, @Request() req) {
    return this.entitiesService.findOne(id, req.user.tenantId);
  }

  @Patch(":id")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Update entity (name, type, and metadata)" })
  @ApiResponse({ status: 200, description: "Entity updated successfully" })
  @ApiResponse({ status: 404, description: "Entity not found" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - cannot manage this entity",
  })
  async update(
    @Param("id") id: string,
    @Body() updateEntityDto: UpdateEntityDto,
    @Request() req,
  ) {
    return this.entitiesService.update(
      id,
      updateEntityDto,
      req.user.sub,
      req.user.tenantId,
      req.user.role,
      req.user.entityId,
    );
  }

  @Patch(":id/move")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Move entity to different parent" })
  @ApiResponse({ status: 200, description: "Entity moved successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 404, description: "Entity not found" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - cannot manage this entity",
  })
  async move(
    @Param("id") id: string,
    @Body() moveEntityDto: MoveEntityDto,
    @Request() req,
  ) {
    return this.entitiesService.move(
      id,
      moveEntityDto,
      req.user.sub,
      req.user.tenantId,
      req.user.role,
      req.user.entityId,
    );
  }

  @Delete(":id")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Delete entity" })
  @ApiResponse({ status: 200, description: "Entity deleted successfully" })
  @ApiResponse({
    status: 400,
    description: "Bad request - entity has children or users",
  })
  @ApiResponse({ status: 404, description: "Entity not found" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - cannot manage this entity",
  })
  async remove(@Param("id") id: string, @Request() req) {
    await this.entitiesService.remove(
      id,
      req.user.sub,
      req.user.tenantId,
      req.user.role,
      req.user.entityId,
    );
    return { message: "Entity deleted successfully" };
  }
}
