# =============================================================================
# Stage 1: Dependencies (shared base)
# =============================================================================
FROM node:22-alpine AS deps

WORKDIR /app
COPY package*.json ./

# =============================================================================
# Stage 2: Test image (includes devDependencies)
# =============================================================================
FROM deps AS test

# Install ALL dependencies (including devDependencies for vitest)
RUN npm ci

# Copy application code
COPY . .

# Run tests (used for CI verification)
CMD ["npm", "run", "test:run"]

# =============================================================================
# Stage 3: Production image (lean, no devDependencies)
# =============================================================================
FROM deps AS production

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data directory for logs and state files
RUN mkdir -p /app/data

# Environment - no NODE_ENV to avoid environment-specific behavior
# TRADING_MODE controls paper/live distinction
ENV DATA_DIR=/app/data
ENV PORT=3333

# Expose health/status port
EXPOSE 3333

# Health check via /health endpoint (V3 Stage 5)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3333/health || exit 1

# Run the application
CMD ["npm", "run", "live"]
