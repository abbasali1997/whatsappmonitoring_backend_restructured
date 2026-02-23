import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    // Safety: never throw from the filter.
    try {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse<Response>();
      const request = ctx.getRequest<Request & { correlationId?: string }>();

      const correlationId =
        request?.correlationId ||
        (request?.headers?.["x-correlation-id"] as string | undefined) ||
        (request?.headers?.["x-correlationid"] as string | undefined);

      const isHttp = exception instanceof HttpException;
      const status = isHttp
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

      const exceptionResponse = isHttp ? exception.getResponse() : undefined;
      const message =
        typeof exceptionResponse === "string"
          ? exceptionResponse
          : (exceptionResponse as any)?.message ||
            (exception as any)?.message ||
            "Internal server error";

      const errorPayload = {
        statusCode: status,
        timestamp: new Date().toISOString(),
        path: request?.originalUrl || request?.url,
        method: request?.method,
        correlationId,
        message,
      };

      const stack = exception instanceof Error ? exception.stack : undefined;
      const name =
        exception instanceof Error ? exception.name : "UnknownException";

      // Keep logs high signal and safe to serialize.
      if (status >= 500) {
        this.logger.error(
          `[${correlationId || "no-correlation-id"}] ${name}: ${String(message)}`,
          stack,
        );
      } else {
        this.logger.warn(
          `[${correlationId || "no-correlation-id"}] ${name}: ${String(message)}`,
        );
      }

      // Avoid "Cannot set headers after they are sent"
      if ((response as any)?.headersSent) return;

      response.status(status).json(errorPayload);
    } catch (filterError) {
      try {
        // Last resort: do not crash the process
        // eslint-disable-next-line no-console
        console.error(
          "[AllExceptionsFilter] Failed while handling exception:",
          filterError,
        );
      } catch {
        // ignore
      }
    }
  }
}
