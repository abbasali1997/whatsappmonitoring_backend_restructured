import {
  IsEmail,
  IsString,
  MinLength,
  IsOptional,
  IsMongoId,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RegisterDto {
  @ApiProperty({ example: "+1234567890" })
  @IsString()
  phoneNumber: string;

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

  @ApiProperty({ example: "507f1f77bcf86cd799439011", required: false })
  @IsOptional()
  @IsMongoId()
  entityId?: string;

  @ApiProperty({ example: "tenant-123", required: false })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
