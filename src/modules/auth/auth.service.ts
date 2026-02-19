import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  HttpStatus,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User, UserRole } from "../../common/schemas/user.schema";
import { Entity } from "../../common/schemas/entity.schema";
import { EmailService } from "../email/email.service";
import { RegisterDto } from "./dto/register.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { MESSAGES } from "../../common/constants/messages";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { CacheService, CacheKey } from "../../common/cache/cache.service";
import { v4 as uuidv4 } from "uuid";
import { isPasswordStrong } from "../../common/security/password.utils";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";

const getFrontendUrl = (): string => {
  const raw = process.env.FRONTEND_URL?.trim();
  if (!raw) {
    return "https://system.2n5global.com";
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
};

const getCompanyName = (): string =>
  process.env.COMPANY_NAME?.trim() || "2N5 Global";

const getCompanyAddress = (): string =>
  process.env.COMPANY_ADDRESS?.trim() ||
  "123 Business Street, Tech City";

const getSupportEmail = (): string =>
  process.env.SUPPORT_EMAIL?.trim() || "support@2n5global.com";

const getLogoUrl = (): string => `${getFrontendUrl()}/images/logo.png`;

const sanitizeOptionalLink = (value?: string): string | undefined =>
  value?.trim() ? value.trim() : undefined;

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string;
  entityId: string;
  entityPath?: string;
  entityIdPath?: string[];
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
    tenantId?: string;
    entityId?: string;
    entityPath?: string;
    mustChangePassword: boolean;
    passwordChangedAt?: string;
  };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<User>,
    @InjectModel(Entity.name)
    private entityModel: Model<Entity>,
    private jwtService: JwtService,
    private emailService: EmailService,
    private cacheService: CacheService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const normalizedEmail = String(email || "")
      .toLowerCase()
      .trim();

    const candidates = await this.userModel
      .find({
        email: normalizedEmail,
        isActive: true,
      })
      .select("+password")
      .exec();

    if (!candidates || candidates.length === 0) {
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: MESSAGES.AUTH.ACCOUNT_NOT_FOUND,
        error: "Unauthorized",
      });
    }

    // If multiple active accounts share the same email (e.g., by role),
    // select the one whose password matches.
    for (const user of candidates) {
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) continue;

      if (!user.isActive) {
        throw new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          message: MESSAGES.AUTH.ACCOUNT_DEACTIVATED,
          error: "Unauthorized",
        });
      }

      if (user.registrationStatus !== "registered") {
        throw new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          message: MESSAGES.AUTH.REGISTRATION_INCOMPLETE,
          error: "Unauthorized",
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { password: _, ...result } = user.toObject();
      return result;
    }

    throw new UnauthorizedException({
      statusCode: HttpStatus.UNAUTHORIZED,
      message: MESSAGES.AUTH.INVALID_CREDENTIALS,
      error: "Unauthorized",
    });
  }

  async login(user: any): Promise<LoginResponse> {
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tenantId: user?.tenantId?.toString(),
      entityId: user?.entityId?.toString(),
    };

    const access_token = this.jwtService.sign(payload);
    const refresh_token = this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    });

    // Persist refresh token and session data in cache
    try {
      const ttl = this.parseExpiresIn(
        process.env.JWT_REFRESH_EXPIRES_IN || "7d",
      );

      // session id to track multiple sessions
      const sessionId = uuidv4();
      const sessionData = {
        id: sessionId,
        refreshToken: refresh_token,
        createdAt: Date.now(),
      };

      // limit concurrent sessions
      const userId = user._id.toString();
      const sessions = (await this.cacheService.getUserSession(userId)) || [];
      const maxSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS || "3", 10);

      // remove oldest sessions when limit reached
      while (sessions.length >= maxSessions) {
        const old = sessions.shift();
        if (old && old.refreshToken) {
          await this.cacheService.del(`${CacheKey.REFRESH_TOKEN}${old.refreshToken}`);
        }
      }

      sessions.push(sessionData);
      await this.cacheService.cacheUserSession(userId, sessions, ttl);
      await this.cacheService.set(`${CacheKey.REFRESH_TOKEN}${refresh_token}`, userId, ttl);
    } catch (err) {
      // Continue even if cache operations fail
      // This ensures login doesn't break when Redis is unavailable
    }
    return {
      access_token,
      refresh_token,
      user: {
        id: user._id.toString(),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user?.tenantId?.toString(),
        entityId: user?.entityId?.toString(),
        entityPath: user?.entityPath,
        mustChangePassword: !!user?.mustChangePassword,
        passwordChangedAt: user?.passwordChangedAt
          ? new Date(user.passwordChangedAt).toISOString()
          : undefined,
      },
    };
  }

  async refreshToken(refreshToken: string): Promise<{ access_token: string }> {
    try {
      // Check token is registered in cache
      const cachedUserId = await this.cacheService.get(`${CacheKey.REFRESH_TOKEN}${refreshToken}`);
      if (!cachedUserId) {
        throw new UnauthorizedException("Invalid refresh token");
      }

      const payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      const user = await this.userModel.findById(payload.sub);
      if (!user || !user.isActive) {
        throw new UnauthorizedException("User not found or inactive");
      }

      const newPayload: JwtPayload = {
        sub: user._id.toString(),
        email: user.email,
        role: user.role,
        tenantId: user.tenantId?.toString(),
        entityId: user.entityId?.toString(),
      };

      return {
        access_token: this.jwtService.sign(newPayload),
      };
    } catch (error) {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async validateToken(token: string): Promise<JwtPayload> {
    try {
      return this.jwtService.verify(token);
    } catch (error) {
      throw new UnauthorizedException("Invalid token");
    }
  }

  async logout(userId?: string): Promise<void> {
    // Invalidate all sessions for a user
    try {
      if (!userId) return;
      const sessions = (await this.cacheService.getUserSession(userId)) || [];
      for (const s of sessions) {
        if (s?.refreshToken) {
          await this.cacheService.del(`${CacheKey.REFRESH_TOKEN}${s.refreshToken}`);
        }
      }

      await this.cacheService.invalidateUserSession(userId);
    } catch (err) {
      // ignore cache errors
    }
  }

  async hashPassword(password: string): Promise<string> {
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);
    return bcrypt.hash(password, saltRounds);
  }

  async comparePassword(
    password: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return bcrypt.compare(password, hashedPassword);
  }

  async register(registerDto: RegisterDto): Promise<LoginResponse> {
    if (!isPasswordStrong(registerDto.password)) {
      throw new BadRequestException(MESSAGES.AUTH.PASSWORD_TOO_WEAK);
    }

    const normalizedEmail = String(registerDto.email || "")
      .toLowerCase()
      .trim();

    const rawPhone = String(registerDto.phoneNumber || "").trim();
    if (!isValidPhoneNumber(rawPhone)) {
      throw new BadRequestException(MESSAGES.USER.INVALID_PHONE_FORMAT);
    }
    const e164Phone = parsePhoneNumber(rawPhone).format("E.164");

    // Check if user already exists
    const existingUser = await this.userModel.findOne({
      isActive: true,
      $or: [
        // phone number must be globally unique among active users
        { phoneNumber: e164Phone },
        // email uniqueness is enforced per-role (see UserSchema index)
        { email: normalizedEmail, role: UserRole.USER },
      ],
    });

    if (existingUser) {
      throw new ConflictException(
        "User with this email or phone number already exists",
      );
    }

    // If entityId and tenantId not provided, find or create a default entity
    let entityId = registerDto.entityId;
    let tenantId = registerDto.tenantId;
    let entityPath = "";

    if (!entityId || !tenantId) {
      // Find the first available entity or create a default one
      const defaultEntity = await this.entityModel.findOne({ type: "E164" });

      if (!defaultEntity) {
        throw new BadRequestException(
          "No default entity available. Please contact administrator.",
        );
      }

      entityId = defaultEntity._id.toString();
      tenantId = defaultEntity.tenantId.toString();
      entityPath = defaultEntity.path;
    } else {
      // Get entity path
      const entity = await this.entityModel.findById(entityId);
      if (!entity) {
        throw new BadRequestException("Invalid entity ID");
      }
      entityPath = entity.path;
    }

    // Hash password
    const hashedPassword = await this.hashPassword(registerDto.password);

    // Create new user
    const newUser = new this.userModel({
      phoneNumber: e164Phone,
      email: normalizedEmail,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
      password: hashedPassword,
      entityId: new Types.ObjectId(entityId),
      tenantId,
      entityPath,
      role: UserRole.USER,
      registrationStatus: "registered",
      isActive: true,
    });

    const savedUser = await newUser.save();

    // Return login response with tokens
    const userObj = savedUser.toObject();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _, ...userWithoutPassword } = userObj;

    return this.login(userWithoutPassword);
  }

  /**
   * Convert jwt expiresIn string to seconds.
   * Supports number strings and suffixes: s,m,h,d
   */
  private parseExpiresIn(expiresIn: string): number {
    if (!expiresIn) return 0;
    const match = String(expiresIn).match(/^(\d+)([smhd])?$/i);
    if (!match) return parseInt(expiresIn, 10) || 0;
    const value = parseInt(match[1], 10);
    const unit = (match[2] || "s").toLowerCase();
    switch (unit) {
      case "s":
        return value;
      case "m":
        return value * 60;
      case "h":
        return value * 3600;
      case "d":
        return value * 86400;
      default:
        return value;
    }
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    const { email } = forgotPasswordDto;

    // Find user by email
    const user = await this.userModel.findOne({
      email,
      isActive: true,
    });

    // Always return success message to prevent email enumeration
    if (!user) {
      return {
        message:
          "If an account exists with this email, a password reset link has been sent.",
      };
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = await bcrypt.hash(resetToken, 10);
    const resetTokenExpires = new Date(Date.now() + 3600000); // 1 hour from now

    // Save reset token to user
    user.resetPasswordToken = resetTokenHash;
    user.resetPasswordExpires = resetTokenExpires;
    await user.save();

    // Create reset link
    const resetLink = `${getFrontendUrl()}/reset-password?token=${resetToken}`;

    // Send password reset email
    await this.emailService.sendPasswordResetEmail(email, {
      firstName: user.firstName,
      resetLink,
      expiryHours: 1,
      logoUrl: getLogoUrl(),
      companyName: getCompanyName(),
      companyAddress: getCompanyAddress(),
      supportEmail: getSupportEmail(),
      socialLinks: {
        website: sanitizeOptionalLink(process.env.COMPANY_WEBSITE),
        linkedin: sanitizeOptionalLink(process.env.COMPANY_LINKEDIN),
        twitter: sanitizeOptionalLink(process.env.COMPANY_TWITTER),
      },
      // language is handled inside email service; cast to any to avoid type drift here
    } as any);

    return {
      message:
        "If an account exists with this email, a password reset link has been sent.",
      // Include token in response for development/testing only
      ...(process.env.NODE_ENV === "development" && { resetToken }),
    };
  }

  async resetPassword(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    const { token, newPassword } = resetPasswordDto;

    if (!isPasswordStrong(newPassword)) {
      throw new BadRequestException(MESSAGES.AUTH.PASSWORD_TOO_WEAK);
    }

    // Find all users with non-expired reset tokens
    const users = await this.userModel
      .find({
        resetPasswordExpires: { $gt: new Date() },
        isActive: true,
      })
      .select("+resetPasswordToken +password");

    // Find user by matching token
    let matchedUser = null;
    for (const user of users) {
      if (
        user.resetPasswordToken &&
        (await bcrypt.compare(token, user.resetPasswordToken))
      ) {
        matchedUser = user;
        break;
      }
    }

    if (!matchedUser) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    // Hash new password
    const hashedPassword = await this.hashPassword(newPassword);

    // Update user password and clear reset token
    matchedUser.password = hashedPassword;
    matchedUser.mustChangePassword = false;
    matchedUser.passwordChangedAt = new Date();
    matchedUser.resetPasswordToken = undefined;
    matchedUser.resetPasswordExpires = undefined;
    await matchedUser.save();

    return { message: MESSAGES.AUTH.PASSWORD_UPDATED };
  }

  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
    email?: string,
  ): Promise<{ message: string }> {
    if (!userId && !email) {
      throw new UnauthorizedException(MESSAGES.AUTH.ACCOUNT_NOT_FOUND);
    }

    let user =
      userId &&
      (await this.userModel
        .findById(userId)
        .select("+password")
        .exec());

    if (!user && email) {
      user = await this.userModel
        .findOne({ email, isActive: true })
        .select("+password")
        .exec();
    }

    if (!user) {
      throw new UnauthorizedException(MESSAGES.AUTH.ACCOUNT_NOT_FOUND);
    }

    const isCurrentPasswordValid = await this.comparePassword(
      changePasswordDto.currentPassword,
      user.password,
    );

    if (!isCurrentPasswordValid) {
      throw new BadRequestException(MESSAGES.AUTH.INVALID_CURRENT_PASSWORD);
    }

    if (!isPasswordStrong(changePasswordDto.newPassword)) {
      throw new BadRequestException(MESSAGES.AUTH.PASSWORD_TOO_WEAK);
    }

    const hashedPassword = await this.hashPassword(
      changePasswordDto.newPassword,
    );

    user.password = hashedPassword;
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();

    await user.save();

    return { message: MESSAGES.AUTH.PASSWORD_UPDATED };
  }
}
