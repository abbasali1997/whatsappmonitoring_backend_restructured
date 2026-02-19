import { Types } from "mongoose";
import { User, UserRole } from "../../src/common/schemas/user.schema";
import { Entity, EntityType } from "../../src/common/schemas/entity.schema";

/**
 * Test data factories
 */
export class TestDataFactory {
  /**
   * Create a mock user object
   */
  static createMockUser(overrides: Partial<User> = {}): Partial<User> {
    return {
      _id: new Types.ObjectId(),
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      password: "hashedPassword123",
      role: UserRole.USER,
      entityId: new Types.ObjectId(),
      tenantId: new Types.ObjectId(),
      isActive: true,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /**
   * Create a mock entity object
   */
  static createMockEntity(overrides: Partial<Entity> = {}): Partial<Entity> {
    return {
      _id: new Types.ObjectId(),
      name: "Test Entity",
      type: EntityType.COMPANY,
      parentId: null,
      tenantId: new Types.ObjectId(),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /**
   * Create a mock JWT payload
   */
  static createMockJwtPayload(overrides: any = {}): any {
    return {
      sub: new Types.ObjectId().toString(),
      email: "test@example.com",
      role: UserRole.USER,
      entityId: new Types.ObjectId().toString(),
      tenantId: new Types.ObjectId().toString(),
      ...overrides,
    };
  }

  /**
   * Create a mock request object with user
   */
  static createMockRequest(user: Partial<User> = {}): any {
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

/**
 * Database helpers for tests
 */
export class DatabaseHelpers {
  /**
   * Create test user in database
   */
  static async createTestUser(
    userModel: any,
    data: Partial<User> = {},
  ): Promise<User> {
    const userData = TestDataFactory.createMockUser(data);
    return await userModel.create(userData);
  }

  /**
   * Create test entity in database
   */
  static async createTestEntity(
    entityModel: any,
    data: Partial<Entity> = {},
  ): Promise<Entity> {
    const entityData = TestDataFactory.createMockEntity(data);
    return await entityModel.create(entityData);
  }

  /**
   * Clean all collections
   */
  static async cleanAllCollections(mongoose: any): Promise<void> {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}

/**
 * Authentication helpers for tests
 */
export class AuthHelpers {
  /**
   * Generate a test JWT token
   */
  static generateTestToken(payload: any = {}): string {
    // In real tests, use JwtService to generate tokens
    // This is a placeholder for test token generation
    const basePayload = TestDataFactory.createMockJwtPayload(payload);
    return `test-token-${JSON.stringify(basePayload)}`;
  }

  /**
   * Create authenticated request headers
   */
  static createAuthHeaders(token: string = "test-token"): any {
    return {
      authorization: `Bearer ${token}`,
    };
  }
}

/**
 * Queue helpers for tests
 */
export class QueueHelpers {
  /**
   * Mock Service Bus message
   */
  static createMockServiceBusMessage(body: any, properties: any = {}): any {
    return {
      body,
      messageId: `test-msg-${Date.now()}`,
      correlationId:
        properties.correlationId || `test-correlation-${Date.now()}`,
      contentType: "application/json",
      applicationProperties: {
        type: properties.type || "TEST",
        ...properties,
      },
      enqueuedTimeUtc: new Date(),
      deliveryCount: 1,
      lockToken: `test-lock-${Date.now()}`,
    };
  }

  /**
   * Wait for async operations (useful for queue tests)
   */
  static async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
