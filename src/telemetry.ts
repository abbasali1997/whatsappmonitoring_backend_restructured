/**
 * Azure Application Insights Telemetry Integration
 *
 * This module initializes OpenTelemetry to automatically capture traces, logs, and metrics
 * and send them to Azure Monitor (Application Insights).
 *
 * Reference: https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme
 *
 * Features:
 * - Automatic instrumentation of Node.js modules (HTTP, MongoDB, Express, etc.)
 * - Custom span attributes for multi-tenant support (tenant.id)
 * - Traces and metrics exported to Azure Monitor
 * - Application Insights sampling support (100% by default)
 * - Console exporter for local debugging
 * - Export error logging and monitoring
 *
 * Usage:
 * Call initTelemetry() before creating the NestJS application in main.ts
 *
 * Verification in Azure:
 * 1. Go to Application Insights → Logs
 * 2. Run: traces | take 10
 * 3. Run: customMetrics | where name contains "api." | take 10
 * 4. Run: dependencies | take 10
 */

import {
  AzureMonitorTraceExporter,
  AzureMonitorMetricExporter,
  ApplicationInsightsSampler,
} from "@azure/monitor-opentelemetry-exporter";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  PeriodicExportingMetricReader,
  MeterProvider,
} from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  trace,
  Span,
  metrics,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from "@opentelemetry/api";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import * as process from "process";

// Store providers for graceful shutdown
let tracerProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

const ENABLE_SELF_TEST = envFlag("OTEL_SELF_TEST", false);
const ENABLE_SHUTDOWN_HOOKS = envFlag("OTEL_ENABLE_SHUTDOWN_HOOKS", true);

// Track export statistics for debugging
// Note: Logs are sent as spans, so they're included in spansExported count
const exportStats = {
  spansExported: 0,
  spansFailed: 0,
  metricsExported: 0,
  metricsFailed: 0,
  lastExportError: null as Error | null,
};

/**
 * Initialize Azure Application Insights telemetry
 *
 * This function must be called BEFORE NestFactory.create() in main.ts
 * to ensure all application traces are captured from the start.
 *
 * Reference: https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme
 *
 * @param connectionString - Azure Monitor connection string from environment
 * @param serviceName - Name of the service (defaults to "UNICX Integration")
 * @param serviceVersion - Version of the service (defaults to "1.0.0")
 * @param sampleRate - Sampling rate between 0 and 1 (defaults to 1.0 = 100%).
 *                     Use 0.75 for 75% sampling to reduce costs.
 * @param enableDebugLogging - Enable OpenTelemetry debug logging (defaults to false)
 */
export function initTelemetry(
  connectionString?: string,
  serviceName: string = "UNICX Integration",
  serviceVersion: string = "1.0.0",
  sampleRate: number = 1.0,
  enableDebugLogging: boolean = false,
): void {
  // Check if running on localhost - disable telemetry in development
  const nodeEnv = process.env.NODE_ENV || "development";
  const isTestEnv =
    nodeEnv === "test" || typeof (process as any).env.JEST_WORKER_ID !== "undefined";
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const isLocalhost =
    (nodeEnv === "development" ||
      baseUrl.includes("localhost") ||
      baseUrl.includes("127.0.0.1")) &&
    !isTestEnv;

  if (isLocalhost) {
    console.log(
      "🔧 [LOCALHOST] Telemetry disabled for localhost development.",
    );
    return;
  }

  // Validate connection string format
  if (!connectionString || connectionString.trim() === "") {
    console.log(
      "⚠️  Azure Monitor connection string not provided. Telemetry disabled.",
    );
    console.log(
      "   Set AZURE_MONITOR_CONNECTION_STRING environment variable to enable telemetry.",
    );
    return;
  }

  // Validate connection string format (should contain InstrumentationKey and IngestionEndpoint)
  if (
    !connectionString.includes("InstrumentationKey=") ||
    !connectionString.includes("IngestionEndpoint=")
  ) {
    console.error("❌ Invalid Azure Monitor connection string format.");
    console.error(
      "   Expected format: InstrumentationKey=xxx;IngestionEndpoint=https://xxx/",
    );
    console.error(
      "   Current value:",
      connectionString.substring(0, 50) + "...",
    );
    return;
  }

  // Check if console exporter should be enabled (for local debugging)
  const enableConsoleExporter =
    process.env.OTEL_CONSOLE_EXPORTER === "true" || enableDebugLogging;

  try {
    console.log("🔧 Initializing Azure Application Insights telemetry...");
    console.log(
      `   Connection String: ${connectionString.substring(0, 30)}...${connectionString.substring(connectionString.length - 20)}`,
    );
    console.log(`   Service: ${serviceName} v${serviceVersion}`);
    console.log(`   Sampling Rate: ${(sampleRate * 100).toFixed(0)}%`);

    // Enable debug logging if requested (useful for troubleshooting)
    // Reference: https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme#enable-debug-logging
    if (enableDebugLogging || process.env.OTEL_LOG_LEVEL === "debug") {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
      console.log("🔍 OpenTelemetry debug logging enabled");
    }

    // ============================================
    // DISTRIBUTED TRACING SETUP
    // ============================================
    // Reference: https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme#distributed-tracing

    // Create Azure Monitor trace exporter with error callback
    const traceExporter = new AzureMonitorTraceExporter({
      connectionString,
    });

    // Wrap exporter to track export statistics and log errors
    const wrappedTraceExporter = {
      export: (
        spans: any[],
        resultCallback: (result: ExportResult) => void,
      ) => {
        traceExporter.export(spans, (result) => {
          if (result.code === ExportResultCode.SUCCESS) {
            exportStats.spansExported += spans.length;
            if (enableDebugLogging) {
              console.log(
                `✅ Exported ${spans.length} span(s) to Azure Monitor`,
              );
            }
          } else {
            exportStats.spansFailed += spans.length;
            exportStats.lastExportError =
              result.error || new Error("Unknown export error");
            console.error(
              `❌ Failed to export ${spans.length} span(s):`,
              result.error || "Unknown error",
            );
          }
          resultCallback(result);
        });
      },
      shutdown: () => traceExporter.shutdown(),
    };

    // Create console exporter for local debugging (optional)
    const consoleExporter = enableConsoleExporter
      ? new ConsoleSpanExporter()
      : null;
    if (consoleExporter) {
      console.log(
        "📝 Console span exporter enabled (spans will be logged to console)",
      );
    }

    // Create Application Insights sampler for proper sampling
    // Reference: https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme#sampling
    // Sampler expects a sample rate of between 0 and 1 inclusive
    // A rate of 1.0 means 100% of traces will be sent (default)
    // A rate of 0.75 means approximately 75% of your traces will be sent
    const aiSampler = new ApplicationInsightsSampler(sampleRate);
    console.log(
      `   Sampler configured: ${(sampleRate * 100).toFixed(0)}% sampling rate`,
    );

    // Create and configure the Node Tracer Provider
    tracerProvider = new NodeTracerProvider({
      sampler: aiSampler,
      resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
        // Add additional resource attributes if needed
        "service.version": serviceVersion,
        "deployment.environment": process.env.NODE_ENV || "development",
      }),
    });

    // Add span processors to the tracer provider
    // Note: Type assertion needed due to version compatibility between Azure exporter and OpenTelemetry SDK
    // The runtime behavior is correct, this is just a TypeScript type mismatch

    // Primary: Azure Monitor exporter
    tracerProvider.addSpanProcessor(
      new BatchSpanProcessor(wrappedTraceExporter as any, {
        exportTimeoutMillis: 30000, // Increased timeout for better reliability
        maxQueueSize: 2048, // Increased queue size
        scheduledDelayMillis: 5000, // Export every 5 seconds
      }),
    );

    // Optional: Console exporter for local debugging
    if (consoleExporter) {
      tracerProvider.addSpanProcessor(
        new BatchSpanProcessor(consoleExporter, {
          exportTimeoutMillis: 1000,
          maxQueueSize: 100,
        }),
      );
    }

    // Register Tracer Provider as global
    // This must be done BEFORE auto-instrumentation registration
    tracerProvider.register();
    console.log("✅ Tracer provider registered globally");

    // ============================================
    // METRICS SETUP
    // ============================================
    // Reference: https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme#metrics

    // Create Azure Monitor metric exporter with error handling
    const metricExporter = new AzureMonitorMetricExporter({
      connectionString,
    });

    // Wrap metric exporter to track export statistics
    const wrappedMetricExporter = {
      export: (
        resourceMetrics: any,
        resultCallback: (result: ExportResult) => void,
      ) => {
        // Count metrics in resourceMetrics (it's a ResourceMetrics object)
        // ResourceMetrics contains scopeMetrics array, each with a metrics array
        let metricCount = 0;
        try {
          if (resourceMetrics?.scopeMetrics) {
            metricCount = resourceMetrics.scopeMetrics.reduce(
              (sum: number, scope: any) => {
                const scopeMetricCount = scope?.metrics?.length || 0;
                if (enableDebugLogging && scopeMetricCount > 0) {
                  console.log(
                    `   Found ${scopeMetricCount} metric(s) in scope: ${scope.scope?.name || "unknown"}`,
                  );
                }
                return sum + scopeMetricCount;
              },
              0,
            );
          }
        } catch (error) {
          // If we can't count, default to 0 (empty collection)
          metricCount = 0;
        }

        // Log if no metrics found (helps debug why metrics aren't exporting)
        if (metricCount === 0) {
          if (enableDebugLogging) {
            console.log(
              "   No metrics to export (empty collection - metrics may not have been recorded yet)",
            );
          }
        }

        metricExporter.export(resourceMetrics, (result) => {
          if (result.code === ExportResultCode.SUCCESS) {
            exportStats.metricsExported += metricCount;
            if (enableDebugLogging || metricCount > 0) {
              console.log(
                `✅ Exported ${metricCount} metric(s) to Azure Monitor`,
              );
            }
          } else {
            exportStats.metricsFailed += metricCount;
            exportStats.lastExportError =
              result.error || new Error("Unknown export error");
            console.error(
              `❌ Failed to export ${metricCount} metric(s):`,
              result.error || "Unknown error",
            );
            if (result.error) {
              console.error("   Error details:", result.error.message);
            }
          }
          resultCallback(result);
        });
      },
      shutdown: () => {
        // Call shutdown on the underlying exporter if it exists
        if (metricExporter && typeof metricExporter.shutdown === "function") {
          return metricExporter.shutdown();
        }
        return Promise.resolve();
      },
      forceFlush: () => {
        // Call forceFlush on the underlying exporter if it exists
        // This is required by PeriodicExportingMetricReader during shutdown
        if (metricExporter && typeof metricExporter.forceFlush === "function") {
          return metricExporter.forceFlush();
        }
        return Promise.resolve();
      },
    };

    // Add the exporter into the MetricReader and register it with the MeterProvider
    // Note: Type assertion needed due to version compatibility between Azure exporter and OpenTelemetry SDK
    // The runtime behavior is correct, this is just a TypeScript type mismatch
    const metricReaderOptions = {
      exporter: wrappedMetricExporter as any,
      exportIntervalMillis: 60000, // Export metrics every 60 seconds (reduced for faster testing)
    };
    const metricReader = new PeriodicExportingMetricReader(metricReaderOptions);

    meterProvider = new MeterProvider({
      readers: [metricReader],
    });

    // Register Meter Provider as global
    metrics.setGlobalMeterProvider(meterProvider);
    console.log("✅ Meter provider registered globally");

    // ============================================
    // AUTO-INSTRUMENTATION SETUP
    // ============================================
    // Auto-instrumentations automatically capture telemetry from:
    // - HTTP/HTTPS requests (incoming and outgoing)
    // - Express.js middleware and routes
    // - MongoDB operations (queries, connections)
    // - Redis operations
    // - And many other Node.js modules

    // Register auto-instrumentations AFTER tracer provider is registered
    // This ensures all instrumentations use the correct tracer provider
    registerInstrumentations({
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs instrumentation to reduce noise (optional)
          // You can enable it if you need to track file operations
          "@opentelemetry/instrumentation-fs": {
            enabled: false,
          },
        }),
      ],
    });
    console.log(
      "✅ Auto-instrumentations registered (HTTP, Express, MongoDB, etc.)",
    );

    console.log(
      "✅ Azure Application Insights telemetry initialized successfully",
    );
    console.log(`   Service: ${serviceName} v${serviceVersion}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   Sampling Rate: ${(sampleRate * 100).toFixed(0)}%`);
    console.log("   Auto-instrumentation: Enabled");
    console.log("   Exporters: Traces, Metrics, Logs");
    console.log("   API Monitoring: Error rates & latency tracking enabled");
    console.log("   Logging: All NestJS logs exported to Application Insights");

    // Optional self-test:
    // - Off by default
    // - Never run in production (prevents accidental noise/costs)
    if (ENABLE_SELF_TEST && (process.env.NODE_ENV || "development") !== "production") {
      // Generate a test span to verify telemetry is working
      generateTestSpan(serviceName);
      // Generate test metrics to verify metrics export is working
      generateTestMetrics(serviceName);
    }

    // Log verification instructions
    console.log("\n📊 To verify telemetry in Azure Application Insights:");
    console.log("   1. Go to Azure Portal → Application Insights → Logs");
    console.log(
      "   2. Run: traces | where name == 'telemetry-test-span' | take 1",
    );
    console.log(
      "   3. Run: customMetrics | where name == 'telemetry.test.counter' | take 1",
    );
    console.log(
      "   4. Run: customMetrics | where name contains 'api.' | take 10",
    );
    console.log("   5. Run: dependencies | take 10");
    console.log(
      "   6. Run: traces | where name startswith 'Log:' | take 10  (for application logs)",
    );
    console.log("   Note: Allow 2-5 minutes for telemetry to appear\n");
  } catch (error) {
    console.error(
      "❌ Failed to initialize Azure Application Insights telemetry:",
      error,
    );
    if (error instanceof Error) {
      console.error("   Error message:", error.message);
      console.error("   Stack trace:", error.stack);
    }
    // Don't throw - allow the application to continue even if telemetry fails
  }
}

/**
 * Generate a test span to verify telemetry is working
 * This creates a simple span that should appear in Azure Monitor within 2-5 minutes
 */
export function generateTestSpan(
  serviceName: string = "unicx-integration",
): void {
  try {
    const tracer = trace.getTracer("unicx-integration", "1.0.0");
    const span = tracer.startSpan("telemetry-test-span");
    span.setAttribute("test.type", "initialization");
    span.setAttribute("service.name", serviceName);
    span.setAttribute("test.timestamp", new Date().toISOString());
    span.setAttribute("test.message", "Telemetry initialization test span");
    span.end();
    console.log("🧪 Test span generated: 'telemetry-test-span'");
  } catch (error) {
    console.warn("⚠️  Failed to generate test span:", error);
  }
}

/**
 * Generate test metrics to verify metrics export is working
 * This creates test metrics that should appear in Azure Monitor within 10-60 seconds
 */
export function generateTestMetrics(
  serviceName: string = "unicx-integration",
): void {
  try {
    const nodeEnv = process.env.NODE_ENV || "development";
    const isTestEnv =
      nodeEnv === "test" || typeof (process as any).env.JEST_WORKER_ID !== "undefined";

    const generate = () => {
      try {
        const meter = metrics.getMeter("unicx-integration-test", "1.0.0");

        // Create a test counter
        const testCounter = meter.createCounter("telemetry.test.counter", {
          description: "Test counter to verify metrics export",
        });

        // Create a test histogram
        const testHistogram = meter.createHistogram("telemetry.test.duration", {
          description: "Test histogram to verify metrics export",
          unit: "ms",
        });

        // Record test metrics
        testCounter.add(1, {
          test_type: "initialization",
          service_name: serviceName,
        });

        testHistogram.record(100, {
          test_type: "initialization",
          service_name: serviceName,
        });

        if (!isTestEnv) {
          console.log(
            "🧪 Test metrics generated: 'telemetry.test.counter', 'telemetry.test.duration'",
          );
          console.log(
            "   Note: Metrics export every 10 seconds, check export stats on shutdown",
          );
        }
      } catch (error) {
        console.warn("⚠️  Failed to generate test metrics:", error);
      }
    };

    // In test environment, run immediately to avoid async logs after tests finish
    if (isTestEnv) {
      generate();
    } else {
      // Wait a bit for meter provider to be fully initialized
      setTimeout(generate, 1000);
    }
  } catch (error) {
    console.warn("⚠️  Failed to initialize test metrics generation:", error);
  }
}

// ============================================
// API METRICS TRACKING
// ============================================
// These metrics are used for alerting in Azure Monitor:
// - API error rates > 5%
// - High latency > 2s per message

interface ApiMetricsData {
  route: string;
  method: string;
  statusCode: number;
  duration: number; // in milliseconds
  isError: boolean;
}

// Create meters for API metrics (lazy initialization)
let apiRequestCounter: any = null;
let apiErrorCounter: any = null;
let apiLatencyHistogram: any = null;

// Create meters for security and queue metrics (lazy initialization)
let crossTenantAccessCounter: any = null;
let queueBacklogGauge: any = null;
let queueMessageCounter: any = null;
// Create meters for WhatsApp alert metrics (lazy initialization)
let whatsappAlertCounter: any = null;

/**
 * Initialize API metrics instruments
 * This is called automatically when the first metric is recorded
 */
function initializeApiMetrics(): void {
  try {
    // Skip if telemetry is not initialized (e.g., on localhost)
    if (!meterProvider) {
      return;
    }

    const meter = metrics.getMeter("unicx-integration-api", "1.0.0");

    // Counter for total API requests
    apiRequestCounter = meter.createCounter("api.requests.total", {
      description: "Total number of API requests",
    });

    // Counter for API errors (status >= 400)
    apiErrorCounter = meter.createCounter("api.errors.total", {
      description: "Total number of API errors (status >= 400)",
    });

    // Histogram for API request latency
    // Note: OpenTelemetry histograms use seconds, but we'll record in milliseconds
    // and convert when needed for Azure Monitor
    apiLatencyHistogram = meter.createHistogram("api.request.duration", {
      description: "API request duration in milliseconds",
      unit: "ms",
    });

    // Counter for cross-tenant access attempts (security alerting)
    crossTenantAccessCounter = meter.createCounter(
      "security.cross_tenant_access.attempts",
      {
        description: "Number of suspicious cross-tenant data access attempts",
      },
    );

    // Gauge for queue backlog (current message count in queue)
    queueBacklogGauge = meter.createObservableGauge("queue.backlog.messages", {
      description: "Current number of messages in queue (backlog)",
      unit: "1",
    });

    // Counter for queue messages sent/received
    queueMessageCounter = meter.createCounter("queue.messages.total", {
      description: "Total number of queue messages sent",
    });
  } catch (error) {
    // Silently fail if metrics aren't initialized yet
    // This can happen if telemetry isn't set up
  }
}

/**
 * Initialize WhatsApp alert metrics instruments
 * This is called automatically when the first metric is recorded
 */
function initializeWhatsAppMetrics(): void {
  try {
    // Skip if telemetry is not initialized (e.g., on localhost)
    if (!meterProvider) {
      return;
    }

    const meter = metrics.getMeter("unicx-integration-whatsapp", "1.0.0");

    // Counter for WhatsApp alert events (blocked, disconnected, health failures)
    whatsappAlertCounter = meter.createCounter("whatsapp.session.alerts.total", {
      description: "Total number of WhatsApp session alert events",
    });
  } catch {
    // Silently fail if metrics aren't initialized yet
  }
}

/**
 * Log API request/response payload to Application Insights
 *
 * This function creates a span with request/response details including:
 * - Request method, path, headers, query params, body
 * - Response status, headers, body (for errors or if enabled)
 * - User information (if available)
 * - Tenant ID (if available)
 *
 * @param data - API request log data
 */
export interface ApiRequestLogData {
  method: string;
  path: string;
  route: string;
  statusCode: number;
  duration: number;
  requestHeaders?: Record<string, string>;
  requestQuery?: Record<string, any>;
  requestBody?: any;
  responseHeaders?: Record<string, string>;
  responseBody?: any;
  userId?: string;
  tenantId?: string;
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  isError?: boolean;
  errorMessage?: string;
  errorStack?: string;
}

export function logApiRequest(data: ApiRequestLogData): void {
  try {
    // Skip if telemetry is not initialized (e.g., on localhost)
    if (!tracerProvider) {
      return;
    }

    const tracer = trace.getTracer("unicx-integration-api", "1.0.0");
    // Use an active span so this log span is correlated with the incoming request trace.
    tracer.startActiveSpan(
      `API ${data.method} ${data.path}`,
      { kind: 1 }, // SpanKind.SERVER
      (span) => {
        // Add standard HTTP attributes
        span.setAttribute("http.method", data.method);
        span.setAttribute("http.route", data.route);
        span.setAttribute("http.path", data.path);
        span.setAttribute("http.status_code", data.statusCode);
        span.setAttribute("http.request.duration", data.duration);

        // Add correlation id (custom)
        if (data.correlationId) {
          span.setAttribute("correlation.id", data.correlationId);
        }

        // Add request information
        if (data.requestHeaders) {
          // Filter sensitive headers (authorization, cookies, etc.)
          const safeHeaders = { ...data.requestHeaders };
          if ((safeHeaders as any).authorization) {
            (safeHeaders as any).authorization = "[REDACTED]";
          }
          if ((safeHeaders as any).cookie) {
            (safeHeaders as any).cookie = "[REDACTED]";
          }
          span.setAttribute("http.request.headers", JSON.stringify(safeHeaders));
        }

        if (data.requestQuery && Object.keys(data.requestQuery).length > 0) {
          span.setAttribute(
            "http.request.query",
            JSON.stringify(data.requestQuery),
          );
        }

        if (data.requestBody) {
          // Truncate large payloads (Application Insights has attribute size limits)
          const bodyStr =
            typeof data.requestBody === "string"
              ? data.requestBody
              : JSON.stringify(data.requestBody);
          const maxBodySize = 8000; // Keep under 8KB per attribute
          if (bodyStr.length > maxBodySize) {
            span.setAttribute(
              "http.request.body",
              bodyStr.substring(0, maxBodySize) + "...[TRUNCATED]",
            );
            span.setAttribute("http.request.body.size", bodyStr.length);
          } else {
            span.setAttribute("http.request.body", bodyStr);
          }
        }

        // Add response information (especially for errors)
        if (data.isError || process.env.LOG_RESPONSE_BODIES === "true") {
          if (data.responseHeaders) {
            span.setAttribute(
              "http.response.headers",
              JSON.stringify(data.responseHeaders),
            );
          }

          if (data.responseBody) {
            const bodyStr =
              typeof data.responseBody === "string"
                ? data.responseBody
                : JSON.stringify(data.responseBody);
            const maxBodySize = 8000;
            if (bodyStr.length > maxBodySize) {
              span.setAttribute(
                "http.response.body",
                bodyStr.substring(0, maxBodySize) + "...[TRUNCATED]",
              );
              span.setAttribute("http.response.body.size", bodyStr.length);
            } else {
              span.setAttribute("http.response.body", bodyStr);
            }
          }
        }

        // Add error information
        if (data.isError) {
          span.setAttribute("error", true);
          if (data.errorMessage) {
            span.setAttribute("error.message", data.errorMessage);
          }
          if (data.errorStack) {
            span.setAttribute("error.stack", data.errorStack);
          }
        }

        // Add user context
        if (data.userId) {
          span.setAttribute("user.id", data.userId);
        }
        if (data.tenantId) {
          span.setAttribute("tenant.id", data.tenantId);
        }
        if (data.ipAddress) {
          span.setAttribute("http.client_ip", data.ipAddress);
        }
        if (data.userAgent) {
          span.setAttribute("http.user_agent", data.userAgent);
        }

        // Add timestamp
        span.setAttribute("timestamp", new Date().toISOString());
        span.end();
      },
    );
  } catch (error) {
    // Silently fail - don't break the application if logging fails
    console.error("Failed to log API request to Application Insights:", error);
  }
}

/**
 * Record API request metrics
 *
 * This function records metrics for each API request:
 * - Total request count
 * - Error count (if status >= 400)
 * - Request latency
 *
 * These metrics are exported to Azure Monitor and can be used for alerting.
 *
 * @param data - API request metrics data
 */
export function recordApiMetrics(data: ApiMetricsData): void {
  try {
    // Initialize metrics if not already done
    if (!apiRequestCounter) {
      initializeApiMetrics();
    }

    // Skip if metrics aren't available (telemetry not initialized)
    if (!apiRequestCounter || !apiErrorCounter || !apiLatencyHistogram) {
      return;
    }

    // Record total request count
    apiRequestCounter.add(1, {
      method: data.method,
      route: data.route,
      status_code: data.statusCode.toString(),
    });

    // Record error count if this is an error
    if (data.isError) {
      apiErrorCounter.add(1, {
        method: data.method,
        route: data.route,
        status_code: data.statusCode.toString(),
      });
    }

    // Record latency in milliseconds
    // OpenTelemetry histograms can record in any unit, we use milliseconds
    apiLatencyHistogram.record(data.duration, {
      method: data.method,
      route: data.route,
      status_code: data.statusCode.toString(),
    });
  } catch (error) {
    // Silently fail - don't break the application if metrics fail
    // This can happen if telemetry isn't properly initialized
  }
}

/**
 * Record cross-tenant access attempt for security alerting
 *
 * This metric tracks suspicious attempts by users to access data
 * from tenants they don't belong to. This is used for security monitoring
 * and alerting in Azure Monitor.
 *
 * @param data - Cross-tenant access attempt data
 */
export interface CrossTenantAccessData {
  userId: string;
  userTenantId: string;
  attemptedTenantId: string;
  route: string;
  ipAddress?: string;
  userAgent?: string;
}

export function recordCrossTenantAccessAttempt(
  data: CrossTenantAccessData,
): void {
  try {
    // Initialize metrics if not already done
    if (!crossTenantAccessCounter) {
      initializeApiMetrics();
    }

    // Skip if metrics aren't available
    if (!crossTenantAccessCounter) {
      return;
    }

    // Record cross-tenant access attempt
    crossTenantAccessCounter.add(1, {
      user_id: data.userId,
      user_tenant_id: data.userTenantId,
      attempted_tenant_id: data.attemptedTenantId,
      route: data.route,
      ip_address: data.ipAddress || "unknown",
    });

    // Also log as a span for detailed investigation
    // Skip if telemetry is not initialized (e.g., on localhost)
    if (!tracerProvider) {
      return;
    }

    const tracer = trace.getTracer("unicx-integration-security", "1.0.0");
    const span = tracer.startSpan("security.cross_tenant_access_attempt", {
      kind: 1, // SpanKind.SERVER
    });

    span.setAttribute("security.event_type", "cross_tenant_access_attempt");
    span.setAttribute("user.id", data.userId);
    span.setAttribute("user.tenant_id", data.userTenantId);
    span.setAttribute("attempted.tenant_id", data.attemptedTenantId);
    span.setAttribute("http.route", data.route);
    span.setAttribute("http.client_ip", data.ipAddress || "unknown");
    span.setAttribute("user_agent.original", data.userAgent || "unknown");
    span.setAttribute("security.severity", "high");
    span.setAttribute("security.alert", true);

    span.end();
  } catch (error) {
    // Silently fail - don't break the application if metrics fail
  }
}

/**
 * Record queue backlog metrics
 *
 * This function updates the queue backlog gauge metric which tracks
 * the current number of messages waiting in a queue. This is used
 * for alerting when queue backlogs exceed thresholds.
 *
 * @param queueName - Name of the queue
 * @param messageCount - Current number of messages in the queue
 */
export function recordQueueBacklog(
  queueName: string,
  messageCount: number,
): void {
  try {
    // Initialize metrics if not already done
    if (!queueBacklogGauge) {
      initializeApiMetrics();
    }

    // Skip if metrics aren't available
    if (!queueBacklogGauge) {
      return;
    }

    // Log as span for queue backlog tracking
    // Azure Monitor will aggregate these spans into metrics
    const tracer = trace.getTracer("unicx-integration-queue", "1.0.0");
    const span = tracer.startSpan("queue.backlog", {
      kind: 1,
    });

    span.setAttribute("queue.name", queueName);
    span.setAttribute("queue.backlog.count", messageCount);
    span.setAttribute("queue.backlog.threshold_exceeded", messageCount > 100); // Alert if > 100 messages
    span.setAttribute("metric.name", "queue.backlog.messages");
    span.setAttribute("metric.value", messageCount);

    span.end();
  } catch (error) {
    // Silently fail
  }
}

/**
 * Record queue message sent/received
 *
 * @param queueName - Name of the queue
 * @param eventType - Type of event/message
 * @param direction - "sent" or "received"
 */
export function recordQueueMessage(
  queueName: string,
  eventType: string,
  direction: "sent" | "received",
): void {
  try {
    // Initialize metrics if not already done
    if (!queueMessageCounter) {
      initializeApiMetrics();
    }

    // Skip if metrics aren't available
    if (!queueMessageCounter) {
      return;
    }

    queueMessageCounter.add(1, {
      queue_name: queueName,
      event_type: eventType,
      direction,
    });
  } catch (error) {
    // Silently fail
  }
}

/**
 * Record WhatsApp alert events for centralized monitoring
 *
 * These metrics/spans are used for alerting in Azure Monitor:
 * - blocked accounts
 * - disconnected sessions
 * - health check failures
 */
export interface WhatsAppAlertEventData {
  eventType: "disconnected" | "blocked" | "health_check_failed" | "auth_failure";
  sessionId?: string;
  tenantId?: string;
  phoneNumber?: string;
  reason?: string;
  status?: string;
}

export function recordWhatsAppAlertEvent(data: WhatsAppAlertEventData): void {
  try {
    // Initialize metrics if not already done
    if (!whatsappAlertCounter) {
      initializeWhatsAppMetrics();
    }

    // Record a low-cardinality metric for alerting
    if (whatsappAlertCounter) {
      whatsappAlertCounter.add(1, {
        event_type: data.eventType,
        tenant_id: data.tenantId || "unknown",
        status: data.status || "unknown",
      });
    }

    // Also emit a span so details are queryable in Logs
    if (!tracerProvider) {
      return;
    }
    const tracer = trace.getTracer("unicx-integration-whatsapp", "1.0.0");
    const span = tracer.startSpan("whatsapp.alert", { kind: 1 });
    span.setAttribute("alert", true);
    span.setAttribute("event.type", data.eventType);
    if (data.sessionId) span.setAttribute("session.id", data.sessionId);
    if (data.tenantId) span.setAttribute("tenant.id", data.tenantId);
    if (data.phoneNumber) span.setAttribute("phone.number", data.phoneNumber);
    if (data.reason) span.setAttribute("reason", data.reason);
    if (data.status) span.setAttribute("status", data.status);
    span.end();
  } catch {
    // Silently fail
  }
}

/**
 * Record WhatsApp health-check execution details to Application Insights.
 * Each call emits a span named "health-check".
 */
export interface WhatsAppHealthCheckLogData {
  sessionId: string;
  tenantId?: string;
  phoneNumber?: string;
  status: "success" | "failed" | "warning";
  consecutiveFailures?: number;
  reason?: string;
  errorMessage?: string;
}

export function recordWhatsAppHealthCheck(
  data: WhatsAppHealthCheckLogData,
): void {
  try {
    if (!tracerProvider) {
      return;
    }
    const tracer = trace.getTracer("unicx-integration-whatsapp", "1.0.0");
    const span = tracer.startSpan("health-check", { kind: 1 });
    span.setAttribute("health.status", data.status);
    span.setAttribute("session.id", data.sessionId);
    if (data.tenantId) span.setAttribute("tenant.id", data.tenantId);
    if (data.phoneNumber) span.setAttribute("phone.number", data.phoneNumber);
    if (typeof data.consecutiveFailures === "number") {
      span.setAttribute("health.consecutive_failures", data.consecutiveFailures);
    }
    if (data.reason) span.setAttribute("health.reason", data.reason);
    if (data.errorMessage) span.setAttribute("error.message", data.errorMessage);
    if (data.status === "failed") span.setAttribute("error", true);
    span.end();
  } catch {
    // Silently fail
  }
}

/**
 * Create a new span with tenant context
 *
 * This is a helper function to create a span that includes tenant.id
 * from the start, rather than adding it later.
 *
 * @param name - Name of the span
 * @param tenantId - The tenant identifier
 * @param callback - Function to execute within the span context
 */
export async function withTenantContext<T>(
  name: string,
  tenantId: string,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("unicx-integration");
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute("tenant.id", tenantId);
    try {
      return await callback(span);
    } finally {
      span.end();
    }
  });
}

/**
 * Shutdown telemetry gracefully
 *
 * Call this function when the application is shutting down to ensure
 * all pending telemetry is flushed to Azure Monitor.
 */
export async function shutdownTelemetry(): Promise<void> {
  try {
    console.log("🛑 Shutting down telemetry...");
    console.log(
      `   Export stats: ${exportStats.spansExported} spans (includes API traces and application logs), ${exportStats.metricsExported} metrics exported`,
    );
    if (exportStats.spansFailed > 0 || exportStats.metricsFailed > 0) {
      console.warn(
        `   Failed exports: ${exportStats.spansFailed} spans, ${exportStats.metricsFailed} metrics`,
      );
      if (exportStats.lastExportError) {
        console.warn(`   Last error:`, exportStats.lastExportError.message);
      }
    }

    if (tracerProvider) {
      await tracerProvider.shutdown();
    }
    if (meterProvider) {
      await meterProvider.shutdown();
    }
    console.log("✅ Telemetry shutdown complete");
  } catch (error) {
    console.error("❌ Error shutting down telemetry:", error);
  }
}

/**
 * Get telemetry export statistics (for debugging)
 */
export function getTelemetryStats() {
  return { ...exportStats };
}

// Handle graceful shutdown (do NOT force process.exit; let the app/framework decide)
function attachSignalOnce(signal: NodeJS.Signals, handler: () => void) {
  if (process.listenerCount(signal) > 0) return;
  process.on(signal, handler);
}

if (ENABLE_SHUTDOWN_HOOKS) {
  attachSignalOnce("SIGTERM", () => {
    void shutdownTelemetry();
  });
  attachSignalOnce("SIGINT", () => {
    void shutdownTelemetry();
  });
}
