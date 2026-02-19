import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Inject, Logger, forwardRef } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  WhatsAppSession,
  WhatsAppSessionDocument,
  SessionStatus,
} from "../../common/schemas/whatsapp-session.schema";
import { WhatsAppService } from "./whatsapp.service";

interface SubscriptionPayload {
  sessionId?: string;
}

@WebSocketGateway({
  namespace: "/qr",
  cors: {
    origin: "*",
    credentials: true,
  },
})
export class QrGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(QrGateway.name);

  // Track which sessions each WebSocket client is subscribed to, so we can
  // detect when there are no more QR subscribers for a session.
  private clientSessions: Map<string, Set<string>> = new Map();
  // Delayed close timers per session so we don't immediately close browsers
  // when the last QR socket disconnects.
  private sessionCloseTimers: Map<string, NodeJS.Timeout> = new Map();
  // How long to keep a non-connected browser alive after the last QR socket
  // disconnects before closing it (default: 60 seconds)
  private readonly qrIdleCloseDelayMs =
    Number(process.env.WHATSAPP_QR_IDLE_CLOSE_DELAY_MS) || 30000;

  constructor(
    @InjectModel(WhatsAppSession.name)
    private readonly sessionModel: Model<WhatsAppSessionDocument>,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsappService: WhatsAppService,
  ) {}

  handleConnection(client: Socket) {
    const totalClients = this.server?.engine?.clientsCount;
    const totalMessage =
      typeof totalClients === "number"
        ? `Client connected: ${client.id} (total: ${totalClients})`
        : `Client connected: ${client.id}`;
    this.logger.debug(totalMessage);
  }

  handleDisconnect(client: Socket) {
    const totalClients = this.server?.engine?.clientsCount;
    const totalMessage =
      typeof totalClients === "number"
        ? `Client disconnected: ${client.id} (total: ${totalClients})`
        : `Client disconnected: ${client.id}`;
    this.logger.debug(totalMessage);

    // On disconnect, check all sessions this client was subscribed to and see
    // if any of them no longer have QR subscribers. For sessions that are not
    // connected (READY/AUTHENTICATED), we can safely close the browser to save
    // memory.
    const sessions = this.clientSessions.get(client.id);
    if (sessions && sessions.size > 0) {
      for (const sessionId of sessions) {
        this.maybeCloseIdleSession(sessionId).catch((error) => {
          this.logger.warn(
            `[QR] Failed to maybeCloseIdleSession for ${sessionId} on disconnect: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      this.clientSessions.delete(client.id);
    }
  }

  @SubscribeMessage("subscribe")
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscriptionPayload,
  ) {
    const sessionId = this.normalizeSessionId(payload?.sessionId);
    if (!sessionId) {
      client.emit("qr.status", {
        status: "error",
        message: "sessionId is required",
      });
      return;
    }

    const room = this.getRoomName(sessionId);
    client.join(room);
    this.logger.debug(`Client ${client.id} subscribed to ${room}`);

    // Track subscription for this client
    let sessions = this.clientSessions.get(client.id);
    if (!sessions) {
      sessions = new Set();
      this.clientSessions.set(client.id, sessions);
    }
    sessions.add(sessionId);

    // A new subscriber arrived for this session; cancel any pending delayed
    // close so the browser stays alive while the user is viewing the QR.
    const existingTimer = this.sessionCloseTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.sessionCloseTimers.delete(sessionId);
      this.logger.debug(
        `[QR] Cancelled pending idle close timer for session ${sessionId} due to new subscription`,
      );
    }

    client.emit("qr.status", {
      sessionId,
      status: "subscribed",
    });

    await this.emitExistingSnapshot(client, sessionId);
  }

  @SubscribeMessage("unsubscribe")
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscriptionPayload,
  ) {
    const sessionId = this.normalizeSessionId(payload?.sessionId);
    if (!sessionId) {
      return;
    }

    const room = this.getRoomName(sessionId);
    client.leave(room);
    this.logger.debug(`Client ${client.id} unsubscribed from ${room}`);

    // Update tracking map
    const sessions = this.clientSessions.get(client.id);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.clientSessions.delete(client.id);
      }
    }

    // If there are no more QR subscribers for this session and the WhatsApp
    // client is not connected, schedule a delayed close to save memory.
    this.maybeCloseIdleSession(sessionId).catch((error) => {
      this.logger.warn(
        `[QR] Failed to maybeCloseIdleSession for ${sessionId} on unsubscribe: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  emitQrUpdate(
    sessionId: string,
    payload: { qrCode: string; expiresAt: Date | null },
  ) {
    const normalizedId = this.normalizeSessionId(sessionId);
    if (!normalizedId) {
      return;
    }
    const room = this.getRoomName(normalizedId);
    this.server?.to(room).emit("qr.update", {
      sessionId: normalizedId,
      ...payload,
    });
  }

  emitStatus(
    sessionId: string,
    payload: { status: string; message?: string },
  ) {
    const normalizedId = this.normalizeSessionId(sessionId);
    if (!normalizedId) {
      return;
    }
    const room = this.getRoomName(normalizedId);
    this.server?.to(room).emit("qr.status", {
      sessionId: normalizedId,
      ...payload,
    });
  }

  private async emitExistingSnapshot(client: Socket, sessionId: string) {
    try {
      const session = await this.sessionModel
        .findOne({ sessionId })
        .select("qrCode qrCodeExpiresAt status")
        .lean();

      if (!session) {
        return;
      }

      if (session.status) {
        client.emit("qr.status", {
          sessionId,
          status: session.status,
        });
      }

      if (session.qrCode) {
        client.emit("qr.update", {
          sessionId,
          qrCode: session.qrCode,
          expiresAt: session.qrCodeExpiresAt ?? null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Failed to emit existing snapshot for ${sessionId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private getRoomName(sessionId: string): string {
    return `qr:${sessionId}`;
  }

  private normalizeSessionId(sessionId?: string): string | null {
    if (!sessionId || typeof sessionId !== "string") {
      return null;
    }
    return sessionId.trim();
  }

  /**
   * If no WebSocket clients are subscribed to QR updates for this session and
   * the session is not in a connected state (READY or AUTHENTICATED), close
   * the underlying WhatsApp/Puppeteer client to free memory. The session
   * status in the database is preserved so higher-level logic can decide how
   * to handle reconnection later.
   */
  private async maybeCloseIdleSession(sessionId: string): Promise<void> {
    const normalizedId = this.normalizeSessionId(sessionId);
    if (!normalizedId || !this.server) {
      return;
    }

    const room = this.getRoomName(normalizedId);
    // Check if there are still any sockets in this room
    const sockets =
      (await this.server.in(room).allSockets().catch(() => undefined)) ||
      undefined;

    if (sockets && sockets.size > 0) {
      // There are still clients listening for QR updates; keep the browser open
      return;
    }

    // If a close timer is already scheduled for this session, don't schedule
    // another one.
    if (this.sessionCloseTimers.has(normalizedId)) {
      return;
    }

    this.logger.debug(
      `[QR] Scheduling idle close for session ${normalizedId} in ${this.qrIdleCloseDelayMs}ms (no active QR subscribers)`,
    );

    const timer = setTimeout(async () => {
      this.sessionCloseTimers.delete(normalizedId);

      try {
        // Re-check sockets; the user may have reopened the QR screen
        const currentSockets =
          (await this.server.in(room).allSockets().catch(() => undefined)) ||
          undefined;
        if (currentSockets && currentSockets.size > 0) {
          this.logger.debug(
            `[QR] Skipping idle close for session ${normalizedId}; subscribers returned`,
          );
          return;
        }

        // No more QR subscribers for this session. Only close if the WhatsApp
        // session is not connected.
        const session = await this.sessionModel
          .findOne({ sessionId: normalizedId })
          .select("status lastActivityAt")
          .lean();

        if (!session) {
          return;
        }

        if (
          session.status === SessionStatus.READY ||
          session.status === SessionStatus.AUTHENTICATED
        ) {
          // Connected sessions should not be closed here.
          return;
        }

        // Skip closing if WhatsApp service reports cleanup/init in progress
        if (this.whatsappService?.isInitializing?.(normalizedId)) {
          this.logger.debug(
            `[QR] Skipping idle close for ${normalizedId}; initialization in progress`,
          );
          return;
        }
        if (this.whatsappService?.isCleanupInProgress?.(normalizedId)) {
          this.logger.debug(
            `[QR] Skipping idle close for ${normalizedId}; cleanup in progress`,
          );
          return;
        }

        this.logger.log(
          `[QR] Idle timeout reached with no QR subscribers; closing non-connected WhatsApp client for session ${normalizedId} (status=${session.status}, lastActivityAt=${session.lastActivityAt})`,
        );

        await this.whatsappService.disconnectSession(normalizedId, {
          preserveStatus: true,
        });
      } catch (error) {
        this.logger.warn(
          `[QR] Failed to close non-connected WhatsApp client for session ${normalizedId} after idle timeout: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, this.qrIdleCloseDelayMs);

    this.sessionCloseTimers.set(normalizedId, timer);
  }
}

