# Production static build (FEATURE_REQUEST.md "the deploy loop" entry,
# 2026-07-18) — replaces the Vite dev server this image used to run behind
# the public whisper.silentlattice.dev URL (ARCHITECTURE_REVIEW_(Claude).md
# Risk 3: no production-grade caching, and a strictly larger/less-audited
# attack surface than a static file server — arbitrary module resolution,
# @vite/client, @react-refresh all reachable in "production"). The old
# dev-server image is preserved unchanged at frontend/Dockerfile.dev for
# optional local iteration (docker-compose.dev.yml) — this file is what's
# actually deployed.
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Vite inlines import.meta.env.VITE_* into the built bundle at build time —
# unlike the old dev-server image, these are no longer read from the
# container's runtime environment (RUNBOOK.md, Frontend Development).
# Supplied via docker-compose.yml's frontend.build.args, not
# frontend.environment.
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_TASK_OWNER_TOKEN_ALIAS
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_TASK_OWNER_TOKEN_ALIAS=$VITE_TASK_OWNER_TOKEN_ALIAS

RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000
