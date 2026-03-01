#!/usr/bin/env node

/**
 * Database Seeding Script for UNICX Integration Backend
 * 
 * This script initializes the MongoDB database with minimal seed data:
 * - One special "System" entity (for Administrators)
 * - One Administrator user (no tenantId, no phoneNumber, belongs to System entity)
 * - Empty collections for other entities and WhatsApp sessions
 * 
 * Usage:
 *   npm run seed:js
 *   npm run seed:js:clean
 *   node scripts/seed-database.js
 *   node scripts/seed-database.js --clean
 * 
 * System Admin Credentials:
 *   Email: admin@unicx.com
 *   Temporary Password: Admin!234Secure
 *   Entity: System (uses SYSTEM_ENTITY_ID constant)
 */

const { NestFactory } = require('@nestjs/core');
const bcrypt = require('bcryptjs');

const DEFAULT_SYSTEM_ADMIN_PASSWORD =
  process.env.SYSTEM_ADMIN_PASSWORD ||
  process.env.SYSTEM_ADMIN_TEMP_PASSWORD ||
  'Admin!234Secure';

// Import the compiled AppModule
// Support both build outputs where compiled files may be in `dist` root or in `dist/src`.
let AppModule;
try {
  AppModule = require('../dist/app.module').AppModule;
} catch (err) {
  // fallback to `dist/src/app.module` for builds that preserve source directories
  AppModule = require('../dist/src/app.module').AppModule;
}

// Import System Entity constants
let SYSTEM_ENTITY_ID, SYSTEM_ENTITY_NAME;
try {
  ({ SYSTEM_ENTITY_ID, SYSTEM_ENTITY_NAME } = require('../dist/common/constants/system-entity'));
} catch (err) {
  ({ SYSTEM_ENTITY_ID, SYSTEM_ENTITY_NAME } = require('../dist/src/common/constants/system-entity'));
}

class DatabaseSeeder {
  constructor(entityModel, userModel, whatsappSessionModel, messageModel) {
    this.entityModel = entityModel;
    this.userModel = userModel;
    this.whatsappSessionModel = whatsappSessionModel;
    this.messageModel = messageModel;
  }

  async seed() {
    console.log('🌱 Starting database seeding...');
    
    await this.cleanDatabase();

    const stats = {
      entities: 0,
      users: 0,
      whatsappSessions: 0,
    };

    // Seed system admin user
    console.log('👥 Seeding system admin user...');
    const users = await this.seedUsers();
    stats.users = users.length;

    return stats;
  }

  async cleanDatabase() {
    console.log('🧹 Cleaning existing data...');
    
    // Delete data from all collections
    await Promise.all([
      this.entityModel.deleteMany({}),
      this.userModel.deleteMany({}),
      this.whatsappSessionModel.deleteMany({}),
      this.messageModel.deleteMany({}),
    ]);

    // Fix phone number index
    console.log('🔧 Fixing phone number index...');
    try {
      const indexes = await this.userModel.collection.indexes();
      const phoneNumberIndexes = indexes.filter(
        (idx) => idx.key && idx.key.phoneNumber !== undefined,
      );

      // Drop all existing phoneNumber indexes (by name if possible, fallback by key)
      for (const index of phoneNumberIndexes) {
        const indexName = index.name || 'phoneNumber_1';
        try {
          await this.userModel.collection.dropIndex(indexName);
          console.log(`✅ Dropped existing phone number index: ${indexName}`);
        } catch (dropError) {
          try {
            await this.userModel.collection.dropIndex({ phoneNumber: 1 });
            console.log('✅ Dropped existing phone number index by key pattern');
          } catch (dropError2) {
            console.log(
              `ℹ️  Could not drop index: ${indexName} - ${dropError2.message}`,
            );
          }
        }
      }

      if (phoneNumberIndexes.length === 0) {
        console.log('ℹ️  No existing phone number index found');
      }
    } catch (error) {
      console.log(`ℹ️  Error checking indexes: ${error.message}`);
    }

    // Create new partial unique index (matching schema and migration)
    try {
      await this.userModel.collection.createIndex(
        { phoneNumber: 1 },
        {
          name: 'phoneNumber_1',
          unique: true,
          background: true,
          partialFilterExpression: {
            phoneNumber: { $type: 'string' },
            isActive: true,
          },
        },
      );
      console.log('✅ Created new partial unique index for phone numbers (active users only)');
    } catch (createError) {
      if (createError.code === 86 || createError.codeName === 'IndexKeySpecsConflict') {
        console.log('ℹ️  Index already exists with correct configuration, skipping creation');
      } else {
        throw createError;
      }
    }
    
    console.log('✅ Database cleaned and indexes updated');
  }

  async seedEntities() {
    return [];
  }

  async seedUsers() {
    const now = new Date();
    
    const usersData = [
      {
        email: process.env.SYSTEM_ADMIN_EMAIL || 'admin@unicx.com',
        firstName: process.env.SYSTEM_ADMIN_FIRST_NAME || 'System',
        lastName: process.env.SYSTEM_ADMIN_LAST_NAME || 'Administrator',
        password: bcrypt.hashSync(DEFAULT_SYSTEM_ADMIN_PASSWORD, 12),
        role: 'SystemAdmin',
        registrationStatus: 'registered',
        whatsappConnectionStatus: 'disconnected',
        entityId: SYSTEM_ENTITY_ID,
        entityPath: SYSTEM_ENTITY_NAME,
        entityIdPath: [SYSTEM_ENTITY_ID],
        tenantId: null, // SystemAdmin has no tenant
        isActive: true,
        mustChangePassword: true,
        createdAt: now,
        updatedAt: now,
      }
    ];

    const users = await this.userModel.insertMany(usersData);
    console.log(`✅ Created ${users.length} user (System Admin)`);
    return users;
  }

  async seedWhatsAppSessions() {
    // No WhatsApp sessions to seed - they are created when users are invited
    console.log(`✅ No WhatsApp sessions created (empty by design)`);
    return [];
  }

  async updateEntityHierarchy() {
    // No hierarchy to update - no entities seeded
    console.log('✅ No entity hierarchy to update (empty by design)');
  }
}

async function main() {
  console.log('🚀 UNICX Integration Database Seeder');
  console.log('=====================================');
  
  console.log('⚠️  CLEAN MODE: Will delete all existing data');

  try {
    // Create NestJS application context
    const app = await NestFactory.createApplicationContext(AppModule);
    
    // Get models
    const entityModel = app.get('EntityModel');
    const userModel = app.get('UserModel');
    const whatsappSessionModel = app.get('WhatsAppSessionModel');
    const messageModel = app.get('MessageModel');

    // Create seeder instance
    const seeder = new DatabaseSeeder(
      entityModel,
      userModel,
      whatsappSessionModel,
      messageModel
    );

    // Run seeding
    const stats = await seeder.seed();

    // Display results
    console.log('\n🎉 Database seeding completed successfully!');
    console.log('=====================================');
    console.log('📊 Summary:');
    console.log(`   🏢 Entities: ${stats.entities}`);
    console.log(`   👥 Users: ${stats.users}`);
    console.log(`   📱 WhatsApp Sessions: ${stats.whatsappSessions}`);
    
    console.log('\n🔐 System Admin Credentials:');
    console.log('   Email: admin@unicx.com');
    console.log(`   Temporary Password: ${DEFAULT_SYSTEM_ADMIN_PASSWORD}`);
    console.log('   Role: SystemAdmin');
    console.log(`   Entity: ${SYSTEM_ENTITY_NAME} (ID: ${SYSTEM_ENTITY_ID})`);
    console.log('   Note: Belongs to special System entity, no tenantId or phoneNumber');

    await app.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}
