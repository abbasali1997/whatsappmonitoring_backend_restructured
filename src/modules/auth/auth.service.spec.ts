import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { getModelToken } from "@nestjs/mongoose";
import { UnauthorizedException, ConflictException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { CacheService } from "../../common/cache/cache.service";
import { User, UserRole } from "../../common/schemas/user.schema";
import { Entity } from "../../common/schemas/entity.schema";
import { EmailService } from "../email/email.service";
import * as bcrypt from "bcryptjs";
import { MESSAGES } from "../../common/constants/messages";

describe("AuthService", () => {
  let service: AuthService;
  let jwtService: JwtService;
  let emailService: EmailService;

  const mockUserModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockEntityModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  const mockEmailService = {
    sendPasswordResetEmail: jest.fn(),
  };

  const mockCacheService = {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
    getUserSession: jest.fn().mockResolvedValue([]),
    cacheUserSession: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    invalidateUserSession: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getModelToken(User.name),
          useValue: mockUserModel,
        },
        {
          provide: getModelToken(Entity.name),
          useValue: mockEntityModel,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get<JwtService>(JwtService);
    emailService = module.get<EmailService>(EmailService);

    // Reset all mocks
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("validateUser", () => {
    it("should return user when credentials are valid", async () => {
      const mockUser = {
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
        password: await bcrypt.hash("password123", 10),
        isActive: true,
        registrationStatus: "registered",
        toObject: jest.fn().mockReturnValue({
          _id: "507f1f77bcf86cd799439011",
          email: "test@example.com",
          isActive: true,
          registrationStatus: "registered",
        }),
      };

      mockUserModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([mockUser]),
        }),
      });

      const result = await service.validateUser(
        "test@example.com",
        "password123",
      );

      expect(result).toBeDefined();
      expect(result.email).toBe("test@example.com");
      expect(result.password).toBeUndefined();
    });

    it("should throw UnauthorizedException when user is not found", async () => {
      mockUserModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      });

      await expect(
        service.validateUser("test@example.com", "password123"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException when password is invalid", async () => {
      const mockUser = {
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
        password: await bcrypt.hash("password123", 10),
        isActive: true,
        registrationStatus: "registered",
        toObject: jest.fn().mockReturnValue({
          _id: "507f1f77bcf86cd799439011",
          email: "test@example.com",
          isActive: true,
          registrationStatus: "registered",
        }),
      };

      mockUserModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([mockUser]),
        }),
      });

      await expect(
        service.validateUser("test@example.com", "wrongpassword"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException when user is inactive", async () => {
      const mockUser = {
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
        password: await bcrypt.hash("password123", 10),
        isActive: false,
        registrationStatus: "registered",
        toObject: jest.fn().mockReturnValue({
          _id: "507f1f77bcf86cd799439011",
          email: "test@example.com",
          isActive: false,
          registrationStatus: "registered",
        }),
      };

      mockUserModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([mockUser]),
        }),
      });

      await expect(
        service.validateUser("test@example.com", "password123"),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("login", () => {
    it("should return access token and refresh token", async () => {
      const mockUser = {
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
        role: UserRole.USER,
        tenantId: "507f1f77bcf86cd799439012",
        entityId: "507f1f77bcf86cd799439013",
        entityPath: "/test",
      };

      mockJwtService.sign = jest
        .fn()
        .mockReturnValueOnce("access_token")
        .mockReturnValueOnce("refresh_token");

      const result = await service.login(mockUser);

      expect(result).toHaveProperty("access_token");
      expect(result).toHaveProperty("refresh_token");
      expect(result).toHaveProperty("user");
      expect(result.user.email).toBe("test@example.com");
      expect(jwtService.sign).toHaveBeenCalledTimes(2);
    });
  });

  describe("hashPassword", () => {
    it("should hash password correctly", async () => {
      const password = "testpassword123";
      const hashed = await service.hashPassword(password);

      expect(hashed).toBeDefined();
      expect(hashed).not.toBe(password);
      expect(hashed.length).toBeGreaterThan(0);
    });
  });

  describe("comparePassword", () => {
    it("should return true for matching passwords", async () => {
      const password = "testpassword123";
      const hashed = await bcrypt.hash(password, 10);

      const result = await service.comparePassword(password, hashed);
      expect(result).toBe(true);
    });

    it("should return false for non-matching passwords", async () => {
      const password = "testpassword123";
      const wrongPassword = "wrongpassword";
      const hashed = await bcrypt.hash(password, 10);

      const result = await service.comparePassword(wrongPassword, hashed);
      expect(result).toBe(false);
    });
  });

  describe("register", () => {
    it("should throw ConflictException when user already exists", async () => {
      const registerDto = {
        email: "test@example.com",
        phoneNumber: "+14155552671",
        password: "StrongPass!234",
        firstName: "John",
        lastName: "Doe",
      };

      mockUserModel.findOne = jest.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
      });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("forgotPassword", () => {
    it("should return success message even when user does not exist", async () => {
      const forgotPasswordDto = {
        email: "nonexistent@example.com",
      };

      mockUserModel.findOne = jest.fn().mockResolvedValue(null);

      const result = await service.forgotPassword(forgotPasswordDto as any);

      expect(result.message).toBeDefined();
      expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it("should send reset email when user exists", async () => {
      const forgotPasswordDto = {
        email: "test@example.com",
      };

      const mockUser = {
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
        firstName: "John",
        isActive: true,
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserModel.findOne = jest.fn().mockResolvedValue(mockUser);
      mockEmailService.sendPasswordResetEmail = jest
        .fn()
        .mockResolvedValue(true);

      const result = await service.forgotPassword(forgotPasswordDto as any);

      expect(result.message).toBeDefined();
      expect(mockUser.save).toHaveBeenCalled();
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalled();
    });
  });

  describe("resetPassword", () => {
    it("should reset password when token is valid", async () => {
      const resetToken = "valid_token";
      const resetTokenHash = await bcrypt.hash(resetToken, 10);
      const resetPasswordDto = {
        token: resetToken,
        newPassword: "NewPassword!234",
      };

      const mockUser = {
        _id: "507f1f77bcf86cd799439011",
        email: "test@example.com",
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: new Date(Date.now() + 3600000),
        password: "oldpassword",
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue([mockUser]),
      });

      const result = await service.resetPassword(resetPasswordDto as any);

      expect(result.message).toBe(MESSAGES.AUTH.PASSWORD_UPDATED);
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockUser.resetPasswordToken).toBeUndefined();
    });
  });
});
