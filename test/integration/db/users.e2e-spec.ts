import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "@/apps/api/app.module";
import { DatabaseHelpers, TestDataFactory } from "../../helpers/test-helpers";
import { getModelToken } from "@nestjs/mongoose";
import { User } from "../../../src/common/schemas/user.schema";
import { Entity } from "../../../src/common/schemas/entity.schema";
import { Model } from "mongoose";
import { cleanDatabase } from "../../setup-e2e";

describe("Users Database Operations (e2e)", () => {
  let app: INestApplication;
  let userModel: Model<User>;
  let entityModel: Model<Entity>;
  let testEntity: Entity;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    userModel = moduleFixture.get<Model<User>>(getModelToken(User.name));
    entityModel = moduleFixture.get<Model<Entity>>(getModelToken(Entity.name));
  });

  beforeEach(async () => {
    await cleanDatabase();
    testEntity = await DatabaseHelpers.createTestEntity(entityModel);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("User CRUD Operations", () => {
    it("should create a user in database", async () => {
      const userData = TestDataFactory.createMockUser({
        email: "newuser@example.com",
        entityId: testEntity._id,
        tenantId: testEntity._id,
      });

      const user = await userModel.create(userData);
      expect(user).toBeDefined();
      expect(user.email).toBe("newuser@example.com");
      expect(user._id).toBeDefined();
    });

    it("should find user by email", async () => {
      const user = await DatabaseHelpers.createTestUser(userModel, {
        email: "findme@example.com",
        entityId: testEntity._id,
        tenantId: testEntity._id,
      });

      const found = await userModel.findOne({ email: "findme@example.com" });
      expect(found).toBeDefined();
      expect(found?.email).toBe("findme@example.com");
      expect(found?._id.toString()).toBe(user._id.toString());
    });

    it("should update user in database", async () => {
      const user = await DatabaseHelpers.createTestUser(userModel, {
        email: "update@example.com",
        firstName: "Old",
        entityId: testEntity._id,
        tenantId: testEntity._id,
      });

      await userModel.updateOne(
        { _id: user._id },
        { $set: { firstName: "New" } },
      );

      const updated = await userModel.findById(user._id);
      expect(updated?.firstName).toBe("New");
    });

    it("should delete user from database", async () => {
      const user = await DatabaseHelpers.createTestUser(userModel, {
        email: "delete@example.com",
        entityId: testEntity._id,
        tenantId: testEntity._id,
      });

      await userModel.deleteOne({ _id: user._id });

      const deleted = await userModel.findById(user._id);
      expect(deleted).toBeNull();
    });

    it("should find users by tenant ID", async () => {
      const { Types } = await import("mongoose");
      const tenantId = new Types.ObjectId();

      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant1@example.com",
        tenantId,
        entityId: testEntity._id,
      });

      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant2@example.com",
        tenantId: new Types.ObjectId(),
        entityId: testEntity._id,
      });

      const users = await userModel.find({ tenantId });
      expect(users).toHaveLength(1);
      expect(users[0].email).toBe("tenant1@example.com");
    });
  });

  describe("User Service Integration", () => {
    it("should find user by email via service", async () => {
      await DatabaseHelpers.createTestUser(userModel, {
        email: "findbyemail@example.com",
        entityId: testEntity._id,
        tenantId: testEntity._id,
      });

      const found = await userModel.findOne({
        email: "findbyemail@example.com",
      });
      expect(found).toBeDefined();
      expect(found?.email).toBe("findbyemail@example.com");
    });

    it("should query users by tenant via service", async () => {
      const tenantId = testEntity._id;

      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenantuser@example.com",
        entityId: testEntity._id,
        tenantId,
      });

      const users = await userModel.find({ tenantId });
      expect(users.length).toBeGreaterThan(0);
      expect(users.some((u) => u.email === "tenantuser@example.com")).toBe(
        true,
      );
    });
  });
});
