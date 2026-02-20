# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gpg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && apt-get purge -y curl gpg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json /app/.npmrc ./
RUN npm ci --omit=dev

# Install Playwright's Chromium + system deps
RUN npx playwright install --with-deps chromium

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/src/dashboard/public ./src/dashboard/public
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/autonomous.config.yaml ./autonomous.config.yaml
COPY --from=builder /app/CHANGELOG.md ./CHANGELOG.md
RUN mkdir -p /repos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
