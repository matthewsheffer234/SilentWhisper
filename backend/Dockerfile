# Build context is the repo root (not /backend) so this image can also
# include /database — knexfile.js's migrations directory (../database/migrations)
# resolves the same way inside the container as it does on the host. See
# docker-compose.yml: build.context is "." with dockerfile "backend/Dockerfile".
FROM node:20-alpine

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/ ./
COPY database/ /app/database/

# docs/plans/active/SHIPMENT_PLAN.md Section 2.3 — ships the standalone maintenance scripts
# (create-first-admin.mjs, verify-audit-log.mjs, upgrade-prompt-versions.mjs
# et al.) inside the backend image so an air-gapped install can run them
# in-container without staging a second scripts/node_modules offline
# artifact. Safe: scripts/package.json's dependencies (dotenv, pg, knex,
# bcryptjs, jsonwebtoken, ws) are an exact-version-range subset of
# backend/package.json's own, already installed above.
COPY scripts/*.mjs /app/scripts/
RUN ln -s /app/backend/node_modules /app/node_modules

EXPOSE 8000

CMD ["node", "src/index.js"]
