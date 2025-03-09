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

# Production stage with Bun runtime
FROM oven/bun:1.2.5

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy only the static folder that's needed
COPY --from=builder /app/static ./static

EXPOSE 3000
CMD ["sh", "-c", "bun dist/${APP_NAME}.js"]

# Uses Node.js/pnpm for reliable build but Bun for faster runtime execution