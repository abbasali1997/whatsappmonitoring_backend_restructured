import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BlobServiceClient,
  ContainerClient,
  BlockBlobClient,
  BlobSASPermissions,
} from "@azure/storage-blob";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageUploadResult {
  url: string;
  proxyUrl: string;
  key: string;
  size: number;
  contentType: string;
}

export interface StorageDownloadResult {
  buffer: Buffer;
  contentType: string;
  size: number;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider: string;
  private readonly baseUrl: string;
  private azureClient?: BlobServiceClient;
  private azureContainer?: ContainerClient;
  private awsClient?: S3Client;
  private awsBucket?: string;

  constructor(private configService: ConfigService) {
    this.provider =
      this.configService.get<string>("storage.provider") || "azure";
    this.baseUrl =
      this.configService.get<string>("app.baseUrl") || "http://localhost:5000";
    if (this.provider === "azure") {
      this.initializeAzure();
    } else if (this.provider === "aws") {
      this.initializeAWS();
    } else {
      throw new BadRequestException(
        `Unsupported storage provider: ${this.provider}`,
      );
    }
  }

  private initializeAzure(): void {
    const connectionString = this.configService.get<string>(
      "storage.azure.connectionString",
    );
    const containerName =
      this.configService.get<string>("storage.azure.container") ||
      "unicx-files";

    if (!connectionString) {
      throw new BadRequestException(
        "Azure storage connection string is required",
      );
    }

    try {
      this.azureClient =
        BlobServiceClient.fromConnectionString(connectionString);
      this.azureContainer = this.azureClient.getContainerClient(containerName);
      this.logger.log(
        `Azure Blob Storage initialized with container: ${containerName}`,
      );
    } catch (error) {
      this.logger.error("Failed to initialize Azure Blob Storage:", error);
      throw new BadRequestException("Failed to initialize Azure Blob Storage");
    }
  }

  private initializeAWS(): void {
    const region =
      this.configService.get<string>("storage.aws.region") || "us-east-1";
    const accessKeyId = this.configService.get<string>(
      "storage.aws.accessKeyId",
    );
    const secretAccessKey = this.configService.get<string>(
      "storage.aws.secretAccessKey",
    );
    this.awsBucket = this.configService.get<string>("storage.aws.bucket");

    if (!accessKeyId || !secretAccessKey || !this.awsBucket) {
      throw new BadRequestException(
        "AWS credentials and bucket name are required",
      );
    }

    try {
      this.awsClient = new S3Client({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.logger.log(
        `AWS S3 initialized with bucket: ${this.awsBucket} in region: ${region}`,
      );
    } catch (error) {
      this.logger.error("Failed to initialize AWS S3:", error);
      throw new BadRequestException("Failed to initialize AWS S3");
    }
  }

  async uploadFile(
    file: Buffer,
    fileName: string,
    contentType: string,
    folder?: string,
  ): Promise<StorageUploadResult> {
    const key = folder ? `${folder}/${fileName}` : fileName;

    if (this.provider === "azure") {
      return this.uploadToAzure(file, key, contentType);
    } else if (this.provider === "aws") {
      return this.uploadToAWS(file, key, contentType);
    }

    throw new BadRequestException(
      `Unsupported storage provider: ${this.provider}`,
    );
  }

  private async uploadToAzure(
    file: Buffer,
    key: string,
    contentType: string,
  ): Promise<StorageUploadResult> {
    if (!this.azureContainer) {
      throw new BadRequestException("Azure container not initialized");
    }

    try {
      const blockBlobClient: BlockBlobClient =
        this.azureContainer.getBlockBlobClient(key);

      await blockBlobClient.upload(file, file.length, {
        blobHTTPHeaders: {
          blobContentType: contentType,
        },
      });

      const url = blockBlobClient.url;
      const proxyUrl = `/api/v1/media/proxy/${encodeURIComponent(key)}`;
      this.logger.log(`File uploaded to Azure: ${url}`);

      return {
        url,
        proxyUrl,
        key,
        size: file.length,
        contentType,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file to Azure: ${error.message}`);
      throw new BadRequestException("Failed to upload file to Azure");
    }
  }

  private async uploadToAWS(
    file: Buffer,
    key: string,
    contentType: string,
  ): Promise<StorageUploadResult> {
    if (!this.awsClient || !this.awsBucket) {
      throw new BadRequestException("AWS S3 client not initialized");
    }

    try {
      const command = new PutObjectCommand({
        Bucket: this.awsBucket,
        Key: key,
        Body: file,
        ContentType: contentType,
      });

      await this.awsClient.send(command);

      const url = `https://${this.awsBucket}.s3.amazonaws.com/${key}`;
      const proxyUrl = `/api/v1/media/proxy/${encodeURIComponent(key)}`;
      this.logger.log(`File uploaded to AWS S3: ${url}`);

      return {
        url,
        proxyUrl,
        key,
        size: file.length,
        contentType,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file to AWS S3: ${error.message}`);
      throw new BadRequestException("Failed to upload file to AWS S3");
    }
  }

  async downloadFile(key: string): Promise<StorageDownloadResult> {
    if (this.provider === "azure") {
      return this.downloadFromAzure(key);
    } else if (this.provider === "aws") {
      return this.downloadFromAWS(key);
    }

    throw new BadRequestException(
      `Unsupported storage provider: ${this.provider}`,
    );
  }

  private async downloadFromAzure(key: string): Promise<StorageDownloadResult> {
    if (!this.azureContainer) {
      throw new BadRequestException("Azure container not initialized");
    }

    try {
      const blockBlobClient = this.azureContainer.getBlockBlobClient(key);
      const downloadResponse = await blockBlobClient.download();

      if (!downloadResponse.readableStreamBody) {
        throw new BadRequestException("File not found");
      }

      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      return {
        buffer,
        contentType: downloadResponse.contentType || "application/octet-stream",
        size: buffer.length,
      };
    } catch (error) {
      this.logger.error(`Failed to download file from Azure: ${error.message}`);
      throw new BadRequestException("Failed to download file from Azure");
    }
  }

  private async downloadFromAWS(key: string): Promise<StorageDownloadResult> {
    if (!this.awsClient || !this.awsBucket) {
      throw new BadRequestException("AWS S3 client not initialized");
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.awsBucket,
        Key: key,
      });

      const response = await this.awsClient.send(command);

      if (!response.Body) {
        throw new BadRequestException("File not found");
      }

      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      return {
        buffer,
        contentType: response.ContentType || "application/octet-stream",
        size: buffer.length,
      };
    } catch (error) {
      this.logger.error(
        `Failed to download file from AWS S3: ${error.message}`,
      );
      throw new BadRequestException("Failed to download file from AWS S3");
    }
  }

  async deleteFile(key: string): Promise<void> {
    if (this.provider === "azure") {
      await this.deleteFromAzure(key);
    } else if (this.provider === "aws") {
      await this.deleteFromAWS(key);
    } else {
      throw new BadRequestException(
        `Unsupported storage provider: ${this.provider}`,
      );
    }
  }

  private async deleteFromAzure(key: string): Promise<void> {
    if (!this.azureContainer) {
      throw new BadRequestException("Azure container not initialized");
    }

    try {
      const blockBlobClient = this.azureContainer.getBlockBlobClient(key);
      await blockBlobClient.delete();
      this.logger.log(`File deleted from Azure: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete file from Azure: ${error.message}`);
      throw new BadRequestException("Failed to delete file from Azure");
    }
  }

  private async deleteFromAWS(key: string): Promise<void> {
    if (!this.awsClient || !this.awsBucket) {
      throw new BadRequestException("AWS S3 client not initialized");
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.awsBucket,
        Key: key,
      });

      await this.awsClient.send(command);
      this.logger.log(`File deleted from AWS S3: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete file from AWS S3: ${error.message}`);
      throw new BadRequestException("Failed to delete file from AWS S3");
    }
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    if (this.provider === "azure") {
      return this.getAzureSignedUrl(key, expiresIn);
    } else if (this.provider === "aws") {
      return this.getAWSSignedUrl(key, expiresIn);
    }

    throw new BadRequestException(
      `Unsupported storage provider: ${this.provider}`,
    );
  }

  private async getAzureSignedUrl(
    key: string,
    expiresIn: number,
  ): Promise<string> {
    if (!this.azureContainer) {
      throw new BadRequestException("Azure container not initialized");
    }

    try {
      const blockBlobClient = this.azureContainer.getBlockBlobClient(key);
      const expiresOn = new Date(Date.now() + expiresIn * 1000);

      const url = await blockBlobClient.generateSasUrl({
        permissions: BlobSASPermissions.parse("r"),
        expiresOn,
      });

      return url;
    } catch (error) {
      this.logger.error(
        `Failed to generate Azure signed URL: ${error.message}`,
      );
      throw new BadRequestException("Failed to generate Azure signed URL");
    }
  }

  private async getAWSSignedUrl(
    key: string,
    expiresIn: number,
  ): Promise<string> {
    if (!this.awsClient || !this.awsBucket) {
      throw new BadRequestException("AWS S3 client not initialized");
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.awsBucket,
        Key: key,
      });

      const url = await getSignedUrl(this.awsClient, command, { expiresIn });
      return url;
    } catch (error) {
      this.logger.error(`Failed to generate AWS signed URL: ${error.message}`);
      throw new BadRequestException("Failed to generate AWS signed URL");
    }
  }

  getProvider(): string {
    return this.provider;
  }

  /**
   * Generate a proxy URL for an existing file
   * @param key The storage key of the file
   * @returns The proxy URL
   */
  getProxyUrl(key: string): string {
    return `/api/v1/media/proxy/${encodeURIComponent(key)}`;
  }

  /**
   * Check if a URL is a proxy URL
   * @param url The URL to check
   * @returns True if it's a proxy URL
   */
  isProxyUrl(url: string): boolean {
    return url.includes("/api/v1/media/proxy/");
  }

  /**
   * Extract the storage key from a proxy URL
   * @param proxyUrl The proxy URL
   * @returns The storage key
   */
  extractKeyFromProxyUrl(proxyUrl: string): string {
    const match = proxyUrl.match(/\/api\/v1\/media\/proxy\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}
