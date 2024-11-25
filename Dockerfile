# Stage 1: Build with pnpm
FROM node:20 as build

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Stage 2: Serve with Bun
FROM oven/bun:latest as serve

# Set working directory
WORKDIR /app

# Copy built files and dependencies from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Expose port
EXPOSE 3000

# Start with Bun
CMD ["sh", "-c", "bun run dist/${APP_NAME}.js"]
