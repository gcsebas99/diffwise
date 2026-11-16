# syntax=docker/dockerfile:1
# The Diffwise GitHub App. Built by Render from render.yaml; locally:
#   docker build -t diffwise-app . && docker run -p 3000:10000 --env-file <file> diffwise-app

# --- build: install everything, bundle the server into one file --------------------------
FROM node:22-slim AS build
WORKDIR /src
# corepack reads "packageManager" from package.json, so the image uses the repo's pinned pnpm.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Only what the bundle needs; .dockerignore keeps secrets and local files out of the context.
COPY tsconfig.json ./
COPY scripts/ scripts/
COPY src/ src/
RUN pnpm build:app

# --- runtime: Node and one file ------------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /src/build/app.mjs ./app.mjs
# The image's built-in unprivileged user: a compromised process can't write outside /tmp.
USER node
# Render routes to $PORT (10000 by default); main.ts binds 0.0.0.0 on it.
EXPOSE 10000
CMD ["node", "app.mjs"]
