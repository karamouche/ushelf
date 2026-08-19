ARG USHELF_WEB_BASE_PATH=/
ARG USHELF_PORT=43110

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json

RUN pnpm install --frozen-lockfile

COPY apps/mcp apps/mcp
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/core packages/core
COPY recipes recipes

ARG USHELF_WEB_BASE_PATH
RUN USHELF_WEB_BASE_PATH="$USHELF_WEB_BASE_PATH" pnpm build

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json

RUN pnpm install --frozen-lockfile --prod --filter @ushelf/server...

FROM node:24-bookworm-slim AS runtime

ARG USHELF_WEB_BASE_PATH
ARG USHELF_PORT
ENV NODE_ENV=production
ENV USHELF_WEB_BASE_PATH=$USHELF_WEB_BASE_PATH

WORKDIR /app

COPY package.json ./
COPY --from=production-dependencies /app/node_modules node_modules
COPY --from=production-dependencies /app/apps/server/node_modules apps/server/node_modules
COPY --from=production-dependencies /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build --chown=node:node /app/recipes /data/recipes

RUN mkdir -p /data/library/items /data/library/history /data/.ushelf \
  && chown -R node:node /data

USER node

EXPOSE $USHELF_PORT

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const base = process.env.USHELF_WEB_BASE_PATH === '/' ? '' : process.env.USHELF_WEB_BASE_PATH.replace(/\/$/, ''); const port = process.env.USHELF_PORT; fetch(`http://127.0.0.1:${port}${base}/api/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "apps/server/dist/index.js"]
