FROM node:23.9 AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy application code
COPY . .

# Build with pnpm (proven to work with the import structure)
RUN pnpm build

# Production stage with Node.js 23 alpine (lighter)
FROM node:23-alpine

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy required static files 
COPY --from=builder /app/static ./static

# Create and set permissions for sessions directory
RUN mkdir -p sessions && chmod 777 sessions

# Set environment variables
ENV NODE_ENV=production

# Optimize for worker threads and memory allocation
ENV NODE_OPTIONS="--experimental-worker"
ENV UV_THREADPOOL_SIZE=64

# Bot worker configuration 
ENV BOTS_PER_WORKER=50
ENV MAX_CONCURRENT_INIT=10
ENV WORKER_TIMEOUT=60000
ENV WORKER_ENABLED=true
ENV BOT_DEBUG=false
ENV STATS_UPDATE_INTERVAL=3000

# Performance tuning
ENV NODE_WORKER_THREADS=1

# Add this variable to enable graceful startup
ENV THROTTLE_STARTUP=true

EXPOSE 3000

# Run with Node.js
CMD ["node", "dist/main.js"]

# Using worker threads for bot management while keeping HTTP handling responsive