# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
ARG BUILD_SHA=dev
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git wget ca-certificates rsync openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gpg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && apt-get purge -y gpg \
    && rm -rf /var/lib/apt/lists/*

# Install .NET 10 SDK (for dotnet+npm repos)
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 10.0 --quality preview --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && rm /tmp/dotnet-install.sh \
    && apt-get purge -y curl \
    && rm -rf /var/lib/apt/lists/*
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
ENV NODE_ENV=production
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
