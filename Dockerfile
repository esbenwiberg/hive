# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmjs.org/
COPY . .
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache git github-cli
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org/
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/src/dashboard/public ./src/dashboard/public
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/autonomous.config.yaml ./autonomous.config.yaml
RUN mkdir -p /repos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
