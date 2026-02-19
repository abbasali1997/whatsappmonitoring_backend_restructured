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
describe('Authentication Security (e2e)', () => {
    let app;
    let userModel;
    let entityModel;
    let testUser;
    let testEntity;
    let accessToken;
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
        testUser = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
            email: 'secure@example.com',
            password: '$2a$10$rOzJqZqZqZqZqZqZqZqZqO',
            entityId: testEntity._id,
            tenantId: testEntity._id,
            role: user_schema_1.UserRole.USER,
        });
        const loginResponse = await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({
            email: 'secure@example.com',
            password: 'password123',
        });
        accessToken = loginResponse.body.access_token;
    });
    afterAll(async () => {
        await app.close();
    });
    describe('JWT Token Security', () => {
        it('should reject requests without token', async () => {
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .expect(401);
        });
        it('should reject requests with invalid token', async () => {
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', 'Bearer invalid-token')
                .expect(401);
        });
        it('should reject requests with malformed token', async () => {
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', 'Bearer not.a.valid.jwt')
                .expect(401);
        });
        it('should accept requests with valid token', async () => {
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);
        });
        it('should reject expired tokens', async () => {
            const expiredToken = 'expired-token';
            await request(app.getHttpServer())
                .get('/api/v1/users')
                .set('Authorization', `Bearer ${expiredToken}`)
                .expect(401);
        });
    });
    describe('Password Security', () => {
        it('should hash passwords before storing', async () => {
            const user = await test_helpers_1.DatabaseHelpers.createTestUser(userModel, {
                email: 'hashed@example.com',
                password: 'plaintext123',
                entityId: testEntity._id,
                tenantId: testEntity._id,
            });
            expect(user.password).not.toBe('plaintext123');
            expect(user.password).toHaveLength(60);
        });
        it('should prevent password in response', async () => {
            const response = await request(app.getHttpServer())
                .get(`/api/v1/users/${testUser._id}`)
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);
            expect(response.body).not.toHaveProperty('password');
        });
    });
    describe('Rate Limiting', () => {
        it('should rate limit login attempts', async () => {
            const attempts = 10;
            let successCount = 0;
            let rateLimitedCount = 0;
            for (let i = 0; i < attempts; i++) {
                const response = await request(app.getHttpServer())
                    .post('/api/v1/auth/login')
                    .send({
                    email: 'secure@example.com',
                    password: 'wrongpassword',
                });
                if (response.status === 401) {
                    successCount++;
                }
                else if (response.status === 429) {
                    rateLimitedCount++;
                }
            }
            expect(rateLimitedCount).toBeGreaterThan(0);
        });
    });
});
//# sourceMappingURL=auth-security.e2e-spec.js.map