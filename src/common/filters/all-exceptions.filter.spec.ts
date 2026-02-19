import { HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { Request, Response } from "express";
import { AllExceptionsFilter } from "./all-exceptions.filter";

describe("AllExceptionsFilter", () => {
  const makeRes = (overrides?: Partial<Response> & { headersSent?: boolean }) =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      headersSent: false,
      ...overrides,
    }) as any as Response;

  const makeReq = (
    overrides?: Partial<Request & { correlationId?: string }>,
  ): Request & { correlationId?: string } =>
    ({
      headers: {},
      url: "/test",
      originalUrl: "/test",
      method: "GET",
      ...overrides,
    }) as any;

  const makeHost = (
    req: Request & { correlationId?: string },
    res: Response,
  ): ArgumentsHost =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    }) as any;

  const makeFilter = () => {
    const filter = new AllExceptionsFilter();
    (filter as any).logger = {
      error: jest.fn(),
      warn: jest.fn(),
    };
    return filter as AllExceptionsFilter;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("handles HttpException with string response and logs warn for <500", () => {
    const filter = makeFilter();
    const req = makeReq({ correlationId: "cid-1" });
    const res = makeRes();
    const host = makeHost(req, res);
    const ex = new HttpException("Bad request", HttpStatus.BAD_REQUEST);

    filter.catch(ex, host);

    expect((filter as any).logger.warn).toHaveBeenCalledTimes(1);
    expect((filter as any).logger.error).not.toHaveBeenCalled();
    expect((res as any).status).toHaveBeenCalledWith(400);
    expect((res as any).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "Bad request",
        correlationId: "cid-1",
        path: "/test",
        method: "GET",
        timestamp: expect.any(String),
      }),
    );
  });

  it("handles HttpException with object response message", () => {
    const filter = makeFilter();
    const req = makeReq({
      headers: { "x-correlation-id": "cid-2" },
      correlationId: undefined,
    });
    const res = makeRes();
    const host = makeHost(req, res);
    const ex = new HttpException({ message: "Unauthorized" }, 401);

    filter.catch(ex, host);

    expect((filter as any).logger.warn).toHaveBeenCalledTimes(1);
    expect((res as any).status).toHaveBeenCalledWith(401);
    expect((res as any).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 401,
        message: "Unauthorized",
        correlationId: "cid-2",
      }),
    );
  });

  it("handles non-Http errors as 500 and logs error", () => {
    const filter = makeFilter();
    const req = makeReq({
      headers: { "x-correlationid": "cid-3" },
      correlationId: undefined,
    });
    const res = makeRes();
    const host = makeHost(req, res);
    const ex = new Error("Boom");

    filter.catch(ex, host);

    expect((filter as any).logger.error).toHaveBeenCalledTimes(1);
    expect((filter as any).logger.warn).not.toHaveBeenCalled();
    expect((res as any).status).toHaveBeenCalledWith(500);
    expect((res as any).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: "Boom",
        correlationId: "cid-3",
      }),
    );
  });

  it("falls back to a safe default message when no message exists", () => {
    const filter = makeFilter();
    const req = makeReq({ correlationId: "cid-4" });
    const res = makeRes();
    const host = makeHost(req, res);

    filter.catch({ notAnError: true } as any, host);

    expect((res as any).status).toHaveBeenCalledWith(500);
    expect((res as any).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: "Internal server error",
        correlationId: "cid-4",
      }),
    );
  });

  it("does not write a response if headers have already been sent", () => {
    const filter = makeFilter();
    const req = makeReq({ correlationId: "cid-5" });
    const res = makeRes({ headersSent: true });
    const host = makeHost(req, res);
    const ex = new Error("Boom");

    filter.catch(ex, host);

    expect((filter as any).logger.error).toHaveBeenCalledTimes(1);
    expect((res as any).status).not.toHaveBeenCalled();
    expect((res as any).json).not.toHaveBeenCalled();
  });

  it("never throws if the filter itself fails", () => {
    const filter = makeFilter();
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const host = {
      switchToHttp: () => {
        throw new Error("Host failure");
      },
    } as any as ArgumentsHost;

    expect(() => filter.catch(new Error("Boom"), host)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});


