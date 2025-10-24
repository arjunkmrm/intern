# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY container_src/package.json container_src/tsconfig.json ./
RUN bun install --frozen-lockfile

# Copy source code
COPY container_src/src ./src

EXPOSE 8080

# Run with Bun (native TypeScript support)
CMD ["bun", "run", "src/server.ts"]
