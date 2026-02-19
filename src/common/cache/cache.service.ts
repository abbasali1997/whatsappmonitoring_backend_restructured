import { Injectable, Logger, Inject, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { ConfigService } from "@nestjs/config";

export enum CacheKey {
  // Session & Auth
  JWT_WHITELIST = "jwt:whitelist:",
  JWT_BLACKLIST = "jwt:blacklist:",
  USER_SESSION = "user:session:",
  REFRESH_TOKEN = "refresh:token:",

  // WhatsApp
  WHATSAPP_QR = "whatsapp:qr:",

  // Messages
  RECENT_MESSAGES = "messages:recent:",
  MESSAGE_STATS = "messages:stats:",
  CONVERSATION_LIST = "conversations:list:",

  // Dashboard
  DASHBOARD_STATS = "dashboard:stats:",
  ENTITY_STATS = "entity:stats:",
  USER_STATS = "user:stats:",
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  startTime: Date;
}

export type CacheStatsResponse = CacheStats & { hitRate: string; uptime: number };

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
    startTime: new Date(),
  };
  private isRedisEnabled = false;
  private statsLogInterval: NodeJS.Timeout;

  constructor(
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.isRedisEnabled = this.configService.get<boolean>("redis.enabled") || false;
    // Keep only connection verification; avoid noisy logs
    await this.testConnection();
    
  }

  /**
   * Test Redis connection on startup
   */
  private async testConnection(): Promise<void> {
    try {
      const testKey = '__cache_connection_test__';
      const testValue = Date.now().toString();
      
      await this.cacheManager.set(testKey, testValue, 10);
      const result = await this.cacheManager.get(testKey);
      await this.cacheManager.del(testKey);

      if (result === testValue) {
        // Keep only the important connection success message
        this.logger.log('✅ Cache Connection Test: SUCCESS');
        this.logger.log(`Type: ${this.isRedisEnabled ? 'Redis' : 'In-Memory'}`);
      } else {
        throw new Error('Connection test failed: value mismatch');
      }
    } catch (error) {
      // Keep only the error for connection tests
      this.logger.error('❌ Cache Connection Test: FAILED');
      this.logger.error(`Error: ${error.message}`);
    }
  }

  /**
   * Log cache statistics
   */
  // Intentionally not logging periodic stats; keep counters for metrics access

  /**
   * Get current cache statistics
   */
  getStats(): CacheStatsResponse {
    const uptime = Date.now() - this.stats.startTime.getTime();
    const hitRate = (this.stats.hits + this.stats.misses) > 0 
      ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(2)
      : '0.00';

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      uptime,
    };
  }

  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | undefined> {
    const startTime = Date.now();
    try {
      const value = await this.cacheManager.get<T>(key);
      const duration = Date.now() - startTime;
      
      if (value) {
        this.stats.hits++;
      } else {
        this.stats.misses++;
      }
      return value;
    } catch (error) {
      this.stats.errors++;
      return undefined;
    }
  }

  /**
   * Set cached value with TTL
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const startTime = Date.now();
    try {
      await this.cacheManager.set(key, value, ttl);
      const duration = Date.now() - startTime;
      this.stats.sets++;
    } catch (error) {
        this.stats.errors++;
    }
  }

  /**
   * Delete cached value
   */
  async del(key: string): Promise<void> {
    const startTime = Date.now();
    try {
      await this.cacheManager.del(key);
      const duration = Date.now() - startTime;
      this.stats.deletes++;
    } catch (error) {
        this.stats.errors++;
    }
  }

  /**
   * Delete multiple keys by pattern
   */
  async delByPattern(pattern: string): Promise<void> {
    const startTime = Date.now();
    try {
      // Note: This requires Redis store with pattern support
      const stores = this.cacheManager.stores as any[];
      if (stores && stores.length > 0) {
        const store = stores[0];
        if (store.keys) {
          const keys = await store.keys(pattern);
          await Promise.all(keys.map((key) => this.cacheManager.del(key)));
          const duration = Date.now() - startTime;
          this.stats.deletes += keys.length;
        } else {
          // No-op; pattern deletion not supported for in-memory cache
        }
      }
    } catch (error) {
      this.stats.errors++;
    }
  }

  /**
   * List keys for a pattern (Redis only)
   */
  async listKeys(pattern: string): Promise<string[]> {
    try {
      const stores = this.cacheManager.stores as any[];
      if (stores && stores.length > 0) {
        const store = stores[0];
        if (store.keys) {
          const keys = await store.keys(pattern);
          return keys;
        }
      }
    } catch (error) {
      this.stats.errors++;
    }
    return [];
  }

  /**
   * Reset all cache
   */
  async reset(): Promise<void> {
    try {
      const stores = this.cacheManager.stores as any[];
      if (stores && stores.length > 0) {
        const store = stores[0];
        if (store.clear) {
          await store.clear();
        }
      }
      
      // Reset statistics
      const oldStats = { ...this.stats };
      this.stats = {
        hits: 0,
        misses: 0,
        sets: 0,
        deletes: 0,
        errors: 0,
        startTime: new Date(),
      };
      
      // Cache reset performed; stats were reset
    } catch (error) {
        this.stats.errors++;
    }
  }

  /**
   * Cleanup on module destroy
   */
  onModuleDestroy() {
    if (this.statsLogInterval) {
      clearInterval(this.statsLogInterval);
    }
  }

  /**
   * Cache user session
   */
  async cacheUserSession(
    userId: string,
    sessionData: any,
    ttl: number = 3600,
  ): Promise<void> {
    // No logs for session caching
    await this.set(`${CacheKey.USER_SESSION}${userId}`, sessionData, ttl);
  }

  /**
   * Get user session from cache
   */
  async getUserSession(userId: string): Promise<any> {
    return this.get(`${CacheKey.USER_SESSION}${userId}`);
  }

  /**
   * Invalidate user session
   */
  async invalidateUserSession(userId: string): Promise<void> {
    // No logs for session invalidation
    await this.del(`${CacheKey.USER_SESSION}${userId}`);
  }

  /**
   * Cache JWT token in whitelist
   */
  async whitelistToken(tokenId: string, ttl: number): Promise<void> {
    // No logs for whitelist actions
    await this.set(`${CacheKey.JWT_WHITELIST}${tokenId}`, true, ttl);
  }

  /**
   * Check if token is whitelisted
   */
  async isTokenWhitelisted(tokenId: string): Promise<boolean> {
    const result = await this.get(`${CacheKey.JWT_WHITELIST}${tokenId}`);
    return !!result;
  }

  /**
   * Blacklist JWT token (for logout)
   */
  async blacklistToken(tokenId: string, ttl: number): Promise<void> {
    // No logs for blacklist actions
    await this.set(`${CacheKey.JWT_BLACKLIST}${tokenId}`, true, ttl);
  }

  /**
   * Check if token is blacklisted
   */
  async isTokenBlacklisted(tokenId: string): Promise<boolean> {
    const result = await this.get(`${CacheKey.JWT_BLACKLIST}${tokenId}`);
    // No logs for blacklist checks
    return !!result;
  }

  /**
   * Cache WhatsApp QR code
   */
  async cacheQRCode(
    sessionId: string,
    qrData: any,
    ttl: number = 120,
  ): Promise<void> {
    // No logs for QR caching
    await this.set(`${CacheKey.WHATSAPP_QR}${sessionId}`, qrData, ttl);
  }

  /**
   * Get cached QR code
   */
  async getQRCode(sessionId: string): Promise<any> {
    return this.get(`${CacheKey.WHATSAPP_QR}${sessionId}`);
  }

  /**
   * Cache dashboard stats
   */
  async cacheDashboardStats(
    entityId: string,
    stats: any,
    ttl: number = 300,
  ): Promise<void> {
    // No logs for caching dashboard stats
    await this.set(`${CacheKey.DASHBOARD_STATS}${entityId}`, stats, ttl);
  }

  /**
   * Get cached dashboard stats
   */
  async getDashboardStats(entityId: string): Promise<any> {
    const stats = await this.get(`${CacheKey.DASHBOARD_STATS}${entityId}`);
    // No logs on dashboard cache retrieval
    return stats;
  }

  /**
   * Cache conversation list
   */
  async cacheConversations(
    tenantId: string,
    conversations: any[],
    ttl: number = 60,
  ): Promise<void> {
    // No logs for caching conversations
    await this.set(
      `${CacheKey.CONVERSATION_LIST}${tenantId}`,
      conversations,
      ttl,
    );
  }

  /**
   * Get cached conversations
   */
  async getConversations(tenantId: string): Promise<any[]> {
    return this.get(`${CacheKey.CONVERSATION_LIST}${tenantId}`);
  }

  /**
   * Invalidate conversation cache
   */
  async invalidateConversations(tenantId: string): Promise<void> {
    await this.del(`${CacheKey.CONVERSATION_LIST}${tenantId}`);
  }
}
