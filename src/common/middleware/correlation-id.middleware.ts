import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { context, propagation, trace } from "@opentelemetry/api";

/**
 * Ensure every request has a correlation id.
 *
 * - Reads from `X-Correlation-Id` (case-insensitive) if provided
 * - Otherwise generates a UUID
 * - Exposes it on `req.correlationId`
 * - Echoes it back in response header `X-Correlation-Id`
 * - Adds it to the active OpenTelemetry context as baggage (`correlationId`)
 *   so downstream spans/logs can pick it up.
 */
export function correlationIdMiddleware(
  req: Request & { correlationId?: string },
  res: Response,
  next: NextFunction,
) {
  const headerValue =
    (req.headers["x-correlation-id"] as string | string[] | undefined) ||
    (req.headers["x-correlationid"] as string | string[] | undefined);

  const incoming =
    Array.isArray(headerValue) ? headerValue[0] : headerValue;

  const correlationId = (incoming && String(incoming).trim()) || randomUUID();
  req.correlationId = correlationId;

  // Echo back so clients can always capture it
  res.setHeader("X-Correlation-Id", correlationId);

  // Put correlationId into baggage for easy propagation
  const activeCtx = context.active();
  const baggage = propagation.createBaggage({
    correlationId: { value: correlationId },
  });
  const ctxWithBaggage = propagation.setBaggage(activeCtx, baggage);

  // Also set as attribute on the current active span (if any)
  const span = trace.getSpan(activeCtx);
  if (span) {
    span.setAttribute("correlation.id", correlationId);
  }

  // Ensure the rest of the pipeline runs with baggage attached
  return context.with(ctxWithBaggage, () => next());
}


