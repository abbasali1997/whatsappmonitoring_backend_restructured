export const configuration = () => ({
  azure: {
    serviceBus: {
      connectionString: process.env.AZURE_SERVICE_BUS_CONNECTION_STRING,
      dlqTopic: process.env.AZURE_SERVICE_BUS_DLQ_TOPIC || "dlq",
      dlqSubscription:
        process.env.AZURE_SERVICE_BUS_DLQ_SUBSCRIPTION || "dlq-processor",
      defaultQueue:
        process.env.AZURE_SERVICE_BUS_DEFAULT_QUEUE || "default-queue",
    },
    monitor: {
      connectionString: process.env.AZURE_MONITOR_CONNECTION_STRING,
    },
  },

  // Application
  app: {
    name: process.env.APP_NAME || "2N5 Integration",
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || "development",
    apiPrefix: process.env.API_PREFIX || "api/v1",
    baseUrl: process.env.BASE_URL || "http://localhost:3000",
  },

  // Database
  database: {
    mongodbUri:
      process.env.MONGODB_URI || "mongodb://localhost:27017/unicx-integration",
    cosmosDbName: process.env.COSMOS_DB_NAME || "unicx-integration",
    maxPoolSize: parseInt(process.env.DATABASE_MAX_POOL_SIZE, 10) || 50,
    minPoolSize: parseInt(process.env.DATABASE_MIN_POOL_SIZE, 10) || 10,
  },

  // JWT Authentication
  jwt: {
    secret: process.env.JWT_SECRET || "your-super-secret-jwt-key",
    expiresIn: process.env.JWT_EXPIRES_IN || "24h",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "your-refresh-secret-key",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },

  // Email Configuration
  email: {
    provider: process.env.EMAIL_PROVIDER || "smtp",
    smtp: {
      host: process.env.EMAIL_HOST || "smtp.gmail.com",
      port: parseInt(process.env.EMAIL_PORT, 10) || 587,
      secure: process.env.EMAIL_SECURE === "true",
      user: process.env.EMAIL_USER || "",
      pass: process.env.EMAIL_PASS || "",
    },
    from: {
      name: process.env.EMAIL_FROM_NAME || "2N5",
      address: process.env.EMAIL_FROM_ADDRESS || "noreply@2n5global.com",
    },
  },

  // Rate Limiting
  rateLimit: {
    default: {
      ttl: parseInt(process.env.RATE_LIMIT_TTL, 10) || 60,
      limit: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    },
    auth: {
      ttl: parseInt(process.env.AUTH_RATE_LIMIT_TTL, 10) || 900,
      limit: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 5,
    },
  },

  // QR Code
  qrCode: {
    expiryHours: parseInt(process.env.QR_CODE_EXPIRY_HOURS, 10) || 24,
    encryptionKey:
      process.env.QR_CODE_ENCRYPTION_KEY || "your-qr-encryption-key",
    maxRetryAttempts: parseInt(process.env.QR_CODE_MAX_RETRY_ATTEMPTS, 10) || 3,
    imageFormat: process.env.QR_CODE_IMAGE_FORMAT || "png",
    size: parseInt(process.env.QR_CODE_SIZE, 10) || 300,
  },

  // WhatsApp Business API
  whatsapp: {
    apiUrl: process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v18.0",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    businessId: process.env.WHATSAPP_BUSINESS_ID || "",
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "",
    // Health check scheduler (in-process interval)
    healthCheckEnabled: process.env.WHATSAPP_HEALTHCHECK_ENABLED !== "false",
    healthCheckIntervalMs:
      parseInt(process.env.WHATSAPP_HEALTHCHECK_INTERVAL_MS || "300000", 10) ||
      30000,
    healthCheckFailureThreshold:
      parseInt(process.env.WHATSAPP_HEALTHCHECK_FAILURE_THRESHOLD || "3", 10) ||
      3,
    // WhatsApp Web (whatsapp-web.js) RemoteAuth
    // How often to sync the auth backup to Mongo (GridFS). Lower = better restart recovery.
    remoteAuthBackupSyncIntervalMs:
      parseInt(
        process.env.WHATSAPP_REMOTE_AUTH_BACKUP_SYNC_INTERVAL_MS || "60000",
        10,
      ) || 60000,
    // Cross-pod session ownership lock (milliseconds)
    sessionLockTtlMs:
      parseInt(process.env.WHATSAPP_SESSION_LOCK_TTL_MS || "600000", 10) ||
      600000,
    sessionLockRefreshIntervalMs:
      parseInt(
        process.env.WHATSAPP_SESSION_LOCK_REFRESH_INTERVAL_MS || "120000",
        10,
      ) || 120000,
  },

  // Security
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    encryptionKey:
      process.env.ENCRYPTION_KEY || "your-encryption-key-32-chars-minimum",
    corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:3000").split(","),
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 5242880, // 5MB
    allowedFileTypes: (
      process.env.ALLOWED_FILE_TYPES || "image/jpeg,image/png,image/gif"
    ).split(","),
  },

  // File Storage
  storage: {
    provider: process.env.STORAGE_PROVIDER || "azure",
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || "",
      container: process.env.AZURE_STORAGE_CONTAINER || "unicx-files",
    },
    aws: {
      bucket: process.env.AWS_S3_BUCKET || "unicx-files",
      region: process.env.AWS_S3_REGION || "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  },

  // Monitoring & Logging
  monitoring: {
    logLevel: process.env.LOG_LEVEL || "info",
    sentryDsn: process.env.SENTRY_DSN || "",
    enableSwagger: process.env.ENABLE_SWAGGER !== "false",
  },

  // Cleanup Jobs
  cleanup: {
    qrCodeCleanupDays: parseInt(process.env.QR_CODE_CLEANUP_DAYS, 10) || 7,
    failedInvitationCleanupDays:
      parseInt(process.env.FAILED_INVITATION_CLEANUP_DAYS, 10) || 14,
    intervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 21600000,
  },

  // Pagination
  pagination: {
    defaultPageSize: parseInt(process.env.DEFAULT_PAGE_SIZE, 10) || 20,
    maxPageSize: parseInt(process.env.MAX_PAGE_SIZE, 10) || 100,
  },

  // Session Management
  session: {
    timeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 30,
    maxConcurrentSessions:
      parseInt(process.env.MAX_CONCURRENT_SESSIONS, 10) || 3,
  },

  // Redis Cache (Azure Cache for Redis)
  redis: {
    url: process.env.REDIS_CONNECTION_STRING || "",
    // Redis is considered enabled when a host/connection string is provided
    enabled: !!process.env.REDIS_CONNECTION_STRING,
    defaultTtl: parseInt(process.env.REDIS_DEFAULT_TTL, 10) || 300,
  },

  // Feature Flags
  features: {
    emailVerification: process.env.ENABLE_EMAIL_VERIFICATION === "true",
    twoFactorAuth: process.env.ENABLE_TWO_FACTOR_AUTH === "true",
    whatsappIntegration: process.env.ENABLE_WHATSAPP_INTEGRATION !== "false",
    externalAuthProviders:
      process.env.ENABLE_EXTERNAL_AUTH_PROVIDERS === "true",
  },
});
