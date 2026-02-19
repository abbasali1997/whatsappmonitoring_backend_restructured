import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { EntitiesService } from "./entities.service";
import { Entity } from "../../common/schemas/entity.schema";
import { EntityType as CustomEntityType } from "../../common/schemas/entity-type.schema";
import { User, UserRole } from "../../common/schemas/user.schema";
import { CreateEntityDto, EntityType } from "./dto/create-entity.dto";
import { UpdateEntityDto } from "./dto/update-entity.dto";
describe("EntitiesService", () => {
  let service: EntitiesService;

  const mockEntityModel = {
    findOne: jest.fn(),
    find: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockUserModel = {
    countDocuments: jest.fn(),
  };

  const mockEntityTypeModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitiesService,
        {
          provide: getModelToken(Entity.name),
          useValue: mockEntityModel,
        },
        {
          provide: getModelToken(User.name),
          useValue: mockUserModel,
        },
        {
          provide: getModelToken(CustomEntityType.name),
          useValue: mockEntityTypeModel,
        },
      ],
    }).compile();

    service = module.get<EntitiesService>(EntitiesService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("create", () => {
    it("should throw NotFoundException when parent does not exist", async () => {
      const createEntityDto: CreateEntityDto = {
        name: "Child Entity",
        type: EntityType.ENTITY,
        parentId: "507f1f77bcf86cd799439013",
      };

      mockEntityModel.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.create(
          createEntityDto,
          "507f1f77bcf86cd799439011",
          UserRole.SYSTEM_ADMIN,
          "507f1f77bcf86cd799439012",
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ForbiddenException when TenantAdmin tries to create root entity", async () => {
      const createEntityDto: CreateEntityDto = {
        name: "Root Entity",
        type: EntityType.ENTITY,
        parentId: null,
      };

      await expect(
        service.create(
          createEntityDto,
          "507f1f77bcf86cd799439011",
          UserRole.TENANT_ADMIN,
          "507f1f77bcf86cd799439012",
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("findOne", () => {
    it("should return an entity when found", async () => {
      const mockEntity = {
        _id: new Types.ObjectId(),
        name: "Test Entity",
        type: EntityType.ENTITY,
        isActive: true,
        toObject: jest.fn().mockReturnValue({
          _id: new Types.ObjectId(),
          name: "Test Entity",
          type: EntityType.ENTITY,
        }),
      };

      mockEntityModel.findOne = jest.fn().mockResolvedValue(mockEntity);
      mockEntityTypeModel.findById = jest.fn().mockResolvedValue(null);

      const result = await service.findOne(
        "507f1f77bcf86cd799439011",
        "507f1f77bcf86cd799439012",
      );

      expect(result).toBeDefined();
      expect(result.name).toBe("Test Entity");
    });

    it("should throw NotFoundException when entity is not found", async () => {
      mockEntityModel.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.findOne("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("findAll", () => {
    it("should return all entities with filters", async () => {
      const mockEntities = [
        {
          _id: new Types.ObjectId(),
          name: "Entity 1",
          type: EntityType.ENTITY,
          toObject: jest.fn().mockReturnValue({
            _id: new Types.ObjectId(),
            name: "Entity 1",
            type: EntityType.ENTITY,
          }),
        },
        {
          _id: new Types.ObjectId(),
          name: "Entity 2",
          type: EntityType.CUSTOM,
          customEntityTypeId: new Types.ObjectId(),
          toObject: jest.fn().mockReturnValue({
            _id: new Types.ObjectId(),
            name: "Entity 2",
            type: EntityType.CUSTOM,
          }),
        },
      ];

      mockEntityModel.find = jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(mockEntities),
      });
      mockEntityTypeModel.findById = jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        title: "Custom Type",
        color: "#FF0000",
      });

      const result = await service.findAll("507f1f77bcf86cd799439012", {
        type: EntityType.ENTITY,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("exportEntities", () => {
    it("should map entities into export rows", async () => {
      const tenantId = "507f1f77bcf86cd799439012";
      const mockEntities = [
        {
          _id: new Types.ObjectId(),
          tenantId: new Types.ObjectId(tenantId),
          path: "Root > Child",
          type: EntityType.ENTITY,
        },
      ];

      mockEntityModel.find = jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(mockEntities),
      });

      const result = await service.exportEntities(tenantId);

      expect(mockEntityModel.find).toHaveBeenCalledWith(
        { isActive: true, tenantId: new Types.ObjectId(tenantId) },
        {
          tenantId: 1,
          path: 1,
          type: 1,
        },
      );
      expect(result).toEqual([
        {
          tenantId,
          path: mockEntities[0].path,
          entityId: mockEntities[0]._id.toString(),
          type: mockEntities[0].type,
        },
      ]);
    });
  });

  describe("update", () => {
    it("should update an entity successfully", async () => {
      const updateEntityDto: UpdateEntityDto = {
        name: "Updated Entity",
      };

      const mockEntity = {
        _id: new Types.ObjectId(),
        name: "Original Entity",
        type: EntityType.ENTITY,
        isActive: true,
        toObject: jest.fn().mockReturnValue({
          _id: new Types.ObjectId(),
          name: "Original Entity",
          type: EntityType.ENTITY,
        }),
      };

      const mockUpdatedEntity = {
        _id: new Types.ObjectId(),
        name: "Updated Entity",
        type: EntityType.ENTITY,
        toObject: jest.fn().mockReturnValue({
          _id: new Types.ObjectId(),
          name: "Updated Entity",
          type: EntityType.ENTITY,
        }),
      };

      mockEntityModel.findOne = jest.fn().mockResolvedValue(mockEntity);
      mockEntityModel.findByIdAndUpdate = jest
        .fn()
        .mockResolvedValue(mockUpdatedEntity);

      const result = await service.update(
        "507f1f77bcf86cd799439011",
        updateEntityDto,
        "507f1f77bcf86cd799439013",
        "507f1f77bcf86cd799439012",
        UserRole.SYSTEM_ADMIN,
        "507f1f77bcf86cd799439012",
      );

      expect(result).toBeDefined();
      expect(mockEntityModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it("should throw NotFoundException when entity is not found", async () => {
      mockEntityModel.findOne = jest.fn().mockResolvedValue(null);

      await expect(
        service.update(
          "507f1f77bcf86cd799439011",
          { name: "Updated" },
          "507f1f77bcf86cd799439013",
          "507f1f77bcf86cd799439012",
          UserRole.SYSTEM_ADMIN,
          "507f1f77bcf86cd799439012",
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove", () => {
    it("should throw BadRequestException when entity has children", async () => {
      const mockEntity = {
        _id: new Types.ObjectId(),
        name: "Parent Entity",
        isActive: true,
        toObject: jest.fn().mockReturnValue({}),
      };

      mockEntityModel.findOne = jest.fn().mockResolvedValue(mockEntity);
      mockEntityModel.countDocuments = jest.fn().mockResolvedValue(1);

      await expect(
        service.remove(
          "507f1f77bcf86cd799439011",
          "507f1f77bcf86cd799439013",
          "507f1f77bcf86cd799439012",
          UserRole.SYSTEM_ADMIN,
          "507f1f77bcf86cd799439012",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when entity has active users", async () => {
      const mockEntity = {
        _id: new Types.ObjectId(),
        name: "Entity",
        isActive: true,
        toObject: jest.fn().mockReturnValue({}),
      };

      mockEntityModel.findOne = jest.fn().mockResolvedValue(mockEntity);
      mockEntityModel.countDocuments = jest
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);
      mockUserModel.countDocuments = jest.fn().mockResolvedValue(1);

      await expect(
        service.remove(
          "507f1f77bcf86cd799439011",
          "507f1f77bcf86cd799439013",
          "507f1f77bcf86cd799439012",
          UserRole.SYSTEM_ADMIN,
          "507f1f77bcf86cd799439012",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("should soft delete entity when no children and no users", async () => {
      const mockEntity = {
        _id: new Types.ObjectId(),
        name: "Entity",
        isActive: true,
        toObject: jest.fn().mockReturnValue({}),
      };

      mockEntityModel.findOne = jest.fn().mockResolvedValue(mockEntity);
      mockEntityModel.countDocuments = jest
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      mockUserModel.countDocuments = jest.fn().mockResolvedValue(0);
      mockEntityModel.findByIdAndUpdate = jest.fn().mockResolvedValue({});

      await service.remove(
        "507f1f77bcf86cd799439011",
        "507f1f77bcf86cd799439013",
        "507f1f77bcf86cd799439012",
        UserRole.SYSTEM_ADMIN,
        "507f1f77bcf86cd799439012",
      );

      expect(mockEntityModel.findByIdAndUpdate).toHaveBeenCalled();
    });
  });

  describe("getEntityStats", () => {
    it("should return entity statistics", async () => {
      const mockStats = [
        { _id: "E164", count: 5, avgLevel: 1.5 },
        { _id: "custom", count: 3, avgLevel: 2.0 },
      ];

      mockEntityModel.aggregate = jest.fn().mockResolvedValue(mockStats);
      mockEntityModel.countDocuments = jest.fn().mockResolvedValue(8);
      mockUserModel.countDocuments = jest.fn().mockResolvedValue(10);

      const result = await service.getEntityStats("507f1f77bcf86cd799439012");

      expect(result).toHaveProperty("totalEntities");
      expect(result).toHaveProperty("totalUsers");
      expect(result).toHaveProperty("byType");
      expect(result.totalEntities).toBe(8);
      expect(result.totalUsers).toBe(10);
    });
  });
});
