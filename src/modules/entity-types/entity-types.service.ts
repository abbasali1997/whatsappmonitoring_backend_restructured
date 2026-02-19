import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { EntityType } from "../../common/schemas/entity-type.schema";
import { CreateEntityTypeDto } from "./dto/create-entity-type.dto";
import { UpdateEntityTypeDto } from "./dto/create-entity-type.dto";

@Injectable()
export class EntityTypesService {
  constructor(
    @InjectModel(EntityType.name)
    private entityTypeModel: Model<EntityType>,
  ) {}

  async create(
    createEntityTypeDto: CreateEntityTypeDto,
    userId: string,
  ): Promise<EntityType> {
    const { title, color } = createEntityTypeDto;

    // Check if entity type with same title already exists for this user
    const existing = await this.entityTypeModel.findOne({
      title,
      userId: new Types.ObjectId(userId),
      isActive: true,
    });

    if (existing) {
      throw new BadRequestException(
        "Entity type with this title already exists",
      );
    }

    const entityType = new this.entityTypeModel({
      _id: new Types.ObjectId(),
      title,
      color,
      userId: new Types.ObjectId(userId),
    });

    return entityType.save();
  }

  async findAll(userId: string): Promise<EntityType[]> {
    return this.entityTypeModel
      .find({
        userId: new Types.ObjectId(userId),
        isActive: true,
      })
      .sort({ createdAt: -1 });
  }

  async findOne(id: string, userId: string): Promise<EntityType> {
    const entityType = await this.entityTypeModel.findOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
      isActive: true,
    });

    if (!entityType) {
      throw new NotFoundException("Entity type not found");
    }

    return entityType;
  }

  async update(
    id: string,
    updateEntityTypeDto: UpdateEntityTypeDto,
    userId: string,
  ): Promise<EntityType> {
    const entityType = await this.findOne(id, userId);

    const updateData: any = {};

    if (
      updateEntityTypeDto.title &&
      updateEntityTypeDto.title !== entityType.title
    ) {
      // Check if another entity type with this title exists
      const existing = await this.entityTypeModel.findOne({
        title: updateEntityTypeDto.title,
        userId: new Types.ObjectId(userId),
        isActive: true,
        _id: { $ne: new Types.ObjectId(id) },
      });

      if (existing) {
        throw new BadRequestException(
          "Entity type with this title already exists",
        );
      }

      updateData.title = updateEntityTypeDto.title;
    }

    if (updateEntityTypeDto.color) {
      updateData.color = updateEntityTypeDto.color;
    }

    return this.entityTypeModel.findByIdAndUpdate(
      new Types.ObjectId(id),
      updateData,
      { new: true },
    );
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findOne(id, userId);

    // Soft delete
    await this.entityTypeModel.findByIdAndUpdate(new Types.ObjectId(id), {
      isActive: false,
    });
  }
}
