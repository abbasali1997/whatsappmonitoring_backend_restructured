import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";

export type BulkUploadStatus = "queued" | "running" | "completed" | "failed";

export interface BulkUploadProgressPayload {
  jobId: string;
  status: BulkUploadStatus;
  total: number;
  processed: number;
  success: number;
  failed: number;
  errors?: any[];
  details?: any[];
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

interface SubscriptionPayload {
  jobId?: string;
}

@WebSocketGateway({
  namespace: "/bulk-upload",
  cors: {
    origin: "*",
    credentials: true,
  },
})
export class BulkUploadGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(BulkUploadGateway.name);
  private latestSnapshots: Map<string, BulkUploadProgressPayload> = new Map();

  @SubscribeMessage("subscribe")
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscriptionPayload,
  ) {
    const jobId = payload?.jobId?.trim();
    if (!jobId) {
      client.emit("bulk-upload:error", { message: "jobId is required" });
      return;
    }

    const room = this.getRoom(jobId);
    client.join(room);
    this.logger.debug(`Client ${client.id} subscribed to bulk upload ${jobId}`);
    client.emit("bulk-upload:subscribed", { jobId });

    const snapshot = this.latestSnapshots.get(jobId);
    if (snapshot) {
      client.emit("bulk-upload:progress", snapshot);
    }
  }

  @SubscribeMessage("unsubscribe")
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscriptionPayload,
  ) {
    const jobId = payload?.jobId?.trim();
    if (!jobId) {
      return;
    }

    const room = this.getRoom(jobId);
    client.leave(room);
    this.logger.debug(
      `Client ${client.id} unsubscribed from bulk upload ${jobId}`,
    );
  }

  emitProgress(jobId: string, payload: BulkUploadProgressPayload) {
    this.latestSnapshots.set(jobId, payload);
    this.server?.to(this.getRoom(jobId)).emit("bulk-upload:progress", payload);
  }

  emitError(jobId: string, message: string) {
    this.server
      ?.to(this.getRoom(jobId))
      .emit("bulk-upload:error", { jobId, message });
  }

  private getRoom(jobId: string) {
    return `bulk-upload:${jobId}`;
  }
}
