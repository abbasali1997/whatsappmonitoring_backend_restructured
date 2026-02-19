import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";

export const RATE_LIMIT_KEY = "rateLimit";

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly requestCounts = new Map<
    string,
    { count: number; resetTime: number }
  >();

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const rateLimitConfig = this.reflector.getAllAndOverride<{
      ttl: number;
      limit: number;
    }>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);

    if (!rateLimitConfig) {
      return true;
    }

    const { ttl, limit } = rateLimitConfig;
    const key = this.getRateLimitKey(request);
    const now = Date.now();
    const windowStart = now - ttl * 1000;

    // Clean up old entries
    this.cleanupOldEntries(windowStart);

    const current = this.requestCounts.get(key);

    if (!current) {
      this.requestCounts.set(key, { count: 1, resetTime: now + ttl * 1000 });
      return true;
    }

    if (current.resetTime < now) {
      this.requestCounts.set(key, { count: 1, resetTime: now + ttl * 1000 });
      return true;
    }

    if (current.count >= limit) {
      throw new HttpException(
        {
          message: "Rate limit exceeded",
          retryAfter: Math.ceil((current.resetTime - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    current.count++;
    return true;
  }

  private getRateLimitKey(request: Request): string {
    const user = (request as any).user;
    const ip = request.ip || request.connection.remoteAddress || "unknown";

    // Use user ID if authenticated, otherwise use IP
    return user ? `user:${user.sub}` : `ip:${ip}`;
  }

  private cleanupOldEntries(windowStart: number): void {
    for (const [key, value] of this.requestCounts.entries()) {
      if (value.resetTime < windowStart) {
        this.requestCounts.delete(key);
      }
    }
  }
}
