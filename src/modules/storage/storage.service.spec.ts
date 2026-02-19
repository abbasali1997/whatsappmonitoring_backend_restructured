import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { BlobServiceClient } from "@azure/storage-blob";

// Mock Azure and AWS SDKs
jest.mock("@azure/storage-blob");
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/s3-request-presigner");

describe("StorageService", () => {
  let service: StorageService;
  let mockConfigService: Partial<ConfigService>;
  let mockBlockBlobClient: any;
  let mockContainerClient: any;
  let mockBlobServiceClient: any;

  beforeEach(async () => {
    // Mock Azure Blob Storage
    mockBlockBlobClient = {
      upload: jest.fn().mockResolvedValue({}),
      download: jest.fn().mockResolvedValue({
        readableStreamBody: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from("test data");
          },
        },
        contentType: "image/png",
      }),
      delete: jest.fn().mockResolvedValue({}),
      generateSasUrl: jest
        .fn()
        .mockResolvedValue("https://example.com/signed-url"),
      url: "https://example.com/blob-url",
    };

    mockContainerClient = {
      getBlockBlobClient: jest.fn().mockReturnValue(mockBlockBlobClient),
    };

    mockBlobServiceClient = {
      getContainerClient: jest.fn().mockReturnValue(mockContainerClient),
    };

    (BlobServiceClient.fromConnectionString as jest.Mock) = jest
      .fn()
      .mockReturnValue(mockBlobServiceClient);

    // Mock ConfigService
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          "storage.provider": "azure",
          "storage.azure.connectionString":
            "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net",
          "storage.azure.container": "unicx-files",
          "storage.aws.region": "us-east-1",
          "storage.aws.accessKeyId": "test-key",
          "storage.aws.secretAccessKey": "test-secret",
          "storage.aws.bucket": "test-bucket",
          "app.baseUrl": "http://localhost:5000",
        };
        return config[key];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("uploadFile", () => {
    it("should upload file to Azure successfully", async () => {
      const file = Buffer.from("test file content");
      const fileName = "test.txt";
      const contentType = "text/plain";

      const result = await service.uploadFile(file, fileName, contentType);

      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("proxyUrl");
      expect(result).toHaveProperty("key");
      expect(result).toHaveProperty("size");
      expect(result).toHaveProperty("contentType");
      expect(mockBlockBlobClient.upload).toHaveBeenCalled();
    });

    it("should upload file with folder path", async () => {
      const file = Buffer.from("test file content");
      const fileName = "test.txt";
      const contentType = "text/plain";
      const folder = "documents";

      const result = await service.uploadFile(
        file,
        fileName,
        contentType,
        folder,
      );

      expect(result.key).toBe(`${folder}/${fileName}`);
    });

    it("should throw error when Azure container is not initialized", async () => {
      // Create a new service instance without proper initialization
      const badConfig = {
        get: jest.fn((key: string) => {
          if (key === "storage.provider") return "azure";
          if (key === "storage.azure.connectionString") return null;
          return null;
        }),
      };

      await expect(() => {
        new StorageService(badConfig as unknown as ConfigService);
      }).toThrow(BadRequestException);
    });
  });

  describe("downloadFile", () => {
    it("should download file from Azure successfully", async () => {
      const key = "test.txt";

      const result = await service.downloadFile(key);

      expect(result).toHaveProperty("buffer");
      expect(result).toHaveProperty("contentType");
      expect(result).toHaveProperty("size");
      expect(mockBlockBlobClient.download).toHaveBeenCalled();
    });

    it("should throw error when file is not found", async () => {
      mockBlockBlobClient.download = jest.fn().mockResolvedValue({
        readableStreamBody: null,
      });

      await expect(service.downloadFile("nonexistent.txt")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("deleteFile", () => {
    it("should delete file from Azure successfully", async () => {
      const key = "test.txt";

      await service.deleteFile(key);

      expect(mockBlockBlobClient.delete).toHaveBeenCalled();
    });
  });

  describe("getSignedUrl", () => {
    it("should generate signed URL for Azure", async () => {
      const key = "test.txt";
      const expiresIn = 3600;

      const result = await service.getSignedUrl(key, expiresIn);

      expect(result).toBe("https://example.com/signed-url");
      expect(mockBlockBlobClient.generateSasUrl).toHaveBeenCalled();
    });
  });

  describe("getProvider", () => {
    it("should return the storage provider", () => {
      const provider = service.getProvider();
      expect(provider).toBe("azure");
    });
  });

  describe("getProxyUrl", () => {
    it("should generate proxy URL", () => {
      const key = "test.txt";
      const proxyUrl = service.getProxyUrl(key);

      expect(proxyUrl).toBe("/api/v1/media/proxy/test.txt");
    });
  });

  describe("isProxyUrl", () => {
    it("should return true for proxy URLs", () => {
      const url = "/api/v1/media/proxy/test.txt";
      expect(service.isProxyUrl(url)).toBe(true);
    });

    it("should return false for non-proxy URLs", () => {
      const url = "https://example.com/file.txt";
      expect(service.isProxyUrl(url)).toBe(false);
    });
  });

  describe("extractKeyFromProxyUrl", () => {
    it("should extract key from proxy URL", () => {
      const proxyUrl = "/api/v1/media/proxy/test.txt";
      const key = service.extractKeyFromProxyUrl(proxyUrl);

      expect(key).toBe("test.txt");
    });

    it("should return empty string for invalid proxy URL", () => {
      const invalidUrl = "https://example.com/file.txt";
      const key = service.extractKeyFromProxyUrl(invalidUrl);

      expect(key).toBe("");
    });
  });
});
