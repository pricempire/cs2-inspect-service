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

# Production stage with Node.js 23.9
FROM node:23.9-slim

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

# Increase memory limit for Node.js to handle bot initialization
ENV NODE_OPTIONS="--max-old-space-size=8096"

EXPOSE 3000

# Run with Node.js
CMD ["node", "dist/main.js"]

# Using Node.js 23.9 for reliable operation with bot initialization