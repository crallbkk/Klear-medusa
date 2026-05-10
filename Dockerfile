# syntax=docker/dockerfile:1.7

# ---- Stage 1: builder ----
# Installs full dep tree, runs `medusa build` (which compiles TS and bundles
# the admin dashboard via Vite). Heavy step — happens once per image build,
# on the developer's laptop, NOT on Railway.
FROM node:20-bookworm-slim AS builder

# Native module build tools (sharp, bcrypt, etc. occasionally need them)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for cached layer (deps rarely change)
COPY package.json package-lock.json turbo.json .npmrc ./
COPY apps/backend/package.json ./apps/backend/

# Install all deps including dev — needed for `medusa build`
RUN npm ci

# Copy source
COPY apps/backend ./apps/backend

# Build: compiles TS + bundles admin dashboard into apps/backend/.medusa/server
RUN cd apps/backend && npm run build

# ---- Stage 2: runner ----
# Slimmer image: copies the built artifacts from stage 1.
# (Future optimization: `npm prune --omit=dev` to drop dev deps. Skipping for
# Session 1 to avoid pruning a Medusa runtime dep by accident.)
FROM node:20-bookworm-slim AS runner

WORKDIR /app

COPY --from=builder /app /app

# Medusa default port
EXPOSE 9000

WORKDIR /app/apps/backend

# Run pending DB migrations, then start the server.
# Migrations are idempotent — safe to run on every container start.
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]
