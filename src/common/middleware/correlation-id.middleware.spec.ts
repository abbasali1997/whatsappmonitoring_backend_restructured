import type { Request, Response } from "express";

// Mock crypto.randomUUID (the middleware imports it directly)
jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => "generated-uuid"),
}));

// Mock OpenTelemetry APIs so we can assert calls without needing a full OTel SDK setup
const setAttributeMock = jest.fn();
const startSpanCtx: any = { _ctx: "active" };
const ctxWithBaggage: any = { _ctx: "with-baggage" };

jest.mock("@opentelemetry/api", () => ({
  context: {
    active: jest.fn(() => startSpanCtx),
    with: jest.fn((ctx: any, fn: any) => fn()),
  },
  propagation: {
    createBaggage: jest.fn((entries: any) => ({ entries })),
    setBaggage: jest.fn(() => ctxWithBaggage),
    getBaggage: jest.fn(() => undefined),
  },
  trace: {
    getSpan: jest.fn(() => ({ setAttribute: setAttributeMock })),
  },
}));

import { correlationIdMiddleware } from "./correlation-id.middleware";
import { randomUUID } from "crypto";
import { context, propagation, trace } from "@opentelemetry/api";

describe("correlationIdMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makeRes = () =>
    ({
      setHeader: jest.fn(),
    }) as any as Response;

  it("uses incoming X-Correlation-Id header and echoes it back", () => {
    const req = {
      headers: { "x-correlation-id": "abc-123" },
    } as any as Request & { correlationId?: string };
    const res = makeRes();
    const next = jest.fn();

    correlationIdMiddleware(req as any, res, next);

    expect(req.correlationId).toBe("abc-123");
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", "abc-123");
    expect(next).toHaveBeenCalledTimes(1);
    expect(randomUUID).not.toHaveBeenCalled();

    // baggage + span attribute
    expect(propagation.createBaggage).toHaveBeenCalledWith({
      correlationId: { value: "abc-123" },
    });
    expect(trace.getSpan).toHaveBeenCalledWith(startSpanCtx);
    expect(setAttributeMock).toHaveBeenCalledWith("correlation.id", "abc-123");
    expect(context.with).toHaveBeenCalled();
  });

  it("uses first value when X-Correlation-Id header is an array", () => {
    const req = {
      headers: { "x-correlation-id": ["first", "second"] },
    } as any as Request & { correlationId?: string };
    const res = makeRes();
    const next = jest.fn();

    correlationIdMiddleware(req as any, res, next);

    expect(req.correlationId).toBe("first");
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", "first");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("generates a UUID when header is missing or blank", () => {
    const req = {
      headers: {},
    } as any as Request & { correlationId?: string };
    const res = makeRes();
    const next = jest.fn();

    correlationIdMiddleware(req as any, res, next);

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(req.correlationId).toBe("generated-uuid");
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Correlation-Id",
      "generated-uuid",
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});


