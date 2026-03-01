"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupTestApp = setupTestApp;
exports.closeTestApp = closeTestApp;
exports.cleanDatabase = cleanDatabase;
const testing_1 = require("@nestjs/testing");
const mongoose_1 = require("@nestjs/mongoose");
const config_1 = require("@nestjs/config");
const mongoose = require("mongoose");
let app;
let mongoConnection;
async function setupTestApp() {
    const moduleRef = await testing_1.Test.createTestingModule({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: ".env.test",
            }),
            mongoose_1.MongooseModule.forRootAsync({
                useFactory: () => ({
                    uri: process.env.MONGODB_URI || "mongodb://localhost:27017/unicx-test",
                }),
            }),
        ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
}
async function closeTestApp() {
    if (app) {
        await app.close();
    }
    if (mongoConnection) {
        await mongoose.connection.close();
    }
}
async function cleanDatabase() {
    if (mongoose.connection.readyState === 1) {
        const collections = mongoose.connection.collections;
        for (const key in collections) {
            await collections[key].deleteMany({});
        }
    }
}
beforeAll(async () => {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/unicx-test";
    mongoConnection = await mongoose.connect(mongoUri);
});
afterAll(async () => {
    await closeTestApp();
    if (mongoConnection) {
        await mongoose.connection.close();
    }
});
//# sourceMappingURL=setup-e2e.js.map