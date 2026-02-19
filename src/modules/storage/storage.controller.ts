import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Res,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { StorageService, StorageUploadResult } from "./storage.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/decorators";
import { UserRole } from "../../common/schemas/user.schema";

export class UploadFileDto {
  folder?: string;
}

export class SignedUrlDto {
  key: string;
  expiresIn?: number;
}

@ApiTags("Storage")
@Controller("storage")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post("upload")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN, UserRole.USER)
  @UseInterceptors(FileInterceptor("file"))
  @ApiOperation({ summary: "Upload a file to cloud storage" })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({ status: 201, description: "File uploaded successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async uploadFile(
    @UploadedFile() file: any,
    @Body() uploadDto: UploadFileDto,
  ): Promise<StorageUploadResult> {
    if (!file) {
      throw new BadRequestException("No file provided");
    }

    const fileName = `${Date.now()}-${file.originalname}`;
    const folder = uploadDto.folder || "uploads";

    return this.storageService.uploadFile(
      file.buffer,
      fileName,
      file.mimetype,
      folder,
    );
  }

  @Get("download/:key(*)")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN, UserRole.USER)
  @ApiOperation({ summary: "Download a file from cloud storage" })
  @ApiResponse({ status: 200, description: "File downloaded successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "File not found" })
  async downloadFile(@Param("key") key: string) {
    const result = await this.storageService.downloadFile(key);

    return {
      buffer: result.buffer,
      contentType: result.contentType,
      size: result.size,
    };
  }

  @Delete(":key(*)")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Delete a file from cloud storage" })
  @ApiResponse({ status: 200, description: "File deleted successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "File not found" })
  async deleteFile(@Param("key") key: string) {
    await this.storageService.deleteFile(key);
    return { message: "File deleted successfully" };
  }

  @Post("signed-url")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN, UserRole.USER)
  @ApiOperation({ summary: "Generate a signed URL for file access" })
  @ApiResponse({
    status: 200,
    description: "Signed URL generated successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async getSignedUrl(@Body() signedUrlDto: SignedUrlDto) {
    const url = await this.storageService.getSignedUrl(
      signedUrlDto.key,
      signedUrlDto.expiresIn || 3600,
    );

    return { url };
  }

  @Get("provider")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Get current storage provider" })
  @ApiResponse({
    status: 200,
    description: "Storage provider retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  async getProvider() {
    return { provider: this.storageService.getProvider() };
  }
}

@ApiTags("Media")
@Controller("media")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class MediaController {
  constructor(private readonly storageService: StorageService) {}

  @Get("proxy/:key(*)")
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.TENANT_ADMIN, UserRole.USER)
  @ApiOperation({ summary: "Proxy media file from cloud storage" })
  @ApiQuery({
    name: "filename",
    required: false,
    description: "Original filename for Content-Disposition header",
  })
  @ApiResponse({ status: 200, description: "Media file served successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "File not found" })
  async proxyMedia(
    @Param("key") key: string,
    @Query("filename") filename: string | undefined,
    @Res() res: any,
  ) {
    try {
      const result = await this.storageService.downloadFile(key);

      const headers: Record<string, string> = {
        "Content-Type": result.contentType,
        "Content-Length": result.size.toString(),
        "Cache-Control": "public, max-age=31536000", // Cache for 1 year
      };

      // If filename is provided, set Content-Disposition header for download with original name
      if (filename) {
        // Encode filename for Content-Disposition (RFC 2231 format for UTF-8 support)
        const encodedFilename = encodeURIComponent(filename);
        headers["Content-Disposition"] =
          `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;
      }

      res.set(headers);
      return res.send(result.buffer);
    } catch (error) {
      throw new BadRequestException("Failed to retrieve media file");
    }
  }
}
