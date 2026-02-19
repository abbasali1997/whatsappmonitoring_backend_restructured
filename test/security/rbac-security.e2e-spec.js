"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const request = require("supertest");
const app_module_1 = require("../../src/app.module");
const test_helpers_1 = require("../helpers/test-helpers");
const mongoose_1 = require("@nestjs/mongoose");
const user_schema_1 = require("../../src/common/schemas/user.schema");
const entity_schema_1 = require("../../src/common/schemas/entity.schema");
const setup_e2e_1 = require("../setup-e2e");
describe('RBAC Security (e2e)', () => {
    let app;
    let userModel;
    let entityModel;
    let systemAdminToken;
    let tenantAdminToken;
    let userToken;
    let systemAdminEntity;
    let tenant1Entity;
    let tenant2Entity;
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
        systemAdminEntity = await test_helpers_1.DatabaseHelpers.createTestEntity(entityModel, {
            name: 'System',
            type: entity_schema_1.EntityType.SYSTEM,
        });
        tenant1Entity = await test_helpers_1.DatabaseHelpers.createTestEntity(entityModel, {
            name: 'Tenant 1',
            type: entity_schema_1.EntityType.COMPANY,
        });
        tenant2Entity = await test_helpers_1.DatabaseHelpers.createTestEntity(entityModel, {
            name: 'Tenant 2',
            type: entity_schema_1.EntityType.COMPANY,
        });
        const systemAdmin = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
            email: 'systemadmin@example.com',
            password: '$2a$10$rOzJqZqZqZqZqZqZqZqZqO',
            role: user_schema_1.UserRole.SYSTEM_ADMIN,
            entityId: systemAdminEntity._id,
            tenantId: systemAdminEntity._id,
        });
        const tenantAdmin = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
            email: 'tenantadmin@example.com',
            password: '$2a$10$rOzJqZqZqZqZqZqZqZqZqO',
            role: user_schema_1.UserRole.TENANT_ADMIN,
            entityId: tenant1Entity._id,
            tenantId: tenant1Entity._id,
        });
        const user = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
            email: 'user@example.com',
            password: '$2a$10$rOzJqZqZqZqZqZqZqZqZqO',
            role: user_schema_1.UserRole.USER,
            entityId: tenant1Entity._id,
            tenantId: tenant1Entity._id,
        });
        const systemAdminLogin = await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'systemadmin@example.com', password: 'password123' });
        systemAdminToken = systemAdminLogin.body.access_token;
        const tenantAdminLogin = await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'tenantadmin@example.com', password: 'password123' });
        tenantAdminToken = tenantAdminLogin.body.access_token;
        const userLogin = await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'user@example.com', password: 'password123' });
        userToken = userLogin.body.access_token;
    });
    afterAll(async () => {
        await app.close();
    });
    describe('Role-Based Access Control', () => {
        it('should allow SYSTEM_ADMIN to access all endpoints', async () => {
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', `Bearer ${systemAdminToken}`)
                .expect(200);
            await request(app.getHttpServer())
                .get('/api/v1/entities')
                .set('Authorization', `Bearer ${systemAdminToken}`)
                .expect(200);
        });
        it('should allow TENANT_ADMIN to access tenant-scoped endpoints', async () => {
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', `Bearer ${tenantAdminToken}`)
                .expect(200);
        });
        it('should deny USER role from admin endpoints', async () => {
            await request(app.getHttpServer())
                .post('/api/v1/users/invite')
                .set('Authorization', `Bearer ${userToken}`)
                .send({
                email: 'new@example.com',
                firstName: 'New',
                lastName: 'User',
            })
                .expect(403);
        });
        it('should deny access without proper role', async () => {
            await request(app.getHttpServer())
                .delete('/api/v1/entities/some-id')
                .set('Authorization', `Bearer ${userToken}`)
                .expect(403);
        });
    });
    describe('Data Isolation', () => {
        it('should isolate data by tenant for TENANT_ADMIN', async () => {
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: 'tenant1user@example.com',
                entityId: tenant1Entity._id,
                tenantId: tenant1Entity._id,
            });
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: 'tenant2user@example.com',
                entityId: tenant2Entity._id,
                tenantId: tenant2Entity._id,
            });
            const response = await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', `Bearer ${tenantAdminToken}`)
                .expect(200);
            const users = response.body.data || response.body;
            const emails = users.map((u) => u.email);
            expect(emails).toContain('tenant1user@example.com');
            expect(emails).not.toContain('tenant2user@example.com');
        });
        it('should allow SYSTEM_ADMIN to see all tenants', async () => {
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: 'tenant1user@example.com',
                entityId: tenant1Entity._id,
                tenantId: tenant1Entity._id,
            });
            await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: 'tenant2user@example.com',
                entityId: tenant2Entity._id,
                tenantId: tenant2Entity._id,
            });
            const response = await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', `Bearer ${systemAdminToken}`)
                .expect(200);
            const users = response.body.data || response.body;
            const emails = users.map((u) => u.email);
            expect(emails).toContain('tenant1user@example.com');
            expect(emails).toContain('tenant2user@example.com');
        });
        it('should prevent cross-tenant data access', async () => {
            const tenant2User = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: 'tenant2user@example.com',
                entityId: tenant2Entity._id,
                tenantId: tenant2Entity._id,
            });
            await request(app.getHttpServer())
                .get(`/api/v1/users/${tenant2User._id}`)
                .set('Authorization', `Bearer ${tenantAdminToken}`)
                .expect(403);
        });
    });
});
//# sourceMappingURL=rbac-security.e2e-spec.js.map