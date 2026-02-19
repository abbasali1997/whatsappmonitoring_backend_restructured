import { INestApplication } from '@nestjs/common';
export declare function setupTestApp(): Promise<INestApplication>;
export declare function closeTestApp(): Promise<void>;
export declare function cleanDatabase(): Promise<void>;
