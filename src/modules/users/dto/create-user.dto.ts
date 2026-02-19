import {
  IsString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsMongoId,
  MinLength,
  IsArray,
  ValidateNested,
  IsBoolean,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";

export enum UserRole {
  SYSTEM_ADMIN = "SystemAdmin",
  TENANT_ADMIN = "TenantAdmin",
  USER = "User",
}

export enum RegistrationStatus {
  PENDING = "pending",
  INVITED = "invited",
  REGISTERED = "registered",
  CANCELLED = "cancelled",
}

export class CreateUserDto {
  @ApiProperty({ example: "+1234567890", required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "John" })
  @IsString()
  firstName: string;

  @ApiProperty({ example: "Doe" })
  @IsString()
  lastName: string;

  @ApiProperty({ example: "password123" })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: "507f1f77bcf86cd799439011" })
  @IsMongoId()
  entityId: string;

  @ApiProperty({ example: "tenant-123" })
  @IsString()
  tenantId: string;

  @ApiProperty({ enum: UserRole, example: UserRole.USER, required: false })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

export class UpdateUserDto {
  @ApiProperty({ example: "+1234567890", required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ example: "user@example.com", required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: "John", required: false })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiProperty({ example: "Doe", required: false })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiProperty({ example: "password123", required: false })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @ApiProperty({ example: "507f1f77bcf86cd799439011", required: false })
  @IsOptional()
  @IsMongoId()
  entityId?: string;

  @ApiProperty({ enum: UserRole, example: UserRole.USER, required: false })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiProperty({ example: "pt", required: false })
  @IsOptional()
  @IsString()
  language?: string;
}

export class InviteUserDto {
  @ApiProperty({ example: "+1234567890", required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "John" })
  @IsString()
  firstName: string;

  @ApiProperty({ example: "Doe" })
  @IsString()
  lastName: string;

  @ApiProperty({ example: "507f1f77bcf86cd799439011" })
  @IsMongoId()
  entityId: string;

  @ApiProperty({ example: "tenant-123", required: false })
  @IsString()
  tenantId: string;

  @ApiProperty({ enum: UserRole, example: UserRole.USER, required: false })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiProperty({ example: "pt", required: false })
  @IsOptional()
  @IsString()
  language?: string;
}

export class BulkInviteUserDto {
  @ApiProperty({ type: [InviteUserDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InviteUserDto)
  users: Omit<InviteUserDto, "tenantId">[];

  @ApiProperty({ example: "tenant-123" })
  @IsString()
  tenantId: string;
}

export class UpdateRegistrationStatusDto {
  @ApiProperty({
    enum: RegistrationStatus,
    example: RegistrationStatus.REGISTERED,
  })
  @IsEnum(RegistrationStatus)
  status: RegistrationStatus;
}

export class BulkUploadUserDto {
  @ApiProperty({ example: "+1234567890" })
  @IsString()
  phoneNumber: string;

  @ApiProperty({ example: "user@example.com", required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: "John" })
  @IsString()
  firstName: string;

  @ApiProperty({ example: "Doe" })
  @IsString()
  lastName: string;

  @ApiProperty({
    example: ["Entity 1", "Entity 2", "Company 1", "Department"],
    description:
      "Array of entity names representing the path from root to target entity",
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  entityPathNames: string[];
}

export class BulkUploadUsersDto {
  @ApiProperty({ type: [BulkUploadUserDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUploadUserDto)
  users: BulkUploadUserDto[];

  @ApiProperty({ example: "tenant-123" })
  @IsString()
  tenantId: string;
}

export class BulkUploadManagerDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "John" })
  @IsString()
  firstName: string;

  @ApiProperty({ example: "Doe" })
  @IsString()
  lastName: string;

  @ApiProperty({
    example: ["2N5 Global", "Executive Office"],
    description:
      "Array of entity names representing the path from root to target entity",
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  entityPathNames: string[];
}

export class BulkUploadManagersDto {
  @ApiProperty({ type: [BulkUploadManagerDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUploadManagerDto)
  managers: BulkUploadManagerDto[];

  @ApiProperty({ example: "tenant-123" })
  @IsString()
  tenantId: string;
}

export class CreateSystemAdminDto {
  @ApiProperty({ example: "system.admin@2n5global.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "System" })
  @IsString()
  firstName: string;

  @ApiProperty({ example: "Administrator" })
  @IsString()
  lastName: string;

  @ApiProperty({
    example: "TempPassword#2024",
    required: false,
    description: "Leave empty to auto-generate a secure temporary password",
  })
  @IsOptional()
  @IsString()
  @MinLength(12)
  temporaryPassword?: string;
}

export class UpdateSystemAdminPasswordDto {
  @ApiProperty({ example: "NewSecurePassword#2024" })
  @IsString()
  @MinLength(12)
  newPassword: string;

  @ApiProperty({
    required: false,
    default: true,
    description:
      "Force the admin to change this password on next login (recommended when rotating another admin password)",
  })
  @IsOptional()
  @IsBoolean()
  requirePasswordChange?: boolean;
}
