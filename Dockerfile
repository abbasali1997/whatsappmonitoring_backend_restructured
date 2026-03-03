# =========================
# Stage 1: Builder
# =========================
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ bash

# Install Chromium for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    chromium-chromedriver

# Puppeteer env
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_BIN=/usr/bin/chromium

# Copy package.json & lock files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build NestJS app
RUN npm run build

# =========================
# Stage 2: Production
# =========================
FROM node:22-alpine

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    bash \
    wget

# Puppeteer environment
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_BIN=/usr/bin/chromium \
    NODE_ENV=production

# Copy package.json & lock
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built app from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/templates ./templates

# Expose app port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/v1/health/live || exit 1

# Run the API (worker uses a separate command: override in the k8s Deployment)
CMD ["node", "-r", "./scripts/register-api-paths.js", "dist/api/apps/api/main.js"]