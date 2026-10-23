# Build: compile server + dashboard, then assemble production-only deps in /prod.
# Compilers are only needed if better-sqlite3 has no prebuilt binary for the platform.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.0.9

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY interveil/package.json interveil/
COPY interveil-vscode/package.json interveil-vscode/
RUN pnpm install --frozen-lockfile --filter interveil
COPY interveil/ interveil/
RUN pnpm --filter interveil run build

WORKDIR /prod
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY interveil/package.json interveil/
COPY interveil-vscode/package.json interveil-vscode/
RUN pnpm install --prod --frozen-lockfile --filter interveil \
 && cp -r /app/interveil/dist interveil/dist

# Runtime: Node, production deps and compiled output only.
FROM node:22-bookworm-slim
COPY --from=build /prod /app
RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production \
    INTERVEIL_HOST=0.0.0.0
USER node
WORKDIR /app/interveil
EXPOSE 3000
CMD ["node", "dist/cli.js", "serve", "--db", "/data/interveil.db"]
