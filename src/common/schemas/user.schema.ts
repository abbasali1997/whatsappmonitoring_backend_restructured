import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export type WhatsAppQR = {
  qrCode: string;
  expiresAt: Date;
  sessionId: string;
};

export type UserDocument = User &
  Document & {
    whatsappQR?: WhatsAppQR;
  };

export enum UserRole {
  SYSTEM_ADMIN = "SystemAdmin",
  TENANT_ADMIN = "TenantAdmin",
  USER = "User",
}

export enum RegistrationStatus {
  PENDING = "pending",
  INVITED = "invited",
  REGISTERED = "registered",
  CANCELLED = "cancelled",
}

export enum WhatsAppConnectionStatus {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  FAILED = "failed",
}

@Schema({ timestamps: true })
export class UserPreferences {
  @Prop({ default: "en" })
  language: string;

  @Prop({ default: "UTC" })
  timezone: string;

  @Prop({ default: true })
  emailNotifications: boolean;

  @Prop({ default: true })
  whatsappNotifications: boolean;
}

@Schema({ timestamps: true })
export class QRInvitationHistory {
  @Prop({ required: true })
  qrCodeId: string;

  @Prop({ required: true })
  sentAt: Date;

  @Prop({ required: true, default: 1 })
  attemptCount: number;

  @Prop()
  scannedAt: Date;

  @Prop()
  expiredAt: Date;

  @Prop({ default: false })
  isExpired: boolean;
}

@Schema({ timestamps: true })
export class User {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: false, sparse: true })
  phoneNumber: string; // E164 format - Optional for TenantAdmin

  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  // Keep index creation centralized via `UserSchema.index({ email: 1 }, { unique: true })`
  // to avoid duplicate index creation warnings when using both Prop unique and explicit schema.index
  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({
    required: true,
    enum: RegistrationStatus,
    default: RegistrationStatus.PENDING,
  })
  registrationStatus: RegistrationStatus;

  @Prop({ required: true, enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Prop({ type: Object, required: false })
  entity: Record<string, unknown>;

  @Prop({ type: Types.ObjectId, ref: "Entity", required: true })
  entityId: Types.ObjectId;

  @Prop({ required: true })
  entityPath: string;

  @Prop({ type: [Types.ObjectId], ref: "Entity", default: [] })
  entityIdPath: Types.ObjectId[]; // Array of all ancestor entity IDs from root to current entity

  @Prop({ type: Types.ObjectId, ref: "Entity", required: false })
  tenantId: Types.ObjectId; // Root/first ancestor entity ID for tenant isolation

  @Prop({ type: Types.ObjectId, ref: "Entity" })
  companyId: Types.ObjectId; // Nearest ancestor entity with type 'company'

  @Prop({
    enum: WhatsAppConnectionStatus,
    default: WhatsAppConnectionStatus.DISCONNECTED,
  })
  whatsappConnectionStatus: WhatsAppConnectionStatus;

  @Prop()
  whatsappConnectedAt: Date;

  @Prop({ type: [QRInvitationHistory], default: [] })
  qrInvitationHistory: QRInvitationHistory[];

  @Prop({ type: UserPreferences, default: () => new UserPreferences() })
  preferences: UserPreferences;

  @Prop()
  avatar: string;

  @Prop()
  initials: string;

  @Prop({ default: false })
  isOnline: boolean;

  @Prop()
  lastSeenAt: Date;

  @Prop({ required: true, default: true })
  isActive: boolean;

  // Audit / deletion & anonymization (LGPD/GDPR)
  @Prop()
  createdBy?: string;

  @Prop()
  updatedBy?: string;

  @Prop()
  deletedBy?: string;

  @Prop()
  deletedAt?: Date;

  @Prop()
  anonymizedAt?: Date;

  /**
   * Human-friendly pseudonym to preserve conversation history without retaining identity.
   * Example: "Deleted User A1B2C3D4"
   */
  @Prop()
  pseudonym?: string;

  @Prop({ select: false })
  resetPasswordToken: string;

  @Prop()
  resetPasswordExpires: Date;

  @Prop({ select: false })
  emailVerificationToken: string;

  @Prop()
  emailVerificationExpires: Date;

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop()
  pendingEmail: string;

  @Prop({ default: false })
  mustChangePassword: boolean;

  @Prop()
  passwordChangedAt: Date;

  @Prop()
  createdAt: Date;

  @Prop()
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Indexes for performance
// Use partial index to ensure uniqueness only for non-null phone numbers
UserSchema.index(
  { phoneNumber: 1 },
  {
    unique: true,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - allow specifying custom partial filter properties
    partialFilterExpression: {
      phoneNumber: { $type: "string" },
      isActive: true,
    },
  },
);
UserSchema.index(
  { email: 1, role: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
  },
);
UserSchema.index({ tenantId: 1, isActive: 1 });
UserSchema.index({ entityId: 1 });
UserSchema.index({ companyId: 1 });
UserSchema.index({ entityIdPath: 1 });
UserSchema.index({ registrationStatus: 1, tenantId: 1 });
UserSchema.index({ role: 1, tenantId: 1 });
UserSchema.index({ whatsappConnectionStatus: 1 });

// Virtual for full name
UserSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Auto-generate initials
UserSchema.pre("save", function () {
  if (this.isModified("firstName") || this.isModified("lastName")) {
    this.initials =
      `${this.firstName.charAt(0)}${this.lastName.charAt(0)}`.toUpperCase();
  }
});

UserSchema.set("toJSON", { virtuals: true });
UserSchema.set("toObject", { virtuals: true });
