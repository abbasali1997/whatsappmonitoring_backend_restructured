import { User } from "../../src/common/schemas/user.schema";
import { Entity } from "../../src/common/schemas/entity.schema";
export declare class TestDataFactory {
    static createMockUser(overrides?: Partial<User>): Partial<User>;
    static createMockEntity(overrides?: Partial<Entity>): Partial<Entity>;
    static createMockJwtPayload(overrides?: any): any;
    static createMockRequest(user?: Partial<User>): any;
}
export declare class DatabaseHelpers {
    static createTestUser(userModel: any, data?: Partial<User>): Promise<User>;
    static createTestEntity(entityModel: any, data?: Partial<Entity>): Promise<Entity>;
    static cleanAllCollections(mongoose: any): Promise<void>;
}
export declare class AuthHelpers {
    static generateTestToken(payload?: any): string;
    static createAuthHeaders(token?: string): any;
}
export declare class QueueHelpers {
    static createMockServiceBusMessage(body: any, properties?: any): any;
    static wait(ms: number): Promise<void>;
}
