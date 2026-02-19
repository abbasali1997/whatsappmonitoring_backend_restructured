import { IsString, IsNotEmpty, IsOptional } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateEntityTypeDto {
  @ApiProperty({ example: "Team" })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: "#3B82F6" })
  @IsString()
  @IsNotEmpty()
  color: string;
}

export class UpdateEntityTypeDto {
  @ApiProperty({ example: "Team", required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ example: "#3B82F6", required: false })
  @IsOptional()
  @IsString()
  color?: string;
}
