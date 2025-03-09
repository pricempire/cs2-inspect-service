FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun build

EXPOSE 3000
CMD ["sh", "-c", "bun dist/${APP_NAME}.js"]

# Using Bun for improved performance and faster initialization