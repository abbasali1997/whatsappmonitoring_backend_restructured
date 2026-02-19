import {
  initTelemetry,
  shutdownTelemetry,
  generateTestSpan,
  generateTestMetrics,
  getTelemetryStats,
} from "./telemetry";
import * as process from "process";

// Mock OpenTelemetry modules
jest.mock("@azure/monitor-opentelemetry-exporter", () => ({
  AzureMonitorTraceExporter: jest.fn().mockImplementation(() => ({
    export: jest.fn(),
    shutdown: jest.fn(),
  })),
  AzureMonitorMetricExporter: jest.fn().mockImplementation(() => ({
    export: jest.fn(),
    shutdown: jest.fn(),
    forceFlush: jest.fn(),
  })),
  ApplicationInsightsSampler: jest.fn().mockImplementation(() => ({
    shouldSample: jest.fn().mockReturnValue({ decision: 1 }),
  })),
}));

jest.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: jest.fn().mockImplementation(() => ({
    addSpanProcessor: jest.fn(),
    register: jest.fn(),
    shutdown: jest.fn(),
  })),
  BatchSpanProcessor: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn(),
  })),
}));

jest.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn(),
  })),
  PeriodicExportingMetricReader: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn(),
  })),
}));

jest.mock("@opentelemetry/sdk-trace-base", () => ({
  ConsoleSpanExporter: jest.fn().mockImplementation(() => ({
    export: jest.fn(),
  })),
}));

jest.mock("@opentelemetry/resources", () => ({
  Resource: {
    default: jest.fn().mockReturnValue({}),
  },
}));

jest.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: jest.fn(),
}));

jest.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: jest.fn().mockReturnValue([]),
}));

describe("Telemetry", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env vars by deleting and re-adding
    Object.keys(process.env).forEach((key) => {
      delete (process.env as any)[key];
    });
    Object.assign(process.env, originalEnv);
  });

  afterEach(() => {
    // Reset env vars
    Object.keys(process.env).forEach((key) => {
      delete (process.env as any)[key];
    });
    Object.assign(process.env, originalEnv);
    jest.restoreAllMocks();
  });

  describe("initTelemetry", () => {
    it("should initialize telemetry with valid connection string", () => {
      const connectionString =
        "InstrumentationKey=test-key;IngestionEndpoint=https://test.endpoint/";

      expect(() => {
        initTelemetry(connectionString, "Test Service", "1.0.0", 1.0, false);
      }).not.toThrow();
    });

    it("should not initialize telemetry without connection string", () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      initTelemetry(undefined);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Azure Monitor connection string not provided"),
      );

      consoleSpy.mockRestore();
    });

    it("should not initialize telemetry with invalid connection string", () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      const invalidConnectionString = "invalid-connection-string";

      initTelemetry(invalidConnectionString);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Invalid Azure Monitor connection string format",
        ),
      );

      consoleErrorSpy.mockRestore();
    });

    it("should initialize with custom service name and version", () => {
      const connectionString =
        "InstrumentationKey=test-key;IngestionEndpoint=https://test.endpoint/";
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      initTelemetry(connectionString, "Custom Service", "2.0.0", 1.0, false);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Custom Service v2.0.0"),
      );

      consoleLogSpy.mockRestore();
    });

    it("should enable console exporter when OTEL_CONSOLE_EXPORTER is true", () => {
      process.env.OTEL_CONSOLE_EXPORTER = "true";
      const connectionString =
        "InstrumentationKey=test-key;IngestionEndpoint=https://test.endpoint/";

      expect(() => {
        initTelemetry(connectionString, "Test Service", "1.0.0", 1.0, false);
      }).not.toThrow();
    });
  });

  describe("shutdownTelemetry", () => {
    it("should shutdown telemetry gracefully", async () => {
      const connectionString =
        "InstrumentationKey=test-key;IngestionEndpoint=https://test.endpoint/";
      initTelemetry(connectionString);

      await expect(shutdownTelemetry()).resolves.not.toThrow();
    });

    it("should handle shutdown when telemetry not initialized", async () => {
      await expect(shutdownTelemetry()).resolves.not.toThrow();
    });
  });

  describe("generateTestSpan", () => {
    it("should generate a test span", () => {
      const connectionString =
        "InstrumentationKey=test-key;IngestionEndpoint=https://test.endpoint/";
      initTelemetry(connectionString);

      expect(() => {
        generateTestSpan();
      }).not.toThrow();
    });
  });

  describe("generateTestMetrics", () => {
    it("should generate test metrics", () => {
      const connectionString =
        "InstrumentationKey=test-key;IngestionEndpoint=https://test.endpoint/";
      initTelemetry(connectionString);

      expect(() => {
        generateTestMetrics();
      }).not.toThrow();
    });
  });

  describe("getTelemetryStats", () => {
    it("should return telemetry statistics", () => {
      const stats = getTelemetryStats();

      expect(stats).toHaveProperty("spansExported");
      expect(stats).toHaveProperty("spansFailed");
      expect(stats).toHaveProperty("metricsExported");
      expect(stats).toHaveProperty("metricsFailed");
    });
  });
});
