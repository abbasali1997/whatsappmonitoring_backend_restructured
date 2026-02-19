import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export type MessageDocument = Message & Document;

export enum MessageType {
  TEXT = "text",
  IMAGE = "image",
  VIDEO = "video",
  AUDIO = "audio",
  DOCUMENT = "document",
  LOCATION = "location",
  CONTACT = "contact",
  STICKER = "sticker",
  CALL = "call",
}

export enum MessageStatus {
  PENDING = "pending",
  SENT = "sent",
  DELIVERED = "delivered",
  READ = "read",
  FAILED = "failed",
}

export enum MessageDirection {
  INBOUND = "inbound",
  OUTBOUND = "outbound",
}

@Schema({ timestamps: true })
export class Message {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  // WhatsApp Message ID
  @Prop({ required: true })
  whatsappMessageId: string;

  // Participant Information
  @Prop({ required: true })
  from: string; // Raw phone number from WhatsApp

  @Prop({ required: true })
  to: string; // Raw phone number from WhatsApp

  @Prop({ required: true })
  fromPhoneNumber: string; // Cleaned E164 format

  @Prop({ required: true })
  toPhoneNumber: string; // Cleaned E164 format

  // WhatsApp Contact Names and Avatars
  @Prop({ type: String })
  fromName: string; // WhatsApp account name or group name (not ID nor phone)

  @Prop({ type: String })
  toName: string; // WhatsApp account name or group name (not ID nor phone)

  @Prop({ type: String })
  fromAvatarUrl: string; // WhatsApp account avatar URL

  @Prop({ type: String })
  toAvatarUrl: string; // WhatsApp account avatar URL

  // Message Content
  @Prop({ required: true, enum: MessageType })
  type: MessageType;

  @Prop({ required: true, enum: MessageDirection })
  direction: MessageDirection;

  @Prop({ type: String })
  content: string; // Text content or caption

  @Prop({ type: String })
  mediaUrl: string; // URL to media file if applicable

  @Prop({ type: String })
  thumbnailUrl: string; // Thumbnail for media

  @Prop({ type: Object })
  metadata: Record<string, any>; // Additional metadata

  // Status Tracking
  @Prop({ required: true, enum: MessageStatus, default: MessageStatus.PENDING })
  status: MessageStatus;

  @Prop()
  sentAt: Date;

  @Prop()
  deliveredAt: Date;

  @Prop()
  readAt: Date;

  @Prop()
  failedAt: Date;

  @Prop()
  failureReason: string;

  // Conversation Tracking
  @Prop({ type: String })
  conversationId: string; // Group messages by conversation

  @Prop({ type: Types.ObjectId, ref: "Message" })
  replyToMessageId: Types.ObjectId; // If this is a reply

  @Prop({ type: Object })
  replyToMessage?: {
    id: Types.ObjectId;
    content: string;
    type: MessageType;
    mediaUrl?: string;
    from: string;
    senderName: string;
  }; // Populated reply message details

  // Campaign Tracking
  @Prop({ type: Types.ObjectId, ref: "Campaign" })
  campaignId: Types.ObjectId;

  @Prop({ type: String })
  templateName: string; // If sent via template

  // Entity & Tenant
  @Prop({ type: Types.ObjectId, ref: "Entity", required: true })
  entityId: Types.ObjectId;

  @Prop({ type: [Types.ObjectId], default: [] })
  entityIdPath: Types.ObjectId[]; // Array of entity IDs representing the path from root to leaf

  @Prop({ type: Types.ObjectId, ref: "Entity", required: true })
  tenantId: Types.ObjectId;

  // External Number Detection
  @Prop({ default: false })
  isExternalNumber: boolean; // True if sender is not a registered user

  @Prop({ type: String })
  whatsappUsername: string; // WhatsApp username/display name

  @Prop({ type: String })
  whatsappGroupName: string; // Group name if message is from a group

  @Prop({ default: false })
  isGroupMessage: boolean; // True if message is from a group

  // Flags
  @Prop({ default: false })
  isStarred: boolean;

  @Prop({ default: false })
  isArchived: boolean;

  @Prop({ default: true })
  isActive: boolean;

  // Audit
  @Prop()
  createdBy: string;

  @Prop()
  updatedBy: string;

  @Prop()
  createdAt: Date;

  @Prop()
  updatedAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Indexes for performance
MessageSchema.index({ whatsappMessageId: 1 });
MessageSchema.index({ fromPhoneNumber: 1, toPhoneNumber: 1 });
MessageSchema.index({ from: 1, to: 1 });
MessageSchema.index({ tenantId: 1, isActive: 1 });
MessageSchema.index({ entityId: 1 });
MessageSchema.index({ conversationId: 1 });
MessageSchema.index({ campaignId: 1 });
MessageSchema.index({ status: 1, tenantId: 1 });
MessageSchema.index({ direction: 1, tenantId: 1 });
MessageSchema.index({ type: 1, tenantId: 1 });
MessageSchema.index({ createdAt: -1 });
MessageSchema.index({ sentAt: -1 });
MessageSchema.index({ isExternalNumber: 1, tenantId: 1 });
