"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueueHelpers = exports.AuthHelpers = exports.DatabaseHelpers = exports.TestDataFactory = void 0;
const mongoose_1 = require("mongoose");
const user_schema_1 = require("../../src/common/schemas/user.schema");
const entity_schema_1 = require("../../src/common/schemas/entity.schema");
class TestDataFactory {
    static createMockUser(overrides = {}) {
        return {
            _id: new mongoose_1.Types.ObjectId(),
            email: 'test@example.com',
            firstName: 'Test',
            lastName: 'User',
            password: 'hashedPassword123',
            role: user_schema_1.UserRole.USER,
            entityId: new mongoose_1.Types.ObjectId(),
            tenantId: new mongoose_1.Types.ObjectId(),
            isActive: true,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides,
        };
    }
    static createMockEntity(overrides = {}) {
        return {
            _id: new mongoose_1.Types.ObjectId(),
            name: 'Test Entity',
            type: entity_schema_1.EntityType.COMPANY,
            parentId: null,
            tenantId: new mongoose_1.Types.ObjectId(),
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides,
        };
    }
    static createMockJwtPayload(overrides = {}) {
        return {
            sub: new mongoose_1.Types.ObjectId().toString(),
            email: 'test@example.com',
            role: user_schema_1.UserRole.USER,
            entityId: new mongoose_1.Types.ObjectId().toString(),
            tenantId: new mongoose_1.Types.ObjectId().toString(),
            ...overrides,
        };
    }
    static createMockRequest(user = {}) {
        const mockUser = this.createMockUser(user);
        return {
            user: {
                sub: mockUser._id?.toString(),
                email: mockUser.email,
                role: mockUser.role,
                entityId: mockUser.entityId?.toString(),
                tenantId: mockUser.tenantId?.toString(),
                entityPath: [mockUser.entityId?.toString()],
            },
            headers: {},
            body: {},
            query: {},
            params: {},
        };
    }
}
exports.TestDataFactory = TestDataFactory;
class DatabaseHelpers {
    static async createTestUser(userModel, data = {}) {
        const userData = TestDataFactory.createMockUser(data);
        return await userModel.create(userData);
    }
    static async createTestEntity(entityModel, data = {}) {
        const entityData = TestDataFactory.createMockEntity(data);
        return await entityModel.create(entityData);
    }
    static async cleanAllCollections(mongoose) {
        const collections = mongoose.connection.collections;
        for (const key in collections) {
            await collections[key].deleteMany({});
        }
    }
}
exports.DatabaseHelpers = DatabaseHelpers;
class AuthHelpers {
    static generateTestToken(payload = {}) {
        const basePayload = TestDataFactory.createMockJwtPayload(payload);
        return `test-token-${JSON.stringify(basePayload)}`;
    }
    static createAuthHeaders(token = 'test-token') {
        return {
            authorization: `Bearer ${token}`,
        };
    }
}
exports.AuthHelpers = AuthHelpers;
class QueueHelpers {
    static createMockServiceBusMessage(body, properties = {}) {
        return {
            body,
            messageId: `test-msg-${Date.now()}`,
            correlationId: properties.correlationId || `test-correlation-${Date.now()}`,
            contentType: 'application/json',
            applicationProperties: {
                type: properties.type || 'TEST',
                ...properties,
            },
            enqueuedTimeUtc: new Date(),
            deliveryCount: 1,
            lockToken: `test-lock-${Date.now()}`,
        };
    }
    static async wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.QueueHelpers = QueueHelpers;
//# sourceMappingURL=test-helpers.js.map