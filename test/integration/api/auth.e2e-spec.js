"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const request = require("supertest");
const app_module_1 = require("@/apps/api/app.module");
const test_helpers_1 = require("../../helpers/test-helpers");
const mongoose_1 = require("@nestjs/mongoose");
const user_schema_1 = require("../../../src/common/schemas/user.schema");
const entity_schema_1 = require("../../../src/common/schemas/entity.schema");
const setup_e2e_1 = require("../../setup-e2e");
describe("Auth API (e2e)", () => {
    let app;
    let userModel;
    let entityModel;
    let testEntity;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        userModel = moduleFixture.get((0, mongoose_1.getModelToken)(user_schema_1.User.name));
        entityModel = moduleFixture.get((0, mongoose_1.getModelToken)(entity_schema_1.Entity.name));
    });
    beforeEach(async () => {
        await (0, setup_e2e_1.cleanDatabase)();
        testEntity = await test_helpers_1.DatabaseHelpers.createTestEntity(entityModel);
        await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
            email: "test@example.com",
            password: "$2a$10$rOzJqZqZqZqZqZqZqZqZqO",
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
//# sourceMappingURL=auth.e2e-spec.js.map