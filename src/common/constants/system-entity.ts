import { Types } from "mongoose";

/**
 * System Entity ID - Special entity for Administrators
 *
 * This is a well-known ObjectId that represents the special "System" entity
 * that Administrators belong to. This entity is not part of any tenant
 * and serves as the organizational unit for system-level users.
 *
 * Usage:
 *   import { SYSTEM_ENTITY_ID } from '../common/constants/system-entity';
 *
 * Features:
 *   - Fixed ObjectId for consistency across environments
 *   - Easy to identify System Admins by checking entityId === SYSTEM_ENTITY_ID
 *   - Can be used in queries, validations, and business logic
 */
export const SYSTEM_ENTITY_ID = new Types.ObjectId("000000000000000000000001");

/**
 * System Entity Name - Human-readable name for the System entity
 */
export const SYSTEM_ENTITY_NAME = "System";

/**
 * System Entity Type - Type identifier for the System entity
 */
export const SYSTEM_ENTITY_TYPE = "system";

/**
 * Helper function to check if an entity ID is the System entity
 * @param entityId - The entity ID to check
 * @returns true if the entity ID matches the System entity ID
 */
export function isSystemEntity(entityId: Types.ObjectId | string): boolean {
  const id = typeof entityId === "string" ? entityId : entityId.toString();
  return id === SYSTEM_ENTITY_ID.toString();
}

/**
 * Helper function to check if a user is a Administrator
 * @param user - The user object to check
 * @returns true if the user belongs to the System entity
 */
export function isSystemAdmin(user: {
  entityId: Types.ObjectId | string;
  role?: string;
}): boolean {
  return isSystemEntity(user.entityId) && user.role === "SystemAdmin";
}
