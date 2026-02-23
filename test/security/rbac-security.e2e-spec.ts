import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "@/apps/api/app.module";
import { DatabaseHelpers } from "../helpers/test-helpers";
import { getModelToken } from "@nestjs/mongoose";
import { User, UserRole } from "../../src/common/schemas/user.schema";
import { Entity, EntityType } from "../../src/common/schemas/entity.schema";
import { Model } from "mongoose";
import { cleanDatabase } from "../setup-e2e";

describe("RBAC Security (e2e)", () => {
  let app: INestApplication;
  let userModel: Model<User>;
  let entityModel: Model<Entity>;
  let systemAdminToken: string;
  let tenantAdminToken: string;
  let userToken: string;
  let systemAdminEntity: Entity;
  let tenant1Entity: Entity;
  let tenant2Entity: Entity;

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

    // Create entities
    systemAdminEntity = await DatabaseHelpers.createTestEntity(entityModel, {
      name: "System",
      type: EntityType.SYSTEM,
    });

    tenant1Entity = await DatabaseHelpers.createTestEntity(entityModel, {
      name: "Tenant 1",
      type: EntityType.COMPANY,
    });

    tenant2Entity = await DatabaseHelpers.createTestEntity(entityModel, {
      name: "Tenant 2",
      type: EntityType.COMPANY,
    });

    // Create users with different roles
    await DatabaseHelpers.createTestUser(userModel, {
      email: "systemadmin@example.com",
      password: "$2a$10$rOzJqZqZqZqZqZqZqZqZqO",
      role: UserRole.SYSTEM_ADMIN,
      entityId: systemAdminEntity._id,
      tenantId: systemAdminEntity._id,
    });

    await DatabaseHelpers.createTestUser(userModel, {
      email: "tenantadmin@example.com",
      password: "$2a$10$rOzJqZqZqZqZqZqZqZqZqO",
      role: UserRole.TENANT_ADMIN,
      entityId: tenant1Entity._id,
      tenantId: tenant1Entity._id,
    });

    await DatabaseHelpers.createTestUser(userModel, {
      email: "user@example.com",
      password: "$2a$10$rOzJqZqZqZqZqZqZqZqZqO",
      role: UserRole.USER,
      entityId: tenant1Entity._id,
      tenantId: tenant1Entity._id,
    });

    // Login to get tokens
    const systemAdminLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "systemadmin@example.com", password: "password123" });
    systemAdminToken = systemAdminLogin.body.access_token;

    const tenantAdminLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "tenantadmin@example.com", password: "password123" });
    tenantAdminToken = tenantAdminLogin.body.access_token;

    const userLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "user@example.com", password: "password123" });
    userToken = userLogin.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Role-Based Access Control", () => {
    it("should allow SYSTEM_ADMIN to access all endpoints", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", `Bearer ${systemAdminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .get("/api/v1/entities")
        .set("Authorization", `Bearer ${systemAdminToken}`)
        .expect(200);
    });

    it("should allow TENANT_ADMIN to access tenant-scoped endpoints", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", `Bearer ${tenantAdminToken}`)
        .expect(200);
    });

    it("should deny USER role from admin endpoints", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/users/invite")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          email: "new@example.com",
          firstName: "New",
          lastName: "User",
        })
        .expect(403);
    });

    it("should deny access without proper role", async () => {
      await request(app.getHttpServer())
        .delete("/api/v1/entities/some-id")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(403);
    });
  });

  describe("Data Isolation", () => {
    it("should isolate data by tenant for TENANT_ADMIN", async () => {
      // Create user in tenant 1
      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant1user@example.com",
        entityId: tenant1Entity._id,
        tenantId: tenant1Entity._id,
      });

      // Create user in tenant 2
      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant2user@example.com",
        entityId: tenant2Entity._id,
        tenantId: tenant2Entity._id,
      });

      // Tenant admin should only see tenant 1 users
      const response = await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", `Bearer ${tenantAdminToken}`)
        .expect(200);

      const users = response.body.data || response.body;
      const emails = users.map((u: any) => u.email);
      expect(emails).toContain("tenant1user@example.com");
      expect(emails).not.toContain("tenant2user@example.com");
    });

    it("should allow SYSTEM_ADMIN to see all tenants", async () => {
      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant1user@example.com",
        entityId: tenant1Entity._id,
        tenantId: tenant1Entity._id,
      });

      await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant2user@example.com",
        entityId: tenant2Entity._id,
        tenantId: tenant2Entity._id,
      });

      const response = await request(app.getHttpServer())
        .get("/api/v1/users")
        .set("Authorization", `Bearer ${systemAdminToken}`)
        .expect(200);

      const users = response.body.data || response.body;
      const emails = users.map((u: any) => u.email);
      expect(emails).toContain("tenant1user@example.com");
      expect(emails).toContain("tenant2user@example.com");
    });

    it("should prevent cross-tenant data access", async () => {
      const tenant2User = await DatabaseHelpers.createTestUser(userModel, {
        email: "tenant2user@example.com",
        entityId: tenant2Entity._id,
        tenantId: tenant2Entity._id,
      });

      // Tenant 1 admin should not access tenant 2 user
      await request(app.getHttpServer())
        .get(`/api/v1/users/${tenant2User._id}`)
        .set("Authorization", `Bearer ${tenantAdminToken}`)
        .expect(403);
    });
  });
});
