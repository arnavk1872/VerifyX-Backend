# VerifyX Backend - deployable to GCP (Cloud Run, GKE, Compute Engine)
# Multi-stage build for smaller production image

FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build deps for native modules (sharp, bcrypt)
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-bookworm-slim AS production

WORKDIR /app

# Runtime deps for sharp (optional; node:bookworm-slim may have enough)
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

# Non-root user for GCP security best practices
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --gid 1001 fastify

COPY --from=builder --chown=fastify:nodejs /app/package.json /app/package-lock.json* ./
COPY --from=builder --chown=fastify:nodejs /app/dist ./dist

# Production dependencies only (no devDependencies)
RUN npm ci --omit=dev && npm cache clean --force

USER fastify

EXPOSE 8080

# GCP Cloud Run sends SIGTERM; handle graceful shutdown
CMD ["node", "dist/index.js"]
