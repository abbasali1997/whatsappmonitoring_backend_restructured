import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "@/apps/api/app.module";
import { DatabaseHelpers } from "../../helpers/test-helpers";
import { getModelToken } from "@nestjs/mongoose";
import { User } from "../../../src/common/schemas/user.schema";
import { Entity } from "../../../src/common/schemas/entity.schema";
import { Model } from "mongoose";
import { cleanDatabase } from "../../setup-e2e";

describe("Auth API (e2e)", () => {
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
    await DatabaseHelpers.createTestUser(userModel, {
      email: "test@example.com",
      password: "$2a$10$rOzJqZqZqZqZqZqZqZqZqO", // bcrypt hash for 'password123'
      entityId: testEntity._id,
      tenantId: testEntity._id,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/v1/auth/login", () => {
    it("should login successfully with valid credentials", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          email: "test@example.com",
          password: "password123",
        })
        .expect(200);

      expect(response.body).toHaveProperty("access_token");
      expect(response.body).toHaveProperty("refresh_token");
      expect(response.body.user).toHaveProperty("email", "test@example.com");
    });

    it("should fail with invalid email", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          email: "invalid@example.com",
          password: "password123",
        })
        .expect(401);
    });

    it("should fail with invalid password", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          email: "test@example.com",
          password: "wrongpassword",
        })
        .expect(401);
    });

    it("should fail with missing credentials", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({})
        .expect(400);
    });
  });

  describe("POST /api/v1/auth/register", () => {
    it("should register a new user successfully", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({
          email: "newuser@example.com",
          password: "password123",
          firstName: "New",
          lastName: "User",
          entityId: testEntity._id.toString(),
        })
        .expect(201);

      expect(response.body).toHaveProperty("user");
      expect(response.body.user.email).toBe("newuser@example.com");
    });

    it("should fail with duplicate email", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({
          email: "test@example.com",
          password: "password123",
          firstName: "Test",
          lastName: "User",
          entityId: testEntity._id.toString(),
        })
        .expect(409);
    });

    it("should fail with invalid entity ID", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({
          email: "newuser@example.com",
          password: "password123",
          firstName: "New",
          lastName: "User",
          entityId: "invalid-id",
        })
        .expect(400);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("should refresh token successfully", async () => {
      // First login to get tokens
      const loginResponse = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          email: "test@example.com",
          password: "password123",
        });

      const refreshToken = loginResponse.body.refresh_token;

      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken })
        .expect(200);

      expect(response.body).toHaveProperty("access_token");
      expect(response.body).toHaveProperty("refresh_token");
    });

    it("should fail with invalid refresh token", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: "invalid-token" })
        .expect(401);
    });
  });
});
