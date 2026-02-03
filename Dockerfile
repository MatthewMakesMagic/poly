# =============================================================================
# Stage 1: Dependencies (shared base)
# =============================================================================
FROM node:20-alpine AS deps

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

# Create data directory for SQLite (will be PostgreSQL in Stage 2)
RUN mkdir -p /app/data

# Environment - no NODE_ENV to avoid environment-specific behavior
# TRADING_MODE controls paper/live distinction
ENV DATA_DIR=/app/data

# Expose dashboard port
EXPOSE 3000

# Health check (will be updated in Stage 3 to use /health endpoint)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Run the application
CMD ["npm", "run", "live"]
