# syntax=docker/dockerfile:1.7

# ---- Stage 1: builder ----
# Installs full dep tree, runs `medusa build` (compiles TS + bundles admin
# dashboard via Vite). Output: apps/backend/.medusa/server — a self-contained
# Node app per Medusa v2's documented production-deploy pattern.
FROM node:20-bookworm-slim AS builder

# Native module build tools (some Medusa deps need them)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json turbo.json .npmrc ./
COPY apps/backend/package.json ./apps/backend/

# Install full dep tree (dev deps required for medusa build)
RUN npm ci

# Copy source
COPY apps/backend ./apps/backend

# Build: produces apps/backend/.medusa/server with the bundled server + admin
RUN cd apps/backend && npm run build

# Install production-only deps inside the .medusa/server bundle.
# This is what Medusa v2 docs prescribe for production deploys.
# --legacy-peer-deps: Medusa v2.14.2 has an internal React 18/19 peer-dep
# conflict between @medusajs/icons (wants 19) and the rest of the bundle (18).
# Known harmless quirk; without this flag npm refuses to install.
RUN cd apps/backend/.medusa/server && npm install --omit=dev --legacy-peer-deps

# ---- Stage 2: runner ----
# Minimal image: only the .medusa/server bundle. The full source tree and
# dev-only deps from stage 1 are dropped.
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Copy the self-contained server bundle (includes its own node_modules and
# the bundled admin dashboard at public/admin/)
COPY --from=builder /app/apps/backend/.medusa/server ./

# Medusa default port
EXPOSE 9000

# Run pending DB migrations on every container start (idempotent), then start
# the server. The medusa CLI is in node_modules/.bin from the production install.
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]
