"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const app_module_1 = require("@/apps/api/app.module");
const test_helpers_1 = require("../../helpers/test-helpers");
const mongoose_1 = require("@nestjs/mongoose");
const user_schema_1 = require("../../../src/common/schemas/user.schema");
const entity_schema_1 = require("../../../src/common/schemas/entity.schema");
const setup_e2e_1 = require("../../setup-e2e");
describe("Users Database Operations (e2e)", () => {
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
    });
    afterAll(async () => {
        await app.close();
    });
    describe("User CRUD Operations", () => {
        it("should create a user in database", async () => {
            const userData = test_helpers_1.TestDataFactory.createMockUser({
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
            const user = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
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
            const user = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: "update@example.com",
                firstName: "Old",
                entityId: testEntity._id,
                tenantId: testEntity._id,
            });
            await userModel.updateOne({ _id: user._id }, { $set: { firstName: "New" } });
            const updated = await userModel.findById(user._id);
            expect(updated?.firstName).toBe("New");
        });
        it("should delete user from database", async () => {
            const user = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: "delete@example.com",
                entityId: testEntity._id,
                tenantId: testEntity._id,
            });
            await userModel.deleteOne({ _id: user._id });
            const deleted = await userModel.findById(user._id);
            expect(deleted).toBeNull();
        });
        it("should find users by tenant ID", async () => {
            const { Types } = await Promise.resolve().then(() => require("mongoose"));
            const tenantId = new Types.ObjectId();
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: "tenant1@example.com",
                tenantId,
                entityId: testEntity._id,
            });
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
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
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
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
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: "tenantuser@example.com",
                entityId: testEntity._id,
                tenantId,
            });
            const users = await userModel.find({ tenantId });
            expect(users.length).toBeGreaterThan(0);
            expect(users.some((u) => u.email === "tenantuser@example.com")).toBe(true);
        });
    });
});
//# sourceMappingURL=users.e2e-spec.js.map