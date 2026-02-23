import { WhatsAppService } from "./whatsapp.service";
import { SessionStatus } from "../../common/schemas/whatsapp-session.schema";

describe("WhatsAppService.disconnectSession", () => {
  it("should NOT cleanup session files by default (prevents wiping auth on restart)", async () => {
    const mockSessionModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ userId: "user-1" }),
        }),
      }),
      updateOne: jest.fn().mockResolvedValue(undefined),
    } as any;
    const mockUserModel = {
      findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
    } as any;

    const svc = new (WhatsAppService as any)(
      {} as any, // mongooseConnection
      mockSessionModel,
      {} as any, // messageModel
      mockUserModel,
      { get: jest.fn() } as any, // configService
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as WhatsAppService;

    const cleanupSpy = jest
      .spyOn(svc as any, "cleanupSessionFilesForSession")
      .mockResolvedValue(true);
    const killSpy = jest
      .spyOn(svc as any, "killProcessTree")
      .mockResolvedValue(undefined);

    // Attach a fake client
    const fakeClient: any = {
      removeAllListeners: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      pupBrowser: { process: () => ({ pid: 1234 }) },
    };
    (svc as any).clients.set("s1", fakeClient);

    await svc.disconnectSession("s1");

    expect(fakeClient.destroy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(1234);
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { sessionId: "s1" },
      expect.objectContaining({
        status: SessionStatus.DISCONNECTED,
      }),
      { new: true },
    );
  });

  it("should cleanup session files only when cleanupSessionFiles=true", async () => {
    const mockSessionModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ userId: null }),
        }),
      }),
      updateOne: jest.fn().mockResolvedValue(undefined),
    } as any;

    const svc = new (WhatsAppService as any)(
      {} as any,
      mockSessionModel,
      {} as any,
      { findByIdAndUpdate: jest.fn() } as any,
      { get: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as WhatsAppService;

    const cleanupSpy = jest
      .spyOn(svc as any, "cleanupSessionFilesForSession")
      .mockResolvedValue(true);

    const fakeClient: any = {
      removeAllListeners: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      pupBrowser: { process: () => ({ pid: 5678 }) },
    };
    (svc as any).clients.set("s2", fakeClient);

    await svc.disconnectSession("s2", { cleanupSessionFiles: true });

    expect(cleanupSpy).toHaveBeenCalledWith("s2");
  });
});
