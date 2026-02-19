import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export type EntityTypeDocument = EntityType & Document;

@Schema({ timestamps: true })
export class EntityType {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  color: string;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, default: true })
  isActive: boolean;

  @Prop()
  createdAt: Date;

  @Prop()
  updatedAt: Date;
}

export const EntityTypeSchema = SchemaFactory.createForClass(EntityType);

// Indexes for performance
EntityTypeSchema.index({ userId: 1, isActive: 1 });
EntityTypeSchema.index({ userId: 1 });
