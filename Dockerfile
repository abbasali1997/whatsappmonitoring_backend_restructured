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
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run app (secrets injected by Kubernetes)
# If CLEAN_DATABASE=1, run the seed script once during deployment/startup.
CMD ["sh", "-c", "if [ \"$CLEAN_DATABASE\" = \"1\" ]; then node scripts/seed-database.js --clean; fi && if [ -f ./dist/src/main.js ]; then node dist/src/main.js; elif [ -f ./dist/main.js ]; then node dist/main.js; else echo 'ERROR: Entrypoint not found' >&2; exit 1; fi"]
# W