import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsMongoId,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export enum EntityType {
  ENTITY = "entity",
  COMPANY = "company",
  DEPARTMENT = "department",
  CUSTOM = "custom",
}

export class CreateEntityDto {
  @ApiProperty({ example: "Sales Department" })
  @IsString()
  name: string;

  @ApiProperty({ enum: EntityType, example: EntityType.DEPARTMENT })
  @IsEnum(EntityType)
  type: EntityType;

  @ApiProperty({ example: "507f1f77bcf86cd799439011", required: false })
  @IsOptional()
  @IsMongoId()
  customEntityTypeId?: string;

  @ApiProperty({ example: "507f1f77bcf86cd799439011", required: false })
  @IsOptional()
  @IsMongoId()
  parentId?: string;

  @ApiProperty({
    example: { description: "Sales team entity" },
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateEntityDto {
  @ApiProperty({ example: "Updated Sales Department", required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    enum: EntityType,
    example: EntityType.DEPARTMENT,
    required: false,
  })
  @IsOptional()
  @IsEnum(EntityType)
  type?: EntityType;

  @ApiProperty({ example: "507f1f77bcf86cd799439011", required: false })
  @IsOptional()
  @IsMongoId()
  customEntityTypeId?: string;

  @ApiProperty({
    example: { description: "Updated description" },
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  isExpanded?: boolean;
}

export class MoveEntityDto {
  @ApiProperty({ example: "507f1f77bcf86cd799439012", required: false })
  @IsOptional()
  @IsMongoId()
  newParentId?: string;
}
