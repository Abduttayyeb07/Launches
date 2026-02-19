# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy everything (filtered by .dockerignore)
COPY . .

# Install all deps and compile
RUN npm ci --ignore-scripts
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files and install prod deps only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Data directory for persistent files
RUN mkdir -p /app/data

STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
