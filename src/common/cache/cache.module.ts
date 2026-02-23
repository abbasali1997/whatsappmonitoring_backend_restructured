import { Module, Global, Logger } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  CacheModule as NestCacheModule,
  CacheModuleOptions,
} from "@nestjs/cache-manager";
import * as redisStore from "cache-manager-redis-yet";
import { CacheService } from "./cache.service";

@Global()
@Module({
  imports: [
    // Use Redis-based cache if configured, otherwise use in-memory
    NestCacheModule.registerAsync<CacheModuleOptions>({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const logger = new Logger("CacheModule");
        const url = configService.get<string>("redis.url");
        const enabled = configService.get<boolean>("redis.enabled");
        const defaultTtl = configService.get<number>("redis.defaultTtl") || 300;

        // Only keep connection logs; suppress other verbose configuration logs

        if (!enabled || !url) {
          // Redis not configured - fallback to in-memory cache (no logs)

          return {
            isGlobal: true,
            max: 100,
            ttl: defaultTtl,
          };
        }

        // Parse connection string to show details (without password)
        const maskedUrl = url.includes("@")
          ? url.replace(/\/\/.*@/, "//*****@")
          : url.replace(/\/\/[^:]+:[^@]+@/, "//*****:*****@");

        logger.log("✅ Redis ENABLED - Connecting to Redis...");
        logger.log(`Connection: ${maskedUrl}`);

        try {
          const config = {
            isGlobal: true,
            store: redisStore,
            url: url,
            socket: {
              tls: url.startsWith("rediss://"),
              reconnectStrategy: (retries: number) => {
                if (retries > 10) {
                  logger.error("❌ Redis connection failed after 10 retries");
                  logger.warn("Falling back to in-memory cache");
                  return new Error("Max retries reached");
                }
                const delay = Math.min(retries * 100, 3000);
                logger.warn(`⚠️  Redis reconnecting... (attempt ${retries})`);
                return delay;
              },
            },
            ttl: defaultTtl,
          } as any;

          return config;
        } catch (error) {
          logger.error(`❌ Failed to configure Redis: ${error.message}`);
          logger.warn("Falling back to in-memory cache");
          return {
            isGlobal: true,
            max: 100,
            ttl: defaultTtl,
          };
        }
      },
      inject: [ConfigService],
    }),
  ],
  providers: [CacheService],
  exports: [CacheService, NestCacheModule],
})
export class CacheModule {}
