import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import helmet from "helmet";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const compression = require("compression");
import { AppModule } from "./app.module";
// Initialize Azure Application Insights telemetry BEFORE creating the app
import { initTelemetry } from "../../telemetry";
import { ApplicationInsightsLogger } from "@/common/logger/application-insights.logger";
import { correlationIdMiddleware } from "@/common/middleware/correlation-id.middleware";
import { AllExceptionsFilter } from "@/common/filters/all-exceptions.filter";

function registerProcessGuards() {
  // Safety: avoid duplicate handlers in watch/hot-reload scenarios.
  const attachOnce = (
    event: "unhandledRejection" | "uncaughtException" | "warning",
    handler: (...args: any[]) => void,
  ) => {
    if (process.listenerCount(event) > 0) return;
    process.on(event, handler);
  };

  attachOnce("unhandledRejection", (reason: any, promise: Promise<any>) => {
    try {
      // eslint-disable-next-line no-console
      console.error("[PROCESS] unhandledRejection (process will NOT exit):", {
        reason,
        promise,
      });
    } catch {
      // ignore
    }
  });

  attachOnce("uncaughtException", (err: any) => {
    try {
      // eslint-disable-next-line no-console
      console.error(
        "[PROCESS] uncaughtException (process will NOT exit):",
        err,
      );
    } catch {
      // ignore
    }
  });

  attachOnce("warning", (warning: any) => {
    try {
      // eslint-disable-next-line no-console
      console.warn("[PROCESS] warning:", warning);
    } catch {
      // ignore
    }
  });
}

async function bootstrap() {
  registerProcessGuards();
  // Check if running on localhost - disable telemetry in development
  const nodeEnv = process.env.NODE_ENV || "development";
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const isLocalhost =
    nodeEnv === "development" ||
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1");

  // Initialize Azure Application Insights telemetry (only if not localhost)
  // This must be called BEFORE NestFactory.create() to capture all traces
  if (!isLocalhost) {
    const connectionString = process.env.AZURE_MONITOR_CONNECTION_STRING;
    const serviceName = process.env.APP_NAME || "2N5 Integration";
    const serviceVersion = process.env.APP_VERSION || "1.0.0";
    initTelemetry(connectionString, serviceName, serviceVersion);
  }

  // Create the NestJS application
  // Use Application Insights logger only in production, default logger on localhost
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // Use default logger on localhost
  if (isLocalhost) {
    app.useLogger(["log", "error", "warn", "debug", "verbose"]);
  } else {
    app.useLogger(new ApplicationInsightsLogger("Application", true));
  }
  const configService = app.get(ConfigService);

  // Security middleware
  app.use(helmet());
  app.use(compression());
  // Correlation id (must be early so interceptors/logging can use it)
  app.use(correlationIdMiddleware);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter (last line of defense: never crash on request errors)
  app.useGlobalFilters(new AllExceptionsFilter());

  // CORS configuration
  // const corsOrigins = configService.get<string[]>('security.corsOrigin', ['http://localhost:3000', 'https://unicx-frontend-pi.vercel.app']);
  app.enableCors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Tenant-ID",
      "X-Correlation-Id",
      "traceparent",
      "tracestate",
      "baggage",
    ],
    exposedHeaders: ["X-Correlation-Id"],
  });

  // Global prefix
  app.setGlobalPrefix(configService.get<string>("app.apiPrefix", "api/v1"));

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle("2N5 Integration API")
    .setDescription("Backend API for 2N5 Integration Platform")
    .setVersion("1.0")
    .addBearerAuth()
    .addTag("Authentication", "User authentication and authorization")
    .addTag("Entities", "Entity management with hierarchical structure")
    .addTag("Users", "User management and registration workflow")
    .addTag("QR Codes", "QR code generation and invitation system")
    .addTag("Onboarding", "Onboarding progress tracking")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const port = configService.get<number>("app.port", 3000);
  const appName = configService.get<string>("app.name", "2N5 Integration");

  await app.listen(port);
  console.log(`🚀 ${appName} is running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
  console.log(`🏥 Health Check: http://localhost:${port}/health`);
  console.log(`🔐 Environment: ${configService.get<string>("app.nodeEnv")}`);
}

bootstrap().catch((err) => {
  try {
    // eslint-disable-next-line no-console
    console.error(
      "[BOOTSTRAP] Fatal error during startup (process will NOT exit):",
      err,
    );
  } catch {
    // ignore
  }
});
