import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { recordCrossTenantAccessAttempt } from "../../telemetry";

export const TENANT_KEY = "tenant";

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requireTenant = this.reflector.getAllAndOverride<boolean>(
      TENANT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requireTenant) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const tenantId =
      request.params.tenantId ||
      request.body.tenantId ||
      request.query.tenantId;

    if (!user) {
      throw new ForbiddenException("User not authenticated");
    }

    // System admins can access any tenant
    if (user.role === "SystemAdmin") {
      return true;
    }

    // If the request doesn't explicitly specify a tenantId, allow and rely on the JWT tenant context
    // (services/controllers use req.user.tenantId for tenant isolation).
    if (tenantId === undefined || tenantId === null || tenantId === "") {
      return true;
    }

    // Other users can only access their own tenant
    if (user.tenantId !== tenantId) {
      // Track suspicious cross-tenant access attempt
      recordCrossTenantAccessAttempt({
        userId: user._id?.toString() || user.id?.toString() || "unknown",
        userTenantId: user.tenantId?.toString() || "unknown",
        attemptedTenantId: tenantId?.toString() || "unknown",
        route: `${request.method} ${request.route?.path || request.path}`,
        ipAddress: request.ip || request.socket?.remoteAddress || "unknown",
        userAgent: request.headers?.["user-agent"] || "unknown",
      });

      throw new ForbiddenException("Access denied to this tenant");
    }

    return true;
  }
}
