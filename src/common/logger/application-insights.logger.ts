/**
 * Application Insights Logger for NestJS
 *
 * This custom logger sends all NestJS application logs to Azure Application Insights
 * using OpenTelemetry traces. Each log entry is sent as a trace with log-specific attributes.
 *
 * Features:
 * - Captures all log levels (log, error, warn, debug, verbose)
 * - Includes context information (service name, module name)
 * - Sends logs as traces to Application Insights
 * - Maintains console output for local development
 * - Supports log correlation with traces
 */

import { LoggerService } from "@nestjs/common";
import { context, propagation, trace } from "@opentelemetry/api";

export class ApplicationInsightsLogger implements LoggerService {
  private readonly tracer = trace.getTracer("unicx-integration-logs", "1.0.0");
  private context?: string;
  private logToConsole: boolean;

  constructor(context?: string, logToConsole: boolean = true) {
    this.context = context;
    this.logToConsole = logToConsole;
  }

  /**
   * Set the context for this logger instance
   */
  setContext(context: string) {
    this.context = context;
  }

  /**
   * Log a message at the specified level
   */
  private logToApplicationInsights(
    level: string,
    message: any,
    ...optionalParams: any[]
  ): void {
    try {
      // Skip if telemetry is not initialized (e.g., on localhost)
      // The tracer might be a no-op tracer, but we check anyway for safety
      if (!this.tracer) {
        return;
      }

      // Use an active span so log entries correlate with the request trace.
      this.tracer.startActiveSpan(`Log: ${level}`, { kind: 0 }, (span) => {
        // Add log attributes
        span.setAttribute("log.level", level);
        span.setAttribute(
          "log.message",
          this.formatMessage(message, optionalParams),
        );

        if (this.context) {
          span.setAttribute("log.context", this.context);
        }

        // Add severity level for Application Insights
        const severityLevel = this.mapLogLevelToSeverity(level);
        span.setAttribute("severity", severityLevel);

        // Add timestamp
        span.setAttribute("timestamp", new Date().toISOString());

        // Add correlation id from baggage (if present)
        try {
          const bag = propagation.getBaggage(context.active());
          const cid = bag?.getEntry("correlationId")?.value;
          if (cid) {
            span.setAttribute("correlation.id", cid);
          }
        } catch {
          // ignore
        }

        // Add optional parameters as attributes if they exist
        if (optionalParams && optionalParams.length > 0) {
          optionalParams.forEach((param, index) => {
            try {
              if (typeof param === "object" && param !== null) {
                // For objects, stringify and add as attribute
                const paramStr = JSON.stringify(param);
                if (paramStr.length < 8000) {
                  span.setAttribute(`log.param.${index}`, paramStr);
                } else {
                  span.setAttribute(
                    `log.param.${index}`,
                    paramStr.substring(0, 8000) + "...[TRUNCATED]",
                  );
                }
              } else {
                span.setAttribute(`log.param.${index}`, String(param));
              }
            } catch (e) {
              // Skip if we can't serialize
            }
          });
        }

        // Mark span as error if it's an error level
        if (level === "error") {
          span.setAttribute("error", true);
          span.recordException(
            new Error(this.formatMessage(message, optionalParams)),
          );
        }

        span.end();
      });
      // Note: Logs are sent as spans, so they're tracked in spansExported count
    } catch (error) {
      // Silently fail - don't break the application if logging fails
      if (this.logToConsole) {
        console.error("Failed to send log to Application Insights:", error);
      }
    }
  }

  /**
   * Format message and optional parameters into a single string
   */
  private formatMessage(message: any, optionalParams: any[]): string {
    let formatted = String(message);
    if (optionalParams && optionalParams.length > 0) {
      formatted +=
        " " +
        optionalParams
          .map((p) => {
            if (typeof p === "object") {
              try {
                return JSON.stringify(p);
              } catch {
                return String(p);
              }
            }
            return String(p);
          })
          .join(" ");
    }
    return formatted;
  }

  /**
   * Map NestJS log level to Application Insights severity level
   */
  private mapLogLevelToSeverity(level: string): string {
    switch (level.toLowerCase()) {
      case "error":
        return "Error";
      case "warn":
        return "Warning";
      case "log":
        return "Information";
      case "debug":
        return "Verbose";
      case "verbose":
        return "Verbose";
      default:
        return "Information";
    }
  }

  /**
   * Log a message
   */
  log(message: any, ...optionalParams: any[]): void {
    if (this.logToConsole) {
      console.log(
        `[${this.context || "Application"}]`,
        message,
        ...optionalParams,
      );
    }
    this.logToApplicationInsights("log", message, ...optionalParams);
  }

  /**
   * Log an error
   */
  error(message: any, trace?: string, context?: string): void {
    const errorContext = context || this.context || "Application";
    if (this.logToConsole) {
      console.error(`[${errorContext}]`, message, trace || "");
    }
    this.logToApplicationInsights("error", message, trace || "");
  }

  /**
   * Log a warning
   */
  warn(message: any, ...optionalParams: any[]): void {
    if (this.logToConsole) {
      console.warn(
        `[${this.context || "Application"}]`,
        message,
        ...optionalParams,
      );
    }
    this.logToApplicationInsights("warn", message, ...optionalParams);
  }

  /**
   * Log a debug message
   */
  debug(message: any, ...optionalParams: any[]): void {
    if (this.logToConsole) {
      console.debug(
        `[${this.context || "Application"}]`,
        message,
        ...optionalParams,
      );
    }
    this.logToApplicationInsights("debug", message, ...optionalParams);
  }

  /**
   * Log a verbose message
   */
  verbose(message: any, ...optionalParams: any[]): void {
    if (this.logToConsole) {
      console.log(
        `[${this.context || "Application"}] [VERBOSE]`,
        message,
        ...optionalParams,
      );
    }
    this.logToApplicationInsights("verbose", message, ...optionalParams);
  }
}
