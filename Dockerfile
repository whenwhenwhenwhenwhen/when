# Stage 1: Build the architecture-independent frontend on the native platform
FROM --platform=$BUILDPLATFORM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder

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

# Stage 2: Publish the built site as a file-only image.
#
# This image is not meant to be run. It carries no web server or entrypoint:
# the deployment host extracts /srv/www out of it (docker create + docker cp)
# and the reverse proxy in front serves those files directly, with the runtime
# /config.json rendered by the host next to them. See docs/deployment.md.
FROM scratch

COPY --from=builder /app/dist /srv/www
