import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { RolesGuard } from "./roles.guard";
import { UserRole } from "../../common/schemas/user.schema";

describe("RolesGuard", () => {
  let guard: RolesGuard;

  const mockReflector = {
    getAllAndOverride: jest.fn(),
  };

  const createMockExecutionContext = (
    user: any,
    _roles?: UserRole[],
  ): ExecutionContext => {
    const request = {
      user,
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
        RolesGuard,
        {
          provide: Reflector,
          useValue: mockReflector,
        },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(guard).toBeDefined();
  });

  describe("canActivate", () => {
    it("should allow access when no roles required", () => {
      mockReflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockExecutionContext({ role: UserRole.USER });

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access when user has required role", () => {
      mockReflector.getAllAndOverride.mockReturnValue([
        UserRole.SYSTEM_ADMIN,
        UserRole.USER,
      ]);
      const context = createMockExecutionContext({
        role: UserRole.SYSTEM_ADMIN,
      });

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should allow access when user has one of multiple required roles", () => {
      mockReflector.getAllAndOverride.mockReturnValue([
        UserRole.SYSTEM_ADMIN,
        UserRole.TENANT_ADMIN,
      ]);
      const context = createMockExecutionContext({
        role: UserRole.TENANT_ADMIN,
      });

      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });

    it("should throw ForbiddenException when user does not have required role", () => {
      mockReflector.getAllAndOverride.mockReturnValue([UserRole.SYSTEM_ADMIN]);
      const context = createMockExecutionContext({ role: UserRole.USER });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        "Insufficient permissions",
      );
    });

    it("should throw ForbiddenException when user is not authenticated", () => {
      mockReflector.getAllAndOverride.mockReturnValue([UserRole.SYSTEM_ADMIN]);
      const context = createMockExecutionContext(null);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        "User not authenticated",
      );
    });

    it("should throw ForbiddenException when user object is missing", () => {
      mockReflector.getAllAndOverride.mockReturnValue([UserRole.SYSTEM_ADMIN]);
      const context = createMockExecutionContext(undefined);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});
