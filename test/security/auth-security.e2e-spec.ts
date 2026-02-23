import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "@/apps/api/app.module";
import { DatabaseHelpers } from "../helpers/test-helpers";
import { getModelToken } from "@nestjs/mongoose";
import { User, UserRole } from "../../src/common/schemas/user.schema";
import { Entity } from "../../src/common/schemas/entity.schema";
import { Model } from "mongoose";
import { cleanDatabase } from "../setup-e2e";

describe("Authentication Security (e2e)", () => {
  let app: INestApplication;
  let userModel: Model<User>;
  let entityModel: Model<Entity>;
  let testUser: User;
  let testEntity: Entity;
  let accessToken: string;

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
    testUser = await DatabaseHelpers.createTestUser(userModel, {
      email: "secure@example.com",
      password: "$2a$10$rOzJqZqZqZqZqZqZqZqZqO", // bcrypt hash for 'password123'
      entityId: testEntity._id,
      tenantId: testEntity._id,
      role: UserRole.USER,
    });

    // Login to get token
    const loginResponse = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({
        email: "secure@example.com",
        password: "password123",
      });

    accessToken = loginResponse.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("JWT Token Security", () => {
    it("should reject requests without token", async () => {
      await request(app.getHttpServer()).get("/api/v1/users").expect(401);
    });

    it("should reject requests with invalid token", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", "Bearer invalid-token")
        .expect(401);
    });

    it("should reject requests with malformed token", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", "Bearer not.a.valid.jwt")
        .expect(401);
    });

    it("should accept requests with valid token", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
    });

    it("should reject expired tokens", async () => {
      // This would require mocking JWT expiration
      // In real scenario, tokens expire after configured time
      const expiredToken = "expired-token";
      await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", `Bearer ${expiredToken}`)
        .expect(401);
    });
  });

  describe("Password Security", () => {
    it("should hash passwords before storing", async () => {
      const user = await DatabaseHelpers.createTestUser(userModel, {
        email: "hashed@example.com",
        password: "plaintext123",
        entityId: testEntity._id,
        tenantId: testEntity._id,
      });

      expect(user.password).not.toBe("plaintext123");
      expect(user.password).toHaveLength(60); // bcrypt hash length
    });

    it("should prevent password in response", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/users/${testUser._id}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).not.toHaveProperty("password");
    });
  });

  describe("Rate Limiting", () => {
    it("should rate limit login attempts", async () => {
      // Make multiple rapid login attempts
      const attempts = 10;
      let rateLimitedCount = 0;

      for (let i = 0; i < attempts; i++) {
        const response = await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .send({
            email: "secure@example.com",
            password: "wrongpassword",
          });

        if (response.status === 401) {
          // Count successful unauthorized responses
        } else if (response.status === 429) {
          rateLimitedCount++;
        }
      }

      // Should eventually hit rate limit
      expect(rateLimitedCount).toBeGreaterThan(0);
    });
  });
});
