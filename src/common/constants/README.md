# System Entity Constants

This module provides global constants and helper functions for working with the System entity, which is a special entity that Administrators belong to.

## Overview

The System entity is a special organizational unit that:
- Has a fixed ObjectId: `000000000000000000000001`
- Is not part of any tenant (`tenantId: null`)
- Serves as the organizational entity for Administrators
- Allows System Admins to access all data across tenants

## Usage

### Import Constants

```typescript
import { 
  SYSTEM_ENTITY_ID, 
  SYSTEM_ENTITY_NAME, 
  SYSTEM_ENTITY_TYPE,
  isSystemEntity,
  isSystemAdmin 
} from '../common/constants/system-entity';
```

### Available Constants

- **`SYSTEM_ENTITY_ID`**: The fixed ObjectId for the System entity
- **`SYSTEM_ENTITY_NAME`**: The name "System" 
- **`SYSTEM_ENTITY_TYPE`**: The type "system"

### Helper Functions

#### `isSystemEntity(entityId: Types.ObjectId | string): boolean`
Check if an entity ID matches the System entity.

```typescript
// Example usage
if (isSystemEntity(user.entityId)) {
  // This user belongs to the System entity
  console.log('User is a Administrator');
}
```

#### `isSystemAdmin(user: { entityId: Types.ObjectId | string; role?: string }): boolean`
Check if a user is a Administrator (belongs to System entity AND has SystemAdmin role).

```typescript
// Example usage
if (isSystemAdmin(user)) {
  // This user is a Administrator
  console.log('User has system-wide access');
}
```

## Service Integration

### Entities Service

```typescript
import { SYSTEM_ENTITY_ID, isSystemEntity } from '../../common/constants/system-entity';

@Injectable()
export class EntitiesService {
  // Check if an entity is the System entity
  isSystemEntity(entityId: Types.ObjectId | string): boolean {
    return isSystemEntity(entityId);
  }

  // Get the System entity ID
  getSystemEntityId(): Types.ObjectId {
    return SYSTEM_ENTITY_ID;
  }
}
```

### Users Service

```typescript
import { SYSTEM_ENTITY_ID, isSystemAdmin } from '../../common/constants/system-entity';

@Injectable()
export class UsersService {
  // Check if a user is a Administrator
  isSystemAdmin(user: User): boolean {
    return isSystemAdmin(user);
  }

  // Get the System entity ID
  getSystemEntityId(): Types.ObjectId {
    return SYSTEM_ENTITY_ID;
  }
}
```

## Database Queries

### Find Administrators

```typescript
// Find all Administrators
const systemAdmins = await userModel.find({
  entityId: SYSTEM_ENTITY_ID,
  role: 'SystemAdmin',
  isActive: true
});
```

### Exclude System Entity from Tenant Queries

```typescript
// Find all entities except System entity
const tenantEntities = await entityModel.find({
  _id: { $ne: SYSTEM_ENTITY_ID },
  isActive: true
});
```

### Check User Permissions

```typescript
// Check if user can access all tenants
function canAccessAllTenants(user: User): boolean {
  return isSystemAdmin(user);
}

// Check if user belongs to a specific tenant
function belongsToTenant(user: User, tenantId: string): boolean {
  if (isSystemAdmin(user)) {
    return true; // System Admins can access all tenants
  }
  return user.tenantId?.toString() === tenantId;
}
```

## Seed Script Usage

The seed script uses these constants to create the System entity and Administrator:

```javascript
const { SYSTEM_ENTITY_ID, SYSTEM_ENTITY_NAME, SYSTEM_ENTITY_TYPE } = require('../dist/common/constants/system-entity');

// Create System entity
const systemEntity = {
  _id: SYSTEM_ENTITY_ID,
  name: SYSTEM_ENTITY_NAME,
  type: SYSTEM_ENTITY_TYPE,
  // ... other fields
};

// Create Administrator
const systemAdmin = {
  entityId: SYSTEM_ENTITY_ID,
  entityPath: SYSTEM_ENTITY_NAME,
  entityIdPath: [SYSTEM_ENTITY_ID],
  // ... other fields
};
```

## Benefits

1. **Consistency**: Single source of truth for System entity identification
2. **Type Safety**: TypeScript support with proper typing
3. **Maintainability**: Easy to update if System entity ID needs to change
4. **Reusability**: Helper functions reduce code duplication
5. **Documentation**: Clear API for working with System entities

## Migration Notes

When migrating existing code:
1. Replace hardcoded `'000000000000000000000001'` with `SYSTEM_ENTITY_ID`
2. Replace hardcoded `'System'` with `SYSTEM_ENTITY_NAME`
3. Use helper functions instead of manual comparisons
4. Update imports to include the constants module
