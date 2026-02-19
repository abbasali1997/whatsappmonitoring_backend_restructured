import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Entity } from "../../common/schemas/entity.schema";
import { EntityType as CustomEntityType } from "../../common/schemas/entity-type.schema";
import { User, UserRole } from "../../common/schemas/user.schema";
import { CreateEntityDto } from "./dto/create-entity.dto";
import { UpdateEntityDto } from "./dto/update-entity.dto";
import { MoveEntityDto } from "./dto/move-entity.dto";
import {
  SYSTEM_ENTITY_ID,
  isSystemEntity,
} from "../../common/constants/system-entity";
import { MESSAGES } from "../../common/constants/messages";

@Injectable()
export class EntitiesService {
  constructor(
    @InjectModel(Entity.name)
    private entityModel: Model<Entity>,
    @InjectModel(User.name)
    private userModel: Model<User>,
    @InjectModel(CustomEntityType.name)
    private entityTypeModel: Model<CustomEntityType>,
  ) {}

  async create(
    createEntityDto: CreateEntityDto,
    userId: string,
    userRole: string,
    userEntityId: string,
  ): Promise<Entity> {
    const { name, type, customEntityTypeId, parentId, metadata } =
      createEntityDto;

    // Validate custom entity type if provided
    if (customEntityTypeId) {
      if (type !== "custom") {
        throw new BadRequestException(MESSAGES.ENTITY.CUSTOM_TYPE_INVALID);
      }

      const customEntityType = await this.entityTypeModel.findOne({
        _id: new Types.ObjectId(customEntityTypeId),
        userId: new Types.ObjectId(userId),
        isActive: true,
      });

      if (!customEntityType) {
        throw new NotFoundException(MESSAGES.ENTITY.CUSTOM_TYPE_NOT_FOUND);
      }
    } else if (type === "custom") {
      throw new BadRequestException(MESSAGES.ENTITY.CUSTOM_TYPE_REQUIRED);
    }

    // Validate parent exists if provided
    let parent: Entity | null = null;
    if (parentId) {
      parent = await this.entityModel.findOne({
        _id: new Types.ObjectId(parentId),
        isActive: true,
      });

      if (!parent) {
        throw new NotFoundException(MESSAGES.ENTITY.PARENT_NOT_FOUND);
      }

      // Prevent circular references
      if (await this.wouldCreateCircularReference(parentId)) {
        throw new BadRequestException(MESSAGES.ENTITY.CIRCULAR_REFERENCE);
      }
    }

    // Authorization check for TenantAdmin
    if (userRole === UserRole.TENANT_ADMIN) {
      // TenantAdmin can only create entities under their hierarchy
      if (parentId) {
        const canManage = await this.canManageEntity(userEntityId, parentId);
        if (!canManage) {
          throw new ForbiddenException(MESSAGES.ENTITY.HIERARCHY_ACCESS_DENIED);
        }
      } else {
        // TenantAdmin cannot create root entities
        throw new ForbiddenException(
          MESSAGES.ENTITY.ROOT_ENTITY_CREATION_DENIED,
        );
      }
    }

    // Generate path
    const path = await this.generatePath(name, parentId);

    // Calculate level
    const level = parentId ? (await this.calculateLevel(parentId)) + 1 : 0;

    const newObjectId = new Types.ObjectId();

    const entityIdPath = await this.generateEntityPath(
      newObjectId,
      parentId ? new Types.ObjectId(parentId) : null,
    );

    const entity = new this.entityModel({
      _id: newObjectId,
      name,
      type,
      customEntityTypeId: customEntityTypeId
        ? new Types.ObjectId(customEntityTypeId)
        : null,
      parentId: parentId ? new Types.ObjectId(parentId) : null,
      path,
      entityIdPath,
      tenantId: parentId ? new Types.ObjectId(parent.tenantId) : newObjectId,
      level,
      metadata: metadata || {},
      createdBy: userId,
    });

    const savedEntity = await entity.save();

    // Populate customEntityType if type is custom
    if (savedEntity.type === "custom" && savedEntity.customEntityTypeId) {
      const customEntityType = await this.entityTypeModel.findById(
        savedEntity.customEntityTypeId,
      );
      return {
        ...savedEntity.toObject(),
        customEntityType: customEntityType
          ? {
              _id: customEntityType._id,
              title: customEntityType.title,
              color: customEntityType.color,
            }
          : null,
      } as Entity;
    }

    return savedEntity;
  }

  async findAll(tenantId: string, filters?: any): Promise<Entity[]> {
    let query: any;

    if (tenantId)
      query = { tenantId: new Types.ObjectId(tenantId), isActive: true };
    else query = { isActive: true };

    if (filters?.type) {
      query.type = filters.type;
    }

    if (filters?.parentId) {
      query.parentId = filters.parentId;
    }

    if (filters?.level !== undefined) {
      query.level = filters.level;
    }

    if (filters?.search) {
      query.name = { $regex: filters.search, $options: "i" };
    }

    if (
      filters?.ancestorId &&
      filters?.ancestorId !== SYSTEM_ENTITY_ID.toString()
    ) {
      query.entityIdPath = new Types.ObjectId(filters.ancestorId);
    }

    const entities = await this.entityModel.find(query).sort({ path: 1 });

    // Populate customEntityTypeId for entities with type 'custom'
    const entitiesWithPopulated = await Promise.all(
      entities.map(async (entity) => {
        if (entity.type === "custom" && entity.customEntityTypeId) {
          const customEntityType = await this.entityTypeModel.findById(
            entity.customEntityTypeId,
          );
          return {
            ...entity.toObject(),
            customEntityType: customEntityType
              ? {
                  _id: customEntityType._id,
                  title: customEntityType.title,
                  color: customEntityType.color,
                }
              : null,
          };
        }
        return entity.toObject();
      }),
    );

    return entitiesWithPopulated as Entity[];
  }

  async exportEntities(
    tenantId: string,
    filters?: {
      type?: string;
      parentId?: string;
      level?: number;
      search?: string;
      ancestorId?: string;
    },
  ): Promise<
    Array<{
      tenantId: string;
      path: string;
      entityId: string;
      type: string;
    }>
  > {
    const query: Record<string, unknown> = { isActive: true };

    if (tenantId && tenantId !== "") {
      query.tenantId = new Types.ObjectId(tenantId);
    }

    if (filters?.type) {
      query.type = filters.type;
    }

    if (filters?.parentId && Types.ObjectId.isValid(filters.parentId)) {
      query.parentId = new Types.ObjectId(filters.parentId);
    }

    if (filters?.level !== undefined) {
      query.level = filters.level;
    }

    if (filters?.search) {
      query["name"] = { $regex: filters.search, $options: "i" };
    }

    if (
      filters?.ancestorId &&
      filters.ancestorId !== SYSTEM_ENTITY_ID.toString() &&
      Types.ObjectId.isValid(filters.ancestorId)
    ) {
      query.entityIdPath = new Types.ObjectId(filters.ancestorId);
    }

    const entities = await this.entityModel
      .find(query, {
        tenantId: 1,
        path: 1,
        type: 1,
      })
      .sort({ path: 1 });

    return entities.map((entity) => ({
      tenantId: entity.tenantId ? entity.tenantId.toString() : "",
      path: entity.path || "",
      entityId: entity._id.toString(),
      type: entity.type,
    }));
  }

  async findOne(id: string, _tenantId: string): Promise<Entity> {
    const entity = await this.entityModel.findOne({
      _id: new Types.ObjectId(id),
      isActive: true,
    });

    if (!entity) {
      throw new NotFoundException(MESSAGES.ENTITY.NOT_FOUND);
    }

    // Populate customEntityTypeId if type is custom
    if (entity.type === "custom" && entity.customEntityTypeId) {
      const customEntityType = await this.entityTypeModel.findById(
        entity.customEntityTypeId,
      );
      return {
        ...entity.toObject(),
        customEntityType: customEntityType
          ? {
              _id: customEntityType._id,
              title: customEntityType.title,
              color: customEntityType.color,
            }
          : null,
      } as Entity;
    }

    return entity;
  }

  async findHierarchy(tenantId: string, maxDepth?: number): Promise<Entity[]> {
    const query: any = { isActive: true };

    // Only filter by tenantId if provided (SystemAdmin has no tenantId)
    if (tenantId && tenantId !== "") {
      query.tenantId = new Types.ObjectId(tenantId);
    }

    if (maxDepth !== undefined) {
      query.level = { $lte: maxDepth };
    }

    return this.entityModel.find(query).sort({ path: 1 });
  }

  async update(
    id: string,
    updateEntityDto: UpdateEntityDto,
    userId: string,
    tenantId: string,
    userRole: string,
    userEntityId: string,
  ): Promise<Entity> {
    const entity = await this.findOne(id, "");

    // Authorization check for TenantAdmin
    if (userRole === UserRole.TENANT_ADMIN) {
      const canManage = await this.canManageEntity(userEntityId, id);
      if (!canManage) {
        throw new ForbiddenException(MESSAGES.ENTITY.HIERARCHY_ACCESS_DENIED);
      }
    }

    const updateData: any = {
      updatedBy: userId,
    };

    // Update name
    if (updateEntityDto.name && updateEntityDto.name !== entity.name) {
      updateData.name = updateEntityDto.name;
      // updateData.path = await this.generatePath(updateEntityDto.name, entity.parentId?.toString());

      // Update descendants' paths when name changes
      // await this.updateDescendantsPaths(id, tenantId);
    }

    // Update type
    if (updateEntityDto.type && updateEntityDto.type !== entity.type) {
      updateData.type = updateEntityDto.type;
    }

    // Update custom entity type
    if (updateEntityDto.customEntityTypeId !== undefined) {
      if (updateEntityDto.type === "custom" || entity.type === "custom") {
        if (updateEntityDto.customEntityTypeId) {
          // Validate custom entity type exists
          const customEntityType = await this.entityTypeModel.findOne({
            _id: new Types.ObjectId(updateEntityDto.customEntityTypeId),
            userId: new Types.ObjectId(userId),
            isActive: true,
          });

          if (!customEntityType) {
            throw new NotFoundException(MESSAGES.ENTITY.CUSTOM_TYPE_NOT_FOUND);
          }

          updateData.customEntityTypeId = new Types.ObjectId(
            updateEntityDto.customEntityTypeId,
          );
          updateData.type = "custom";
        } else {
          // Removing custom entity type - need to set a default type
          throw new BadRequestException(
            MESSAGES.ENTITY.CANNOT_REMOVE_CUSTOM_TYPE,
          );
        }
      } else {
        throw new BadRequestException(MESSAGES.ENTITY.CUSTOM_TYPE_INVALID);
      }
    }

    // If type is being changed to custom but no customEntityTypeId provided
    if (
      updateEntityDto.type === "custom" &&
      !updateEntityDto.customEntityTypeId &&
      entity.type !== "custom"
    ) {
      throw new BadRequestException(MESSAGES.ENTITY.CUSTOM_TYPE_REQUIRED);
    }

    // If type is being changed from custom to something else, clear customEntityTypeId
    if (
      updateEntityDto.type &&
      updateEntityDto.type !== "custom" &&
      entity.type === "custom"
    ) {
      updateData.customEntityTypeId = null;
    }

    // Update metadata
    if (updateEntityDto.metadata) {
      updateData.metadata = updateEntityDto.metadata;
    }

    // Update isExpanded
    if (updateEntityDto.isExpanded !== undefined) {
      updateData.isExpanded = updateEntityDto.isExpanded;
    }

    const updatedEntity = await this.entityModel.findByIdAndUpdate(
      new Types.ObjectId(id),
      updateData,
      { new: true },
    );

    // Populate customEntityType if type is custom
    if (updatedEntity.type === "custom" && updatedEntity.customEntityTypeId) {
      const customEntityType = await this.entityTypeModel.findById(
        updatedEntity.customEntityTypeId,
      );
      return {
        ...updatedEntity.toObject(),
        customEntityType: customEntityType
          ? {
              _id: customEntityType._id,
              title: customEntityType.title,
              color: customEntityType.color,
            }
          : null,
      } as Entity;
    }

    return updatedEntity;
  }

  async move(
    id: string,
    moveEntityDto: MoveEntityDto,
    userId: string,
    tenantId: string,
    userRole: string,
    userEntityId: string,
  ): Promise<Entity> {
    const entity = await this.findOne(id, tenantId);
    const { newParentId } = moveEntityDto;

    // Authorization check for TenantAdmin
    if (userRole === UserRole.TENANT_ADMIN) {
      // Check if user can manage the entity being moved
      const canManageEntity = await this.canUserManageEntity(userEntityId, id);
      if (!canManageEntity) {
        throw new ForbiddenException(MESSAGES.ENTITY.HIERARCHY_ACCESS_DENIED);
      }

      // Check if user can manage the new parent (if provided)
      if (newParentId) {
        const canManageParent = await this.canUserManageEntity(
          userEntityId,
          newParentId,
        );
        if (!canManageParent) {
          throw new ForbiddenException(MESSAGES.ENTITY.HIERARCHY_ACCESS_DENIED);
        }
      } else {
        // TenantAdmin cannot move entities to root level
        throw new ForbiddenException(MESSAGES.ENTITY.CANNOT_MOVE_TO_ROOT);
      }
    }

    // Validate new parent exists if provided
    if (newParentId) {
      const newParentQuery: any = {
        _id: newParentId,
        isActive: true,
      };

      // Only filter by tenantId if provided (SystemAdmin has no tenantId)
      if (tenantId && tenantId !== "") {
        newParentQuery.tenantId = new Types.ObjectId(tenantId);
      }

      const newParent = await this.entityModel.findOne(newParentQuery);

      if (!newParent) {
        throw new NotFoundException(MESSAGES.ENTITY.PARENT_NOT_FOUND);
      }

      // Prevent circular references
      if (await this.wouldCreateCircularReference(newParentId, id)) {
        throw new BadRequestException(MESSAGES.ENTITY.CIRCULAR_REFERENCE);
      }
    }

    // Update entity
    const newPath = await this.generatePath(entity.name, newParentId);
    const newLevel = newParentId
      ? (await this.calculateLevel(newParentId)) + 1
      : 0;

    await this.entityModel.findByIdAndUpdate(id, {
      parentId: newParentId || null,
      path: newPath,
      level: newLevel,
      updatedBy: userId,
    });

    // Update all descendants' paths and levels
    await this.updateDescendantsPaths(id, tenantId);

    return this.findOne(id, tenantId);
  }

  async remove(
    id: string,
    userId: string,
    tenantId: string,
    userRole: string,
    userEntityId: string,
  ): Promise<void> {
    await this.findOne(id, "");

    // Authorization check for TenantAdmin
    if (userRole === UserRole.TENANT_ADMIN) {
      // TenantAdmin must not delete their own root entity
      if (userEntityId && id === String(userEntityId)) {
        throw new ForbiddenException(MESSAGES.ENTITY.HIERARCHY_ACCESS_DENIED);
      }

      const canManage = await this.canManageEntity(userEntityId, id);
      if (!canManage) {
        throw new ForbiddenException(MESSAGES.ENTITY.HIERARCHY_ACCESS_DENIED);
      }
    }

    console.log("children", id);

    // Check if entity has children
    const childrenCount = await this.entityModel.countDocuments({
      parentId: new Types.ObjectId(id),
      isActive: true,
    });

    if (childrenCount > 0) {
      throw new BadRequestException(MESSAGES.ENTITY.HAS_CHILDREN);
    }

    // Check if entity has users
    const usersCount = await this.userModel.countDocuments({
      entityId: new Types.ObjectId(id),
      isActive: true,
    });

    if (usersCount > 0) {
      throw new BadRequestException(MESSAGES.ENTITY.HAS_ACTIVE_USERS);
    }

    // Soft delete
    await this.entityModel.findByIdAndUpdate(new Types.ObjectId(id), {
      isActive: false,
      updatedBy: userId,
    });
  }

  async getEntityStats(tenantId: string): Promise<any> {
    // Build match query - only include tenantId if provided (SystemAdmin has no tenantId)
    const matchQuery: any = { isActive: true };
    if (tenantId && tenantId !== "") {
      matchQuery.tenantId = new Types.ObjectId(tenantId);
    }

    const stats = await this.entityModel.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          avgLevel: { $avg: "$level" },
        },
      },
    ]);

    const totalEntities = await this.entityModel.countDocuments(matchQuery);
    const totalUsers = await this.userModel.countDocuments(matchQuery);

    return {
      totalEntities,
      totalUsers,
      byType: stats,
    };
  }

  /**
   * Check if an entity is the System entity
   * @param entityId - The entity ID to check
   * @returns true if the entity is the System entity
   */
  isSystemEntity(entityId: Types.ObjectId | string): boolean {
    return isSystemEntity(entityId);
  }

  /**
   * Get the System entity ID constant
   * @returns The System entity ObjectId
   */
  getSystemEntityId(): Types.ObjectId {
    return SYSTEM_ENTITY_ID;
  }

  private async generatePath(
    name: string,
    parentId: string | null,
  ): Promise<string> {
    if (!parentId) {
      return name;
    }

    const parent = await this.entityModel.findOne({
      _id: new Types.ObjectId(parentId),
      isActive: true,
    });

    if (!parent) {
      throw new NotFoundException(MESSAGES.ENTITY.PARENT_NOT_FOUND);
    }

    return `${parent.path} > ${name}`;
  }

  private async generateEntityPath(
    entityId: Types.ObjectId,
    parentId: Types.ObjectId | null,
  ): Promise<Types.ObjectId[]> {
    if (!parentId) {
      return [entityId];
    }

    const parent = await this.entityModel.findOne({
      _id: parentId,
      isActive: true,
    });

    if (!parent) {
      throw new NotFoundException(MESSAGES.ENTITY.PARENT_NOT_FOUND);
    }

    // Create a copy of the parent's entityIdPath to avoid mutating the original array
    const path = [...(parent.entityIdPath || [])];
    path.push(entityId);

    return path;
  }

  private async calculateLevel(parentId: string): Promise<number> {
    const parent = await this.entityModel.findOne({
      _id: new Types.ObjectId(parentId),
      isActive: true,
    });

    return parent ? parent.level : 0;
  }

  private async wouldCreateCircularReference(
    parentId: string,
    excludeId?: string,
  ): Promise<boolean> {
    const query: any = { _id: parentId, isActive: true };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const parent = await this.entityModel.findOne(query);
    if (!parent) {
      return false;
    }

    // Check if the parent is a descendant of the entity being moved
    if (excludeId) {
      const descendants = await this.getAllDescendants(excludeId);
      return descendants.some((desc) => desc._id.toString() === parentId);
    }

    return false;
  }

  private async getAllDescendants(entityId: string): Promise<Entity[]> {
    const descendants: Entity[] = [];
    const children = await this.entityModel.find({
      parentId: entityId,
      isActive: true,
    });

    for (const child of children) {
      descendants.push(child);
      const childDescendants = await this.getAllDescendants(
        child._id.toString(),
      );
      descendants.push(...childDescendants);
    }

    return descendants;
  }

  private async updateDescendantsPaths(
    entityId: string,
    _tenantId: string,
  ): Promise<void> {
    const descendants = await this.getAllDescendants(entityId);

    for (const descendant of descendants) {
      const newPath = await this.generatePath(
        descendant.name,
        descendant.parentId?.toString(),
      );
      const newLevel =
        (await this.calculateLevel(descendant.parentId?.toString())) + 1;

      await this.entityModel.findByIdAndUpdate(descendant._id, {
        path: newPath,
        level: newLevel,
      });
    }
  }

  /**
   * Check if a user can manage an entity based on their role and entity hierarchy
   * TenantAdmin can only manage entities that are under their entity or are their entity itself
   * SystemAdmin can manage all entities
   */
  private async canUserManageEntity(
    userEntityId: string,
    targetEntityId: string,
  ): Promise<boolean> {
    // If user's entity is the target entity, they can manage it
    if (userEntityId === targetEntityId) {
      return true;
    }

    // Check if target entity is a descendant of user's entity
    const targetEntity = await this.entityModel.findOne({
      _id: targetEntityId,
      isActive: true,
    });

    if (!targetEntity) {
      return false;
    }

    // Check if user's entityId is in the target entity's entityIdPath
    // This means the target entity is under the user's entity hierarchy
    if (targetEntity.entityIdPath && targetEntity.entityIdPath.length > 0) {
      return targetEntity.entityIdPath.some(
        (id) => id.toString() === userEntityId,
      );
    }

    // Check parent chain if entityIdPath is not available
    let currentEntity = targetEntity;
    while (currentEntity.parentId) {
      if (currentEntity.parentId.toString() === userEntityId) {
        return true;
      }
      currentEntity = await this.entityModel.findOne({
        _id: currentEntity.parentId,
        isActive: true,
      });
      if (!currentEntity) {
        break;
      }
    }

    return false;
  }

  private async canManageEntity(
    userEntityId: string,
    targetEntityId: string,
  ): Promise<boolean> {
    // If user's entity is the target entity, they can manage it
    if (userEntityId === targetEntityId) {
      return true;
    }

    // Check if target entity is a descendant of user's entity
    const targetEntity = await this.entityModel.findOne({
      _id: new Types.ObjectId(targetEntityId),
      entityIdPath: new Types.ObjectId(userEntityId),
      isActive: true,
    });

    if (!targetEntity) {
      return false;
    }
    return true;
  }
}
