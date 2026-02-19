import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { EntityTypesService } from "./entity-types.service";
import { EntityType } from "../../common/schemas/entity-type.schema";
import { CreateEntityTypeDto } from "./dto/create-entity-type.dto";
import { UpdateEntityTypeDto } from "./dto/create-entity-type.dto";

describe("EntityTypesService", () => {
  let service: EntityTypesService;
  let entityTypeModel: any;
  let mockSave: jest.Mock;

  const mockEntityTypeModel = {
    findOne: jest.fn(),
    find: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  };

  beforeEach(async () => {
    // Create a shared save mock that we can verify
    mockSave = jest.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      title: "Test Type",
      color: "#FF0000",
    });

    // Create a mock constructor function
    const MockModel: any = jest.fn().mockImplementation((data) => {
      const instance = {
        ...data,
        save: mockSave,
      };
      return instance;
    });

    // Attach static methods to the constructor
    MockModel.findOne = jest.fn();
    MockModel.find = jest.fn();
    MockModel.findByIdAndUpdate = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityTypesService,
        {
          provide: getModelToken(EntityType.name),
          useValue: MockModel,
        },
      ],
    }).compile();

    service = module.get<EntityTypesService>(EntityTypesService);
    entityTypeModel = module.get(getModelToken(EntityType.name));

    // Update mocks to use the MockModel
    mockEntityTypeModel.findOne = MockModel.findOne;
    mockEntityTypeModel.find = MockModel.find;
    mockEntityTypeModel.findByIdAndUpdate = MockModel.findByIdAndUpdate;

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("create", () => {
    const userId = new Types.ObjectId().toString();
    const createDto: CreateEntityTypeDto = {
      title: "Test Type",
      color: "#FF0000",
    };

    it("should create a new entity type", async () => {
      mockEntityTypeModel.findOne.mockResolvedValue(null);

      const result = await service.create(createDto, userId);

      expect(mockEntityTypeModel.findOne).toHaveBeenCalledWith({
        title: createDto.title,
        userId: new Types.ObjectId(userId),
        isActive: true,
      });
      expect(entityTypeModel).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(mockSave).toHaveBeenCalled();
    });

    it("should throw BadRequestException if entity type already exists", async () => {
      mockEntityTypeModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(),
        title: createDto.title,
      });

      await expect(service.create(createDto, userId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(createDto, userId)).rejects.toThrow(
        "Entity type with this title already exists",
      );
    });
  });

  describe("findAll", () => {
    const userId = new Types.ObjectId().toString();

    it("should return all entity types for user", async () => {
      const mockEntityTypes = [
        {
          _id: new Types.ObjectId(),
          title: "Type 1",
          color: "#FF0000",
          userId: new Types.ObjectId(userId),
        },
        {
          _id: new Types.ObjectId(),
          title: "Type 2",
          color: "#00FF00",
          userId: new Types.ObjectId(userId),
        },
      ];

      const mockFind = {
        sort: jest.fn().mockResolvedValue(mockEntityTypes),
      };
      mockEntityTypeModel.find.mockReturnValue(mockFind);

      const result = await service.findAll(userId);

      expect(mockEntityTypeModel.find).toHaveBeenCalledWith({
        userId: new Types.ObjectId(userId),
        isActive: true,
      });
      expect(mockFind.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(result).toEqual(mockEntityTypes);
    });

    it("should return empty array if no entity types found", async () => {
      const mockFind = {
        sort: jest.fn().mockResolvedValue([]),
      };
      mockEntityTypeModel.find.mockReturnValue(mockFind);

      const result = await service.findAll(userId);

      expect(result).toEqual([]);
    });
  });

  describe("findOne", () => {
    const id = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();

    it("should return entity type if found", async () => {
      const mockEntityType = {
        _id: new Types.ObjectId(id),
        title: "Test Type",
        userId: new Types.ObjectId(userId),
      };

      mockEntityTypeModel.findOne.mockResolvedValue(mockEntityType);

      const result = await service.findOne(id, userId);

      expect(mockEntityTypeModel.findOne).toHaveBeenCalledWith({
        _id: new Types.ObjectId(id),
        userId: new Types.ObjectId(userId),
        isActive: true,
      });
      expect(result).toEqual(mockEntityType);
    });

    it("should throw NotFoundException if entity type not found", async () => {
      mockEntityTypeModel.findOne.mockResolvedValue(null);

      await expect(service.findOne(id, userId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne(id, userId)).rejects.toThrow(
        "Entity type not found",
      );
    });
  });

  describe("update", () => {
    const id = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const updateDto: UpdateEntityTypeDto = {
      title: "Updated Type",
      color: "#0000FF",
    };

    it("should update entity type", async () => {
      const existingEntityType = {
        _id: new Types.ObjectId(id),
        title: "Old Type",
        color: "#FF0000",
        userId: new Types.ObjectId(userId),
      };

      mockEntityTypeModel.findOne.mockResolvedValue(existingEntityType);
      mockEntityTypeModel.findOne
        .mockResolvedValueOnce(existingEntityType)
        .mockResolvedValueOnce(null);
      mockEntityTypeModel.findByIdAndUpdate.mockResolvedValue({
        ...existingEntityType,
        ...updateDto,
      });

      const result = await service.update(id, updateDto, userId);

      expect(mockEntityTypeModel.findByIdAndUpdate).toHaveBeenCalledWith(
        new Types.ObjectId(id),
        updateDto,
        { new: true },
      );
      expect(result).toBeDefined();
    });

    it("should throw BadRequestException if title already exists", async () => {
      const existingEntityType = {
        _id: new Types.ObjectId(id),
        title: "Old Type",
        userId: new Types.ObjectId(userId),
      };

      const conflictingEntityType = {
        _id: new Types.ObjectId(),
        title: updateDto.title,
        userId: new Types.ObjectId(userId),
      };

      mockEntityTypeModel.findOne
        .mockResolvedValueOnce(existingEntityType)
        .mockResolvedValueOnce(conflictingEntityType);

      await expect(service.update(id, updateDto, userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should only update color if title not provided", async () => {
      const existingEntityType = {
        _id: new Types.ObjectId(id),
        title: "Existing Type",
        color: "#FF0000",
        userId: new Types.ObjectId(userId),
      };

      const colorOnlyUpdate: UpdateEntityTypeDto = {
        color: "#00FF00",
      };

      mockEntityTypeModel.findOne.mockResolvedValue(existingEntityType);
      mockEntityTypeModel.findByIdAndUpdate.mockResolvedValue({
        ...existingEntityType,
        color: colorOnlyUpdate.color,
      });

      const result = await service.update(id, colorOnlyUpdate, userId);

      expect(result.color).toBe(colorOnlyUpdate.color);
    });
  });

  describe("remove", () => {
    const id = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();

    it("should soft delete entity type", async () => {
      const existingEntityType = {
        _id: new Types.ObjectId(id),
        title: "Test Type",
        userId: new Types.ObjectId(userId),
      };

      mockEntityTypeModel.findOne.mockResolvedValue(existingEntityType);
      mockEntityTypeModel.findByIdAndUpdate.mockResolvedValue({
        ...existingEntityType,
        isActive: false,
      });

      await service.remove(id, userId);

      expect(mockEntityTypeModel.findByIdAndUpdate).toHaveBeenCalledWith(
        new Types.ObjectId(id),
        { isActive: false },
      );
    });

    it("should throw NotFoundException if entity type not found", async () => {
      mockEntityTypeModel.findOne.mockResolvedValue(null);

      await expect(service.remove(id, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
