import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { EntityTypesService } from "./entity-types.service";
import { CreateEntityTypeDto } from "./dto/create-entity-type.dto";
import { UpdateEntityTypeDto } from "./dto/create-entity-type.dto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles, RequireTenant } from "../auth/decorators";
import { UserRole } from "../../common/schemas/user.schema";

@ApiTags("Entity Types")
@Controller("entity-types")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class EntityTypesController {
  constructor(private readonly entityTypesService: EntityTypesService) {}

  @Post()
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Create a new custom entity type" })
  @ApiResponse({ status: 201, description: "Entity type created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  async create(
    @Body() createEntityTypeDto: CreateEntityTypeDto,
    @Request() req,
  ) {
    return this.entityTypesService.create(createEntityTypeDto, req.user.sub);
  }

  @Get()
  @RequireTenant()
  @ApiOperation({ summary: "Get all custom entity types for the current user" })
  @ApiResponse({
    status: 200,
    description: "Entity types retrieved successfully",
  })
  async findAll(@Request() req) {
    return this.entityTypesService.findAll(req.user.sub);
  }

  @Get(":id")
  @RequireTenant()
  @ApiOperation({ summary: "Get entity type by ID" })
  @ApiResponse({
    status: 200,
    description: "Entity type retrieved successfully",
  })
  @ApiResponse({ status: 404, description: "Entity type not found" })
  async findOne(@Param("id") id: string, @Request() req) {
    return this.entityTypesService.findOne(id, req.user.sub);
  }

  @Patch(":id")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Update entity type" })
  @ApiResponse({ status: 200, description: "Entity type updated successfully" })
  @ApiResponse({ status: 404, description: "Entity type not found" })
  async update(
    @Param("id") id: string,
    @Body() updateEntityTypeDto: UpdateEntityTypeDto,
    @Request() req,
  ) {
    return this.entityTypesService.update(
      id,
      updateEntityTypeDto,
      req.user.sub,
    );
  }

  @Delete(":id")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @RequireTenant()
  @ApiOperation({ summary: "Delete entity type" })
  @ApiResponse({ status: 200, description: "Entity type deleted successfully" })
  @ApiResponse({ status: 404, description: "Entity type not found" })
  async remove(@Param("id") id: string, @Request() req) {
    await this.entityTypesService.remove(id, req.user.sub);
    return { message: "Entity type deleted successfully" };
  }
}
