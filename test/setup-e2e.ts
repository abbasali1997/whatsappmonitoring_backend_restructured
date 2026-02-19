import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfigModule } from "@nestjs/config";
import * as mongoose from "mongoose";

// Global test database connection
let app: INestApplication;
let mongoConnection: typeof mongoose;

export async function setupTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: ".env.test",
      }),
      MongooseModule.forRootAsync({
        useFactory: () => ({
          uri:
            process.env.MONGODB_URI || "mongodb://localhost:27017/unicx-test",
        }),
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

export async function closeTestApp(): Promise<void> {
  if (app) {
    await app.close();
  }
  if (mongoConnection) {
    await mongoose.connection.close();
  }
}

// Clean database before each test
export async function cleanDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}

// Setup before all tests
beforeAll(async () => {
  // Connect to test database
  const mongoUri =
    process.env.MONGODB_URI || "mongodb://localhost:27017/unicx-test";
  mongoConnection = await mongoose.connect(mongoUri);
});

// Cleanup after all tests
afterAll(async () => {
  await closeTestApp();
  if (mongoConnection) {
    await mongoose.connection.close();
  }
});
