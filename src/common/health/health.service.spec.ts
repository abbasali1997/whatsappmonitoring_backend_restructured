import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getConnectionToken } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { HealthService } from "./health.service";
import { EmailService } from "../../modules/email/email.service";
import { CacheService } from "../cache/cache.service";

describe("HealthService", () => {
  let service: HealthService;
  let mockConnection: Partial<Connection>;
  let mockConfigService: Partial<ConfigService>;
  let mockEmailService: Partial<EmailService>;
  let mockCacheService: Partial<CacheService>;

  beforeEach(async () => {
    // Mock MongoDB connection
    mockConnection = {
      db: {
        admin: jest.fn().mockReturnValue({
          ping: jest.fn().mockResolvedValue(true),
        }),
      },
      readyState: 1,
      host: "localhost",
      port: 27017,
      name: "test-db",
    } as any;

    // Mock ConfigService
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          "email.host": "smtp.example.com",
          "email.port": 587,
        };
        return config[key];
      }),
    };

    // Mock EmailService
    mockEmailService = {
      verifyConnection: jest.fn().mockResolvedValue(true),
    };

    // Mock CacheService
    mockCacheService = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: getConnectionToken(),
          useValue: mockConnection,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("checkHealth", () => {
    it("should return unhealthy status when database is unhealthy", async () => {
      mockConnection.db!.admin = jest.fn().mockReturnValue({
        ping: jest.fn().mockRejectedValue(new Error("Connection failed")),
      }) as any;

      const result = await service.checkHealth();

      expect(result.status).toBe("unhealthy");
      expect(result.services.database.status).toBe("unhealthy");
    });

    it("should return unhealthy status when email service is unhealthy", async () => {
      mockEmailService.verifyConnection = jest.fn().mockResolvedValue(false);

      const result = await service.checkHealth();

      expect(result.status).toBe("unhealthy");
      expect(result.services.email.status).toBe("degraded");
    });

    it("should handle errors gracefully", async () => {
      mockEmailService.verifyConnection = jest
        .fn()
        .mockRejectedValue(new Error("Email service error"));

      const result = await service.checkHealth();

      expect(result.services.email.status).toBe("unhealthy");
      expect(result.services.email.error).toBeDefined();
    });
  });

  describe("getMetrics", () => {
    it("should return system metrics", async () => {
      const metrics = await service.getMetrics();

      expect(metrics).toHaveProperty("memory");
      expect(metrics).toHaveProperty("cpu");
      expect(metrics).toHaveProperty("uptime");
      expect(metrics).toHaveProperty("timestamp");
      expect(metrics.memory).toHaveProperty("rss");
      expect(metrics.memory).toHaveProperty("heapTotal");
      expect(metrics.memory).toHaveProperty("heapUsed");
      expect(metrics.memory).toHaveProperty("external");
    });
  });

  describe("checkDatabase", () => {
    it("should return healthy status when database is accessible", async () => {
      const result = await (service as any).checkDatabase();

      expect(result.status).toBe("healthy");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.details).toBeDefined();
    });

    it("should return unhealthy status when database is not accessible", async () => {
      mockConnection.db!.admin = jest.fn().mockReturnValue({
        ping: jest.fn().mockRejectedValue(new Error("Connection failed")),
      }) as any;

      const result = await (service as any).checkDatabase();

      expect(result.status).toBe("unhealthy");
      expect(result.error).toBeDefined();
    });
  });

  describe("checkEmail", () => {
    it("should return healthy status when email service is connected", async () => {
      mockEmailService.verifyConnection = jest.fn().mockResolvedValue(true);

      const result = await (service as any).checkEmail();

      expect(result.status).toBe("healthy");
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
    });

    it("should return degraded status when email service is not connected", async () => {
      mockEmailService.verifyConnection = jest.fn().mockResolvedValue(false);

      const result = await (service as any).checkEmail();

      expect(result.status).toBe("degraded");
    });

    it("should return unhealthy status when email check fails", async () => {
      mockEmailService.verifyConnection = jest
        .fn()
        .mockRejectedValue(new Error("Email error"));

      const result = await (service as any).checkEmail();

      expect(result.status).toBe("unhealthy");
      expect(result.error).toBeDefined();
    });
  });

  describe("checkMemory", () => {
    it("should return healthy status when memory usage is low", async () => {
      // Mock process.memoryUsage to return low usage
      const originalMemoryUsage = process.memoryUsage;
      const mockMemoryUsage = {
        heapTotal: 100 * 1024 * 1024, // 100 MB
        heapUsed: 50 * 1024 * 1024, // 50 MB (50% usage)
        rss: 200 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      };
      process.memoryUsage = jest.fn().mockReturnValue(mockMemoryUsage) as any;

      const result = await (service as any).checkMemory();

      expect(result.status).toBe("healthy");
      expect(result.details).toBeDefined();
      expect(result.details.usagePercentage).toBeDefined();

      // Restore original
      process.memoryUsage = originalMemoryUsage;
    });

    it("should return degraded status when memory usage is high", async () => {
      const originalMemoryUsage = process.memoryUsage;
      const mockMemoryUsage = {
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 80 * 1024 * 1024, // 80% usage
        rss: 200 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      };
      process.memoryUsage = jest.fn().mockReturnValue(mockMemoryUsage) as any;

      const result = await (service as any).checkMemory();

      expect(result.status).toBe("degraded");

      process.memoryUsage = originalMemoryUsage;
    });
  });
});
