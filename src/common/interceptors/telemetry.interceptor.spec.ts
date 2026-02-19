import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionContext, CallHandler } from "@nestjs/common";
import { of, throwError } from "rxjs";
import { TelemetryInterceptor } from "./telemetry.interceptor";
import { recordApiMetrics, logApiRequest } from "../../telemetry";

// Mock telemetry functions
jest.mock("../../telemetry", () => ({
  recordApiMetrics: jest.fn(),
  logApiRequest: jest.fn(),
}));

describe("TelemetryInterceptor", () => {
  let interceptor: TelemetryInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TelemetryInterceptor],
    }).compile();

    interceptor = module.get<TelemetryInterceptor>(TelemetryInterceptor);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(interceptor).toBeDefined();
  });

  describe("intercept", () => {
    const createMockExecutionContext = (
      url: string,
      method: string = "GET",
      user?: any,
    ): ExecutionContext => {
      const request = {
        url,
        method,
        path: url,
        route: { path: url },
        query: {},
        body: {},
        headers: { "user-agent": "test-agent" },
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.1" },
        user,
      };

      const response = {
        statusCode: 200,
        getHeaders: () => ({}),
      };

      return {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as ExecutionContext;
    };

    const createMockCallHandler = (data?: any, error?: Error): CallHandler => {
      return {
        handle: () => (error ? throwError(() => error) : of(data)),
      } as CallHandler;
    };

    it("should skip telemetry for health check endpoints", (done) => {
      const context = createMockExecutionContext("/api/v1/health");
      const handler = createMockCallHandler({ success: true });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(recordApiMetrics).not.toHaveBeenCalled();
          expect(logApiRequest).not.toHaveBeenCalled();
          done();
        },
      });
    });

    it("should skip telemetry for docs endpoints", (done) => {
      const context = createMockExecutionContext("/api/docs");
      const handler = createMockCallHandler({ success: true });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(recordApiMetrics).not.toHaveBeenCalled();
          done();
        },
      });
    });

    it("should record metrics for successful requests", (done) => {
      const context = createMockExecutionContext("/api/v1/users", "GET", {
        _id: "user-123",
        tenantId: "tenant-123",
      });
      const handler = createMockCallHandler({ data: [] });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(recordApiMetrics).toHaveBeenCalled();
          expect(logApiRequest).toHaveBeenCalled();
          done();
        },
      });
    });

    it("should record metrics for error responses", (done) => {
      const context = createMockExecutionContext("/api/v1/users", "GET", {
        _id: "user-123",
        tenantId: "tenant-123",
      });
      const error = new Error("Test error");
      const handler = createMockCallHandler(undefined, error);

      interceptor.intercept(context, handler).subscribe({
        error: () => {
          expect(recordApiMetrics).toHaveBeenCalled();
          done();
        },
      });
    });

    it("should extract user context from request", (done) => {
      const user = {
        _id: "user-123",
        tenantId: "tenant-123",
      };
      const context = createMockExecutionContext("/api/v1/users", "GET", user);
      const handler = createMockCallHandler({ data: [] });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(recordApiMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
              route: expect.any(String),
              method: expect.any(String),
              statusCode: expect.any(Number),
              duration: expect.any(Number),
              isError: expect.any(Boolean),
            }),
          );
          expect(logApiRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              userId: "user-123",
              tenantId: "tenant-123",
            }),
          );
          done();
        },
      });
    });

    it("should handle requests without user context", (done) => {
      const context = createMockExecutionContext("/api/v1/public", "GET");
      const handler = createMockCallHandler({ data: [] });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(recordApiMetrics).toHaveBeenCalled();
          done();
        },
      });
    });

    it("should capture request and response data", (done) => {
      const context = createMockExecutionContext("/api/v1/users", "POST", {
        _id: "user-123",
      });
      const requestBody = { name: "Test User" };
      const responseBody = { id: "new-user-123" };

      // Update context to include body
      (context.switchToHttp().getRequest() as any).body = requestBody;

      const handler = createMockCallHandler(responseBody);

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(logApiRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              method: "POST",
              path: expect.any(String),
              route: expect.any(String),
              requestBody,
              responseBody: undefined, // Response body may be undefined if LOG_RESPONSE_BODIES is not set
              userId: "user-123",
            }),
          );
          done();
        },
      });
    });
  });
});
