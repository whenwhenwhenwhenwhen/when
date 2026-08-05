# Stage 1: Build the architecture-independent frontend on the native platform
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder

# Enable corepack for pnpm
RUN corepack enable pnpm

WORKDIR /app

# Copy package files and pnpm dependency-build policy
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build the application (no VITE_* args needed — config is injected at runtime)
RUN pnpm run build

# Stage 2: Serve
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy entrypoint that generates /config.json from env vars
COPY docker-entrypoint.sh /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
