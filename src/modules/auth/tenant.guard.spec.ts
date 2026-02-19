import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { TenantGuard } from "./tenant.guard";

describe("TenantGuard", () => {
  let guard: TenantGuard;

  const mockReflector = {
    getAllAndOverride: jest.fn(),
  };

  const createMockExecutionContext = (
    user: any,
    params?: any,
    body?: any,
    query?: any,
  ): ExecutionContext => {
    const request = {
      user,
      params: params || {},
      body: body || {},
      query: query || {},
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantGuard,
        {
          provide: Reflector,
          useValue: mockReflector,
        },
      ],
    }).compile();

    guard = module.get<TenantGuard>(TenantGuard);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(guard).toBeDefined();
  });

  describe("canActivate", () => {
    it("should allow access when tenant not required", () => {
      mockReflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockExecutionContext({ role: "USER" });

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access when tenant is required and user tenantId matches", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext(
        {
          role: "USER",
          tenantId: "tenant-123",
        },
        { tenantId: "tenant-123" },
      );

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access for SystemAdmin even when tenant required", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext({
        role: "SystemAdmin",
        tenantId: null,
      });

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access when tenant is required but no tenantId is provided in the request", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext({
        role: "USER",
        tenantId: "tenant-123",
      });

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should throw ForbiddenException when tenant required but user not authenticated", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext(null);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        "User not authenticated",
      );
    });

    it("should throw ForbiddenException when tenant mismatch", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext(
        {
          role: "USER",
          tenantId: "tenant-123",
        },
        { tenantId: "tenant-456" },
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        "Access denied to this tenant",
      );
    });

    it("should check tenantId from query params", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext(
        {
          role: "USER",
          tenantId: "tenant-123",
        },
        {},
        {},
        { tenantId: "tenant-123" },
      );

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should check tenantId from body params", () => {
      mockReflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockExecutionContext(
        {
          role: "USER",
          tenantId: "tenant-123",
        },
        {},
        { tenantId: "tenant-123" },
      );

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });
  });
});
