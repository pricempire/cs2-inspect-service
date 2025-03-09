FROM node:20 AS builder

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

# Production stage with Deno runtime
FROM denoland/deno:alpine

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
ENV NODE_PATH=/app/node_modules
ENV NODE_ENV=production

EXPOSE 3000

# Direct command to run the application with Deno
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", "--unstable-ffi", "--unstable-fs", "--node-modules-dir", "dist/main.js"]

# Uses Node.js/pnpm for reliable build but Deno for faster runtime execution