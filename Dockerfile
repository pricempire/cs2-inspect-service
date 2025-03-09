FROM oven/bun:latest

WORKDIR /app

# Copy only package.json first
COPY package.json ./
# Install dependencies and generate lockfile
RUN bun install

# Copy the rest of the application
COPY . .
# Run the build script from package.json instead of direct bun build command
RUN bun run build

EXPOSE 3000
CMD ["sh", "-c", "bun dist/${APP_NAME}.js"]

# Using Bun for improved performance and faster initialization