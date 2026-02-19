/**
 * Telemetry Interceptor
 *
 * This interceptor tracks API request metrics and logs request/response payloads:
 * - Total API requests
 * - API error rates (status >= 400)
 * - Request latency (duration in milliseconds)
 * - Request/response payloads (headers, query, body)
 * - User and tenant context
 *
 * Metrics are exported to Azure Monitor via OpenTelemetry for alerting:
 * - API error rates > 5%
 * - High latency > 2s per message
 *
 * Request/response payloads are logged as spans in Application Insights.
 * Set LOG_RESPONSE_BODIES=true to log response bodies for successful requests (default: only errors).
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap, catchError, map } from "rxjs/operators";
import { Request, Response } from "express";
import { recordApiMetrics, logApiRequest } from "../../telemetry";

@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TelemetryInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startTime = Date.now();

    // Skip telemetry for health checks and docs
    if (
      request.url.startsWith("/api/docs") ||
      request.url.startsWith("/api/v1/health") ||
      request.url === "/favicon.ico"
    ) {
      return next.handle();
    }

    // Extract request information
    const method = request.method;
    const path = request.route?.path || request.path;
    const route = `${method} ${path}`;

    // Capture request data
    const requestHeaders: Record<string, string> = {};
    Object.keys(request.headers).forEach((key) => {
      const value = request.headers[key];
      requestHeaders[key] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    });

    const requestQuery = request.query || {};
    const requestBody = request.body || undefined;

    // Extract user context from request (if available)
    const userId =
      (request as any).user?._id?.toString() ||
      (request as any).user?.id?.toString();
    const tenantId =
      (request as any).user?.tenantId?.toString() ||
      (request as any).tenantId?.toString();

    // Capture IP address and user agent
    const ipAddress = request.ip || request.socket.remoteAddress || "unknown";
    const userAgent = request.headers["user-agent"] || "unknown";
    const correlationId =
      (request as any).correlationId ||
      (request.headers["x-correlation-id"] as any) ||
      (requestHeaders["x-correlation-id"] as any);

    return next.handle().pipe(
      map((data) => {
        // Capture response data before it's sent
        const responseBody = data;
        const responseHeaders: Record<string, string> = {};

        // Capture response headers
        try {
          Object.keys(response.getHeaders()).forEach((key) => {
            const value = response.getHeaders()[key];
            responseHeaders[key] = Array.isArray(value)
              ? value.join(", ")
              : String(value);
          });
        } catch (e) {
          // Headers might not be available yet
        }

        // Calculate request duration
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode || 200;
        const isError = statusCode >= 400;

        // Record metrics for successful requests
        recordApiMetrics({
          route,
          method,
          statusCode,
          duration,
          isError,
        });

        // Log request/response payloads to Application Insights
        logApiRequest({
          method,
          path,
          route,
          statusCode,
          duration,
          requestHeaders,
          requestQuery,
          requestBody,
          responseHeaders:
            Object.keys(responseHeaders).length > 0
              ? responseHeaders
              : undefined,
          responseBody:
            isError || process.env.LOG_RESPONSE_BODIES === "true"
              ? responseBody
              : undefined,
          userId,
          tenantId,
          correlationId: correlationId ? String(correlationId) : undefined,
          ipAddress,
          userAgent,
          isError,
        });

        return data;
      }),
      tap(() => {
        // Additional tap for any side effects if needed
      }),
      catchError((error) => {
        // Calculate request duration even for errors
        const duration = Date.now() - startTime;
        const statusCode = error.status || response.statusCode || 500;
        const isError = true;

        // Capture response headers for errors
        const errorResponseHeaders: Record<string, string> = {};
        try {
          Object.keys(response.getHeaders()).forEach((key) => {
            const value = response.getHeaders()[key];
            errorResponseHeaders[key] = Array.isArray(value)
              ? value.join(", ")
              : String(value);
          });
        } catch (e) {
          // Headers might not be available
        }

        // Record metrics for failed requests
        recordApiMetrics({
          route,
          method,
          statusCode,
          duration,
          isError,
        });

        // Log request/response payloads for errors
        logApiRequest({
          method,
          path,
          route,
          statusCode,
          duration,
          requestHeaders,
          requestQuery,
          requestBody,
          responseHeaders:
            Object.keys(errorResponseHeaders).length > 0
              ? errorResponseHeaders
              : undefined,
          responseBody: error.response || error.message,
          userId,
          tenantId,
          correlationId: correlationId ? String(correlationId) : undefined,
          ipAddress,
          userAgent,
          isError: true,
          errorMessage: error.message || String(error),
          errorStack: error.stack,
        });

        // Re-throw the error so NestJS can handle it
        throw error;
      }),
    );
  }
}
